// Per-user + per-session rollups joining the users table with the ledger.
import { db } from '../db/storage.service';
import { config } from '../config/config.service';
import { getCostRatesWithSource, rateCost } from '../config/cost-rates.service';
import type {
  AnalyticsSessions, AnalyticsUsers, SessionFile
} from '../models/analytics.model';
import { avg, num, roundCost } from './analytics-helpers';

export interface UserSearchResult {
  username: string;
  display_name: string;
  department: string;
  role: string;
  enabled: boolean;
}

export async function searchUsers(term: string, limit = 10): Promise<UserSearchResult[]> {
  const users = await db().listUsers();
  return users
    .filter(u => u.username.toLowerCase().includes(term.toLowerCase()))
    .slice(0, limit)
    .map(u => ({
      username: u.username,
      display_name: u.display_name || u.username,
      department: u.department || '',
      role: u.role || 'user',
      enabled: u.enabled !== false,
    }));
}

export async function buildUsers(days: number): Promise<AnalyticsUsers> {
  const users = await db().listUsers();
  const summary = await db().summary({ days });
  const byUser = new Map(summary.byUser.map(u => [String(u.k), u]));
  const day = new Date().toISOString().slice(0, 10);
  const ledger = await db().listMessages({ limit: 1000 });
  const latByUser = new Map<string, number[]>();
  const sessByUser = new Map<string, Set<string>>();
  const lastByUser = new Map<string, string>();
  for (const m of ledger) {
    const u = String(m.username || 'unknown');
    if (m.duration_ms) {
      if (!latByUser.has(u)) latByUser.set(u, []);
      latByUser.get(u)!.push(num(m.duration_ms));
    }
    if (m.session_id) {
      if (!sessByUser.has(u)) sessByUser.set(u, new Set());
      sessByUser.get(u)!.add(String(m.session_id));
    }
    const ts = tsOf(m.created_at);
    if (ts && (!lastByUser.has(u) || ts > lastByUser.get(u)!)) lastByUser.set(u, ts);
  }
  const rows: AnalyticsUsers['users'] = [];
  for (const u of users) {
    const b = byUser.get(u.username);
    const requestsToday = await db().getRequestUsage(u.username, day);
    const limit = u.role === 'admin' ? null : (u.requests_per_day ?? config.rateLimit.requestsPerDay);
    rows.push({
      username: u.username,
      display_name: u.display_name || u.username,
      department: u.department || '',
      role: u.role || 'user',
      enabled: u.enabled !== false,
      calls: num(b?.calls),
      input_tokens: num(b?.input),
      output_tokens: num(b?.output),
      total_tokens: num(b?.input) + num(b?.output),
      cost_usd: roundCost(b?.cost),
      sessions: sessByUser.get(u.username)?.size ?? 0,
      requests_today: requestsToday,
      requests_limit: limit,
      requests_remaining: limit === null ? null : Math.max(0, limit - requestsToday),
      avg_latency_ms: avg(latByUser.get(u.username) ?? []),
      last_seen: u.last_seen || null,
      last_active: lastByUser.get(u.username) ?? null,
    });
  }
  for (const [name, b] of byUser) {
    if (rows.some(r => r.username === name)) continue;
    rows.push({
      username: name,
      display_name: name,
      department: '',
      role: 'user',
      enabled: true,
      calls: num(b.calls),
      input_tokens: num(b.input),
      output_tokens: num(b.output),
      total_tokens: num(b.input) + num(b.output),
      cost_usd: roundCost(b.cost),
      sessions: sessByUser.get(name)?.size ?? 0,
      requests_today: 0,
      requests_limit: config.rateLimit.requestsPerDay,
      requests_remaining: config.rateLimit.requestsPerDay,
      avg_latency_ms: avg(latByUser.get(name) ?? []),
      last_seen: null,
      last_active: lastByUser.get(name) ?? null,
    });
  }
  rows.sort((a, b) => b.cost_usd - a.cost_usd);
  return { timestamp: new Date().toISOString(), days, count: rows.length, users: rows };
}
/**
 * One chat "session" as the UI defines it: everything from the conversation
 * start (or from just after the previous end marker) up to and including the next
 * `[ended session]` marker. A trailing run with no marker is still open.
 */
interface SessionSegment {
  /** 1-based position within the PARENT conversation, not across all of them. */
  no: number;
  start: string | null;
  end: string | null;
  closed: boolean;
  userMessages: number;
  assistantMessages: number;
/** Files the assistant was handed, keyed by stored_name, plus how we know. */
  files: Map<string, SessionFile>;
  /**
   * True when every file was recorded from an assistant message's meta (the
   * precise source). False when at least one had to be inferred from the
   * conversation's upload timestamps, which is weaker but better than reporting
   * zero for a session a file demonstrably belongs to.
   */
  filesExact: boolean;
}

/** The end-of-session row as it is stored. */
const END_MARKER = '[ended session]';

/**
 * A row's timestamp as a comparable ISO string.
 *
 * This exists because `created_at` arrives as a JavaScript Date, not a string.
 * `String(date)` yields "Thu Oct 08 2026 08:27:45 GMT+0800 (Philippine Standard
 * Time)", and sorting those lexicographically compares WEEKDAY NAMES - every
 * Thursday row sorted ahead of every Wednesday row regardless of date, so the
 * session labelled #1 was routinely the newest one. Normalising to ISO makes the
 * ordering match the chronology, and unparseable values sort as empty rather
 * than poisoning the comparison.
 */
function tsOf(v: unknown): string {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : '';
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  const s = String(v ?? '').trim();
  if (!s) return '';
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

function isEndMarker(m: Record<string, unknown>): boolean {
  return String(m.role || '') === 'system' && String(m.content || '').includes(END_MARKER);
}

/** Loads a full transcript for one conversation via the keyset pager. */
async function loadTranscript(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let before: string | number | null = null;
  // 40 pages of 100 is 4000 messages, far past the retention window.
  for (let page = 0; page < 40; page++) {
    const res = await db().pageMessages(sessionId, { limit: 100, before });
    const msgs = res.messages || [];
    out.push(...msgs);
    if (!res.has_more || !res.next_before || msgs.length === 0) break;
    before = res.next_before;
  }
  // The pager walks backwards, so the collected rows arrive newest-first and have
  // to be put back in order before anything can be segmented.
  out.sort((a, b) => {
    const ta = tsOf(a.created_at);
    const tb = tsOf(b.created_at);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return num(a.id) - num(b.id);
  });
  return out;
}

/** Reads the per-file record the chat pipeline leaves on an assistant message. */
function filesFromMeta(meta: unknown): SessionFile[] {
  if (!meta || typeof meta !== 'object') return [];
  const files = (meta as Record<string, unknown>).files;
  if (!Array.isArray(files)) return [];
  const out: SessionFile[] = [];
  for (const raw of files) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const stored = String(f.stored_name ?? '').trim();
    // Keyed on stored_name because that is the identity a file keeps across the
    // conversation; two uploads of "images.jpg" are different files.
    if (!stored) continue;
    out.push({
      name: String(f.name ?? stored),
      stored_name: stored,
      type: String(f.type ?? ''),
      size: num(f.size),
      uploaded_at: null
    });
  }
  return out;
}

/**
 * Files uploaded into this conversation, read from `conversations.uploads`.
 *
 * This is the FALLBACK source, not the primary one. The array accumulates every
 * upload for the life of the conversation (capped at twenty), so counting it
 * directly would report a screenshot from session #1 as "read" in session #5.
 * It is only safe once each upload is placed by its own `uploaded_at` against the
 * session windows - see attachUploadsToSessions.
 */
function uploadsFromConversation(conv: Record<string, unknown>): SessionFile[] {
  const raw = conv.uploads;
  if (!Array.isArray(raw)) return [];
  const out: SessionFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const u = item as Record<string, unknown>;
    const stored = String(u.stored_name ?? '').trim();
    if (!stored) continue;
    out.push({
      name: String(u.name ?? stored),
      stored_name: stored,
      type: String(u.type ?? ''),
      size: num(u.size),
      uploaded_at: String(u.uploaded_at ?? '') || null
    });
  }
  return out;
}

/**
 * Places each upload into the session whose window contains its timestamp.
 *
 * This is how files that predate the per-message tracking still get counted.
 * An upload cannot be placed after a session ended, because the upload happened
 * inside that window by definition, and the pipeline analyses images before the
 * model is called - so a file uploaded during a session was available to the
 * assistant during it. Marking the segment inexact is what keeps this honest:
 * the number is inferred from timing, not recorded from what the model read.
 */
function attachUploadsToSessions(segments: SessionSegment[], uploads: SessionFile[]): void {
  if (!uploads.length || !segments.length) return;
  for (const f of uploads) {
    if (!f.uploaded_at) continue;
    for (const seg of segments) {
      if (!seg.start) continue;
      const afterStart = f.uploaded_at >= seg.start;
      // An open session has no end yet, so anything after its start belongs to it.
      const beforeEnd = seg.closed ? (!!seg.end && f.uploaded_at <= seg.end) : true;
      if (afterStart && beforeEnd) {
        if (!seg.files.has(f.stored_name)) {
          seg.files.set(f.stored_name, f);
          seg.filesExact = false;
        }
        break;
      }
    }
  }
}

/**
 * Splits one conversation transcript into sessions on the end markers.
 *
 * User and assistant messages are counted separately rather than as one total,
 * because "Msgs In" and "Msgs Out" are the numbers that explain the token
 * counts: output tokens track assistant replies, input tokens track prompts.
 * Collapsing them into a single number loses that link.
 */
function segmentTranscript(msgs: Array<Record<string, unknown>>): SessionSegment[] {
  const segments: SessionSegment[] = [];
  let current: SessionSegment | null = null;

const open = (): SessionSegment => ({
    no: segments.length + 1,
    start: null,
    end: null,
    closed: false,
    userMessages: 0,
    assistantMessages: 0,
    files: new Map<string, SessionFile>(),
    filesExact: true
  });

  for (const m of msgs) {
    if (!current) current = open();
    const ts = tsOf(m.created_at) || null;
    if (!current.start && ts) current.start = ts;

    if (isEndMarker(m)) {
      current.end = ts;
      current.closed = true;
      segments.push(current);
      current = null;
      continue;
    }

    const role = String(m.role || '');
    if (role === 'user') current.userMessages++;
    else if (role === 'assistant') current.assistantMessages++;
    if (ts) current.end = ts;

    // Only assistant messages carry the file record: it is written when the
    // model has consumed the file, so a user message that merely mentions one
    // cannot make it look as though the assistant read it.
    if (role === 'assistant') {
      for (const f of filesFromMeta(m.meta)) {
        if (!current.files.has(f.stored_name)) current.files.set(f.stored_name, f);
      }
    }
  }
  if (current && (current.userMessages > 0 || current.assistantMessages > 0)) {
    segments.push(current);
  }
  return segments;
}

/**
 * Attribute each usage row to the session whose window contains it.
 *
 * The usage ledger is keyed by CONVERSATION, not by session, so one conversation
 * with six sessions is six rows in `usage_messages` and one row in `messages`.
 * Splitting them apart is what this does: a usage row is charged to the last
 * session that had already started when the call was made, which is the only
 * mapping the two timestamps support.
 */
function assignUsage(segments: SessionSegment[], usage: Array<{ created_at: string }>): Map<number, number[]> {
  const bySegment = new Map<number, number[]>();
const started = segments
    .map((_, i) => i)
    .filter(i => !!segments[i].start);

  usage.forEach((u, ui) => {
    const ts = tsOf(u.created_at);
    if (!ts || !started.length) return;
    let target = started[0];
    for (const i of started) {
      if (segments[i].start! <= ts) target = i;
      else break;
    }
    if (!bySegment.has(target)) bySegment.set(target, []);
    bySegment.get(target)!.push(ui);
  });
  return bySegment;
}

export async function buildSessions(limit: number | 'all' = 100, username?: string | null): Promise<AnalyticsSessions> {
  const convs = await db().listConversations({ limit: 500 });

  const usageAll = await db().listMessages({ limit: 20000 });
  const usageByConv = new Map<string, number[]>();
  const loginByConv = new Map<string, string>();
  usageAll.forEach((u, i) => {
    const sid = String(u.session_id || '');
    if (!sid) return;
    if (!usageByConv.has(sid)) usageByConv.set(sid, []);
    usageByConv.get(sid)!.push(i);
    const login = String(u.username || '').trim();
    if (login && !loginByConv.has(sid)) loginByConv.set(sid, login);
  });

  // Rates are read ONCE per request, not per session, so every row on the page is
  // priced identically. Reading them per row would let a rate edited mid-render
  // produce a table where the top rows and the total disagree.
  const rates = getCostRatesWithSource();

  const rows: AnalyticsSessions['sessions'] = [];

  for (const conv of convs) {
    const convId = String(conv.session_id || '');
    if (!convId) continue;
    // conversations.username holds the DISPLAY name ("rems baks"), so the login id
    // has to come from the usage ledger.
    const convUser = loginByConv.get(convId) || String(conv.username || '') || 'unknown';
    if (username && convUser !== username) continue;

const transcript = await loadTranscript(convId);
    const segments = segmentTranscript(transcript);
    if (!segments.length) continue;

    // Files recorded on assistant messages are exact; anything the transcript
    // did not record is placed by upload timestamp so an older session is not
    // reported as having read nothing.
    attachUploadsToSessions(segments, uploadsFromConversation(conv));

    const usageIdx = usageByConv.get(convId) || [];
    const usageForConv = usageIdx.map(i => usageAll[i]);
    const assigned = assignUsage(segments, usageForConv);

    segments.forEach((seg, si) => {
      let input = 0, output = 0, ledgerCost = 0;
      const lat: number[] = [];
      const idxs = assigned.get(si) || [];
      for (const ui of idxs) {
        const u = usageForConv[ui];
        input += num(u.input_tokens);
        output += num(u.output_tokens);
        ledgerCost += num(u.cost_usd);
        if (u.duration_ms) lat.push(num(u.duration_ms));
      }

      const inputCost = rateCost(input, rates.input_per_million);
      const outputCost = rateCost(output, rates.output_per_million);

      rows.push({
        session_id: `${convId}${seg.no}`,
        user: convUser,
        mode: String(conv.mode || 'chat'),
        status: seg.closed ? 'ended' : 'active',
        session_no: seg.no,
        messages: seg.userMessages + seg.assistantMessages,
        user_messages: seg.userMessages,
        assistant_messages: seg.assistantMessages,
        ai_calls: idxs.length,
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        input_cost_usd: inputCost,
        output_cost_usd: outputCost,
        cost_usd: roundCost(inputCost + outputCost),
        ledger_cost_usd: roundCost(ledgerCost),
files: [...seg.files.values()],
        files_count: seg.files.size,
        files_exact: seg.filesExact,
        avg_latency_ms: avg(lat),
        created_at: seg.start,
        last_activity: seg.end
      });
    });
  }

  // Oldest first, so a conversation reads 1,2,3... in the order it happened and the
  // first session is genuinely the first one. Ties break on the id, which encodes
  // the same order, because several sessions can share a millisecond.
rows.sort((a, b) => {
    const ta = tsOf(a.created_at);
    const tb = tsOf(b.created_at);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.session_id < b.session_id ? -1 : 1;
  });

  const capped = limit === 'all' ? rows : rows.slice(0, limit);
  return {
    timestamp: new Date().toISOString(),
    count: capped.length,
    sessions: capped,
    rates: {
      input_per_million: rates.input_per_million,
      output_per_million: rates.output_per_million,
      source: rates.source
    }
  };
}
