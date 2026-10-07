/* Ami Widget Configuration & Constants */

const AmiConfig = {
  // Default configuration
  defaults: {
    maxHistory: 50,
    maxUploads: 20,
    typingDots: 3,
    bounceInterval: 1400,
    scrollThreshold: 40,
    uploadPreviewMaxWidth: 240,
    uploadPreviewMaxHeight: 180,
    quickReplyLimit: 8,
    // Server sends these on /api/session and /api/chat responses
    idleSessionMs: 5 * 60 * 1000,
    idlePollMs: 60 * 1000,
    nudgeMs: 4 * 60 * 1000
  },

  // Storage keys
  storage: {
    apiBaseKey: 'ami_api_base'
  },

  // API endpoints
  endpoints: {
    chat: '/api/chat',
    history: '/api/history/',
    health: '/api/health',
    files: '/api/files/',
    ticket: '/api/ticket',
    catalog: {
      departments: '/api/catalog/departments',
      locations: '/api/catalog/locations',
      supportCategories: '/api/catalog/support-categories',
      systems: '/api/catalog/systems',
      assetItems: '/api/catalog/asset-items'
    }
  },

  // Selectors
  selectors: {
    userName: '.user-name',
    userEmail: '.user-email',
    userDept: '.user-dept, .user-department',
    userRole: '.user-role'
  },

  // CSS class names
  classes: {
    widget: 'ami-widget',
    chatButton: 'ami-chat-button',
    chatWindow: 'ami-chat-window',
    header: 'ami-header',
    messages: 'ami-messages',
    typing: 'ami-typing',
    quickReplies: 'ami-quick-replies',
    inputArea: 'ami-input-area',
    pending: 'ami-pending',
    input: 'ami-input',
    fileLabel: 'ami-file-label',
    attachBtn: 'ami-attach-btn',
    sendBtn: 'ami-send',
    badge: 'ami-badge',
    lightbox: 'ami-lightbox',
    msgRow: 'ami-msg-row',
    message: 'ami-message',
    avatar: 'ami-avatar',
    avatarSm: 'ami-avatar-sm',
    uploadGrid: 'ami-upload-grid',
    thumb: 'ami-thumb',
    file: 'ami-file',
    chip: 'ami-chip',
    quickReplyBtn: 'ami-quick-reply-btn',
    time: 'ami-time',
    typingBubble: 'ami-typing-bubble'
  },

  // Default user avatar fallback
  defaultAvatar: 'ami-icon-box.png'
};

// Export for both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AmiConfig;
}

export { AmiConfig };
export default AmiConfig;
