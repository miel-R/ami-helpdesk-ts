// IT Asset items.
//
// From `scrf_it_asset_inventory`, shown as "NAME - ONHAND" exactly like the legacy
// <option>. The count is advisory: nothing stops a user asking for more than MIS
// has on hand - the request is for them to decide, and a hard cap would silently
// change what they asked for.

import { queryRows } from './catalog.client';
import type { ItAssetItem, Row } from './catalog.client';

export async function itAssetItems(): Promise<ItAssetItem[]> {
  return queryRows(
    'itAssetItems',
    'SELECT Item, Onhand FROM scrf_it_asset_inventory WHERE Item IS NOT NULL AND Item <> "" ORDER BY Item',
    [],
    (rows: Row[]): ItAssetItem[] => rows
      .map(r => {
        const onhand = Number(r.Onhand);
        return {
          value: String(r.Item ?? '').trim(),
          onhand: Number.isFinite(onhand) ? onhand : null
        };
      })
      .filter(r => r.value)
  );
}
