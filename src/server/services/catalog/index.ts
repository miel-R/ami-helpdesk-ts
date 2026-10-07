// The MIS option catalogue, read-only.
//
// Every option the chatbot offers comes from MIS's own tables, so the lists can
// never drift from what MIS accepts. Hardcoded lists were the previous behaviour
// and they were already wrong: 7 departments against the real 29, four invented
// locations that exist nowhere in MIS, and an IT asset list that is not what MIS
// actually stocks.
//
// Each flow has its own options, and they are NOT interchangeable:
//
//   tech support   department -> department.Dept                            (29)
//                  location   -> it_asset.locations (active = 'Y')           (72)
//                  category   -> support_category.request_category != 0      (4)
//                  system     -> support_category.system_type                (18)
//
//   system request system     -> scrf_request_category (category_type 'System')  (19)
//                  category   -> scrf_request_category (category_type 'Category')(6)
//                  group      -> scrf_request_category.group_category
//
//   IT asset       department -> department.Dept
//                  item       -> scrf_it_asset_inventory (89 items, with Onhand)
//
// Every query is the one the legacy PHP form runs. Everything is cached, fails
// soft, and never throws: if MIS is unreachable the chatbot asks an open question
// instead of offering a stale list.
//
// This was one 632-line file holding the connection, four unrelated catalogues and
// five caches. It is split by which table is being read, over a shared client.

export {
  enabled, invalidate, close,
  queryCached, queryRows, queryIdMap, strings,
  cache, itemCache, idCache, rowCache, optionCache
} from './catalog.client';
export type { CatalogOption, ItAssetItem, Row, IdCacheEntry } from './catalog.client';

export { departments, locations } from './directory.service';

export {
  systemRequestSystems, systemRequestCategories,
  systemRequestSystemOptions, systemRequestCategoryOptions, systemRequestGroups
} from './system-request.service';

export {
  supportCategories, supportSystemOptions, supportCategoryOptions, supportCategoryTypes
} from './support.service';

export { itAssetItems } from './asset.service';

export {
  systemRequestCategoryIdMap, systemRequestSystemIdMap,
  supportSystemTypeIdMap, supportCategoryIdMap
} from './id-maps.service';

export { misUser } from './mis-user.service';

export { registerCatalogRoutes } from './catalog.controller';
