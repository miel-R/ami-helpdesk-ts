// What a ticket has to contain before it is worth sending to MIS.
//
// Two passes, and the order matters. The cheap structural pass runs first and
// needs no database at all; the catalogue pass then checks the answers against
// what MIS actually accepts.
//
// Nothing here is fuzzy. The dropdowns only ever offered what the server itself
// returned, so an answer that fails these checks is one the user could not have
// picked - a typed name, or a stale cached list - and is rejected rather than
// passed through.

import type { TicketType } from '../../models/types.model';
import * as catalog from '../catalog';
const REQUIRED_FIELDS: Record<TicketType, readonly string[]> = {
  tech_support: ['department', 'location', 'category', 'system', 'description', 'justification'],
  system_request: ['department', 'category', 'system', 'description', 'justification', 'from_process', 'to_process', 'risk'],
  it_asset: ['department', 'request_category', 'items', 'description', 'justification']
};

// Flattening of collected fields now lives in webhook.ts with the rest of the
// payload build, so there is nothing left to classify here.

/** One {item, quantity} pair, as the repeatable IT Asset rows submit them. */
interface ItemEntry {
  item: string;
  quantity: number;
}

function readItemEntries(raw: unknown): ItemEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ItemEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const item = String(rec.item ?? '').trim();
    const quantity = Number(rec.quantity);
    if (item && Number.isFinite(quantity) && quantity >= 1) out.push({ item, quantity: Math.floor(quantity) });
  }
  return out;
}

export function validateFields(ticketType: TicketType, fields: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const required = REQUIRED_FIELDS[ticketType] ?? [];
  for (const f of required) {
    const v = fields[f];
    if (Array.isArray(v)) {
      if (v.length === 0) errors.push(`Missing required field: ${f}`);
      continue;
    }
    if (v === undefined || v === null || String(v).trim() === '') {
      errors.push(`Missing required field: ${f}`);
    }
  }
  
  if (ticketType === 'it_asset') {
    const items = readItemEntries(fields.items);
    if (!items.length) {
      errors.push('At least one item with a quantity is required');
    } else if (items.length !== (Array.isArray(fields.items) ? fields.items.length : 0)) {
      // A row with a blank item or a bad quantity would otherwise be dropped
      // silently and MIS would never know the user asked for it.
      errors.push('Each item needs a name and a quantity of at least 1');
    }
  }
  return errors;
}

/**
 * Does a submitted value match a MIS option?
 *
 * Accepts either the id or the label. The form posts ids, because that is what
 * MIS stores, but the $test-webhook probe still sends labels and a label is
 * unambiguous too - so both shapes validate rather than one of them silently
 * failing with "Invalid system".
 */
function matchesOption(options: readonly { id: number; name: string }[], submitted: unknown): boolean {
  const v = String(submitted ?? '').trim();
  if (!v) return false;
  return options.some(o => String(o.id) === v || o.name === v);
}

/** Every option a flow accepts, empty when MIS is unreachable. */
interface FlowOptions {
  category: Array<{ id: number; name: string }>;
  system: Array<{ id: number; name: string }>;
}

async function catalogOptionsFor(ticketType: TicketType): Promise<FlowOptions> {
  if (ticketType === 'tech_support') {
    const [category, system] = await Promise.all([
      catalog.supportCategoryOptions(),
      catalog.supportSystemOptions()
    ]);
    return { category, system };
  }
  const [category, system] = await Promise.all([
    catalog.systemRequestCategoryOptions(),
    catalog.systemRequestSystemOptions()
  ]);
  return { category, system };
}

export async function validateCatalogFields(ticketType: TicketType, fields: Record<string, unknown>): Promise<string[]> {
  const errors: string[] = [];
  try {
    if (fields.department) {
      const depts = await catalog.departments();
      if (depts.length && !depts.includes(String(fields.department))) errors.push('Invalid department');
    }
    if (fields.location) {
      const locs = await catalog.locations();
      if (locs.length && !locs.includes(String(fields.location))) errors.push('Invalid location');
    }
    // Per-type catalogs. Both flows used to be checked against the System
    // Request list, so Tech Support rejected "Printer" - a perfectly valid
    // support_category row - purely because it is not a company system.
    const opts = await catalogOptionsFor(ticketType);
    if (fields.category) {
      // Checked against the category options, not the system ones. It was being
      // compared to opts.system with a name-only fallback, so a posted
      // category_id ("15") matched neither and every System Request was rejected
      // as "Invalid category" even with a perfectly valid choice.
      if (opts.category.length && !matchesOption(opts.category, fields.category)) {
        errors.push('Invalid category');
      }
    }
    if (fields.system) {
      const systems = Array.isArray(fields.system) ? fields.system : [fields.system];
      // Only worth checking when MIS actually returned something. An empty
      // catalog means MIS is unreachable, not that the user's answer is wrong -
      // and treating it as "invalid" made every submission fail during a MIS
      // outage, which is the opposite of degrading gracefully.
      if (opts.system.length) {
        for (const s of systems) {
          if (!matchesOption(opts.system, s)) { errors.push(`Invalid system: ${s}`); break; }
        }
      }
    }
    if (fields.item) {
      const items = await catalog.itAssetItems();
      const itemNames = items.map(i => i.value);
      if (itemNames.length && !itemNames.includes(String(fields.item))) errors.push('Invalid item');
    }
    if (fields.items) {
      const items = await catalog.itAssetItems();
      const itemNames = items.map(i => i.value);
      if (itemNames.length) {
        for (const entry of readItemEntries(fields.items)) {
          if (!itemNames.includes(entry.item)) { errors.push(`Invalid item: ${entry.item}`); break; }
        }
      }
    }
  } catch {
    // If MIS catalog unavailable, skip validation rather than block
  }
  return errors;
}

/** Who the caller is, as resolved from the session the server already holds. */