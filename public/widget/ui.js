/* Ami Widget UI Rendering */

const AmiUI = (function() {
  'use strict';

  var icons = null;

  function setIcons(iconSet) {
    icons = iconSet;
  }

  function getIcon(name) {
    return icons && icons[name] ? icons[name] : '';
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderContent(text) {
    var escaped = escapeHtml(text);
    escaped = escaped.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
    return escaped;
  }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function extOf(name) {
    var m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
    return m ? m[1] : '';
  }

  function createMessageElement(role, content, opts) {
    opts = opts || {};
    var row = document.createElement('div');
    row.className = 'ami-msg-row ' + (role === 'user' ? 'user' : 'assistant');
    row.style.width = '100%';
    if (opts.quiet) row.style.animation = 'none';

    var avatar = document.createElement('div');
    avatar.className = 'ami-avatar-sm';
    avatar.innerHTML = role === 'user' ? '' : getIcon('bot');

    var wrap = document.createElement('div');
    wrap.className = 'ami-msg-body';
    var bubble = document.createElement('div');
    bubble.className = 'ami-message ' + role;
    if (opts.notice) bubble.classList.add('ami-ticket-notice');
    if (opts.error) bubble.classList.add('ami-error');

    if (role === 'assistant') {
      bubble.innerHTML = renderContent(content || '');
    } else {
      bubble.textContent = content || '';
    }
    wrap.appendChild(bubble);

    if (opts.time) {
      var t = document.createElement('div');
      t.className = 'ami-time';
      t.textContent = formatTime(opts.time);
      wrap.appendChild(t);
    }

    row.appendChild(avatar);
    row.appendChild(wrap);
    return row;
  }

  function createUploadNode(item, self) {
    var enriched = item.file ? item : {
      file: item,
      name: item.name,
      size: item.size,
      type: item.type,
      previewUrl: /^image\//.test(item.type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(item.name || '')
        ? URL.createObjectURL(item)
        : null,
      downloadUrl: null
    };

    var isImg = /^image\//.test(enriched.type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(enriched.name || '');
    var node = document.createElement('div');
    node.className = 'ami-thumb';

    if (isImg && enriched.previewUrl) {
      var img = document.createElement('img');
      img.src = enriched.previewUrl;
      img.alt = enriched.name;
      img.addEventListener('click', function () { openLightbox(this.src, enriched.name); });
      var overlay = document.createElement('div');
      overlay.className = 'ami-thumb-overlay';
      var expand = document.createElement('button');
      expand.className = 'ami-thumb-expand';
      expand.type = 'button';
      expand.innerHTML = getIcon('expand');
      expand.addEventListener('click', function (e) { e.stopPropagation(); openLightbox(img.src, enriched.name); });
      overlay.appendChild(expand);
      node.appendChild(img);
      node.appendChild(overlay);
      return node;
    }

    var a = document.createElement('a');
    a.className = 'ami-file';
    a.href = enriched.downloadUrl || '#';
    a.download = enriched.name || 'download';
    a.target = '_blank';
    a.rel = 'noopener';

    var ico = document.createElement('div');
    ico.className = 'ami-file-ico';
    ico.textContent = (extOf(enriched.name) || 'FILE').slice(0, 4).toUpperCase();

    var meta = document.createElement('div');
    meta.className = 'ami-file-meta';
    var nm = document.createElement('div');
    nm.className = 'ami-file-name';
    nm.textContent = enriched.name || 'file';
    var sz = document.createElement('div');
    sz.className = 'ami-file-size';
    sz.textContent = formatSize(enriched.size);
    meta.appendChild(nm);
    meta.appendChild(sz);

    a.appendChild(ico);
    a.appendChild(meta);
    node.appendChild(a);
    return node;
  }

  function openLightbox(src, caption) {
    var l = document.getElementById('ami-lightbox');
    if (!l) {
      l = document.createElement('div');
      l.id = 'ami-lightbox';
      l.addEventListener('click', function () { l.classList.remove('open'); });
      document.body.appendChild(l);
    }
    // Built with DOM calls, never innerHTML: `caption` is the user's own filename,
    // so a crafted name could close the tag and execute script in the host page's
    // origin. `textContent` and a property assignment leave no HTML to escape.
    while (l.firstChild) l.removeChild(l.firstChild);
    var img = document.createElement('img');
    img.src = String(src || '');
    img.alt = '';
    l.appendChild(img);
    if (caption) {
      var cap = document.createElement('div');
      cap.className = 'ami-lb-caption';
      cap.textContent = String(caption);
      l.appendChild(cap);
    }
    l.classList.add('open');
  }

  return {
    setIcons,
    getIcon,
    escapeHtml,
    renderContent,
    formatTime,
    formatSize,
    extOf,
    createMessageElement,
    createUploadNode,
    openLightbox
  };
})();

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AmiUI;
}

export { AmiUI };
export default AmiUI;
