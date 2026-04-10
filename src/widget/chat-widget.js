(function() {
  'use strict';

  // Find the script tag to read config
  const scriptTag = document.currentScript;
  const ENDPOINT = scriptTag?.getAttribute('data-agent') || '';
  const TITLE_OVERRIDE = scriptTag?.getAttribute('data-title') || '';
  const PRIMARY = scriptTag?.getAttribute('data-color') || '#2563eb';
  const POSITION = scriptTag?.getAttribute('data-position') || 'right';
  const GREETING = scriptTag?.getAttribute('data-greeting') || '';

  if (!ENDPOINT) {
    console.error('[aaas-widget] Missing data-agent attribute. Usage: <script src="widget.js" data-agent="https://your-agent-url"></script>');
    return;
  }

  // Derive a short stable key from the endpoint to scope storage per agent
  const agentKey = ENDPOINT.replace(/[^a-zA-Z0-9]/g, '_').slice(-60);

  // Generate or retrieve persistent user ID (scoped per agent)
  function getUserId() {
    const storageKey = 'aaas_user_id_' + agentKey;
    let id = localStorage.getItem(storageKey);
    if (!id) {
      id = 'user_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(storageKey, id);
    }
    return id;
  }

  const userId = getUserId();
  let messages = JSON.parse(localStorage.getItem('aaas_messages_' + agentKey + '_' + userId) || '[]');
  let isOpen = false;
  let isLoading = false;
  let isExpanded = false;

  // ── Styles (scoped inside Shadow DOM) ──
  const css = `
    :host {
      all: initial;
      position: fixed;
      z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #1f2937;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    .widget-btn {
      position: fixed;
      bottom: 20px;
      ${POSITION}: 20px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: ${PRIMARY};
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99999;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .widget-btn:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 20px rgba(0,0,0,0.25);
    }
    .widget-btn svg {
      width: 26px;
      height: 26px;
      fill: white;
    }

    .panel {
      position: fixed;
      bottom: 88px;
      ${POSITION}: 20px;
      width: 380px;
      max-width: calc(100vw - 32px);
      height: 520px;
      max-height: calc(100vh - 120px);
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.16);
      z-index: 99998;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      opacity: 0;
      transform: translateY(16px) scale(0.96);
      pointer-events: none;
      transition: opacity 0.25s ease, transform 0.25s ease;
    }
    .panel.open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: all;
    }

    .header {
      padding: 14px 16px;
      background: ${PRIMARY};
      color: white;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(255,255,255,0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      position: relative;
    }
    .header-avatar svg {
      width: 20px;
      height: 20px;
      fill: white;
    }
    .ai-badge {
      position: absolute;
      bottom: -2px;
      right: -2px;
      background: white;
      color: ${PRIMARY};
      font-size: 7px;
      font-weight: 700;
      padding: 1px 3px;
      border-radius: 3px;
      line-height: 1;
      letter-spacing: 0.5px;
    }
    .header-info {
      display: flex;
      flex-direction: column;
    }
    .header-title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 15px;
      font-weight: 600;
      color: white;
      line-height: 1.3;
    }
    .header-name {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      font-weight: 400;
      color: rgba(255,255,255,0.85);
      line-height: 1.3;
      margin-top: 1px;
    }
    .close-btn {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 4px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
    }
    .close-btn:hover {
      background: rgba(255,255,255,0.15);
    }
    .close-btn svg {
      width: 20px;
      height: 20px;
      fill: white;
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #f9fafb;
    }
    .messages::-webkit-scrollbar {
      width: 4px;
    }
    .messages::-webkit-scrollbar-thumb {
      background: #d1d5db;
      border-radius: 4px;
    }

    .msg {
      max-width: 82%;
      padding: 10px 14px;
      border-radius: 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 400;
      line-height: 1.5;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .msg-user {
      align-self: flex-end;
      background: ${PRIMARY};
      color: white;
      border-bottom-right-radius: 4px;
      white-space: pre-wrap;
    }
    .msg-agent {
      align-self: flex-start;
      background: white;
      color: #1f2937;
      border: 1px solid #e5e7eb;
      border-bottom-left-radius: 4px;
      white-space: normal;
    }
    .msg-agent p {
      margin: 0;
    }
    .msg-agent p + p {
      margin-top: 8px;
    }
    .msg-agent strong { font-weight: 600; }
    .msg-agent em { font-style: italic; }
    .msg-agent a {
      color: ${PRIMARY};
      text-decoration: underline;
      word-break: break-word;
    }
    .msg-agent code {
      font-family: 'SF Mono', Menlo, Monaco, 'Courier New', monospace;
      font-size: 12.5px;
      background: #f3f4f6;
      padding: 1px 5px;
      border-radius: 4px;
      color: #db2777;
    }
    .msg-agent pre {
      background: #f3f4f6;
      padding: 10px 12px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 6px 0;
    }
    .msg-agent pre code {
      background: transparent;
      padding: 0;
      color: #1f2937;
      font-size: 12px;
      line-height: 1.5;
    }
    .msg-agent ul, .msg-agent ol {
      margin: 4px 0;
      padding-left: 20px;
    }
    .msg-agent li {
      margin: 2px 0;
    }
    .msg-agent h1, .msg-agent h2, .msg-agent h3 {
      font-weight: 600;
      margin: 6px 0 4px;
      line-height: 1.3;
    }
    .msg-agent h1 { font-size: 16px; }
    .msg-agent h2 { font-size: 15px; }
    .msg-agent h3 { font-size: 14px; }
    .msg-agent blockquote {
      border-left: 3px solid #e5e7eb;
      padding-left: 10px;
      color: #6b7280;
      margin: 4px 0;
    }

    .msg-greeting {
      align-self: center;
      background: transparent;
      color: #6b7280;
      font-size: 13px;
      text-align: center;
      padding: 8px 16px;
      max-width: 90%;
    }

    .msg-files {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 6px;
    }
    .msg-files:first-child {
      margin-top: 0;
    }
    .msg-img {
      max-width: 100%;
      border-radius: 8px;
      cursor: pointer;
      display: block;
    }
    .msg-audio {
      width: 100%;
      height: 36px;
      border-radius: 8px;
    }
    .msg-video {
      max-width: 100%;
      border-radius: 8px;
      display: block;
    }
    .msg-file {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: rgba(0,0,0,0.04);
      border-radius: 8px;
      text-decoration: none;
      color: inherit;
      font-size: 12px;
    }
    .msg-file:hover {
      background: rgba(0,0,0,0.08);
    }
    .msg-file-icon {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: ${PRIMARY};
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .msg-file-icon svg {
      width: 14px;
      height: 14px;
      fill: white;
    }
    .msg-file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
    }

    .img-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100000;
      cursor: pointer;
    }
    .img-overlay img {
      max-width: 90%;
      max-height: 90%;
      border-radius: 8px;
    }

    .typing {
      align-self: flex-start;
      display: flex;
      gap: 4px;
      padding: 12px 16px;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      border-bottom-left-radius: 4px;
    }
    .typing-dot {
      width: 7px;
      height: 7px;
      background: #9ca3af;
      border-radius: 50%;
      animation: bounce 1.2s infinite;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.15s; }
    .typing-dot:nth-child(3) { animation-delay: 0.3s; }
    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-4px); }
    }

    .input-wrap {
      border-top: 1px solid #e5e7eb;
      background: white;
      flex-shrink: 0;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 16px 0;
    }
    .chips:empty {
      display: none;
    }
    .chip {
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 180px;
      padding: 4px 6px 4px 8px;
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      font-size: 12px;
      color: #1f2937;
    }
    .chip.uploading { opacity: 0.6; }
    .chip.error { background: #fef2f2; border-color: #fecaca; color: #ef4444; }
    .chip-name {
      max-width: 130px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip-x {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: none;
      background: #d1d5db;
      color: white;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .chip-x:hover { background: #9ca3af; }
    .input-area {
      padding: 12px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .attach-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #f3f4f6;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: #6b7280;
    }
    .attach-btn:hover { background: #e5e7eb; }
    .attach-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .attach-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; }
    .input {
      flex: 1;
      border: 1px solid #d1d5db;
      border-radius: 24px;
      padding: 10px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 400;
      color: #1f2937;
      outline: none;
      transition: border-color 0.15s;
      background: #f9fafb;
      line-height: 1.5;
      -webkit-appearance: none;
      appearance: none;
    }
    .input:focus {
      border-color: ${PRIMARY};
      background: white;
    }
    .input::placeholder {
      color: #9ca3af;
    }
    .send-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: ${PRIMARY};
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: opacity 0.15s;
    }
    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .send-btn svg {
      width: 18px;
      height: 18px;
      fill: white;
    }

    .powered {
      text-align: center;
      padding: 6px 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11px;
      font-weight: 400;
      color: #9ca3af;
      background: white;
      border-top: 1px solid #f3f4f6;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }
    .powered a {
      color: #6b7280;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-weight: 500;
    }
    .powered a:hover {
      text-decoration: underline;
    }
    .powered img {
      width: 13px;
      height: 13px;
      border-radius: 2px;
    }

    .panel.expanded {
      width: 100vw;
      height: 100vh;
      max-width: 100vw;
      max-height: 100vh;
      bottom: 0;
      ${POSITION}: 0;
      border-radius: 0;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .expand-btn {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 4px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
    }
    .expand-btn:hover {
      background: rgba(255,255,255,0.15);
    }
    .expand-btn svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: white;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .error {
      align-self: center;
      color: #ef4444;
      font-size: 12px;
      padding: 4px 12px;
      background: #fef2f2;
      border-radius: 8px;
    }

    .retry-wrap {
      align-self: flex-end;
      margin-top: -6px;
    }
    .retry-btn {
      background: none;
      border: none;
      color: #ef4444;
      font-size: 12px;
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .retry-btn:hover {
      background: #fef2f2;
    }
    .retry-btn svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    @media (max-width: 440px) {
      .panel {
        width: calc(100vw - 16px);
        height: calc(100vh - 80px);
        bottom: 8px;
        ${POSITION}: 8px;
        border-radius: 12px;
        max-height: none;
      }
      .widget-btn {
        bottom: 16px;
        ${POSITION}: 16px;
      }
    }
  `;

  // ── Helper ──
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Minimal markdown renderer (safe — escapes HTML first, then applies markdown)
  function renderMarkdown(src) {
    if (!src) return '';
    // Extract fenced code blocks first so their content isn't processed
    const codeBlocks = [];
    src = src.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push(code.replace(/\n+$/, ''));
      return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
    });

    // Escape HTML
    let html = escapeHtml(src);

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Inline code (before bold/italic so backticks are protected)
    const inlineCodes = [];
    html = html.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return `\u0001IC${inlineCodes.length - 1}\u0001`;
    });

    // Bold (**text** or __text__)
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

    // Italic (*text* or _text_)
    html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    html = html.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Bare URLs
    html = html.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

    // Lists — group consecutive items
    html = html.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (m, items) => {
      const lis = items.trim().split(/\n/).map(l => '<li>' + l.replace(/^[-*] /, '') + '</li>').join('');
      return '\n<ul>' + lis + '</ul>';
    });
    html = html.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m, items) => {
      const lis = items.trim().split(/\n/).map(l => '<li>' + l.replace(/^\d+\. /, '') + '</li>').join('');
      return '\n<ol>' + lis + '</ol>';
    });

    // Paragraphs (split on double newlines, wrap)
    html = html.split(/\n{2,}/).map(block => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (/^<(h[1-3]|ul|ol|blockquote|pre)/.test(trimmed)) return trimmed;
      return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
    }).join('');

    // Restore inline code
    html = html.replace(/\u0001IC(\d+)\u0001/g, (_, i) => '<code>' + escapeHtml(inlineCodes[+i]) + '</code>');

    // Restore code blocks
    html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => '<pre><code>' + escapeHtml(codeBlocks[+i]) + '</code></pre>');

    return html;
  }

  // ── Build Shadow DOM ──
  const host = document.createElement('div');
  host.id = 'aaas-widget-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);

  // Chat button
  const btn = document.createElement('button');
  btn.className = 'widget-btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>`;
  shadow.appendChild(btn);

  // Chat panel
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="header">
      <div class="header-left">
        <div class="header-avatar">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1.07A7 7 0 0 1 14 23h-4a7 7 0 0 1-6.93-4H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2zm-4 13a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>
          <span class="ai-badge">AI</span>
        </div>
        <div class="header-info">
          <div class="header-title" id="agent-title">${TITLE_OVERRIDE ? escapeHtml(TITLE_OVERRIDE) : 'AI Agent'}</div>
          <div class="header-name" id="agent-name">AI Agent</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="expand-btn" id="expand-btn" aria-label="Expand chat">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
        <button class="close-btn" aria-label="Close chat">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </div>
    <div class="messages" id="messages"></div>
    <div class="input-wrap">
      <div class="chips" id="chips"></div>
      <div class="input-area">
        <button class="attach-btn" id="attach-btn" aria-label="Attach file">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <input class="input" id="chat-input" type="text" placeholder="Type a message..." autocomplete="off" />
        <input type="file" id="file-input" style="display:none" accept="image/*,audio/*,video/*,application/pdf,text/plain" multiple />
        <button class="send-btn" id="send-btn" aria-label="Send">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
    <div class="powered">Powered by <a href="https://streetai.org" target="_blank" rel="noopener"><img src="https://streetai.org/logo.png" alt="Street AI" />Street AI</a></div>
  `;
  shadow.appendChild(panel);

  document.body.appendChild(host);

  // ── References (inside shadow) ──
  const messagesEl = shadow.getElementById('messages');
  const inputEl = shadow.getElementById('chat-input');
  const sendBtn = shadow.getElementById('send-btn');
  const attachBtn = shadow.getElementById('attach-btn');
  const fileInput = shadow.getElementById('file-input');
  const chipsEl = shadow.getElementById('chips');
  const closeBtn = shadow.querySelector('.close-btn');
  const expandBtn = shadow.getElementById('expand-btn');

  // Selected files (pending upload + uploaded). Each: {id, file, name, status, url, mimeType, size, error}
  let pendingFiles = [];
  const MAX_FILES = 5;
  const MAX_FILE_BYTES = 20 * 1024 * 1024;

  function typeFromMime(mime) {
    if (!mime) return 'file';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    return 'file';
  }

  function renderChips() {
    chipsEl.innerHTML = pendingFiles.map(f => {
      const cls = f.status === 'error' ? 'chip error' : f.status === 'uploading' ? 'chip uploading' : 'chip';
      const label = f.status === 'uploading' ? 'Uploading…' : f.status === 'error' ? (f.error || 'Failed') : f.name;
      return `<div class="chip ${cls}"><span class="chip-name" title="${escapeHtml(f.name)}">${escapeHtml(label)}</span><button class="chip-x" data-id="${f.id}" aria-label="Remove">×</button></div>`;
    }).join('');
    chipsEl.querySelectorAll('.chip-x').forEach(b => {
      b.addEventListener('click', () => {
        pendingFiles = pendingFiles.filter(f => f.id !== b.dataset.id);
        renderChips();
      });
    });
  }

  async function uploadFile(entry) {
    try {
      const resp = await fetch(ENDPOINT.replace(/\/$/, '') + '/upload', {
        method: 'POST',
        headers: {
          'Content-Type': entry.file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(entry.name),
        },
        body: entry.file,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed (${resp.status})`);
      }
      const data = await resp.json();
      entry.status = 'ready';
      entry.url = data.url;
      entry.mimeType = data.mimeType || entry.file.type;
      entry.size = data.size;
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
    }
    renderChips();
  }

  function handleFiles(fileList) {
    for (const file of fileList) {
      if (pendingFiles.length >= MAX_FILES) break;
      if (file.size > MAX_FILE_BYTES) {
        pendingFiles.push({
          id: Math.random().toString(36).slice(2),
          file, name: file.name,
          status: 'error', error: 'Too large (20 MB max)',
        });
        continue;
      }
      const entry = {
        id: Math.random().toString(36).slice(2),
        file, name: file.name,
        status: 'uploading',
      };
      pendingFiles.push(entry);
      uploadFile(entry);
    }
    renderChips();
  }

  // ── Render ──
  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function renderFileHtml(file) {
    const url = escapeHtml(file.url || '');
    const name = escapeHtml(file.filename || 'file');
    if (file.type === 'image') {
      return `<img class="msg-img" src="${url}" alt="${name}" data-full="${url}" />`;
    }
    if (file.type === 'audio') {
      return `<audio class="msg-audio" controls preload="none"><source src="${url}" type="${escapeHtml(file.mimeType || 'audio/mpeg')}"></audio>`;
    }
    if (file.type === 'video') {
      return `<video class="msg-video" controls preload="none"><source src="${url}" type="${escapeHtml(file.mimeType || 'video/mp4')}"></video>`;
    }
    return `<a class="msg-file" href="${url}" target="_blank" rel="noopener"><span class="msg-file-icon"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg></span><span class="msg-file-name">${name}</span></a>`;
  }

  function renderMessages() {
    let html = '';

    if (GREETING && messages.length === 0) {
      html += `<div class="msg msg-greeting">${escapeHtml(GREETING)}</div>`;
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'error') {
        html += `<div class="error">${escapeHtml(msg.text)}</div>`;
        const isLast = i === messages.length - 1;
        const prevIsUser = i > 0 && messages[i - 1].role === 'user';
        if (isLast && prevIsUser) {
          html += `<div class="retry-wrap"><button class="retry-btn" data-retry="${i}"><svg viewBox="0 0 24 24"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>Retry</button></div>`;
        }
      } else {
        const cls = msg.role === 'user' ? 'msg-user' : 'msg-agent';
        let content = '';
        if (msg.text) {
          content = msg.role === 'agent' ? renderMarkdown(msg.text) : escapeHtml(msg.text);
        }
        if (msg.files && msg.files.length > 0) {
          content += `<div class="msg-files">${msg.files.map(renderFileHtml).join('')}</div>`;
        }
        html += `<div class="msg ${cls}">${content}</div>`;
      }
    }

    if (isLoading) {
      html += `<div class="typing"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;
    }

    messagesEl.innerHTML = html;

    // Image click to expand
    messagesEl.querySelectorAll('.msg-img').forEach(img => {
      img.addEventListener('click', () => {
        const overlay = document.createElement('div');
        overlay.className = 'img-overlay';
        overlay.innerHTML = `<img src="${img.dataset.full}" />`;
        overlay.addEventListener('click', () => overlay.remove());
        shadow.appendChild(overlay);
      });
    });

    // Retry click
    messagesEl.querySelectorAll('.retry-btn').forEach(b => {
      b.addEventListener('click', () => {
        const errIdx = parseInt(b.dataset.retry, 10);
        // Find the user message before this error
        let userMsg = null;
        for (let j = errIdx - 1; j >= 0; j--) {
          if (messages[j].role === 'user') { userMsg = messages[j]; break; }
        }
        // Remove the error
        messages.splice(errIdx, 1);
        saveMessages();
        if (userMsg) {
          // Re-send: remove the user message too, sendMessage will re-add it
          const userIdx = messages.indexOf(userMsg);
          if (userIdx !== -1) messages.splice(userIdx, 1);
          saveMessages();
          // Restore attachments if any
          const text = userMsg.text || '';
          if (userMsg.files && userMsg.files.length > 0) {
            pendingFiles = userMsg.files.map(f => ({
              id: Math.random().toString(36).slice(2),
              file: null, name: f.filename, status: 'ready',
              url: f.url, mimeType: f.mimeType, size: f.size,
            }));
          }
          sendMessage(text);
        } else {
          renderMessages();
        }
      });
    });

    scrollToBottom();
  }

  function saveMessages() {
    const toSave = messages.slice(-100);
    try {
      localStorage.setItem('aaas_messages_' + agentKey + '_' + userId, JSON.stringify(toSave));
    } catch (e) {
      messages = messages.slice(-20);
      localStorage.setItem('aaas_messages_' + agentKey + '_' + userId, JSON.stringify(messages));
    }
  }

  // ── API ──
  async function sendMessage(text) {
    if (isLoading) return;
    const trimmed = (text || '').trim();
    const ready = pendingFiles.filter(f => f.status === 'ready');
    if (!trimmed && ready.length === 0) return;
    if (pendingFiles.some(f => f.status === 'uploading')) return;

    const attachments = ready.map(f => ({
      url: f.url, filename: f.name, mimeType: f.mimeType, size: f.size,
    }));

    const userMsg = { role: 'user', text: trimmed };
    if (attachments.length > 0) {
      userMsg.files = attachments.map(a => ({
        url: a.url, filename: a.filename, mimeType: a.mimeType, type: typeFromMime(a.mimeType),
      }));
    }
    messages.push(userMsg);
    isLoading = true;
    renderMessages();
    saveMessages();

    inputEl.value = '';
    pendingFiles = [];
    renderChips();
    sendBtn.disabled = true;

    try {
      const resp = await fetch(ENDPOINT.replace(/\/$/, '') + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          userId: userId,
          attachments,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${resp.status})`);
      }

      const data = await resp.json();
      const agentMsg = { role: 'agent', text: data.response || 'No response' };
      if (data.files && data.files.length > 0) {
        agentMsg.files = data.files;
      }
      messages.push(agentMsg);
    } catch (err) {
      messages.push({ role: 'error', text: err.message || 'Failed to connect' });
    } finally {
      isLoading = false;
      sendBtn.disabled = false;
      renderMessages();
      saveMessages();
      inputEl.focus();
    }
  }

  // ── Events ──
  btn.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    if (isOpen) {
      renderMessages();
      inputEl.focus();
    }
  });

  closeBtn.addEventListener('click', () => {
    isOpen = false;
    isExpanded = false;
    panel.classList.remove('open', 'expanded');
    btn.style.display = '';
  });

  expandBtn.addEventListener('click', () => {
    isExpanded = !isExpanded;
    panel.classList.toggle('expanded', isExpanded);
    btn.style.display = isExpanded ? 'none' : '';
    // Swap icon: expand ↔ collapse
    expandBtn.innerHTML = isExpanded
      ? '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>'
      : '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
    scrollToBottom();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  sendBtn.addEventListener('click', () => {
    sendMessage(inputEl.value);
  });

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      isOpen = false;
      isExpanded = false;
      panel.classList.remove('open', 'expanded');
      btn.style.display = '';
    }
  });

  // Fetch agent info — use real name as title
  fetch(ENDPOINT.replace(/\/$/, '') + '/info')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data?.name) {
        const titleEl = shadow.getElementById('agent-title');
        const nameEl = shadow.getElementById('agent-name');
        if (!TITLE_OVERRIDE && titleEl) titleEl.textContent = data.name;
        if (nameEl) nameEl.textContent = 'AI Agent';
      }
    })
    .catch(() => {});

  // Initial render
  renderMessages();
})();
