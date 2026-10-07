/* Ami Widget - Modal Ticket Form */

/* Ticket forms matching the MIS flows field for field.
 *
 * Sources: scrf.form.php (System Request), new.support.form.php (Tech Support)
 * and it_asset_form.php (IT Asset).
 *
 * Fields the legacy forms mark readonly or disabled - date, control number,
 * requester name/id/email, MIS Assessment, "Initiate by" - are server-generated
 * or filled by MIS after submission, so they are deliberately absent here.
 *
 * Where MIS stores an id rather than the label, the control submits the id,
 * because that is what the legacy checkbox/radio posted:
 *
 *   category (SR)  scrf_request_category.category_id  (Account = 15)
 *   system (SR)    scrf_request_category.category_id  (Oracle ERP = 1)
 *   category (TS)  support_category.request_category   (Hardware = 1)
 *   system (TS)    support_category.ID                 (Printer = 2)
 *
 * `source` values are relative API paths; the modal resolves them against the
 * base the chat widget discovered, and authenticates with X-Session-ID exactly
 * like every other widget call. */
const FORM_DEFINITIONS = {
  tech_support: {
    label: 'Tech Support',
    icon: '\u{1F6E0}',
    description: 'Something is broken, wrong or not working',
    fields: [
      { id: 'department', label: 'Department', type: 'select', required: true, source: '/api/catalog/departments', placeholder: 'Select department' },
      { id: 'location', label: 'Location', type: 'select', required: true, source: '/api/catalog/locations', placeholder: 'Select location' },
      { id: 'category', label: 'Request Category', type: 'select', required: true, source: '/api/catalog/support-categories', placeholder: 'Select category' },
      { id: 'system', label: 'System Type', type: 'checkboxgroup', required: true, source: '/api/catalog/support-systems', filter: true, hint: 'Select every system type this affects' },
      { id: 'description', label: 'Request Description', type: 'textarea', required: true, prefillable: true, placeholder: 'What is the problem?' },
      { id: 'justification', label: 'Justification', type: 'textarea', required: true, prefillable: true, placeholder: 'What do you need from us?' }
    ]
  },
  system_request: {
    label: 'System Request',
    icon: '\u{1F4BB}',
    description: 'Access, data or a change to a company system',
    fields: [
      { id: 'department', label: 'Department', type: 'select', required: true, source: '/api/catalog/departments', placeholder: 'Select department' },
      { id: 'category', label: 'Request Category', type: 'select', required: true, source: '/api/catalog/request-categories', placeholder: 'Select category' },
      { id: 'system', label: 'System Name', type: 'checkboxgroup', required: true, source: '/api/catalog/systems', grouped: true, filter: true, hint: 'Systems outside the group you pick are disabled' },
      { id: 'description', label: 'Request Description', type: 'textarea', required: true, prefillable: true, placeholder: 'What exactly do you need?' },
      { id: 'justification', label: 'Justification', type: 'textarea', required: true, prefillable: true, placeholder: 'Why is this needed?' },
      { id: 'from_process', label: 'FROM (Current Process)', type: 'textarea', required: true, placeholder: 'What happens today?' },
      { id: 'to_process', label: 'TO (Requested Process)', type: 'textarea', required: true, placeholder: 'What should happen instead?' },
      { id: 'risk', label: 'Risk / Impact Assessment', type: 'textarea', required: true, placeholder: 'What is the risk of not doing this?' }
    ]
  },
  it_asset: {
    label: 'IT Asset',
    icon: '\u{1F4E6}',
    description: 'Borrow, replace or request equipment',
    // No upload in the legacy form; MIS has no folder to put one in.
    allowAttachments: false,
    fields: [
      { id: 'department', label: 'Department', type: 'select', required: true, source: '/api/catalog/departments', placeholder: 'Select department' },
      // Request Category is the one dropdown with no table behind it: the legacy
      // form hardcodes it as `$reqCategory = [1 => "New", 2 => "Borrow",
      // 3 => "Replacement", 4 => "Transfer"]` (it_asset_form.php:13) and posts the
      // LABEL as the value, so value and label are the same string here.
      //
      // These must be objects, not bare strings. appendOption() reads
      // `opt.value` and `opt.label`, and a string has neither - so the list
      // rendered as four blank entries and the field submitted the literal text
      // "undefined", which cleared a required field the user had visibly filled in.
      { id: 'request_category', label: 'Request Category', type: 'select', required: true, options: [
        { value: 'New', label: 'New' },
        { value: 'Borrow', label: 'Borrow' },
        { value: 'Replacement', label: 'Replacement' },
        { value: 'Transfer', label: 'Transfer' }
      ], placeholder: 'Select category' },
      // The legacy form is a repeatable list of item/quantity pairs, so one item
      // and one quantity would silently drop everything after the first.
      { id: 'items', label: 'Item Request', type: 'repeater', required: true, subfields: [
        { id: 'item', label: 'Item', type: 'select', required: true, source: '/api/catalog/asset-items', placeholder: 'Select item' },
        { id: 'quantity', label: 'Quantity', type: 'number', required: true, min: 1, placeholder: 'Qty' }
      ] },
      { id: 'description', label: 'Request Description', type: 'textarea', required: true, prefillable: true, placeholder: 'What do you need this for?' },
      { id: 'justification', label: 'Justification', type: 'textarea', required: true, prefillable: true, placeholder: 'Why is this needed?' }
    ]
  }
};

const MAX_ATTACHMENTS = 5;

/**
 * Ticket types that can carry files.
 *
 * IT Asset is excluded because the legacy form has no file input at all and
 * there is no folder convention for MIS to file one under. Offering the picker
 * would only produce a submission the server has to reject.
 */
function allowsAttachments(type) {
  const def = FORM_DEFINITIONS[type];
  return def ? def.allowAttachments !== false : true;
}

const AmiModal = (function() {
  'use strict';

  let modalEl = null;
  let currentStep = 1;
  let selectedType = null;
  let fieldValues = {};
  let attachmentFiles = [];
  const catalogCache = {};

  // Everything the modal needs to talk to the server, handed over by the chat
  // widget in open(). The modal does not reach for globals: the chat widget owns
  // API-base discovery and the session id, and duplicating that here is how the
  // form ends up pointed at the wrong host.
  let ctx = { apiUrl: (p) => p, sessionId: '', prefill: null };
  let onCloseCb = null;
  let onCreatedCb = null;

  function createModal() {
    if (modalEl) return modalEl;

    modalEl = document.createElement('div');
    modalEl.className = 'ami-modal-overlay';
    modalEl.innerHTML = `
      <div class="ami-modal" role="dialog" aria-modal="true" aria-labelledby="ami-modal-title">
        <div class="ami-modal-header">
          <h2 id="ami-modal-title">Create Ticket</h2>
          <button type="button" class="ami-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="ami-modal-body">
          <!-- Step 1: Type Selector -->
          <div class="ami-modal-step" data-step="1">
            <p class="ami-modal-hint">Select the type of ticket you need</p>
            <div class="ami-type-cards">
              <button type="button" class="ami-type-card" data-type="tech_support">
                <span class="ami-type-icon">${FORM_DEFINITIONS.tech_support.icon}</span>
                <span class="ami-type-label">${FORM_DEFINITIONS.tech_support.label}</span>
                <span class="ami-type-desc">${FORM_DEFINITIONS.tech_support.description}</span>
              </button>
              <button type="button" class="ami-type-card" data-type="system_request">
                <span class="ami-type-icon">${FORM_DEFINITIONS.system_request.icon}</span>
                <span class="ami-type-label">${FORM_DEFINITIONS.system_request.label}</span>
                <span class="ami-type-desc">${FORM_DEFINITIONS.system_request.description}</span>
              </button>
              <button type="button" class="ami-type-card" data-type="it_asset">
                <span class="ami-type-icon">${FORM_DEFINITIONS.it_asset.icon}</span>
                <span class="ami-type-label">${FORM_DEFINITIONS.it_asset.label}</span>
                <span class="ami-type-desc">${FORM_DEFINITIONS.it_asset.description}</span>
              </button>
            </div>
          </div>

          <!-- Step 2: Form -->
          <div class="ami-modal-step" data-step="2" style="display:none;">
            <div class="ami-form-header">
              <button type="button" class="ami-form-back" aria-label="Back to ticket types">&larr; Back</button>
              <h3 class="ami-form-title"><span class="ami-form-icon"></span><span class="ami-form-label"></span></h3>
            </div>
            <form id="ami-ticket-form" class="ami-ticket-form">
              <div class="ami-form-fields"></div>
              <div class="ami-form-attachments">
                <label class="ami-attach-label">
                  <input type="file" id="ami-attachment-input" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" style="display:none;" aria-label="Attach files">
                  <span class="ami-attach-btn">\u{1F4CE} Attach Files</span>
                </label>
                <div id="ami-attachment-list" class="ami-attachment-list"></div>
              </div>
              <div class="ami-form-actions">
                <button type="button" class="ami-btn ami-btn-secondary ami-form-cancel">Cancel</button>
                <button type="submit" class="ami-btn ami-btn-primary" disabled>Submit</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;

    // Step 1: Type card clicks
    modalEl.querySelectorAll('.ami-type-card').forEach(function (card) {
      card.addEventListener('click', function () { selectType(card.dataset.type); });
    });

    // Close button
    modalEl.querySelector('.ami-modal-close').addEventListener('click', function () { close('cancelled'); });
    modalEl.querySelector('.ami-form-back').addEventListener('click', function () { goToStep(1); });
    modalEl.querySelector('.ami-form-cancel').addEventListener('click', function () { close('cancelled'); });

    // Escape closes, as it does for every other dialog on the page.
    modalEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close('cancelled');
    });

    // Form submit
    modalEl.querySelector('#ami-ticket-form').addEventListener('submit', handleSubmit);

    // File input
    const fileInput = modalEl.querySelector('#ami-attachment-input');
    const attachBtn = modalEl.querySelector('.ami-attach-btn');
    attachBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', handleFiles);

    // Click overlay to close
    modalEl.addEventListener('click', function (e) {
      if (e.target === modalEl) close('cancelled');
    });

    document.body.appendChild(modalEl);
    return modalEl;
  }

  function selectType(type) {
    selectedType = type;
    fieldValues = {};
    // Cleared on every type change, not just when the new type forbids files:
    // otherwise files chosen under one type are silently submitted under
    // another, and the server has to reject the whole ticket over it.
    attachmentFiles = [];
    currentStep = 2;
    renderForm();
    applyAttachmentVisibility();
    showStep(2);
  }

  /** Show or hide the attachment block for the selected type. */
  function applyAttachmentVisibility() {
    const block = modalEl && modalEl.querySelector('.ami-form-attachments');
    if (!block) return;
    block.style.display = allowsAttachments(selectedType) ? '' : 'none';
    renderAttachments();
  }

  function goToStep(step) {
    currentStep = step;
    showStep(step);
  }

  function showStep(step) {
    modalEl.querySelectorAll('.ami-modal-step').forEach(el => {
      el.style.display = el.dataset.step == step ? 'block' : 'none';
    });
  }

  function renderForm() {
    const def = FORM_DEFINITIONS[selectedType];
    const fieldsContainer = modalEl.querySelector('.ami-form-fields');
    const titleIcon = modalEl.querySelector('.ami-form-icon');
    const titleLabel = modalEl.querySelector('.ami-form-label');

    titleIcon.textContent = def.icon;
    titleLabel.textContent = def.label;

    fieldsContainer.innerHTML = '';

    def.fields.forEach(field => {
      const wrapper = document.createElement('div');
      wrapper.className = 'ami-form-field';
      wrapper.dataset.fieldId = field.id;

      const label = document.createElement('label');
      label.htmlFor = `ami-field-${field.id}`;
      label.textContent = field.label + (field.required ? ' *' : '');
      wrapper.appendChild(label);

      let input;
      if (field.type === 'select' || field.type === 'multiselect') {
        input = document.createElement('select');
        input.id = `ami-field-${field.id}`;
        input.name = field.id;
        if (field.type === 'multiselect') input.multiple = true;
        input.required = field.required;

        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = field.placeholder || 'Select...';
        placeholderOpt.disabled = true;
        placeholderOpt.selected = true;
        input.appendChild(placeholderOpt);

        // Load options from source or use static options
        if (field.source) {
          loadCatalogOptions(field.source).then(options => {
            options.forEach(opt => appendOption(input, opt));
          });
        } else if (field.options) {
          field.options.forEach(opt => appendOption(input, opt));
        }
      } else if (field.type === 'checkboxes') {
        // Fixed option set, any number may be ticked. The group itself is the
        // required part, so `required` lands on each box as a native check.
        const group = document.createElement('div');
        group.className = 'ami-checkbox-group';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', field.label);

        field.options.forEach(opt => {
          const row = document.createElement('label');
          row.className = 'ami-checkbox-item';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = opt.value;
          box.name = `${field.id}[]`;
          box.required = field.required;
          const text = document.createElement('span');
          text.textContent = opt.label;
          row.appendChild(box);
          row.appendChild(text);
          box.addEventListener('change', () => {
            fieldValues[field.id] = Array.from(group.querySelectorAll('input:checked'))
              .map(b => b.value);
            validateForm();
          });
          group.appendChild(row);
        });

        wrapper.appendChild(group);
        if (field.hint) {
          const hint = document.createElement('small');
          hint.className = 'ami-field-hint';
          hint.textContent = field.hint;
          wrapper.appendChild(hint);
        }
        fieldsContainer.appendChild(wrapper);
        return;
      } else if (field.type === 'checkboxgroup') {
        // Catalog-backed tick boxes, optionally split into the groups MIS uses.
        // Replaces the old System Request single-select and Tech Support
        // multiselect, both of which were wrong: SR could only ever pick one
        // system, and TS listed company systems instead of the things that break.
        wrapper.appendChild(buildCheckboxGroup(field));
        if (field.hint) {
          const hint = document.createElement('small');
          hint.className = 'ami-field-hint';
          hint.textContent = field.hint;
          wrapper.appendChild(hint);
        }
        fieldsContainer.appendChild(wrapper);
        return;
      } else if (field.type === 'repeater') {
        wrapper.appendChild(buildRepeater(field));
        fieldsContainer.appendChild(wrapper);
        return;
      } else if (field.type === 'number') {
        input = document.createElement('input');
        input.type = 'number';
        input.id = `ami-field-${field.id}`;
        input.name = field.id;
        input.min = field.min || 1;
        input.placeholder = field.placeholder || '';
        input.required = field.required;
      } else if (field.type === 'text') {
        input = document.createElement('input');
        input.type = 'text';
        input.id = `ami-field-${field.id}`;
        input.name = field.id;
        input.placeholder = field.placeholder || '';
        input.required = field.required;
      } else {
        // textarea
        input = document.createElement('textarea');
        input.id = `ami-field-${field.id}`;
        input.name = field.id;
        input.placeholder = field.placeholder || '';
        input.required = field.required;
        input.rows = 3;
      }

      input.addEventListener('change', () => {
        fieldValues[field.id] = field.type === 'multiselect'
          ? Array.from(input.selectedOptions).map(o => o.value)
          : input.value;
        validateForm();
      });
      input.addEventListener('input', () => validateForm());

      // Carried in from the conversation so the user confirms rather than retypes.
      if (field.prefillable && ctx.prefill && typeof ctx.prefill[field.id] === 'string' && ctx.prefill[field.id].trim()) {
        input.value = ctx.prefill[field.id];
        fieldValues[field.id] = input.value;
        wrapper.dataset.prefilled = 'true';
      }

      wrapper.appendChild(input);
      if (field.hint) {
        const hint = document.createElement('small');
        hint.className = 'ami-field-hint';
        hint.textContent = field.hint;
        wrapper.appendChild(hint);
      }
      fieldsContainer.appendChild(wrapper);
    });

    validateForm();
  }

  /**
   * Catalog-backed tick boxes, optionally grouped.
   *
   * The grouping reproduces scrf.form.php's behaviour: it defines six groups in
   * JavaScript and, when a box is ticked, disables every box outside that group.
   * Only one group can be in play at a time, which is the constraint MIS's own
   * form enforces - dbGetPrefix() reads a single scrf_conditions row, so a
   * cross-group ticket has no prefix to give it.
   *
   * Enforced here in the browser only, on purpose. The legacy form does the same,
   * and history shows it leaking (scrf_sys_name "1,3" spans two groups on eight
   * tickets), so a server-side rejection would refuse submissions MIS accepted.
   */
  function buildCheckboxGroup(field) {
    const root = document.createElement('div');
    root.className = 'ami-checkgroup';

    const status = document.createElement('div');
    status.className = 'ami-checkgroup-status';
    status.setAttribute('aria-live', 'polite');
    root.appendChild(status);

    let listWrap = document.createElement('div');
    listWrap.className = 'ami-checkgroup-list';
    root.appendChild(listWrap);

    /** All rendered boxes, so filtering and grouping can find them. */
    const boxes = [];

    function currentGroups() {
      return new Set(boxes.filter(b => b.box.checked).map(b => b.group));
    }

    function applyExclusivity() {
      const active = currentGroups();
      boxes.forEach(b => {
        if (!field.grouped) {
          b.box.disabled = false;
          b.row.classList.remove('is-disabled');
          return;
        }
        // No boxes ticked yet: everything stays available.
        const off = active.size > 0 && !active.has(b.group);
        b.box.disabled = off;
        b.row.classList.toggle('is-disabled', off);
      });
    }

    function syncValues() {
      fieldValues[field.id] = boxes.filter(b => b.box.checked).map(b => b.value);
      const n = fieldValues[field.id].length;
      status.textContent = n ? n + ' selected' : '';
      applyExclusivity();
      validateForm();
    }

    function addBox(section, opt) {
      const row = document.createElement('label');
      row.className = 'ami-checkbox-item';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = opt.value;
      box.name = `${field.id}[]`;
      // `required` on every box would demand all of them; at-least-one is
      // enforced by validateForm() through the array length instead.
      box.addEventListener('change', syncValues);

      const text = document.createElement('span');
      text.textContent = opt.labelWithCount || opt.label;

      row.appendChild(box);
      row.appendChild(text);
      section.appendChild(row);
      // The label is kept for filtering. Recorded here rather than matched up by
      // index afterwards, because grouped sections are appended group-by-group and
      // so are not in the same order the catalog returned.
      // `value` is recorded alongside the DOM node because syncValues reads it
      // back off this record. Reading `b.value` here silently produced
      // [undefined], which JSON-serialises to [null] and came back from MIS as
      // "Invalid system: null" even though the user had ticked a real system.
      boxes.push({ box, row, value: opt.value, group: opt.group || '', label: (opt.label || '').toLowerCase() });
    }

    loadCatalogOptions(field.source).then(options => {
      if (field.filter) {
        const filter = document.createElement('input');
        filter.type = 'text';
        filter.className = 'ami-checkgroup-filter';
        filter.placeholder = 'Filter to narrow the list';
        filter.autocomplete = 'off';
        filter.setAttribute('aria-label', 'Filter options');
        // Inserted above the list but below the status line.
        root.insertBefore(filter, listWrap);
        filter.addEventListener('input', () => {
          const q = filter.value.trim().toLowerCase();
          boxes.forEach(b => {
            const match = !q || b.label.toLowerCase().includes(q);
            // A box hidden by the filter must not look disabled by grouping, and
            // a disabled box stays hidden-but-disabled rather than becoming
            // clickable just because its label matched.
            b.row.style.display = match ? '' : 'none';
            if (!match) b.row.classList.add('is-disabled');
            else applyExclusivity();
          });
        });
      }

      if (field.grouped) {
        // Preserve MIS's own ordering of groups, and of options within them.
        const groups = [];
        options.forEach(opt => {
          const g = opt.group || 'Other';
          let section = groups.find(x => x.name === g);
          if (!section) {
            // options has to exist here: it is filled on the next line, and a
            // missing initialiser made every grouped list throw instead of render.
            section = { name: g, options: [], wrap: document.createElement('div') };
            section.wrap.className = 'ami-checkgroup-section';
            const heading = document.createElement('div');
            heading.className = 'ami-checkgroup-heading';
            heading.textContent = g;
            section.wrap.appendChild(heading);
            const body = document.createElement('div');
            body.className = 'ami-checkbox-group';
            section.wrap.appendChild(body);
            section.body = body;
            groups.push(section);
          }
          section.options.push(opt);
        });
        groups.forEach(section => {
          section.options.forEach(opt => addBox(section.body, opt));
          listWrap.appendChild(section.wrap);
        });
      } else {
        const body = document.createElement('div');
        body.className = 'ami-checkbox-group';
        options.forEach(opt => addBox(body, opt));
        listWrap.appendChild(body);
      }

      syncValues();
    }).catch((e) => {
      // loadCatalogOptions swallows its own errors, so reaching here means the
      // render itself threw. Say so instead of blaming the network, and keep the
      // real error visible - the first version of this handler reported a plain
      // load failure for what was actually a TypeError in the grouping code.
      console.error('ami-modal: could not render', field.id, e);
      status.textContent = 'Could not display the options (' + (e && e.message ? e.message : 'unknown error') + ').';
    });

    return root;
  }

  /**
   * A repeatable group of subfields, used where the legacy form posts an array.
   * Every row keeps its values under field.id so the payload matches PHP's
   * inventory_items[]/request_qty[] shape rather than collapsing to one pair.
   *
   * Rows live in their own container, with the "Add another item" button as a
   * sibling after it. Appending rows straight to the parent used to put every
   * new row *below* that button, which read as the button having duplicated
   * itself rather than added a row.
   */
  function buildRepeater(field) {
    const container = document.createElement('div');
    container.className = 'ami-repeater';

    const rows = document.createElement('div');
    rows.className = 'ami-repeater-rows';
    container.appendChild(rows);

    function syncRows() {
      fieldValues[field.id] = Array.from(rows.querySelectorAll('.ami-repeater-row'))
        .map(row => {
          const entry = {};
          row.querySelectorAll('[data-sub]').forEach(input => {
            entry[input.dataset.sub] = input.value;
          });
          return entry;
        })
        // A half-typed row is not a request. Dropping it here means the payload
        // never carries an item with no quantity, which the server rejects.
        .filter(entry => entry.item && String(entry.item).trim());
      validateForm();
    }

    function addRow(initial) {
      const itemSub = (field.subfields || []).find(s => s.id === 'item') || {};
      const row = document.createElement('div');
      row.className = 'ami-repeater-row';

      const itemWrap = document.createElement('div');
      itemWrap.className = 'ami-repeater-cell ami-repeater-grow';
      const itemLabel = document.createElement('label');
      itemLabel.textContent = itemSub.label || 'Item';

      let itemInput;
      if (itemSub.type === 'select') {
        itemInput = document.createElement('select');
        const placeholderOpt = document.createElement('option');
        placeholderOpt.value = '';
        placeholderOpt.textContent = itemSub.placeholder || 'Select...';
        placeholderOpt.disabled = true;
        placeholderOpt.selected = true;
        itemInput.appendChild(placeholderOpt);
        loadCatalogOptions(itemSub.source).then(options => {
          options.forEach(opt => appendOption(itemInput, opt));
        });
      } else {
        itemInput = document.createElement('input');
        itemInput.type = 'text';
        itemInput.placeholder = itemSub.placeholder || '';
      }
      itemInput.dataset.sub = 'item';
      itemInput.name = 'item';
      itemInput.required = true;
      itemInput.setAttribute('aria-label', itemSub.label || 'Item');
      if (initial && initial.item) itemInput.value = initial.item;
      itemInput.addEventListener('change', syncRows);
      itemInput.addEventListener('input', syncRows);
      itemWrap.appendChild(itemLabel);
      itemWrap.appendChild(itemInput);

      const qtyWrap = document.createElement('div');
      qtyWrap.className = 'ami-repeater-cell ami-repeater-qty';
      const qtyLabel = document.createElement('label');
      qtyLabel.textContent = 'Quantity';
      const qtyInput = document.createElement('input');
      qtyInput.type = 'number';
      qtyInput.dataset.sub = 'quantity';
      qtyInput.min = 1;
      qtyInput.required = true;
      qtyInput.placeholder = 'Qty';
      qtyInput.setAttribute('aria-label', 'Quantity');
      if (initial && initial.quantity) qtyInput.value = initial.quantity;
      qtyInput.addEventListener('input', syncRows);
      qtyWrap.appendChild(qtyLabel);
      qtyWrap.appendChild(qtyInput);

      const removeWrap = document.createElement('div');
      removeWrap.className = 'ami-repeater-cell ami-repeater-remove';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ami-btn ami-btn-ghost ami-btn-danger';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove this item');
      // The form always needs one row to type into, so the last one stays put
      // and is only cleared.
      remove.addEventListener('click', () => {
        if (rows.querySelectorAll('.ami-repeater-row').length <= 1) {
          itemInput.value = '';
          qtyInput.value = '';
          syncRows();
          itemInput.focus();
          return;
        }
        row.remove();
        syncRows();
      });
      removeWrap.appendChild(remove);

      row.appendChild(itemWrap);
      row.appendChild(qtyWrap);
      row.appendChild(removeWrap);
      rows.appendChild(row);
    }

    const existing = Array.isArray(fieldValues[field.id]) ? fieldValues[field.id] : [];
    if (existing.length) existing.forEach(entry => addRow(entry));
    else addRow();

    const addMore = document.createElement('button');
    addMore.type = 'button';
    addMore.className = 'ami-btn ami-btn-ghost';
    addMore.textContent = '+ Add another item';
    addMore.addEventListener('click', () => {
      addRow();
      // Focus the new row's item picker, since that is what the click was asking for.
      const last = rows.querySelector('.ami-repeater-row:last-child [data-sub="item"]');
      if (last) last.focus();
    });
    container.appendChild(addMore);

    // Rows exist now, so publish the initial state.
    syncRows();
    return container;
  }

  async function loadCatalogOptions(path) {
    if (catalogCache[path]) return catalogCache[path];
    try {
      const response = await fetch(ctx.apiUrl(path), {
        headers: { 'X-Session-ID': ctx.sessionId },
        mode: 'cors',
        cache: 'no-store'
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) {
          // Catalogs come in three shapes and every consumer wants {value,label}:
          //   "MIS"                              plain string
          //   {id,name,group}                    MIS stores an id for this field
          //   {value,onhand}                     IT asset item, with a stock count
          // Normalised here once so no renderer has to special-case them.
          const options = data.map(normaliseOption).filter(Boolean);
          catalogCache[path] = options;
          return options;
        }
      }
      console.warn('Catalog returned no usable options:', path);
    } catch (e) {
      console.warn('Failed to load catalog:', path, e);
    }
    return [];
  }

  /**
   * One catalog entry as {value, label, group, onhand}.
   *
   * `value` is what gets submitted, which is the id where MIS has one. The
   * fallback to `name`/`value` keeps a plain-string catalog working unchanged,
   * and an empty id degrades to sending the label rather than an empty field.
   */
  function normaliseOption(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string' || typeof raw === 'number') {
      const s = String(raw);
      return s ? { value: s, label: s, group: '', onhand: null } : null;
    }
    if (typeof raw !== 'object') return null;
    const name = String(raw.name ?? raw.value ?? raw.label ?? '').trim();
    if (!name) return null;
    const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
    const onhand = Number(raw.onhand);
    return {
      value: id || name,
      label: name,
      group: String(raw.group ?? '').trim(),
      // Shown beside the name, exactly like the legacy <option>: "AVR - 15".
      labelWithCount: Number.isFinite(onhand) ? `${name} - ${onhand}` : name,
      onhand: Number.isFinite(onhand) ? onhand : null
    };
  }

  /** Add one normalised option to a <select>. */
  function appendOption(select, opt) {
    const optEl = document.createElement('option');
    optEl.value = opt.value;
    optEl.textContent = opt.labelWithCount || opt.label;
    select.appendChild(optEl);
    return optEl;
  }

  function validateForm() {
    const def = FORM_DEFINITIONS[selectedType];
    const submitBtn = modalEl.querySelector('.ami-btn-primary');
    let valid = true;
    for (const field of def.fields) {
      if (field.required) {
        const val = fieldValues[field.id];
        if (val === undefined || val === null || (Array.isArray(val) ? val.length === 0 : String(val).trim() === '')) {
          valid = false;
          break;
        }
      }
    }
    submitBtn.disabled = !valid;
  }

  function handleFiles(e) {
    const files = Array.from(e.target.files);
    for (const file of files) {
      if (attachmentFiles.length >= MAX_ATTACHMENTS) break;
      attachmentFiles.push(file);
    }
    renderAttachments();
    e.target.value = ''; // allow re-selecting same file
  }

  function renderAttachments() {
    const list = modalEl.querySelector('#ami-attachment-list');
    list.innerHTML = '';
    attachmentFiles.forEach(function (file, idx) {
      const item = document.createElement('div');
      item.className = 'ami-attachment-item';

      // textContent, not innerHTML: a file name is user input and `<img onerror>`
      // in one would run in the host page.
      const name = document.createElement('span');
      name.className = 'ami-attach-name';
      name.textContent = file.name + ' (' + formatBytes(file.size) + ')';
      item.appendChild(name);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ami-attach-remove';
      remove.setAttribute('aria-label', 'Remove ' + file.name);
      remove.textContent = '\u00D7';
      remove.addEventListener('click', function () {
        attachmentFiles.splice(idx, 1);
        renderAttachments();
      });
      item.appendChild(remove);

      list.appendChild(item);
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const submitBtn = modalEl.querySelector('.ami-btn-primary');
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    const formData = new FormData();
    formData.append('ticket_type', selectedType);
    formData.append('fields', JSON.stringify(fieldValues));
    formData.append('session_id', ctx.sessionId);
    // Belt and braces: the picker is hidden for types that forbid files, and the
    // files are cleared on type change, so this should never have anything to
    // skip. The server rejects them either way, but not failing the whole ticket
    // over an empty file input is kinder.
    if (allowsAttachments(selectedType)) {
      attachmentFiles.forEach(function (f) { formData.append('attachments', f); });
    }

    try {
      const response = await fetch(ctx.apiUrl('/api/ticket'), {
        method: 'POST',
        body: formData,
        headers: { 'X-Session-ID': ctx.sessionId },
        mode: 'cors',
        cache: 'no-store'
      });
      const result = await response.json().catch(function () { return {}; });

      if (!response.ok || !result.ok) {
        const detail = (result.errors || result.error || []).toString() || ('HTTP ' + response.status);
        throw new Error(detail);
      }

      // Hand the confirmation back to the chat so it lands in the transcript
      // once. The chat owns the message list; the modal only reports the result.
      const createdCb = onCreatedCb;
      close('submitted');
      if (createdCb) createdCb(result);
    } catch (err) {
      showToast('Could not submit: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'ami-toast ami-toast-' + (type || 'success');
    // textContent: this can carry an n8n error string, which is not ours to trust.
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function () { toast.classList.add('show'); }, 10);
    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.remove(); }, 300);
    }, 5000);
  }

  /**
   * @param {object}  [options]
   * @param {function} [options.apiUrl]    path -> absolute URL, from the chat widget
   * @param {string}   [options.sessionId] session the server already knows about
   * @param {function} [options.onCreated] called with the ticket result once MIS confirms
   * @param {function} [options.onClose]   called when the user backs out
   */
  function open(options) {
    const opts = options || {};
    if (typeof opts.apiUrl === 'function') ctx.apiUrl = opts.apiUrl;
    if (opts.sessionId) ctx.sessionId = opts.sessionId;
    // Values the server carried over from the conversation. Cleared on close so
    // a later handover does not inherit the previous problem's wording.
    ctx.prefill = opts.prefill && typeof opts.prefill === 'object' ? opts.prefill : null;
    onCreatedCb = typeof opts.onCreated === 'function' ? opts.onCreated : null;
    onCloseCb = typeof opts.onClose === 'function' ? opts.onClose : null;

    createModal();

    // Reset state
    currentStep = 1;
    selectedType = null;
    fieldValues = {};
    attachmentFiles = [];
    showStep(1);
    modalEl.classList.add('open');
    document.body.style.overflow = 'hidden';
    modalEl.querySelector('.ami-modal-close').focus();
  }

  /**
   * Dismiss the form.
   *
   * `reason` tells the chat why, so a cancel can be acknowledged while the close
   * that follows a successful submit stays silent - otherwise every filed ticket
   * would also report itself as cancelled.
   *
   *   'cancelled' - X, Cancel, Escape, or a click on the backdrop
   *   'submitted' - the form went through; the chat already confirms it
   */
function close(reason) {
    const cb = onCloseCb;
    onCreatedCb = null;
    onCloseCb = null;
    // Dropped so the next handover starts from that conversation, not this one.
    ctx.prefill = null;
    if (!modalEl) { if (cb) cb(reason); return; }
    modalEl.classList.remove('open');
    document.body.style.overflow = '';
    // Clear the catalog cache so the next form open re-requests the dropdowns
    // and the form-active signal fires again. Without this, a second form open
    // in the same page load would use cached data and skip the server signal.
    //
    // The keys are deleted in place rather than the object reassigned:
    // `catalogCache` is a `const`, so `catalogCache = {}` threw
    // "Assignment to constant variable." on EVERY form close - the exception
    // fired before the onClose callback, so the cancel/submit path died before
    // the chat could acknowledge it and `form_active` was never cleared server
    // side. Clearing the keys also keeps any holder of the object valid.
    Object.keys(catalogCache).forEach(function (key) { delete catalogCache[key]; });
    if (cb) cb(reason);
  }

  return { open, close };
})();

export { AmiModal };
export default AmiModal;
