// The authoritative MIS identity for a login id.
//
// Everything here comes from MIS, not from the browser: the login id, the display
// name, the email and the role are all things a request body could otherwise
// forge or simply get stale. The employee number in particular has no other
// source - the chatbot only ever sees the login string.
//
// Null when MIS has no such user, or cannot be reached. Callers must keep their
// previous values in that case rather than blanking them.
//
// Note scrf_user carries two ids: `ID` is the table's own primary key and is NOT
// the employee number. `user_id` is the employee number MIS files tickets
// against, and it is what belongs in a ticket's requester id.

import { queryRows } from './catalog.client';
import type { Row } from './catalog.client';

const idMapRows = identityRows;
/** The MIS identity behind a login id, as scrf_user stores it. */
export interface MisUser {
  /** MIS employee number, e.g. "266684". This is the requester id tickets need. */
  userId: string;
  login: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  role: string;
  /** Set when MIS has disabled the account; the person cannot sign in. */
  disabled: boolean;
}

export interface UserProfileInput {
  user_id?: string;
  user_name?: string;
  first_name?: string;
  last_name?: string;
  user_email?: string;
  user_role?: string;
  disable_date?: string | null;
}
export function misUser(login: string): Promise<MisUser | null> {
  const key = String(login || '').trim();
  if (!key) return Promise.resolve(null);
  return idMapRows(
    'misUser:' + key,
    'SELECT user_id, user_name, first_name, last_name, user_email, user_role, disable_date FROM scrf_user WHERE user_name = ? LIMIT 1',
    [key]
  ).then(rows => {
    const r = rows[0];
    if (!r) return null;
    const first = String(r.first_name ?? '').trim();
    const last = String(r.last_name ?? '').trim();
    return {
      userId: String(r.user_id ?? '').trim(),
      login: String(r.user_name ?? '').trim(),
      firstName: first,
      lastName: last,
      fullName: [first, last].filter(Boolean).join(' '),
      email: String(r.user_email ?? '').trim(),
      role: String(r.user_role ?? '').trim(),
      disabled: !!r.disable_date
    };
  });
}

/**
 * The identity row, kept whole rather than through the string mapper: a user has seven
 * fields and every one of them is used, so squeezing them through queryCached's
 * single-string shape would lose some of them.
 */
async function identityRows(key: string, sql: string, params: unknown[]): Promise<Row[]> {
  return queryRows(key, sql, params, rows => rows);
}