/* Ami Widget State Management */

const AmiState = (function() {
  'use strict';

  function createInitialState() {
    return {
      sessionId: null,
      isOpen: false,
      _apiBase: null,
      unread: 0,
      loadedCount: 0,
      // False until the server says otherwise.
      //
      // This was `true`, which made a failed or empty history load indistinguishable
      // from a healthy one: `hasMore` stayed true, `nextBefore` stayed null, and
      // every scroll at the top logged "skipped: no cursor" as though the trigger
      // itself were broken. Paging is opt-in, set from the response.
      hasMore: false,
      nextBefore: null,
      loadingOlder: false,
      pendingFiles: [],
      awaitingAttachment: false,
      lastMode: 'chat',
      _composing: false,
      _sessionEnded: false,
      _sessionEndedNode: null,
      _markerRetired: false,
      _lastActivity: 0,
      _idleMs: null,
      _idleTimer: null,
      userName: '',
      userEmail: '',
      userDepartment: '',
      userRole: '',
      loginUser: '',
      userAvatar: ''
    };
  }

  function createPendingFile(file) {
    var isImg = /^image\//.test(file.type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(file.name || '');
    return {
      file: file,
      name: file.name,
      size: file.size,
      type: file.type,
      previewUrl: isImg ? URL.createObjectURL(file) : null,
      downloadUrl: null
    };
  }

  function enrichFiles(files) {
    return (files || []).map(createPendingFile);
  }

  function createMessage(role, content, opts) {
    opts = opts || {};
    return {
      role: role,
      content: content || '',
      timestamp: opts.time || new Date().toISOString(),
      notice: opts.notice || false,
      error: opts.error || false
    };
  }

  function createUploadNodeData(item) {
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
    return enriched;
  }

  return {
    createInitialState,
    createPendingFile,
    enrichFiles,
    createMessage,
    createUploadNodeData
  };
})();

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AmiState;
}

export { AmiState };
export default AmiState;
