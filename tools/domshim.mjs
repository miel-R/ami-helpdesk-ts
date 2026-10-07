/* Tiny DOM shim - just enough surface for the widget regression test.
   Not a browser emulator; it only models what the widget touches. */

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.style = {};
    this.classList = new ClassList(this);
    this._text = '';
    this.className = '';
    this.parentNode = null;
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.value = '';
    // Buttons are enabled unless something disables them. Without this the
    // property reads `undefined`, so `el.disabled === false` is false and a test
    // asserting "this control is reachable by keyboard" fails on a control that is
    // genuinely reachable.
    this.disabled = false;
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map(c => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
  set innerHTML(v) { this._text = String(v == null ? '' : v); this.children = []; }
  get innerHTML() { return this._text; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i > -1) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  insertBefore(n, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(n);
    n.parentNode = this;
    this.children.splice(i, 0, n);
    return n;
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  // Depth-first search by class name, e.g. querySelectorAll('.ami-session-end')
  _walk(out) {
    for (const c of this.children) {
      const cls = String(c.className || '').split(/\s+/);
      out.push(c);
      c._walk(out);
    }
    return out;
  }
  querySelectorAll(sel) {
    const want = String(sel).replace(/^\./, '');
    return this._walk([]).filter(e => String(e.className || '').split(/\s+/).includes(want));
  }
  closest() { return null; }
  getContext() { return null; }
  focus() {}
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  querySelector() { return null; }
}

export class JSDOMLite {
  constructor() {
    this.document = {
      readyState: 'loading',
      body: new El('body'),
      head: new El('head'),
      createElement: (t) => new El(t),
      createTextNode: (t) => { const e = new El('#text'); e._text = t; return e; },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      head_: null
    };
    this.document.head_ = this.document.head;
    // document.head/head.insertAdjacentHTML are used by the stylesheet injector
    this.document.head.insertAdjacentHTML = function (_pos, h) { this.children.push(new El('link')); };

    // capture whatever render() injects so tests can assert on the markup, and
    // register ids so getElementById resolves the elements main.js looks up.
    const body = this.document.body;
    body.inserted = [];
    const registry = this.registry = {};
    body.insertAdjacentHTML = function (_pos, h) {
      this.inserted.push(h);
      for (const m of h.matchAll(/id="([^"]+)"/g)) {
        const el = new El('div');
        el.id = m[1];
        registry[m[1]] = el;
      }
    };
    this.document.getElementById = (id) => registry[id] || null;

    this.URL = {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => {}
    };
    this.AbortController = class { constructor() { this.signal = {}; } abort() {} };

    this.window = {
      location: { origin: 'http://localhost', protocol: 'http:', hostname: 'localhost', href: 'http://localhost/' },
      addEventListener: () => {},
      innerWidth: 1280,
      innerHeight: 900,
      AmiChatConfig: {}
    };
    // Storage. `localStorage` only grew get/set, which is all anything used until
    // the widget started remembering panel state in `sessionStorage` - which also
    // needs removeItem and key enumeration, and a store that silently drops those
    // would make "did the widget clean up after itself?" untestable.
    const makeStorage = () => ({
      _d: {},
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
      clear() { this._d = {}; },
      key(i) { return Object.keys(this._d)[i] ?? null; },
      get length() { return Object.keys(this._d).length; }
    });
    this.window.localStorage = makeStorage();
    // Separate from localStorage on purpose: the browser's are independent, and a
    // shared object would hide a widget that read one while writing the other.
    this.window.sessionStorage = makeStorage();
  }
}