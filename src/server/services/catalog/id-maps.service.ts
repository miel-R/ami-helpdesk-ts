// Name -> numeric id maps, for the fields MIS stores as codes.
//
// These are what let the form post ids instead of labels. MIS keeps several
// foreign-key columns, and free text in one of them reads back as a key that
// matches nothing - so the control-number prefix ends up silently wrong.

import { queryIdMap } from './catalog.client';

// The original name, kept so the extracted bodies below read as they did.
const idMapWithParam = queryIdMap;

// Hardcoded labels the Tech Support category list uses for display only.
const SUPPORT_TYPE_LABELS: Readonly<Record<string, string | null>> = Object.freeze({
  Computer: 'Computer', Printer: 'Printer', Laptop: 'Laptop', VPN: 'VPN'
});
export function systemRequestCategoryIdMap(): Promise<Record<string, number>> {
  return idMapWithParam(
    'srCategoryIds',
    'SELECT category_name, category_id FROM scrf_request_category WHERE category_type = ?',
    ['Category'],
    'category_name', 'category_id'
  );
}

/** System Request system name -> category_id (Oracle ERP 1, PMR 2, MES 3, ...). */
export function systemRequestSystemIdMap(): Promise<Record<string, number>> {
  return idMapWithParam(
    'srSystemIds',
    'SELECT category_name, category_id FROM scrf_request_category WHERE category_type = ?',
    ['System'],
    'category_name', 'category_id'
  );
}

/** Tech Support system type name -> support_category.ID (Printer 2, Laptop 3, ...). */
export function supportSystemTypeIdMap(): Promise<Record<string, number>> {
  return idMapWithParam(
    'supportSystemTypeIds',
    'SELECT system_type, ID FROM support_category',
    [],
    'system_type', 'ID'
  );
}

/**
 * Tech Support category name -> request_category code.
 *
 * support_category stores the code (1-4) against every row while the NAME lives
 * only in the label table, so this is derived rather than queried - keeping one
 * source of truth for what MIS calls these four categories.
 */
export function supportCategoryIdMap(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, label] of Object.entries(SUPPORT_TYPE_LABELS)) {
    if (label) out[label] = Number(code);
  }
  return out;
}

/** The MIS identity behind a login id, as scrf_user stores it. */