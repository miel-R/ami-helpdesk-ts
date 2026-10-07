/* Ami Widget API Communication */

const AmiApi = (function() {
  'use strict';

  let _apiBase = '';
  let _discoveryPromise = null;

  const CORS_HEADERS = { 'Content-Type': 'application/json' };

  function getApiBase() {
    return _apiBase;
  }

  function setApiBase(base) {
    _apiBase = base;
  }

  function apiUrl(path) {
    return _apiBase + path;
  }

  function candidateBases(config) {
    const list = [];
    function push(u) {
      if (!u) return;
      u = String(u).replace(/\/+$/, '');
      if (list.indexOf(u) === -1) list.push(u);
    }

    push(config.baseUrl);
    push(config.apiUrl);
    (config.fallbackUrls || []).forEach(push);

    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].src || '';
        if (/(^|\/)widget\.js/i.test(src)) push(src.replace(/widget\.js[^/]*$/i, ''));
      }
    } catch (e) { /* ignore */ }

    push(window.location.origin);
    ['192.1.5.65:3000', 'localhost:3000', '127.0.0.1:3000'].forEach(function (h) {
      push(window.location.protocol + '//' + h);
    });
    if (window.location.protocol === 'https:') push('https://' + window.location.hostname + ':3000');

    try {
      var cached = localStorage.getItem('ami_api_base');
      if (cached) list.unshift(cached);
    } catch (e) { /* ignore */ }

    return list;
  }

  function probe(base) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2500);
    return fetch(base + '/api/health', { method: 'GET', signal: ctrl.signal, mode: 'cors', cache: 'no-store' })
      .then(function (r) { clearTimeout(timer); return r.ok ? base : null; })
      .catch(function () { clearTimeout(timer); return null; });
  }

  function probeChain(list) {
    var i = 0;
    function next() {
      if (i >= list.length) return Promise.resolve('');
      return probe(list[i++]).then(function (ok) {
        if (ok) {
          try { localStorage.setItem('ami_api_base', ok); } catch (e) { /* ignore */ }
          return ok;
        }
        return next();
      });
    }
    return next();
  }

  function discover(config) {
    var list = candidateBases(config);
    if (!list.length) return Promise.resolve('');

    var cfgBase = (config || {}).baseUrl;
    if (cfgBase && list[0] === String(cfgBase).replace(/\/+$/, '')) {
      return fetch(cfgBase.replace(/\/+$/, '') + '/api/health', { mode: 'cors', cache: 'no-store' })
        .then(function (r) { return r.ok ? cfgBase.replace(/\/+$/, '') : probeChain(list.slice(1)); })
        .catch(function () { return probeChain(list.slice(1)); });
    }
    return probeChain(list);
  }

  async function post(path, body) {
    if (!_apiBase) throw new Error('API base not set');
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body),
      headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      mode: 'cors',
      cache: 'no-store'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function get(path) {
    if (!_apiBase) throw new Error('API base not set');
    const res = await fetch(apiUrl(path), { mode: 'cors', cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  return {
    getApiBase,
    setApiBase,
    apiUrl,
    candidateBases,
    probe,
    probeChain,
    discover,
    post,
    get,
    _setDiscoveryPromise: function(p) { _discoveryPromise = p; },
    _getDiscoveryPromise: function() { return _discoveryPromise; }
  };
})();

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AmiApi;
}

export { AmiApi };
export default AmiApi;
