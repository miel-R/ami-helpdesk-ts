// Webhook Client
import axios from 'axios';
import { config } from '../../config/config.service';
import * as catalog from '../catalog';
import { isWebhookDebug } from '../../core/flags';
import type { SessionUser, TicketType } from '../../models/types.model';

/**
 * Impact columns, matching measurable_impact(scrf_id, productivity, quality,
 * yield, cost_saving, customer_requirement, measurable_impact_remarks).
 */
const IMPACT_COLUMNS: readonly string[] = [
  'productivity',
  'quality',
  'yield',
  'cost_saving',
  'customer_requirement'
];

export interface WebhookResult {
  ok: boolean;
  error?: string;
  status?: number | null;
  body?: unknown;
  url?: string;
}

/**
 * The URL a real ticket submission should go to right now.
 *
 * Production by default. When webhook debug mode is on, the TEST endpoint is
 * used instead so an admin can iterate on the n8n workflow without writing real
 * tickets. The flag is consulted on every submission rather than captured once
 * at startup, so $webhook-debug takes effect immediately.
 *
 * Falls back to production when debug is on but no test URL is configured,
 * because dropping the ticket entirely would be worse than sending it somewhere
 * real. Callers that need to warn about that can check isWebhookDebug() too.
 */
export function activeWebhookUrl(): string {
  if (isWebhookDebug() && config.n8n.testWebhookUrl) return config.n8n.testWebhookUrl;
  return config.n8n.webhookUrl;
}

/**
 * Trigger the n8n webhook with ticket data.
 *
 * `urlOverride` lets a caller target the TEST endpoint instead of production.
 * $test-webhook uses this so probing never writes into the live ticket tables.
 * Omit it for real submissions, which then follow webhook debug mode.
 */
export async function triggerWebhook(
  payload: Record<string, unknown>,
  urlOverride?: string
): Promise<WebhookResult> {
  const url = urlOverride || config.n8n.webhookUrl;
  if (!url) return { ok: false, error: 'No webhook URL configured' };

  try {
    const response = await axios.post(url, payload, { timeout: 10000 });
    return { ok: true, status: response.status, body: response.data, url };
  } catch (err) {
    // Axios's own message ("Request failed with status code 404") is useless on
    // its own. n8n puts the actual diagnosis in the response body - for a 404
    // that is literally "The workflow must be active..." - so surface it instead
    // of swallowing it and leaving the user guessing.
    const e = err as {
      message?: string;
      response?: { status?: number; data?: unknown };
    };
    const body = e.response?.data;
    let detail = e.message ?? 'Request failed';
    if (body && typeof body === 'object') {
      const b = body as { message?: string; hint?: string };
      const parts = [b.message, b.hint].filter(Boolean);
      if (parts.length) detail = parts.join(' - ');
    } else if (typeof body === 'string' && body.trim()) {
      detail = body.trim();
    }

    return {
      ok: false,
      error: detail,
      status: e.response?.status ?? null,
      url
    };
  }
}

/** One attachment as n8n expects it. */
/**
 * One attachment as n8n expects it.
 *
 * `staged_path` is where the bytes are right now, under the _incoming folder on
 * the shared file_master mount. n8n moves each one to
 * file_master/<type>/<control number>/<file_name> once it has minted a control
 * number, and records that final relative path itself.
 */
interface TicketAttachment {
  file_name: string;
  staged_path: string;
  file_type: string;
  file_size: number;
}

/**
 * Everything needed to build a ticket payload.
 *
 * Both a real submission and $test-webhook go through here. They used to be built
 * separately and drifted apart, which made the probe useless for testing an n8n
 * insert: the probe sent a flat body with almost no fields, so an insert that
 * worked against the probe broke on a real ticket. One builder, one contract.
 */
export interface TicketPayloadInput {
  ticketType: TicketType | string;
  /** Routing hint derived from the user's profile. See getDepartment(). */
  department: string;
  userName: string;
  user: SessionUser;
  collectedFields: Record<string, string | number | string[]>;
  attachments?: Array<Record<string, unknown>>;
  /**
   * Marks this as a probe. n8n can use it to skip the real insert, and it is the
   * only difference between a probe and a genuine submission.
   */
  test?: boolean;
  /** Numeric MIS codes for category/system. Resolved by buildResolvedPayload. */
  lookupIds?: LookupIds;
}

/**
 * The numeric codes MIS uses for the chosen category and system.
 *
 * Sent alongside the names so an n8n insert can write a foreign key instead of
 * storing free text. Names stay in the payload too: a human-readable ticket is
 * still useful in the job list, and if MIS is ever unreachable the names remain
 * correct while the ids go blank rather than wrong.
 */
export interface LookupIds {
  category_id: number | '';
  /**
   * A single id, or several comma-separated when the user picked more than one.
   *
   * MIS stores several system types on one ticket as e.g. "14,15"
   * (`support_master.support_category`), so a comma list is a real value here
   * rather than a display string.
   */
  system_id: number | string | '';
}

/**
 * Flatten a collected answer set for the wire.
 *
 * A multi-select answer is held as a list in the session, but MIS reads several
 * values as one comma-separated string (`support_category` = "14,15"), so the
 * list is joined here rather than serialised as a JSON array. That also keeps
 * `ticket_data` free of a type n8n's Set/Merge nodes do not handle.
 */
function flattenFields(
  fields: Record<string, string | number | string[]>
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = toScalar(v);
  return out;
}

/** Flatten one answer to text, so a number and a list both read cleanly. */
function toScalar(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join(', ');
  return String(value ?? '').trim();
}

/**
 * Flatten one answer to a list of parts.
 *
 * Multi-select arrives as `string[]`, but a value saved before multi-select
 * existed is already a joined string, so commas are treated as separators.
 */
function toScalarList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * The id behind whatever the form submitted for one field.
 *
 * The form posts ids, because that is what MIS stores, but the $test-webhook probe
 * still posts labels and a label is unambiguous. Accepting either means the probe
 * stays a faithful stand-in for a real ticket instead of silently writing blanks.
 */
function pickId(
  options: readonly { id: number; name: string }[],
  raw: string
): number | '' {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  return options.find(o => String(o.id) === v || o.name === v)?.id ?? '';
}

/**
 * Ids for a multi-valued field, comma-joined.
 *
 * Several systems on one ticket is a real stored value, not a display string:
 * scrf_master.scrf_sys_name holds "1" on 2915 rows and "2,3,7,14" on others, and
 * support_master.support_category holds "15". Joined without a space so it drops
 * straight into those columns.
 */
function joinIds(
  options: readonly { id: number; name: string }[],
  values: readonly string[]
): number | string | '' {
  const ids = values
    .map(v => options.find(o => String(o.id) === String(v).trim() || o.name === String(v).trim())?.id)
    .filter((v): v is number => v !== undefined);
  if (!ids.length) return '';
  return ids.length === 1 ? ids[0] : ids.join(',');
}

/**
 * n8n's MySQL node takes replacements as ONE comma-separated string that it
 * splits into positional placeholders, so a value containing a comma - which
 * every multi-system ticket has, because MIS stores `"1,3"` - silently shifts
 * every column after it. Ticket AIP26100039 lost its requester name, employee
 * number and e-mail that way, with the later answers landing in the wrong
 * columns.
 *
 * The list is therefore sent both ways: `system_id` stays the comma-joined
 * value for the flows that bind by name, and `system_ids` carries each id on
 * its own so a positional flow can bind them without splitting. A single id is
 * still a bare number, so existing single-select tickets are unchanged.
 */
function splitIdsForPositional(value: unknown): number[] {
  return String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (Number.isFinite(Number(v)) ? Number(v) : v))
    .filter((v): v is number => typeof v === 'number');
}

/**
 * Add the per-id list beside the joined value. `system_ids` is a JSON array so a
 * positional n8n flow can bind it without n8n splitting on the comma, and
 * `system_id_count` tells that flow how many placeholders it now owes.
 */
function withSplitIds(ids: LookupIds): LookupIds & { system_ids?: number[]; system_id_count?: number } {
  const joined = ids.system_id;
  if (typeof joined !== 'string' || !joined.includes(',')) return ids;
  const list = splitIdsForPositional(joined);
  return {
    ...ids,
    system_ids: list,
    system_id_count: list.length
  };
}

/**
 * The pipe-separated twin of a comma-joined value.
 *
 * n8n splits its `queryReplacement` on commas AFTER the expressions are
 * evaluated, so `"1,3"` becomes two placeholders and every column after it
 * shifts one place left. That is what emptied the requester name, employee
 * number and e-mail on AIP26100039 and left Request Category blank on the MIS
 * job list. A single select has no comma and is unaffected, which is why the
 * damage only ever appeared on multi-system tickets.
 *
 * Sending the same ids joined with `|` keeps the value one token, and the flow
 * restores the comma in SQL with REPLACE(..., '|', ','). Always emitted, even
 * for a single id, so a flow never has to branch on whether there was a comma.
 */
function pipeTwin(value: unknown): string {
  return String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .join('|');
}

/**
 * Resolve category/system to MIS's own ids.
 *
 * Both maps come from MIS, never from a hardcoded table, so a category MIS
 * renumbers is picked up on the next cache refresh.
 */
async function resolveLookupIds(
  ticketType: TicketType | string,
  fields: Record<string, unknown>
): Promise<LookupIds> {
  const category = toScalar(fields.category);
  // A multi-select field arrives as a list; a single-select one as a string.
  const systemNames = toScalarList(fields.system);
  const empty: LookupIds = { category_id: '', system_id: '' };
  if (!category && !systemNames.length) return empty;

  try {
    if (ticketType === 'system_request') {
      const [cats, systems] = await Promise.all([
        catalog.systemRequestCategoryOptions(),
        catalog.systemRequestSystemOptions()
      ]);
      return withSplitIds({
        category_id: pickId(cats, category),
        system_id: joinIds(systems, systemNames)
      });
    }
    if (ticketType === 'tech_support') {
      // Tech Support category is the 1-4 request_category code; system is the
      // support_category.ID of the chosen system type. Both tables are distinct
      // from the System Request ones.
      const [cats, systems] = await Promise.all([
        catalog.supportCategoryOptions(),
        catalog.supportSystemOptions()
      ]);
      const unknown = systemNames.filter(v => !systems.some(o => String(o.id) === v || o.name === v));
      if (unknown.length) {
        console.warn(`[webhook] no MIS id for system types: ${unknown.join(', ')}`);
      }
      return withSplitIds({
        category_id: pickId(cats, category),
        system_id: joinIds(systems, systemNames)
      });
    }
  } catch (e) {
    // Never let a catalogue lookup stop a ticket being filed.
    console.warn(`[webhook] could not resolve ids: ${(e as Error).message}`);
  }
  return empty;
}

/**
 * Render an id as a number when it is one, so it drops into a numeric column.
 *
 * MIS stores the employee number as a VARCHAR, but the requester id on a ticket
 * is numeric. Anything non-numeric is passed through untouched rather than being
 * forced to NaN, and a missing id stays blank instead of becoming 0 - which would
 * silently point a ticket at employee zero.
 */
function numericId(value: string | number | null | undefined): number | string {
  if (value === undefined || value === null || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) && String(value).trim() !== '' ? n : String(value);
}

/**
 * Stamp a ticket with the local date and time MIS expects.
 *
 * Format is exactly `YYYY-MM-DD HH:MM:SS`, converted into config.timezone rather
 * than whatever the container's clock happens to be set to. Falls back to UTC if
 * the configured zone is invalid, so a typo in TIMEZONE cannot break ticket
 * filing - only the offset would be wrong.
 */
export function formatTicketTimestamp(when: Date = new Date()): string {
  try {
    // Assembled from parts rather than taken from the formatted string: locale
    // data varies between Node/ICU versions and renders "2026-10-03, 14:41:11"
    // with a separator, which is not the layout MIS uses. formatToParts makes the
    // output exact and independent of the host locale.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(when);

    const part = (type: string): string =>
      parts.find(p => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')} `
      + `${part('hour')}:${part('minute')}:${part('second')}`;
  } catch {
    // Invalid timezone: fall back to UTC so filing still works, just offset wrong.
    return when.toISOString().slice(0, 19).replace('T', ' ');
  }
}

/**
 * Build the webhook body.
 *
 * The blank defaults exist so every field is present even when a flow did not ask
 * for it; n8n's mapping is happier with explicit empties than with missing keys.
 *
 * `lookupIds` is resolved by the caller and merged in, because resolving it needs
 * MIS and this function is deliberately synchronous.
 */
export function buildTicketPayload(input: TicketPayloadInput): Record<string, unknown> {
  const { ticketType, department, userName, user, collectedFields, attachments = [], test } = input;

  const ticketData: Record<string, unknown> = {
    category: '', system: '', location: '', description: '', justification: '',
    impact: '', from_process: '', to_process: '', risk: '',
    request_category: '', inventory_items: '', request_quantity: '',
    // When the ticket was raised, as MIS wants it: 'YYYY-MM-DD HH:MM:SS' in the
    // configured timezone. Filled here rather than by the flow so a probe and a
    // real ticket are stamped identically.
    created_at: formatTicketTimestamp(),
    // Numeric MIS codes for category/system, resolved by the caller. Blank when
    // the flow has no such field, or when MIS could not be read.
    category_id: '', system_id: '',
    ...flattenFields(collectedFields),
    ...(input.lookupIds ?? {})
  };

  // The impact answers live in their own table, one boolean column per category,
  // so the ticked set is expanded into those column names here rather than left
  // as a list n8n would have to unpack.
  if (Array.isArray(collectedFields?.impact)) {
    const ticked = new Set((collectedFields.impact as unknown[]).map(String));
    for (const key of IMPACT_COLUMNS) ticketData[key] = ticked.has(key) ? 'Yes' : 'No';
    ticketData.measurable_impact_remarks = toScalar(collectedFields.measurable_impact);
    // The raw list is not a column MIS has; leaving it invites an insert into
    // the wrong thing.
    delete ticketData.impact;
  }

  if (Array.isArray(collectedFields?.items)) {
    const pairs = (collectedFields.items as unknown as Array<Record<string, unknown>>)
      .map(r => ({
        item: String(r?.item ?? '').trim(),
        quantity: Number(r?.quantity)
      }))
      .filter(r => r.item && Number.isFinite(r.quantity) && r.quantity >= 1);
    ticketData.inventory_items = pairs.map(r => r.item).join(', ');
    ticketData.request_quantity = pairs.map(r => Math.floor(r.quantity)).join(', ');
    delete ticketData.items;
  }

  // Comma-free twins of every value that can hold more than one choice. The
  // canonical field keeps the comma MIS actually stores; these are what a
  // positional n8n flow must bind, because n8n splits its replacement list on
  // commas and would otherwise shift every column that follows. See pipeTwin().
  for (const field of ['system_id', 'inventory_items', 'request_quantity', 'system'] as const) {
    ticketData[`${field}_pipe`] = pipeTwin(ticketData[field]);
  }

  if (test) ticketData._test = true;

  return {
    event: 'ticket_created',
    department,
    ticket_type: ticketType,
    target_list: ticketType === 'tech_support' ? 'mis_job_list_tech' : 'mis_job_list',
    user: {
      // MIS employee number (scrf_user.user_id), e.g. 266684. This is the
      // requester id a ticket is filed against - NOT the login string, and NOT
      // scrf_user.ID which is only the table's primary key.
      //
      // Sent as a number when it is numeric so it drops straight into a numeric
      // column. Blank when MIS could not be reached, which is better than
      // filing the ticket against the wrong person.
      user_id: numericId(user.mis_user_id),
      // The login id, kept alongside because it is the key the chatbot's own
      // quota, usage ledger and admin dashboard use.
      //
      // `user_name` IS the login on SessionUser - resolveSession sets it to the
      // login id, not to the display name (see session-auth.service). It used to
      // read `user.login`, which is optional and never populated on this path, so
      // it always went out empty and n8n wrote a blank scrf_name.
      login: user.user_name || user.login || '',
      // Full display name as MIS knows it, e.g. "Remiel Baking". This used to be
      // fed `user.user_name`, which on this path is the LOGIN, so it went out as
      // "remiel.baking" instead of the person's name.
      //
      // Rebuilt from first/last rather than read from `user_name`, because that
      // field means the login here.
      full_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || userName || '',
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      name: userName,
      email: user.email || '',
      department: user.department || '',
      role: user.role || 'user'
    },
    ticket_data: ticketData,
    attachment_count: attachments.length,
    // Accepts either key spelling so a caller still holding the older
    // name/stored_path shape produces the same wire format rather than blanks.
    attachments: attachments.map(
      (a): TicketAttachment => ({
        file_name: String(a.file_name ?? a.name ?? ''),
        staged_path: String(a.staged_path ?? a.stored_path ?? ''),
        file_type: String(a.file_type ?? a.type ?? ''),
        file_size: Number(a.file_size ?? a.size ?? 0)
      })
    )
  };
}

/**
 * Realistic sample values, one set per ticket type.
 *
 * Every field the matching flow actually collects is populated, so a probe
 * exercises the same columns a genuine ticket would. Values are prefixed SAMPLE
 * so a stray real insert is obvious in the database rather than looking like a
 * genuine request.
 */
export function sampleTicketFields(ticketType: TicketType | string): Record<string, string | number> {
  if (ticketType === 'tech_support') {
    return {
      department: 'Finance',
      location: 'CK1 MIS',
      category: 'Hardware',
      system: 'Printer',
      description: 'SAMPLE: finance printer shows a paper jam error',
      justification: 'SAMPLE: month-end printing is blocked'
    };
  }
  if (ticketType === 'it_asset') {
    return {
      department: 'QCQA',
      request_category: 'Borrow',
      item: 'AVR',
      item_onhand: 15,
      quantity: 2,
      description: 'SAMPLE: temporary AVR for the incoming inspection team',
      justification: 'SAMPLE: borrowed while the unit under test is recalibrated'
    };
  }
  return {
    department: 'Finance',
    category: 'Data Update',
    system: 'Oracle ERP',
    description: 'SAMPLE: add my account to the Oracle ERP procurement module',
    justification: 'SAMPLE: need to raise POs for the incoming inspectors',
    from_process: 'SAMPLE: POs are raised manually in Excel',
    to_process: 'SAMPLE: POs are raised directly in Oracle ERP',
    risk: 'SAMPLE: manual entry causes delays and stock shortages'
  };
}

/**
 * Build a payload with the category/system ids resolved from MIS.
 *
 * This is the entry point both a real submission and $test-webhook use, so the
 * ids are populated identically in each. A ticket filed without them would store
 * free text where the MIS tables expect a foreign key.
 */
export async function buildResolvedPayload(input: TicketPayloadInput): Promise<Record<string, unknown>> {
  const lookupIds = await resolveLookupIds(input.ticketType, input.collectedFields || {});
  return buildTicketPayload({ ...input, lookupIds });
}

