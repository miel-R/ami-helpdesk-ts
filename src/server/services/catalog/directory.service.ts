// Department and location - the two lists every flow starts from.
//
// Locations come from it_asset.locations (active = 'Y') because that is the
// curated list MIS maintains. They used to be mined out of support_master.location,
// which produced 365 free-text values including "(ifv mold) at dtfs area" and
// "(BM/AU ADMIN)" - one-off typos that then had to be hidden behind a typeahead.

import { queryCached, strings } from './catalog.client';
/** All departments, from the table MIS itself uses. */
export function departments(): Promise<string[]> {
  return queryCached(
    'departments',
    'SELECT DISTINCT Dept FROM department WHERE Dept IS NOT NULL AND Dept <> "" ORDER BY Dept',
    [],
    rows => strings(rows, 'Dept')
  );
}

/**
 * All locations seen on support tickets. There are ~360 of these, so they must
 * never be presented as a list: the user types and we match instead.
 */
/**
 * All locations a Tech Support ticket can be raised against.
 *
 * `it_asset.locations WHERE active='Y'` is what the legacy form offers
 * (dbGetItAssetLocation). Deriving this from support_master.location instead
 * produced 365 values, of which only 69 were real places and every one of the
 * other 296 was a single-use typo - which is why the field used to be a
 * typeahead. MIS curates this table, so it is the list to trust.
 */
export function locations(): Promise<string[]> {
  return queryCached(
    'locations',
    'SELECT name FROM it_asset.locations WHERE active = \'Y\' ORDER BY name',
    [],
    rows => strings(rows, 'name')
  );
}

/** The support categories MIS accepts (Computer, Printer, Laptop, ...). */