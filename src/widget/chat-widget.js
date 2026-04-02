(function() {
  'use strict';

  // Find the script tag to read config
  const scriptTag = document.currentScript;
  const ENDPOINT = scriptTag?.getAttribute('data-agent') || '';
  const TITLE = scriptTag?.getAttribute('data-title') || 'Chat';
  const PRIMARY = scriptTag?.getAttribute('data-color') || '#2563eb';
  const POSITION = scriptTag?.getAttribute('data-position') || 'right';
  const GREETING = scriptTag?.getAttribute('data-greeting') || '';

  if (!ENDPOINT) {
    console.error('[aaas-widget] Missing data-agent attribute. Usage: <script src="widget.js" data-agent="https://your-agent-url"></script>');
    return;
  }

  // Generate or retrieve persistent user ID
  function getUserId() {
    let id = localStorage.getItem('aaas_user_id');
    if (!id) {
      id = 'user_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('aaas_user_id', id);
    }
    return id;
  }

  const userId = getUserId();
  let messages = JSON.parse(localStorage.getItem('aaas_messages_' + userId) || '[]');
  let isOpen = false;
  let isLoading = false;

  // ── Styles ──
  const css = `
    #aaas-widget-container * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    #aaas-widget-btn {
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
    #aaas-widget-btn:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 20px rgba(0,0,0,0.25);
    }
    #aaas-widget-btn svg {
      width: 26px;
      height: 26px;
      fill: white;
    }

    #aaas-widget-panel {
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
    #aaas-widget-panel.aaas-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: all;
    }

    .aaas-header {
      padding: 16px 20px;
      background: ${PRIMARY};
      color: white;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .aaas-header-title {
      font-size: 16px;
      font-weight: 600;
    }
    .aaas-header-status {
      font-size: 12px;
      opacity: 0.85;
      margin-top: 2px;
    }
    .aaas-close-btn {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 4px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .aaas-close-btn:hover {
      background: rgba(255,255,255,0.15);
    }
    .aaas-close-btn svg {
      width: 20px;
      height: 20px;
      fill: white;
    }

    .aaas-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #f9fafb;
    }
    .aaas-messages::-webkit-scrollbar {
      width: 4px;
    }
    .aaas-messages::-webkit-scrollbar-thumb {
      background: #d1d5db;
      border-radius: 4px;
    }

    .aaas-msg {
      max-width: 82%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 14px;
      line-height: 1.5;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .aaas-msg-user {
      align-self: flex-end;
      background: ${PRIMARY};
      color: white;
      border-bottom-right-radius: 4px;
    }
    .aaas-msg-agent {
      align-self: flex-start;
      background: white;
      color: #1f2937;
      border: 1px solid #e5e7eb;
      border-bottom-left-radius: 4px;
    }

    .aaas-msg-greeting {
      align-self: center;
      background: transparent;
      color: #6b7280;
      font-size: 13px;
      text-align: center;
      padding: 8px 16px;
      max-width: 90%;
    }

    .aaas-typing {
      align-self: flex-start;
      display: flex;
      gap: 4px;
      padding: 12px 16px;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      border-bottom-left-radius: 4px;
    }
    .aaas-typing-dot {
      width: 7px;
      height: 7px;
      background: #9ca3af;
      border-radius: 50%;
      animation: aaas-bounce 1.2s infinite;
    }
    .aaas-typing-dot:nth-child(2) { animation-delay: 0.15s; }
    .aaas-typing-dot:nth-child(3) { animation-delay: 0.3s; }
    @keyframes aaas-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-4px); }
    }

    .aaas-input-area {
      padding: 12px 16px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      gap: 8px;
      background: white;
      flex-shrink: 0;
    }
    .aaas-input {
      flex: 1;
      border: 1px solid #d1d5db;
      border-radius: 24px;
      padding: 10px 16px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
      background: #f9fafb;
    }
    .aaas-input:focus {
      border-color: ${PRIMARY};
      background: white;
    }
    .aaas-input::placeholder {
      color: #9ca3af;
    }
    .aaas-send-btn {
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
    .aaas-send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .aaas-send-btn svg {
      width: 18px;
      height: 18px;
      fill: white;
    }

    .aaas-powered {
      text-align: center;
      padding: 6px;
      font-size: 11px;
      color: #9ca3af;
      background: white;
      border-top: 1px solid #f3f4f6;
    }
    .aaas-powered a {
      color: #6b7280;
      text-decoration: none;
    }
    .aaas-powered a:hover {
      text-decoration: underline;
    }

    .aaas-error {
      align-self: center;
      color: #ef4444;
      font-size: 12px;
      padding: 4px 12px;
      background: #fef2f2;
      border-radius: 8px;
    }

    @media (max-width: 440px) {
      #aaas-widget-panel {
        width: calc(100vw - 16px);
        height: calc(100vh - 80px);
        bottom: 8px;
        ${POSITION}: 8px;
        border-radius: 12px;
        max-height: none;
      }
      #aaas-widget-btn {
        bottom: 16px;
        ${POSITION}: 16px;
      }
    }
  `;

  // ── Build DOM ──
  const container = document.createElement('div');
  container.id = 'aaas-widget-container';

  const style = document.createElement('style');
  style.textContent = css;
  container.appendChild(style);

  // Chat button
  const btn = document.createElement('button');
  btn.id = 'aaas-widget-btn';
  btn.setAttribute('aria-label', 'Open chat');
  btn.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>`;
  container.appendChild(btn);

  // Chat panel
  const panel = document.createElement('div');
  panel.id = 'aaas-widget-panel';
  panel.innerHTML = `
    <div class="aaas-header">
      <div>
        <div class="aaas-header-title">${escapeHtml(TITLE)}</div>
        <div class="aaas-header-status">Online</div>
      </div>
      <button class="aaas-close-btn" aria-label="Close chat">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
    <div class="aaas-messages" id="aaas-messages"></div>
    <div class="aaas-input-area">
      <input class="aaas-input" id="aaas-input" type="text" placeholder="Type a message..." autocomplete="off" />
      <button class="aaas-send-btn" id="aaas-send-btn" aria-label="Send">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
    <div class="aaas-powered">Powered by <a href="https://github.com/streetai/aaas" target="_blank" rel="noopener">AaaS</a></div>
  `;
  container.appendChild(panel);

  document.body.appendChild(container);

  // ── References ──
  const messagesEl = document.getElementById('aaas-messages');
  const inputEl = document.getElementById('aaas-input');
  const sendBtn = document.getElementById('aaas-send-btn');
  const closeBtn = panel.querySelector('.aaas-close-btn');

  // ── Render ──
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function renderMessages() {
    let html = '';

    if (GREETING && messages.length === 0) {
      html += `<div class="aaas-msg aaas-msg-greeting">${escapeHtml(GREETING)}</div>`;
    }

    for (const msg of messages) {
      if (msg.role === 'error') {
        html += `<div class="aaas-error">${escapeHtml(msg.text)}</div>`;
      } else {
        const cls = msg.role === 'user' ? 'aaas-msg-user' : 'aaas-msg-agent';
        html += `<div class="aaas-msg ${cls}">${escapeHtml(msg.text)}</div>`;
      }
    }

    if (isLoading) {
      html += `<div class="aaas-typing"><div class="aaas-typing-dot"></div><div class="aaas-typing-dot"></div><div class="aaas-typing-dot"></div></div>`;
    }

    messagesEl.innerHTML = html;
    scrollToBottom();
  }

  function saveMessages() {
    // Keep last 100 messages in localStorage
    const toSave = messages.slice(-100);
    try {
      localStorage.setItem('aaas_messages_' + userId, JSON.stringify(toSave));
    } catch (e) {
      // Storage full — clear old messages
      messages = messages.slice(-20);
      localStorage.setItem('aaas_messages_' + userId, JSON.stringify(messages));
    }
  }

  // ── API ──
  async function sendMessage(text) {
    if (!text.trim() || isLoading) return;

    messages.push({ role: 'user', text: text.trim() });
    isLoading = true;
    renderMessages();
    saveMessages();

    inputEl.value = '';
    sendBtn.disabled = true;

    try {
      const resp = await fetch(ENDPOINT.replace(/\/$/, '') + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text.trim(),
          userId: userId,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Server error (${resp.status})`);
      }

      const data = await resp.json();
      messages.push({ role: 'agent', text: data.response || 'No response' });
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
    panel.classList.toggle('aaas-open', isOpen);
    if (isOpen) {
      renderMessages();
      inputEl.focus();
    }
  });

  closeBtn.addEventListener('click', () => {
    isOpen = false;
    panel.classList.remove('aaas-open');
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

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      isOpen = false;
      panel.classList.remove('aaas-open');
    }
  });

  // Initial render
  renderMessages();
})();
