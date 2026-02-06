(() => {
  'use strict';

  const DEBOUNCE_MS = 900;
  const MIN_TEXT_CHARS = 250;
  const MAX_PAGE_CHARS = 14000;
  const MAX_TITLE_CHARS = 160;
  const MAX_CACHE_ENTRIES = 80;

  const extApi = globalThis.browser && globalThis.browser.runtime
    ? globalThis.browser
    : globalThis.chrome;

  if (!extApi?.runtime?.sendMessage) {
    console.warn('[JTS] runtime messaging API is unavailable on this page.');
    return;
  }

  let debounceTimer = null;
  let currentPageKey = null;
  let inFlightPageKey = null;
  let keyPromptInFlight = false;
  const cache = new Map();

  const host = document.createElement('div');
  host.id = 'jts-root';
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.top = '96px';
  host.style.right = '12px';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';

  const shadow = host.attachShadow({ mode: 'open' });

  function getMountTarget() {
    return document.body || document.documentElement;
  }

  function ensureHostMounted() {
    const target = getMountTarget();
    if (!target) {
      return false;
    }

    if (host.parentNode !== target || !host.isConnected) {
      target.appendChild(host);
    }

    return true;
  }

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .panel {
      pointer-events: auto;
      width: 280px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      color: #1f2937;
      background: #ffffffcc;
      backdrop-filter: blur(6px);
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .12);
      overflow: hidden;
      transition: width .22s ease, border-radius .22s ease, background-color .22s ease;
    }
    .panel.compact {
      width: 176px;
      border-radius: 999px;
      background: #111827f0;
      border-color: #111827;
      color: #ffffff;
    }
    .panel.compact .hdr,
    .panel.compact .title,
    .panel.compact .body {
      display: none;
    }
    .panel.compact .footer {
      padding: 10px 12px;
      background: transparent;
      color: #ffffff;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .panel.compact .spinner {
      border-color: rgba(255, 255, 255, 0.3);
      border-top-color: #ffffff;
    }
    .hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: #111827;
      color: #ffffff;
      font-weight: 600;
      letter-spacing: .2px;
    }
    .hdr .tag {
      font-size: 11px;
      opacity: .9;
      font-weight: 500;
    }
    .title {
      padding: 10px 12px 0;
      font-size: 12px;
      color: #374151;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .body { padding: 10px 12px 12px; background: #ffffff; }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px dashed #e5e7eb;
    }
    .row:last-child { border-bottom: 0; }
    .label { color: #6b7280; }
    .value { font-weight: 700; color: #111827; }
    .muted { color: #9ca3af; font-weight: 600; }
    .pill {
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      margin-left: 8px;
    }
    .pill.ok { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
    .pill.warn { background: #fff7ed; color: #9a3412; border: 1px solid #fed7aa; }
    .pill.bad { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .footer {
      padding: 8px 12px;
      background: #f9fafb;
      font-size: 11px;
      color: #6b7280;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status {
      flex: 1 1 auto;
      min-width: 0;
    }
    .action-btn {
      appearance: none;
      border: 1px solid #d1d5db;
      background: #ffffff;
      color: #111827;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      padding: 6px 9px;
      cursor: pointer;
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .action-btn:hover { background: #f3f4f6; }
    .action-btn:active { background: #e5e7eb; }
    .panel.compact .action-btn {
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.35);
      background: rgba(255, 255, 255, 0.14);
    }
    .panel.compact .action-btn:hover { background: rgba(255, 255, 255, 0.22); }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #d1d5db;
      border-top-color: #111827;
      border-radius: 50%;
      animation: spin .8s linear infinite;
      display: inline-block;
      vertical-align: -2px;
      flex: 0 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hide { display: none; }
  `;
  shadow.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel compact';
  panel.innerHTML = `
    <div class="hdr">
      <div>Job Triage</div>
      <div class="tag" id="jts-tag">Page scan</div>
    </div>
    <div class="title" id="jts-title"></div>
    <div class="body">
      <div class="row">
        <div class="label">Sponsorship / Clearance</div>
        <div class="value" id="jts-sponsorship"><span class="muted">-</span></div>
      </div>
      <div class="row">
        <div class="label">Years of Experience</div>
        <div class="value" id="jts-years"><span class="muted">-</span></div>
      </div>
    </div>
    <div class="footer">
      <span class="spinner hide" id="jts-spin"></span>
      <span class="status" id="jts-status">Scanning page...</span>
      <button class="action-btn hide" id="jts-setkey" type="button">Set API key</button>
    </div>
  `;
  shadow.appendChild(panel);

  if (!ensureHostMounted()) {
    document.addEventListener('DOMContentLoaded', ensureHostMounted, { once: true });
  }

  const ui = {
    tag: shadow.getElementById('jts-tag'),
    title: shadow.getElementById('jts-title'),
    sponsorship: shadow.getElementById('jts-sponsorship'),
    years: shadow.getElementById('jts-years'),
    spin: shadow.getElementById('jts-spin'),
    status: shadow.getElementById('jts-status'),
    setKey: shadow.getElementById('jts-setkey')
  };

  function truncate(text, maxLen) {
    const value = String(text || '').trim();
    if (!value) return '';
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen - 1)}...`;
  }

  function setCompact(isCompact) {
    panel.classList.toggle('compact', isCompact);
  }

  function setStatus(text, spinning = false) {
    ui.status.textContent = text;
    ui.spin.classList.toggle('hide', !spinning);
  }

  function showSetKeyAction(show) {
    ui.setKey.classList.toggle('hide', !show);
  }

  function setValueEl(el, text) {
    el.innerHTML = '';
    const normalized = String(text || '').trim();
    if (!normalized || /not applicable/i.test(normalized)) {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = normalized || '-';
      el.appendChild(span);
      return;
    }

    const span = document.createElement('span');
    span.className = 'value';
    span.textContent = normalized;
    el.appendChild(span);

    const t = normalized.toLowerCase();
    const pill = document.createElement('span');
    pill.className = 'pill';

    if (/no sponsor|no sponsorship|unsponsored|no visa|requires clearance|active clearance|secret|ts\/sci|polygraph/.test(t)) {
      pill.textContent = /clearance/.test(t) ? 'Clearance' : 'No sponsor';
      pill.classList.add('bad');
      el.appendChild(pill);
      return;
    }

    if (/not mentioned|unspecified|unknown/.test(t)) {
      pill.textContent = 'Unknown';
      pill.classList.add('warn');
      el.appendChild(pill);
      return;
    }

    pill.textContent = 'OK';
    pill.classList.add('ok');
    el.appendChild(pill);
  }

  function keyFromText(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) - hash) + value.charCodeAt(i);
      hash |= 0;
    }
    return `h${Math.abs(hash)}`;
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\u00A0/g, ' ')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[^\S\n]{2,}/g, ' ')
      .trim();
  }

  function getPageTitle() {
    const h1 = cleanText(document.querySelector('h1')?.textContent || '');
    const docTitle = cleanText(document.title || '');
    if (h1 && docTitle && docTitle.toLowerCase().includes(h1.toLowerCase())) {
      return docTitle;
    }
    return h1 || docTitle || '';
  }

  function extractLikelyPageText() {
    const selectors = [
      '[class*="job-description"]',
      '[id*="job-description"]',
      '[class*="jobdetails"]',
      '[id*="jobdetails"]',
      '[class*="description"]',
      '[id*="description"]',
      'article',
      'main',
      '[role="main"]'
    ];

    let best = '';
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const text = cleanText(node.innerText || '');
        if (text.length > best.length) {
          best = text;
        }
      }
    }

    if (best.length < MIN_TEXT_CHARS) {
      const bodyText = cleanText(document.body?.innerText || '');
      if (bodyText.length > best.length) {
        best = bodyText;
      }
    }

    return best;
  }

  function computePageKey(pageTitle, pageText) {
    const canonicalUrl = `${location.origin}${location.pathname}${location.search}`;
    return keyFromText(`${canonicalUrl}|${pageTitle.slice(0, MAX_TITLE_CHARS)}|${pageText.slice(0, 1800)}`);
  }

  function hookHistory() {
    const push = history.pushState;
    const replace = history.replaceState;

    history.pushState = function (...args) {
      const out = push.apply(this, args);
      window.dispatchEvent(new Event('locationchange'));
      return out;
    };

    history.replaceState = function (...args) {
      const out = replace.apply(this, args);
      window.dispatchEvent(new Event('locationchange'));
      return out;
    };

    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('locationchange'));
    });
  }

  function debounce(fn, ms) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fn, ms);
  }

  async function sendRuntimeMessage(payload) {
    if (globalThis.browser?.runtime?.sendMessage) {
      return globalThis.browser.runtime.sendMessage(payload);
    }

    return new Promise((resolve, reject) => {
      globalThis.chrome.runtime.sendMessage(payload, (resp) => {
        const lastError = globalThis.chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(resp);
      });
    });
  }

  async function callOpenAI(pagePayload) {
    const resp = await sendRuntimeMessage({ type: 'analyze-page', ...pagePayload });
    if (!resp?.ok) {
      throw new Error(resp?.error || 'Unknown error from worker');
    }
    return resp.data;
  }

  function applyResult(result, pageTitle) {
    const isJobDescription = Boolean(result?.is_job_description);
    showSetKeyAction(false);

    if (!isJobDescription) {
      setCompact(true);
      ui.tag.textContent = 'Not JD';
      ui.title.textContent = '';
      setValueEl(ui.sponsorship, '-');
      setValueEl(ui.years, '-');
      setStatus('Not a job description', false);
      return;
    }

    setCompact(false);
    ui.tag.textContent = 'Job page';
    ui.title.textContent = truncate(pageTitle || 'Job description', MAX_TITLE_CHARS);
    setValueEl(ui.sponsorship, result.sponsorship_or_clearance || 'Not mentioned');
    setValueEl(ui.years, result.years_experience || 'Not mentioned');
    setStatus('Job description detected', false);
  }

  async function onSetApiKeyClick() {
    if (keyPromptInFlight) {
      return;
    }

    keyPromptInFlight = true;
    try {
      const input = window.prompt('Paste your OpenAI API key (starts with sk-):', '');
      if (input === null) {
        setStatus('API key setup canceled', false);
        return;
      }

      const apiKey = String(input || '').trim();
      if (!apiKey) {
        setStatus('API key cannot be empty', false);
        return;
      }

      setStatus('Saving API key...', true);
      const resp = await sendRuntimeMessage({ type: 'set-api-key', api_key: apiKey });
      if (!resp?.ok) {
        throw new Error(resp?.error || 'Failed to save API key');
      }

      showSetKeyAction(false);
      setStatus('API key saved. Re-analyzing...', true);
      debounce(checkAndAnalyze, 180);
    } catch (error) {
      console.error('[JTS] set-api-key error:', error);
      showSetKeyAction(true);
      setStatus('Could not save key', false);
    } finally {
      keyPromptInFlight = false;
    }
  }

  async function checkAndAnalyze() {
    if (!ensureHostMounted()) {
      return;
    }

    const pageText = extractLikelyPageText();
    const pageTitle = getPageTitle();

    if (!pageText || pageText.length < MIN_TEXT_CHARS) {
      setCompact(true);
      ui.tag.textContent = 'Page scan';
      ui.title.textContent = '';
      showSetKeyAction(false);
      setStatus('Waiting for text...', false);
      return;
    }

    const pageKey = computePageKey(pageTitle, pageText);

    if (pageKey === currentPageKey && cache.has(pageKey)) {
      return;
    }

    if (pageKey === inFlightPageKey) {
      return;
    }

    currentPageKey = pageKey;

    if (cache.has(pageKey)) {
      applyResult(cache.get(pageKey), pageTitle);
      return;
    }

    setCompact(true);
    ui.tag.textContent = 'Page scan';
    ui.title.textContent = '';
    showSetKeyAction(false);
    setStatus('Analyzing page...', true);
    inFlightPageKey = pageKey;

    try {
      const result = await callOpenAI({
        page_url: location.href,
        page_title: pageTitle.slice(0, MAX_TITLE_CHARS),
        page_text: pageText.slice(0, MAX_PAGE_CHARS)
      });

      if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) {
          cache.delete(oldestKey);
        }
      }

      cache.set(pageKey, result);
      applyResult(result, pageTitle);
    } catch (err) {
      console.error('[JTS] OpenAI error:', err);
      const message = String(err?.message || err || '');
      setCompact(true);

      if (/missing openai api key|set it|set api key/i.test(message)) {
        ui.tag.textContent = 'API key';
        showSetKeyAction(true);
        setStatus('OpenAI key required', false);
      } else {
        ui.tag.textContent = 'Error';
        showSetKeyAction(false);
        setStatus('API error (see console)', false);
      }
    } finally {
      if (inFlightPageKey === pageKey) {
        inFlightPageKey = null;
      }
    }
  }

  hookHistory();

  const observer = new MutationObserver(() => {
    ensureHostMounted();
    debounce(checkAndAnalyze, DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('locationchange', () => debounce(checkAndAnalyze, 150));
  ui.setKey.addEventListener('click', onSetApiKeyClick);

  debounce(checkAndAnalyze, 400);
})();
