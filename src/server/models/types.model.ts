/**
 * Shared domain types.
 *
 * These exist because the same shapes travel through almost every module: a
 * conversation crosses the conversation store, the database layer, the intake
 * state machine, the admin dashboard and the AI prompt. Typing them once means a
 * rename or a missing field is a compile error instead of an undefined at
 * runtime three layers later.
 */

/** The two roles the chatbot understands. */
export type Role = 'admin' | 'user';

/** Where a resolved role came from, surfaced in $whoami and /api/session. */
export type RoleSource = 'mis' | 'mis-directory' | 'database' | 'allowlist';

/** MIS uses capitalised names; only these three exist. */
export type MisRole = 'Admin' | 'Approver' | 'User';

export type TicketType = 'tech_support' | 'system_request' | 'it_asset';

/** A person, as known by the server. Never trust this from the request body. */
export interface SessionUser {
  user_name: string;
  email: string;
  department: string;
  /** Resolved server-side. Anything authorisation uses must read this. */
  role: Role;
  first_name: string;
  /** Family name, from MIS. Only present once the identity has been resolved. */
  last_name?: string;
  /** Where `role` was resolved from, for support/debugging. */
  role_source?: RoleSource;
  login?: string;
  /**
   * MIS employee number, from scrf_user.user_id (e.g. "266684").
   *
   * Distinct from `login`: scrf_user carries two ids and only this one is the
   * employee number MIS files a ticket against. `ID` in the same table is just
   * the row primary key and must not be used.
   */
  mis_user_id?: string;
}

/** One turn in a conversation. */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * Optional on purpose. Messages restored from storage come back as bare
   * { role, content } pairs with no timestamp, and requiring it here would either
   * force a fake value or lie about what storage actually holds.
   */
  timestamp?: string;
  [extra: string]: unknown;
}

/** A conversation as held in memory by the conversation store. */
export interface Conversation {
  session_id: string;
  user: SessionUser;
  messages: Message[];
  mode: 'chat' | 'escalated';
  status: 'active' | 'ended' | 'escalated';
  last_control_number?: string | null;
  pending_goodbye?: string | null;
  greeted?: boolean;
  nudge_sent?: boolean;
  /**
   * True while the ticket form is open for this session.
   *
   * Runtime-only, and deliberately NEVER persisted: it describes what the user
   * is doing right now, not part of the conversation. saveConversation strips it
   * out of the state blob.
   *
   * That exclusion is load-bearing. It used to ride along in the persisted state,
   * so a clean redeploy (the SIGTERM flush saves every conversation) wrote
   * `form_active: true` to disk and restore() read it back. The idle sweep skips
   * flagged sessions, so the session could then never expire again - it stayed
   * `active`, held its whole transcript in memory, and showed as permanently
   * active on /api/health and the dashboard.
   *
   * It is also why a catalog request has to move `last_seen` forward: the flag
   * cannot be relied on to save the clock across a restart.
   */
  form_active?: boolean;
  /**
   * Set when a real request (not a peek) used this conversation. Runtime-only.
   *
   * Lets restore() tell "this was merely opened" from "this is being used", so it
   * does not rewind a live `last_seen` back to the pre-restart value and let the
   * sweep expire a session someone is actively in.
   */
  touched?: boolean;
  uploads?: unknown[];
  attachments?: unknown[];
  created_at?: string;
  updated_at?: string;
  restored?: boolean;
  [extra: string]: unknown;
}

/** The question the intake state machine is currently waiting on. */
export interface PendingQuestion {
  id: string;
  type?: 'text' | 'select' | 'search' | 'number';
  question: string;
  label?: string;
  options?: string[];
  /** True when the user should type rather than tap, e.g. 363 locations. */
  searchable?: boolean;
  /**
   * True when the user may tap more than one option before moving on.
   *
   * MIS genuinely stores several system types on one ticket, comma separated
   * (`support_master.support_category` = "14,15"), so the single-value
   * `collected_fields` slot has to be widened to hold a list.
   */
  multi?: boolean;
  /** IT asset stock, keyed by item name. */
  onhand?: Record<string, number> | null;
}

/** A flow question as declared in flows/ticket_types/*.json. */
export interface FlowQuestion {
  id: string;
  label?: string;
  question: string;
  type?: 'text' | 'select' | 'search' | 'number';
  /** A `db:` key resolved through the MIS catalogue. */
  source?: string;
  /** True when the user may tap more than one, e.g. System Type (MIS stores "14,15"). */
  multi?: boolean;
  /** "search" means match typed text against the list instead of tapping. */
  match?: 'search' | 'list';
  options?: string[];
  required?: boolean;
  min?: number;
  with_onhand?: boolean;
  check_onhand?: boolean;
}

/** A parsed identity assertion from MIS. */
export interface IdentityClaims {
  login: string;
  name: string;
  dept: string;
  role: Role;
  exp: number;
}

/** Outcome of resolving who someone is and what they may do. */
export interface ResolvedIdentity {
  role: Role;
  source: RoleSource;
  isAdmin: boolean;
  mis: IdentityClaims | null;
  loginMatched: boolean;
}

/** A live option list read from MIS. */
export interface ResolvedOptions {
  options: string[];
  onhandByValue: Record<string, number>;
  large: boolean;
  isItemList?: boolean;
}

/** Result of matching typed text against an option list. */
export interface OptionMatch {
  value: string | null;
  ambiguous: boolean;
  candidates: string[];
}

/** Result of validating a quantity against stock. */
export interface QuantityCheck {
  ok: boolean;
  value: number | null;
  warning: string | null;
  error: string | null;
}

/** What /api/session returns on page load. */
export interface SessionBootstrap {
  session_id: string;
  user: SessionUser;
  allowed: boolean;
  access_reason: string | null;
  access_code: string | null;
  remaining: number | null;
  limit: number | null;
  disabled: boolean;
  role_synced: boolean;
  messages: Message[];
}