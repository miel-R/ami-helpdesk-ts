/* Ami Widget Event Binding */

const AmiEvents = (function() {
  'use strict';

  function bindEvents(widget) {
    var self = widget;

    // Chat button toggle
    document.getElementById('ami-chat-button').addEventListener('click', function () { self.toggle(); });
    document.getElementById('ami-close').addEventListener('click', function () { self.close(); });
    document.getElementById('ami-minimize').addEventListener('click', function () { self.close(); });
    document.getElementById('ami-send').addEventListener('click', function () { self.send(); });

    // Input handling
    var input = self.el.input;
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      if (self._composing || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      self.send();
    });

    input.addEventListener('compositionstart', function () { this._composing = true; });
    input.addEventListener('compositionend', function () { this._composing = false; });

    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    // File attachment
    var attachBtn = self.el.attachBtn;
    var fileInput = self.el.fileInput;
    attachBtn.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      if (files.length) self.stageFiles(files);
      e.target.value = '';
    });

    // Paste image
    input.addEventListener('paste', function (e) {
      var items = (e.clipboardData || {}).items || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); self.stageFiles(files); }
    });

    // Scroll to load older messages
    var msgs = self.el.msgs;
    msgs.addEventListener('scroll', function () {
      if (this.scrollTop <= 40) self.loadOlder();
    });

    // Drag to move window
    var win = self.el.win;
    var handle = document.getElementById('ami-header');
    var dragging = false, offX = 0, offY = 0;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return;
      var r = win.getBoundingClientRect();
      dragging = true;
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      win.style.position = 'fixed';
      win.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var w = win.offsetWidth, h = win.offsetHeight;
      var x = Math.min(Math.max(0, e.clientX - offX), window.innerWidth - w);
      var y = Math.min(Math.max(0, e.clientY - offY), window.innerHeight - h);
      win.style.left = x + 'px';
      win.style.top = y + 'px';
      win.style.right = 'auto';
      win.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', function () {
      dragging = false;
      win.classList.remove('dragging');
    });

    // Drag & drop files on panel
    ['dragenter', 'dragover'].forEach(function (evt) {
      win.addEventListener(evt, function (e) {
        e.preventDefault();
        win.style.outline = '2px dashed var(--ami-primary)';
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      win.addEventListener(evt, function (e) {
        e.preventDefault();
        win.style.outline = 'none';
      });
    });
    win.addEventListener('drop', function (e) {
      var files = Array.prototype.slice.call((e.dataTransfer || {}).files || []);
      if (files.length) self.stageFiles(files);
    });

    // Lightbox click to close
    var lb = document.getElementById('ami-lightbox');
    if (lb) {
      lb.addEventListener('click', function () { lb.classList.remove('open'); });
    }
  }

  return {
    bindEvents
  };
})();

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AmiEvents;
}

export { AmiEvents };
export default AmiEvents;
