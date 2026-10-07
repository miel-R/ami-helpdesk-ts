// Tech Support: the category list and the system list.
//
// IMPORTANT: these come from `support_category` and NOT from the System Request
// table. They look interchangeable and are not - a Tech Support "Printer" is a
// request_category code, not a company system - and using the wrong list is why
// Tech Support used to reject valid choices outright.

import { queryCached, queryOptionsCached, strings } from './catalog.client';
import type { CatalogOption, Row } from './catalog.client';
/** The support categories MIS accepts (Computer, Printer, Laptop, ...). */
export function supportCategories(): Promise<string[]> {
  return queryCached(
    'supportCategories',
    'SELECT DISTINCT system_type FROM support_category WHERE system_type IS NOT NULL AND system_type <> "" ORDER BY system_type',
    [],
    rows => strings(rows, 'system_type')
  );
}
export function supportSystemOptions(): Promise<CatalogOption[]> {
  return queryOptionsCached(
    'supportSystemOptions',
    'SELECT ID, system_type FROM support_category ORDER BY system_type ASC',
    [],
    rows => (rows as Row[])
      .map(r => {
        const id = Number(r.ID);
        const name = String(r.system_type ?? '').trim();
        if (!name || !Number.isFinite(id)) return null;
        return { id, name, group: '' } satisfies CatalogOption;
      })
      .filter((o): o is CatalogOption => o !== null)
  );
}

/**
 * The four Tech Support categories, as {code, label}.
 *
 * A quirk worth restating, because it looks like a bug and is not:
 * dbGetSupportRequestCategory() selects `WHERE request_category != 0` and then
 * renders value=request_category but label=system_type. So the submitted value
 * is the numeric code 1-4 while the text the user reads comes from a different
 * column. support_master.category holds that code, not the label.
 */
export function supportCategoryOptions(): Promise<CatalogOption[]> {
  return queryOptionsCached(
    'supportCategoryOptions',
    'SELECT request_category, system_type FROM support_category WHERE request_category != 0 ORDER BY request_category ASC',
    [],
    rows => (rows as Row[])
      .map(r => {
        const id = Number(r.request_category);
        const name = String(r.system_type ?? '').trim();
        if (!name || !Number.isFinite(id)) return null;
        return { id, name, group: '' } satisfies CatalogOption;
      })
      .filter((o): o is CatalogOption => o !== null)
  );
}

/** ERP / MES / TECH grouping MIS uses to route a System Request. */
const SUPPORT_TYPE_LABELS: Readonly<Record<string, string | null>> = Object.freeze({
  '0': null,
  '1': 'Hardware',
  '2': 'Software',
  '3': 'Account',
  '4': 'Network'
});

/**
 * The four support category types, derived from the codes MIS actually uses.
 *
 * Pinned to exactly Hardware / Software / Account / Network. Anything else the
 * query happens to return is dropped: the MIS form offers four categories and a
 * fifth invented option would let a user file a ticket MIS cannot categorise.
 */
export function supportCategoryTypes(): Promise<string[]> {
  return queryCached(
    'supportCategoryTypes',
    'SELECT DISTINCT request_category FROM support_category WHERE request_category IS NOT NULL ORDER BY request_category',
    [],
    rows =>
      rows
        .map(r => SUPPORT_TYPE_LABELS[String(r.request_category ?? '').trim()] ?? null)
        .filter((v): v is string => typeof v === 'string')
  );
}

/**
 * IT asset items with current stock.
 *
 * The onhand figure matters: a request for 20 AVR when only 15 are in stock is a
 * conversation MIS would have anyway, so the chatbot can raise it up front
 * instead of letting the request die at approval.
 *
 * Cached in its own typed entry rather than reusing queryCached, because this is
 * the one list that returns objects, and a cache hit must still carry the stock
 * figures or the quantity check silently stops working.
 */