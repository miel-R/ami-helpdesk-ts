// Retrieval over real filed tickets, used as few-shot examples.
//
// This is deliberately NOT vector RAG. Everything here is keyword scoring over
// 150 real tickets that already exist, which means no embedding API, no vector
// store, no per-request cost and nothing new to run. For "find tickets that look
// like this one" over a corpus this small and this structured, token overlap is
// both adequate and instant.
//
// What it buys us:
//   - ticket-type routing reads real filed tickets instead of a hand-written
//     keyword list, so "my laptop screen is flickering" is judged the way MIS
//     actually filed similar tickets
//   - the AI is shown how a real ticket for this kind of problem was written,
//     which is what stops it inventing fields or control numbers
//
// It never throws. A missing or malformed corpus degrades to "no examples",
// never to a failed request.

import fs from 'fs';
import path from 'path';
import { config } from '../config/config.service';
import type { TicketType } from '../models/types.model';

/** One real ticket, flattened for scoring and for showing to the model. */
export interface RagExample {
  ticket_type: TicketType;
  /** Field text joined for keyword matching. */
  text: string;
  /** The raw record, for rendering a few-shot example. */
  fields: Record<string, string>;
  score: number;
}

/** Which corpus file holds which ticket type. */
const CORPUS: ReadonlyArray<{ type: TicketType; file: string }> = Object.freeze([
  { type: 'system_request', file: 'system_request_examples.json' },
  { type: 'tech_support', file: 'tech_support_examples.json' },
  { type: 'it_asset', file: 'it_asset_examples.json' }
]);

/**
 * Words that carry no signal for matching. Includes the site codes, which
 * appear in almost every location and would otherwise make every ticket look
 * like every other ticket in the same building.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of', 'in', 'on',
  'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its', 'this', 'that',
  'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he',
  'she', 'they', 'them', 'his', 'her', 'their', 'not', 'no', 'yes',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can',
  'could', 'should', 'there', 'here', 'please', 'need', 'want', 'like',
  'ck1', 'ck2', 'ck3', 'cp1', 'cp2', 'mis', 'ami', 'null', 'none', 'nan'
]);

/** Split text into meaningful lowercase tokens. */
function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

/** MIS category code -> the name MIS shows, for matching and for display. */
function configCategoryName(code: string): string {
  const map: Record<string, string> = {
    '15': 'Account', '16': 'Data Update', '17': 'New System',
    '18': 'System Update', '20': 'Accessories', '22': 'Software'
  };
  return map[code] ?? code;
}

/** MIS system code -> the system name. */
function configSystemName(code: string): string {
  const map: Record<string, string> = {
    '1': 'Oracle ERP', '2': 'PMR', '3': 'MES', '4': 'PSIS', '5': 'HRIS',
    '6': 'IQAR', '7': 'EDAS', '8': 'ONHB', '9': 'Traceability', '10': 'Logsheet',
    '11': 'Shared Folder', '12': 'VPN', '13': 'E-mail', '19': 'Captive Portal',
    '21': 'IT Asset', '23': 'Application', '24': 'MIS HELPDESK', '25': 'MIS Related'
  };
  return map[code] ?? code;
}

/** Collapse a raw record into scorable text plus clean display fields. */
function toExample(ticketType: TicketType, raw: unknown): RagExample | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    const s = typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim();
    if (s) fields[k] = s;
  }
  // The numeric codes MIS stores for category/system are not words and would
  // never match, so the human names are substituted for matching purposes only.
  if (fields.category && /^\d+$/.test(fields.category)) {
    fields.category = configCategoryName(fields.category);
  }
  if (fields.system && /^\d+$/.test(fields.system)) {
    fields.system = configSystemName(fields.system);
  }

  const text = Object.values(fields).join(' ');
  if (!tokenize(text).length) return null;
  return { ticket_type: ticketType, text, fields, score: 0 };
}

let cache: RagExample[] | null = null;
let cacheStamp = 0;

/** Newest mtime across the corpus, used to invalidate when files change. */
function corpusStamp(): number {
  let newest = 0;
  for (const c of CORPUS) {
    try {
      const f = path.join(config.paths.ragDir, c.file);
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
    } catch {
      // A missing file is not fatal; the others still load.
    }
  }
  return newest;
}

export function enabled(): boolean {
  return config.features.ragEnabled === true;
}

/** All examples, loaded once and reused until the corpus files change. */
export function all(): RagExample[] {
  if (!enabled()) return [];
  const stamp = corpusStamp();
  if (cache && stamp === cacheStamp) return cache;

  const out: RagExample[] = [];
  for (const c of CORPUS) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(config.paths.ragDir, c.file), 'utf8').replace(/^﻿/, '')
      ) as unknown[];
      if (!Array.isArray(raw)) continue;
      for (const row of raw) {
        const ex = toExample(c.type, row);
        if (ex) out.push(ex);
      }
    } catch (e) {
      console.warn(`[rag] could not load ${c.file}: ${(e as Error).message}`);
    }
  }
  cache = out;
  cacheStamp = stamp;
  return out;
}

/**
 * Score one example against the query tokens.
 *
 * Weighted so a rare, specific word ("barcode", "oracle") counts for more than a
 * common one, and the whole phrase is rewarded on top. That keeps "printer jam
 * in CK1" from outranking "barcode scanner will not scan" purely on length.
 */
function scoreExample(ex: RagExample, queryTokens: string[], rawQuery: string): number {
  if (!queryTokens.length) return 0;
  const exTokens = new Set(tokenize(ex.text));
  let score = 0;
  for (const t of queryTokens) {
    if (exTokens.has(t)) score += 1;
    // A token that is long is almost always the distinctive one.
    else if (t.length >= 5 && [...exTokens].some(e => e.startsWith(t) || t.startsWith(e))) score += 0.5;
  }
  if (score === 0) return 0;

  // Whole-phrase bonus, so an exact repeat ranks above a bag of loose words.
  const first = queryTokens[0] as string;
  const last = queryTokens[queryTokens.length - 1] as string;
  if (first && last && rawQuery.includes(`${first} ${last}`)) score += 2;

  return score;
}

/** Top matching examples across the whole corpus. */
export function search(query: string, limit = 3): RagExample[] {
  const q = String(query || '').toLowerCase().trim();
  const queryTokens = tokenize(q);
  if (!queryTokens.length) return [];

  return all()
    .map(ex => ({ ...ex, score: scoreExample(ex, queryTokens, q) }))
    .filter(ex => ex.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/** Top matching examples for one ticket type only. */
export function searchType(
  ticketType: TicketType | string | null | undefined,
  query: string,
  limit = 2
): RagExample[] {
  if (!ticketType) return [];
  return search(query, Math.max(6, limit)).filter(ex => ex.ticket_type === ticketType).slice(0, limit);
}

/**
 * Guess the ticket type from real filed tickets.
 *
 * Returns null when nothing scores, when the best match is weak, or when the
 * top two are too close to call. That matters: this is only a shortcut past the
 * "what type of ticket?" question, so a wrong confident answer is worse than
 * asking the user.
 *
 * Scored on each type's BEST hit, not the sum of all its hits. Summing let a
 * type win by sheer number of vaguely-related tickets - "hard drive failing"
 * matched a dozen weak system-request rows and came out ahead of the one that
 * actually matched. Strength of evidence, not volume of it.
 */
export function suggestTicketType(query: string): TicketType | null {
  const hits = search(query, 12);
  if (!hits.length) return null;

  const best = new Map<TicketType, number>();
  for (const h of hits) {
    const prev = best.get(h.ticket_type) ?? 0;
    if (h.score > prev) best.set(h.ticket_type, h.score);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];
  if (!top) return null;

  // A single token in common is not evidence. Require a real overlap.
  const MIN_BEST = 2.5;
  if (top[1] < MIN_BEST) return null;

  // And require it to be clearly better than the runner-up, so a genuine toss-up
  // ("printer is not printing" - could be a broken printer or a request for a
  // new one) is handed to the user instead of guessed.
  if (second && second[1] > 0 && top[1] - second[1] < 1) return null;

  return top[0];
}

/** Fields not shown to the model: internal codes it might echo back verbatim. */
const HIDDEN_FIELDS = new Set(['asset_tag']);

/** Render one example as a compact, model-readable ticket. */
function renderExample(ex: RagExample): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ex.fields)) {
    if (HIDDEN_FIELDS.has(k)) continue;
    const pretty = k.replace(/_/g, ' ');
    parts.push(`${pretty}: ${v}`);
  }
  return parts.join(' | ');
}

/**
 * A few-shot block for the system prompt.
 *
 * Empty when there is nothing relevant, so the prompt never carries filler.
 */
export function fewShotBlock(
  query: string,
  ticketType?: TicketType | string | null,
  limit = 2
): string {
  if (!enabled()) return '';
  const hits = ticketType ? searchType(ticketType, query, limit) : search(query, limit);
  if (!hits.length) return '';
  const lines = hits.map(h => `- [${h.ticket_type}] ${renderExample(h)}`);
  return 'SIMILAR REAL TICKETS ALREADY FILED (use only for wording and field '
    + 'conventions - never copy a control number and never claim one of these was '
    + `filed for this user):\n${lines.join('\n')}`;
}

/** Clear the cache, for tests. */
export function invalidate(): void {
  cache = null;
  cacheStamp = 0;
}
