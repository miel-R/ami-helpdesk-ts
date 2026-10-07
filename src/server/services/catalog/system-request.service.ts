// System Request: the six categories and the nineteen systems.
//
// The systems are grouped, and the grouping is NOT the `group_category` column.
// That column files HRIS under MES and IT Asset under TECH; the legacy form treats
// ids 5, 21 and 23 as singletons that override their base group instead. Using the
// column directly would let someone tick IT Asset alongside Shared Folder, which
// the real form does not allow.

import { queryCached, queryOptionsCached, strings } from './catalog.client';
import type { CatalogOption, Row } from './catalog.client';
function scrfNames(categoryType: 'System' | 'Category'): Promise<string[]> {
  return queryCached(
    `scrf_${categoryType}`,
    'SELECT category_name FROM scrf_request_category WHERE category_type = ? ORDER BY sequence, category_name',
    [categoryType],
    rows => strings(rows, 'category_name')
  );
}

/** Systems a System Request can target (Oracle ERP, MES, HRIS, ...). */
export function systemRequestSystems(): Promise<string[]> {
  return scrfNames('System');
}

/** Request categories (Account, Data Update, New System, ...). */
export function systemRequestCategories(): Promise<string[]> {
  return scrfNames('Category');
}

/**
 * The legacy form's System Request groups.
 *
 * scrf.form.php hardcodes six of them in JS, and they are NOT the group_category
 * column: the column says HRIS belongs to MES and IT Asset belongs to TECH, but
 * the form pulls id5, id21 and id23 out as singletons so a requester can pick
 * "HRIS" without also dragging in every other MES system.
 *
 * Only ever applied as an override. Anything MIS adds later still gets its real
 * group_category, which is the right answer for something the legacy form has
 * never heard of.
 */
const SR_SINGLETON_GROUP_IDS: ReadonlySet<number> = new Set([5, 21, 23]);


/**
 * Systems a System Request can target, with the category_id MIS stores.
 *
 * The legacy checkbox carries category_id as its value (scrf.form.php:409) and
 * scrf_master.scrf_sys_name holds those ids comma-joined - "1" on 2915 existing
 * rows, "2,3,7,14" and so on. Sending the name instead would put free text in a
 * column MIS reads back as a foreign key, and dbGetPrefix()'s
 * `WHERE category_id IN (...)` would match nothing.
 */
export function systemRequestSystemOptions(): Promise<CatalogOption[]> {
  return queryOptionsCached(
    'srSystemOptions',
    'SELECT category_id, category_name, group_category FROM scrf_request_category WHERE category_type = ? ORDER BY sequence, category_name',
    ['System'],
    rows => (rows as Row[])
      .map(r => {
        const id = Number(r.category_id);
        const name = String(r.category_name ?? '').trim();
        if (!name || !Number.isFinite(id)) return null;
        const columnGroup = String(r.group_category ?? '').trim();
        const group = SR_SINGLETON_GROUP_IDS.has(id)
          ? name
          : (columnGroup || name);
        return { id, name, group } satisfies CatalogOption;
      })
      .filter((o): o is CatalogOption => o !== null)
  );
}

/** System Request categories with their category_id (Account 15, Data Update 16). */
export function systemRequestCategoryOptions(): Promise<CatalogOption[]> {
  return queryOptionsCached(
    'srCategoryOptions',
    'SELECT category_id, category_name, group_category FROM scrf_request_category WHERE category_type = ? ORDER BY sequence, category_name',
    ['Category'],
    rows => (rows as Row[])
      .map(r => {
        const id = Number(r.category_id);
        const name = String(r.category_name ?? '').trim();
        if (!name || !Number.isFinite(id)) return null;
        return { id, name, group: '' } satisfies CatalogOption;
      })
      .filter((o): o is CatalogOption => o !== null)
  );
}

/**
 * System types a Tech Support ticket can be about, with support_category.ID.
 *
 * This is a completely different table from the System Request list. The widget
 * used to read /api/catalog/systems here, which offered Oracle ERP, PMR, MES and
 * HRIS - MIS's company systems, not the things that break. The legacy form uses
 * `SELECT * FROM support_category` (dbGetSupportSupportCategory), whose
 * system_type column is Computer, Printer, Laptop, VPN and so on.
 *
 * Unfiltered, exactly like the legacy query: the four rows carrying
 * request_category 1-4 also appear here, because that is what MIS renders.
 */
export function systemRequestGroups(): Promise<string[]> {
  return queryCached(
    'scrfGroups',
    'SELECT DISTINCT group_category FROM scrf_request_category WHERE group_category IS NOT NULL AND group_category <> "" ORDER BY group_category',
    [],
    rows => strings(rows, 'group_category')
  );
}

/**
 * MIS labels its four support categories by a numeric code, not a name:
 * support_category.request_category is a small integer and support_master
 * stores that code. MIS also uses 0 as an unnamed default bucket; it is NOT one
 * of the four real categories, so it is mapped to null and filtered out rather
 * than being offered to the user as a fifth choice.
 */