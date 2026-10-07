# Flow Data Documentation

This document describes the ticket form definitions used by the modal ticket creation system.

## Overview

The ticket forms are defined in TypeScript constants within `public/widget/modal.js` (client-side) and validated server-side in `src/server/services/ticket/routes.service.ts`.

## Form Definitions

### Tech Support (`tech_support`)

```typescript
{
  label: 'Tech Support',
  icon: '🛠️',
  description: 'Something is broken, wrong or not working',
  fields: [
    { id: 'department',       label: 'Department',       type: 'select',      required: true, source: '/api/catalog/departments',       placeholder: 'Select department' },
    { id: 'location',         label: 'Location',         type: 'select',      required: true, source: '/api/catalog/locations',         placeholder: 'Select location' },
    { id: 'category',         label: 'Request Category', type: 'select',      required: true, source: '/api/catalog/support-categories',  placeholder: 'Select category' },
    { id: 'system',           label: 'System Type',      type: 'checkboxgroup', required: true, source: '/api/catalog/support-systems',   filter: true, hint: 'Select every system type this affects' },
    { id: 'description',      label: 'Request Description', type: 'textarea', required: true, prefillable: true, placeholder: 'What is the problem?' },
    { id: 'justification',    label: 'Justification',    type: 'textarea',  required: true, prefillable: true, placeholder: 'What do you need from us?' }
  ]
}
```

**System Type reads a different table than System Request's System Name.** It comes
from `support_category` (Computer, Printer, Laptop, VPN — 18 rows), not
`scrf_request_category` (Oracle ERP, MES, HRIS — 19 rows). The two lists have
nothing in common, and reading the wrong one offered MIS's company systems as
things that break.

### System Request (`system_request`)

Derived from `scrf.form.php`.

```typescript
{
  label: 'System Request',
  icon: '💻',
  description: 'Access, data or a change to a company system (Oracle ERP, HRIS, MIS...)',
  fields: [
    { id: 'department',        label: 'Department',         type: 'select',    required: true, source: '/api/catalog/departments',       placeholder: 'Select department' },
    { id: 'category',          label: 'Request Category',   type: 'select',    required: true, source: '/api/catalog/request-categories',  placeholder: 'Select category' },
    { id: 'system',            label: 'System Name',        type: 'checkboxgroup', required: true, source: '/api/catalog/systems',      grouped: true, filter: true, hint: 'Systems outside the group you pick are disabled' },
    { id: 'description',       label: 'Request Description', type: 'textarea', required: true, prefillable: true, placeholder: 'What exactly do you need?' },
    { id: 'justification',     label: 'Justification',      type: 'textarea',  required: true, prefillable: true, placeholder: 'Why is this needed?' },
    { id: 'to_process',        label: 'TO (Requested Process)', type: 'textarea', required: true, placeholder: 'What should happen instead?' },
    { id: 'risk',              label: 'Risk / Impact Assessment', type: 'textarea', required: true, placeholder: 'What is the risk or impact of not doing this?' }
  ]
}
```
Both were removed from the form on request. scrf.form.php:54 calls
dbInsertMeasurableImpact(...) unconditionally, so MIS writes the row either way
and an all-No row is a valid state.
### IT Asset (`it_asset`)

Derived from `it_asset_form.php`.

```typescript
{
  label: 'IT Asset',
  icon: '📦',
  description: 'Borrow, replace or request equipment',
  fields: [
    { id: 'department',        label: 'Department',        type: 'select',    required: true, source: '/api/catalog/departments',   placeholder: 'Select department' },
    { id: 'request_category',  label: 'Request Category',  type: 'select',    required: true, options: ['New', 'Borrow', 'Replacement', 'Transfer'], placeholder: 'Select category' },
    { id: 'items',             label: 'Item Request',      type: 'repeater',  required: true, subfields: [
      { id: 'item',     label: 'Item',     type: 'select', required: true, source: '/api/catalog/asset-items', placeholder: 'Select item' },
      { id: 'quantity', label: 'Quantity', type: 'number', required: true, min: 1, placeholder: 'Qty' }
    ] },
    { id: 'description',       label: 'Request Description', type: 'textarea', required: true, prefillable: true, placeholder: 'What do you need this for?' },
    { id: 'justification',     label: 'Justification',     type: 'textarea',  required: true, prefillable: true, placeholder: 'Why is this needed?' }
  ]
}
```

The legacy form is a repeatable list of item/quantity pairs with an "Add Another"
button, so `items` is an array of `{ item, quantity }`. Each pair must have a
non-empty item name and a quantity of at least 1; a row that fails either check
is rejected rather than silently dropped. The last remaining row cannot be
removed, so there is always somewhere to type.

Items are stored per line in a child table:

```sql
inventory_items_log(control_id, inventory_items, request_quantity)
```

so the payload carries `inventory_items` and `request_quantity` as
comma-separated values in row order.

`Asset_tag` is deliberately **not** sent. The legacy app sets it in a later step
(`dbUpdateScrfItAssetSerialNumber`) once MIS assigns the real asset number, so
anything the widget supplied there would be wrong.

## Catalog Sources

Every dropdown is the query the legacy PHP form runs, so the lists cannot drift
from what MIS accepts. Verified against live MIS on 2026-10-05.

| Form field | Query | Rows | Control | Posts |
|------------|-------|------|---------|-------|
| Department (all 3) | `SELECT * FROM department ORDER BY Dept ASC` | 29 | `select` | name |
| SR category | `scrf_request_category WHERE category_type='Category'` | 6 | `select` | `category_id` |
| SR system | `scrf_request_category WHERE category_type='System'` | 19 | `checkboxgroup`, grouped | `system_id` |
| SR impact / measurable impact | not collected | - | none | - |
| TS location | `SELECT name FROM it_asset.locations WHERE active='Y' ORDER BY name` | 72 | `select` | name |
| TS category | `support_category WHERE request_category != 0` | 4 | `select` | `request_category` code |
| TS system | `SELECT ID, system_type FROM support_category ORDER BY system_type ASC` | 18 | `checkboxgroup` | `support_category.ID` |
| Asset item | `scrf_it_asset_inventory` | 89 | `select` showing `NAME - ONHAND` | name |
| Asset qty | `<input type=number min=1>` | — | `number`, uncapped | int |

Three of these were wrong before:

- **TS location** was mined from `SELECT DISTINCT location FROM support_master`,
  which returned **365** free-text strings including `(ifv mold) at dtfs area` and
  `(BM/AU ADMIN)`. Only 69 were real places and every one of the remaining 296 was
  a single-use typo, which is why the field had to be a typeahead.
  `it_asset.locations WHERE active='Y'` is the 72 places MIS curates, offered as a
  plain dropdown like the legacy form.
- **TS system** read `/api/catalog/systems`, i.e. the System Request list.
- **Asset item** is a typeahead that only searched once two characters were typed,
  and the endpoint discarded the `onhand` count, so the list looked empty.

## Ids, Not Labels

MIS stores foreign keys in several of these columns, so the form submits the id.
`scrf_master.scrf_sys_name` holds `"1"` on 2915 existing rows and comma-joined
ids like `"2,3,7,14"` on others; `support_master.support_category` holds `"15"`.
Sending the label there puts free text in a column MIS reads back as a key, and
`dbGetPrefix()`'s `WHERE category_id IN (...)` then matches nothing, so the
control-number prefix is silently wrong.

| Column | Holds |
|--------|-------|
| `scrf_master.scrf_req_category` | `scrf_request_category.category_id` (15 = Account) |
| `scrf_master.scrf_sys_name` | comma-joined `scrf_request_category.category_id` |
| `support_master.category` | `support_category.request_category` (1 = Hardware) |
| `support_master.support_category` | comma-joined `support_category.ID` |

Both the label and the id are sent (`category`/`system` alongside
`category_id`/`system_id`), so n8n can write the key and a human-readable ticket
still reads sensibly in the job list.

Validation accepts **either** an id or a label, because `$test-webhook` still
posts labels and the probe has to stay a faithful stand-in for a real ticket.

## The System Request Group Rule

`scrf.form.php:612` hardcodes six groups in JavaScript and, when a box is ticked,
disables every box outside that group. The chatbot reproduces this:

| Group | ids | Systems |
|-------|-----|---------|
| ERP | 1 | Oracle ERP |
| MES | 2,3,4,6,7,8,9,10,14,24,25 | PMR, MES, PSIS, IQAR, EDAS, ONHB, Traceability, Logsheet, OpenKM, MIS HELPDESK, MIS Related |
| TECH | 11,12,13,19 | Shared Folder, VPN, E-mail, Captive Portal |
| HRIS | 5 | HRIS |
| IT Asset | 21 | IT Asset |
| Application | 23 | Application |

Note this is **not** the `group_category` column, which files HRIS under MES and
IT Asset under TECH. The column is used as the base and ids 5, 21 and 23 are then
lifted out as singletons, so a MIS row added later still lands in a real group.

That is also why 21 and 23 do **not** appear in the MES and TECH rows above: a
singleton overrides its base group rather than joining it. Listing them in both
places would suggest a user can tick IT Asset together with Shared Folder, which
the form does not allow.

Enforcement is **client-side only**, matching the legacy form. `dbGetPrefix()`
reads a single `scrf_conditions` row, so a cross-group ticket has no prefix, but
history shows the rule leaking: `scrf_sys_name = "1,3"` spans two groups on eight
tickets. A server-side rejection would refuse submissions MIS accepted.

## Field Types

| Type | Description | Client Rendering | Validation |
|------|-------------|------------------|------------|
| `select` | Single choice from list | `<select>` dropdown | Must match catalog exactly |
| `multiselect` | Multiple choices | `<select multiple>`, Ctrl/Cmd-click | Each value must match catalog |
| `number` | Numeric input | `<input type="number">` | Must be >= 1 |
| `textarea` | Multi-line text | `<textarea>` | Required, non-empty |
| `text` | Single-line text | `<input type="text">` | Required, non-empty |
| `checkboxes` | Fixed option set, one or more | `<input type="checkbox">` group | At least one ticked; each value must be a known option |
| `checkboxgroup` | Catalog-backed tick boxes, optionally grouped | One section per group, optional filter box, ticked count | At least one ticked; each value must be a known option |
| `repeater` | Repeatable group of subfields | Repeatable rows with Add/Remove | At least one row; every row fully valid |

Catalog endpoints return `string[]` where the form only needs a label, and
`{id, name, group}` or `{value, onhand}` where MIS stores an id or a count. The
widget normalises all three shapes once, in `normaliseOption()`.

Validation is exact-match, not fuzzy. The typeahead only filters the catalog the
server itself returned, so what the user can pick is always what the server will
accept. A field the modal did not offer (a name typed by hand, a stale cached
list) is rejected with a 400 rather than passed through to MIS.

## Server-Side Validation

Located in `src/server/services/ticket/routes.service.ts`:

```typescript
const REQUIRED_FIELDS: Record<TicketType, readonly string[]> = {
  tech_support: ['department', 'location', 'category', 'system', 'description', 'justification'],

## n8n Workflow Contract

The chatbot POSTs to a user-owned n8n flow. It is the only thing outside this
repository that writes to MIS, which is why the payload is documented as
precisely as the API itself.

### Payload shape

```json
{
  "event": "ticket_created",
  "ticket_type": "system_request | tech_support | it_asset",
  "target_list": "mis_job_list | mis_job_list_tech",
  "user": { "login": "", "user_id": 0, "email": "", "department": "", "role": "" },
  "ticket_data": {
    "category_id": 15,
    "system_id": "1,3",
    "system_id_pipe": "1|3",
    "system_ids": [1, 3],
    "system_id_count": 2,
    "inventory_items": "RJ45, ACER LAPTOP",
    "inventory_items_pipe": "RJ45|ACER LAPTOP",
    "request_quantity": "2, 1",
    "request_quantity_pipe": "2|1",
    "created_at": "YYYY-MM-DD HH:MM:SS"
  },
  "attachment_count": 2,
  "attachments": [ { "file_name": "", "staged_path": "", "file_size": 0 } ]
}
```

### Why the `_pipe` twins exist

n8n binds SQL values from ONE comma-separated `queryReplacement` string and splits
it on commas **after** the expressions are evaluated. A multi-system ticket sends
`system_id: "1,3"`, so that value became two placeholders and every column to its
right slid one place left.

On ticket **AIP26100039** that wrote the description into the system column, the
justification into the category column, and left the requester name, employee
number and e-mail **empty** - because their slots had been taken by values that
belonged to other fields. Only multi-system tickets were ever affected, which is
why single-select tickets looked correct throughout.

So every field that can hold more than one choice is also sent with `|` as the
separator, and the flow restores the comma in SQL:

```sql
REPLACE($13, '|', ',')
```

A single select has no comma to restore and is unaffected either way.

### The six fixes in the corrected workflow

| # | Node | Was | Now |
|---|------|-----|-----|
| 1 | Insert System Request | `scrf_sys_name` 7th of 13, so a multi-value id shifted everything after it | moved last, bound from `system_id_pipe` |
| 2 | Insert Tech Support | 9 placeholders, 8 replacements; `support_category` bound to `location` | 9 and 9: `$8` = system, `$9` = location |
| 3 | Insert IT Asset | referenced `item` and `quantity`, which the app never sends | `inventory_items_pipe` and `request_quantity_pipe` |
| 4 | Insert Attachment | stray `)` broke the statement; whole array bound to `file_name`; directory hardcoded as `still not implemented` | balanced statement, one row per file, `staged_path` reaches `file_directory` |
| 5 | Has Attachments | tested `$json.body.attachments` on a MySQL row, so always false - and the false branch had **no connection** | reads from the parent code node; false branch now reaches the responder |
| 6 | Respone back to ami | read `$('Build Control').item`, which breaks as soon as an item is reshaped | reads `.first()`, which needs no item linking |

Fix 5 is the one that mattered most and was invisible in the export: the
attachment branch could never be taken, and the branch that *was* taken had
nothing wired to it, so a System Request or Tech Support ticket with no
attachment simply stopped running. The chatbot then reported *"n8n accepted the
request but returned no control number"* for a ticket that was in fact filed.

Attachments are expanded by a new **One Item Per File** code node rather than
Split Out. Split Out would have to read a field off the incoming item, and at that
point the incoming item is a MySQL row that does not carry the webhook body; the
code node reads from the parent and emits flat items, which also removes the
item-linking dependency from the insert.

### Known gap

A ticket **with** attachments does not send the "Send a message" email: the
attachment branch deliberately skips the Gmail node rather than send one email per
file. The ticket row and the attachment rows are both written correctly, so the
ticket still appears in `MIS_JOB_LIST`; only the notification is missing. Wiring it
back needs a merge construct that cannot be validated without a live n8n instance
to execute it.
