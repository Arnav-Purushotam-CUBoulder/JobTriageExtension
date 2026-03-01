(() => {
  'use strict';

  const DEBOUNCE_MS = 900;
  const MIN_TEXT_CHARS = 250;
  const MAX_PAGE_CHARS = 14000;
  const MAX_PAGE_CONTEXT_CHARS = 56000;
  const MAX_FORM_FIELDS = 180;
  const MAX_FORM_OPTIONS = 30;
  const MAX_CUSTOM_OPTION_SCAN = 220;
  const MAX_FORM_TEXT_CHARS = 220;
  const MAX_KEY_CONTEXT_CHARS = 2200;
  const MAX_APPLICANT_SIGNALS_CHARS = 3600;
  const OPTION_INTERACTION_DELAY_MS = 90;
  const CHOICE_MATCH_MAX_ATTEMPTS = 6;
  const CHOICE_MATCH_RETRY_DELAY_MS = 120;
  const AUTOFILL_MAX_APPLY_PASSES = 3;
  const AUTOFILL_RETRY_DELAY_MS = 320;
  const CHOICE_OPTION_NODE_SELECTOR = [
    '[role="option"]',
    'option',
    '[data-value]',
    '[data-automation-id*="promptOption"]',
    '[data-automation-id*="option"]',
    '[data-automation-id*="menuItem"]'
  ].join(', ');
  const CONTEXT_SPLIT_MARKER = '\n[... omitted middle page content ...]\n';
  const MAX_TITLE_CHARS = 160;
  const MAX_CACHE_ENTRIES = 80;
  const PANEL_TOP_OFFSET_PX = 12;
  const PANEL_RIGHT_OFFSET_PX = 12;
  const JD_SIGNAL_RE = /\b(about the job|about this role|job description|responsibilities|requirements|qualifications|experience|what you'll do|minimum qualifications|preferred qualifications)\b/i;
  const NON_JD_SIGNAL_RE = /\b(people also viewed|people you may know|top applicant|show match details|tailor my resume|create cover letter|messages)\b/i;

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
  let autofillInFlight = false;
  let openProfileInFlight = false;
  const cache = new Map();
  const formFieldRegistry = new Map();

  // Clear stale overlays from previous script versions before creating a fresh one.
  for (const existingRoot of document.querySelectorAll('#jts-root')) {
    existingRoot.remove();
  }

  const host = document.createElement('div');
  host.id = 'jts-root';

  function applyHostPlacement() {
    host.style.setProperty('all', 'initial');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('top', `${PANEL_TOP_OFFSET_PX}px`, 'important');
    host.style.setProperty('right', `${PANEL_RIGHT_OFFSET_PX}px`, 'important');
    host.style.setProperty('bottom', 'auto', 'important');
    host.style.setProperty('left', 'auto', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');
    host.style.setProperty('transform', 'translate3d(0,0,0)', 'important');
  }

  applyHostPlacement();

  const shadow = host.attachShadow({ mode: 'open' });

  function getMountTarget() {
    return document.body || document.documentElement;
  }

  function ensureHostMounted() {
    const target = getMountTarget();
    if (!target) {
      return false;
    }

    for (const existingRoot of document.querySelectorAll('#jts-root')) {
      if (existingRoot !== host) {
        existingRoot.remove();
      }
    }

    if (host.parentNode !== target || !host.isConnected) {
      target.appendChild(host);
    }

    applyHostPlacement();
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
      width: 232px;
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
      padding: 8px 10px;
      background: transparent;
      color: #ffffff;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .panel.compact .status { display: none; }
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
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
    }
    .panel.compact .actions {
      width: 100%;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      align-items: center;
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
    .action-btn:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    .panel.compact .action-btn {
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.35);
      background: rgba(255, 255, 255, 0.14);
      width: 100%;
      min-width: 0;
      text-align: center;
      padding: 6px 8px;
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
  panel.className = 'panel';
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
      <div class="row">
        <div class="label">Employment Type</div>
        <div class="value" id="jts-jobtype"><span class="muted">-</span></div>
      </div>
      <div class="row">
        <div class="label">Applicants</div>
        <div class="value" id="jts-applicants"><span class="muted">-</span></div>
      </div>
      <div class="row">
        <div class="label">Salary Range</div>
        <div class="value" id="jts-salary"><span class="muted">-</span></div>
      </div>
    </div>
    <div class="footer">
      <span class="spinner hide" id="jts-spin"></span>
      <span class="status" id="jts-status">Scanning page...</span>
      <span class="actions">
        <button class="action-btn" id="jts-profile-btn" type="button">Edit Profile</button>
        <button class="action-btn" id="jts-autofill-btn" type="button">AI Fill Form</button>
      </span>
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
    jobType: shadow.getElementById('jts-jobtype'),
    applicants: shadow.getElementById('jts-applicants'),
    salary: shadow.getElementById('jts-salary'),
    spin: shadow.getElementById('jts-spin'),
    status: shadow.getElementById('jts-status'),
    profileBtn: shadow.getElementById('jts-profile-btn'),
    autofillBtn: shadow.getElementById('jts-autofill-btn')
  };

  function truncate(text, maxLen) {
    const value = String(text || '').trim();
    if (!value) return '';
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen - 1)}...`;
  }

  // Keep the full panel visible to avoid compact-mode layout regressions.
  function setCompact(_isCompact) {
    panel.classList.remove('compact');
    ui.profileBtn.textContent = 'Edit Profile';
    ui.autofillBtn.textContent = 'AI Fill Form';
  }

  function setStatus(text, spinning = false) {
    ui.status.textContent = text;
    ui.spin.classList.toggle('hide', !spinning);
  }

  function setPlainValueEl(el, text) {
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
  }

  function normalizeSponsorshipStatus(status) {
    const normalizedStatus = String(status || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');

    if (/^(available|not_available|clearance_required|unknown|not_applicable)$/.test(normalizedStatus)) {
      return normalizedStatus;
    }

    return 'unknown';
  }

  function setSponsorshipValueEl(el, text, status) {
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

    const resolvedStatus = normalizeSponsorshipStatus(status);
    if (resolvedStatus === 'not_applicable') {
      return;
    }

    const pill = document.createElement('span');
    pill.className = 'pill';

    if (resolvedStatus === 'not_available' || resolvedStatus === 'clearance_required') {
      pill.textContent = resolvedStatus === 'clearance_required' ? 'Clearance' : 'No sponsor';
      pill.classList.add('bad');
      el.appendChild(pill);
      return;
    }

    if (resolvedStatus === 'unknown') {
      pill.textContent = 'Unknown';
      pill.classList.add('warn');
      el.appendChild(pill);
      return;
    }

    pill.textContent = 'Sponsor OK';
    pill.classList.add('ok');
    el.appendChild(pill);
  }

  function normalizeEmploymentTypeStatus(status) {
    const normalizedStatus = String(status || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');

    if (/^(full_time|contract|unknown|not_applicable)$/.test(normalizedStatus)) {
      return normalizedStatus;
    }

    return 'unknown';
  }

  function setEmploymentTypeValueEl(el, text, status) {
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

    const resolvedStatus = normalizeEmploymentTypeStatus(status);
    if (resolvedStatus === 'not_applicable') {
      return;
    }

    const pill = document.createElement('span');
    pill.className = 'pill';

    if (resolvedStatus === 'contract') {
      pill.textContent = 'Contract';
      pill.classList.add('bad');
      el.appendChild(pill);
      return;
    }

    if (resolvedStatus === 'full_time') {
      pill.textContent = 'Full-time';
      pill.classList.add('ok');
      el.appendChild(pill);
      return;
    }

    pill.textContent = 'Unknown';
    pill.classList.add('warn');
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

  function scoreCandidateText(text) {
    const value = cleanText(text);
    if (!value) {
      return Number.NEGATIVE_INFINITY;
    }

    let score = Math.min(value.length, 12000);
    if (JD_SIGNAL_RE.test(value)) {
      score += 3500;
    }
    if (NON_JD_SIGNAL_RE.test(value)) {
      score -= 1200;
    }

    const bulletCount = (value.match(/\n(?:-|\*|\u2022)\s+/g) || []).length;
    if (bulletCount >= 3) {
      score += 500;
    }

    return score;
  }

  function pickBestTextFromSelectors(selectors, minChars = 0) {
    let best = '';
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const text = cleanText(node.innerText || '');
        if (!text || text.length < minChars) {
          continue;
        }

        const score = scoreCandidateText(text);
        if (score > bestScore) {
          best = text;
          bestScore = score;
        }
      }
    }

    return best;
  }

  function isLinkedInJobsPage() {
    return /(^|\.)linkedin\.com$/i.test(location.hostname) && /\/jobs(\/|$)/i.test(location.pathname);
  }

  function extractLinkedInJobText() {
    if (!isLinkedInJobsPage()) {
      return '';
    }

    const detailSelectors = [
      '[class*="jobs-search__job-details"]',
      '[class*="job-view-layout"]',
      '[class*="jobs-description"]',
      '[class*="jobs-box__html-content"]',
      '[class*="jobs-details"]',
      '[class*="scaffold-layout__detail"]'
    ];
    const detailText = pickBestTextFromSelectors(detailSelectors, 140);
    if (detailText.length >= MIN_TEXT_CHARS) {
      return detailText;
    }

    const heading = Array.from(document.querySelectorAll('h1,h2,h3,h4,strong,span'))
      .find((el) => /about the job|about this role|job description/i.test(cleanText(el.textContent || '')));

    if (heading) {
      const section = heading.closest('section,article,main,div') || heading.parentElement;
      const sectionText = cleanText(section?.innerText || '');
      if (sectionText.length > detailText.length) {
        return sectionText;
      }
    }

    return detailText;
  }

  function extractLikelyPageText() {
    const linkedInText = extractLinkedInJobText();
    if (linkedInText.length >= MIN_TEXT_CHARS) {
      return linkedInText;
    }

    const selectors = [
      '[class*="job-description"]',
      '[id*="job-description"]',
      '[class*="jobdetails"]',
      '[id*="jobdetails"]',
      '[class*="job-details"]',
      '[id*="job-details"]',
      '[class*="description"]',
      '[id*="description"]',
      'article',
      'main',
      '[role="main"]'
    ];

    let best = pickBestTextFromSelectors(selectors, 120);

    if (best.length < MIN_TEXT_CHARS) {
      const bodyText = cleanText(document.body?.innerText || '');
      if (scoreCandidateText(bodyText) > scoreCandidateText(best)) {
        best = bodyText;
      }
    }

    return best;
  }

  function buildPageContextText(fullPageText) {
    const text = cleanText(fullPageText);
    if (!text) {
      return '';
    }

    if (text.length <= MAX_PAGE_CONTEXT_CHARS) {
      return text;
    }

    const budget = Math.max(0, MAX_PAGE_CONTEXT_CHARS - CONTEXT_SPLIT_MARKER.length);
    const headChars = Math.floor(budget / 2);
    const tailChars = Math.max(0, budget - headChars);
    return `${text.slice(0, headChars)}${CONTEXT_SPLIT_MARKER}${text.slice(-tailChars)}`;
  }

  function extractApplicantSignals(fullPageText) {
    const text = cleanText(fullPageText);
    if (!text) {
      return '';
    }

    const lines = text.split('\n');
    const out = [];
    const seen = new Set();

    const add = (value) => {
      const normalized = cleanText(value).slice(0, 220);
      if (!normalized) {
        return;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push(normalized);
    };

    const applicantLineRe = /\b(applicant|applicants|clicked apply|candidates?\s+who\s+clicked\s+apply|candidate)\b/i;
    for (let i = 0; i < lines.length; i += 1) {
      const line = cleanText(lines[i]);
      if (!line || !applicantLineRe.test(line)) {
        continue;
      }

      add(line);
      if (i > 0 && /\d/.test(lines[i - 1])) {
        add(lines[i - 1]);
      }
      if (i + 1 < lines.length && /\d/.test(lines[i + 1])) {
        add(lines[i + 1]);
      }
      if (i + 2 < lines.length && /\d/.test(lines[i + 2])) {
        add(lines[i + 2]);
      }
    }

    const patterns = [
      /\b(over\s+\d[\d,]*\s+applicants?)\b/gi,
      /\b(\d[\d,]*\+?\s+applicants?)\b/gi,
      /\b(candidates?\s+who\s+clicked\s+apply[\s\S]{0,60}?\b\d[\d,]*\b[\s\S]{0,24}?\btotal\b)\b/gi,
      /\b(\d[\d,]*\b[\s\S]{0,28}?\bpeople\s+clicked\s+apply)\b/gi
    ];

    for (const re of patterns) {
      for (const match of text.matchAll(re)) {
        add(match[1] || match[0]);
      }
    }

    return out.join('\n').slice(0, MAX_APPLICANT_SIGNALS_CHARS);
  }

  function computePageKey(pageTitle, pageText, pageContextText, applicantSignals) {
    const canonicalUrl = `${location.origin}${location.pathname}${location.search}`;
    const primaryHash = keyFromText(String(pageText || '').slice(0, MAX_PAGE_CHARS));
    const context = String(pageContextText || '');
    const contextKey = `${context.slice(0, MAX_KEY_CONTEXT_CHARS)}|${context.slice(-MAX_KEY_CONTEXT_CHARS)}`;
    const contextHash = keyFromText(contextKey);
    const applicantHash = keyFromText(String(applicantSignals || ''));
    return keyFromText(
      `${canonicalUrl}|${pageTitle.slice(0, MAX_TITLE_CHARS)}|${primaryHash}|${contextHash}|${applicantHash}`
    );
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

  function clipText(value, maxLen = MAX_FORM_TEXT_CHARS) {
    const text = cleanText(value);
    if (!text) {
      return '';
    }
    return text.slice(0, maxLen);
  }

  function normalizeFieldText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const US_STATE_NAME_BY_CODE = Object.freeze({
    AL: 'Alabama',
    AK: 'Alaska',
    AZ: 'Arizona',
    AR: 'Arkansas',
    CA: 'California',
    CO: 'Colorado',
    CT: 'Connecticut',
    DE: 'Delaware',
    FL: 'Florida',
    GA: 'Georgia',
    HI: 'Hawaii',
    ID: 'Idaho',
    IL: 'Illinois',
    IN: 'Indiana',
    IA: 'Iowa',
    KS: 'Kansas',
    KY: 'Kentucky',
    LA: 'Louisiana',
    ME: 'Maine',
    MD: 'Maryland',
    MA: 'Massachusetts',
    MI: 'Michigan',
    MN: 'Minnesota',
    MS: 'Mississippi',
    MO: 'Missouri',
    MT: 'Montana',
    NE: 'Nebraska',
    NV: 'Nevada',
    NH: 'New Hampshire',
    NJ: 'New Jersey',
    NM: 'New Mexico',
    NY: 'New York',
    NC: 'North Carolina',
    ND: 'North Dakota',
    OH: 'Ohio',
    OK: 'Oklahoma',
    OR: 'Oregon',
    PA: 'Pennsylvania',
    RI: 'Rhode Island',
    SC: 'South Carolina',
    SD: 'South Dakota',
    TN: 'Tennessee',
    TX: 'Texas',
    UT: 'Utah',
    VT: 'Vermont',
    VA: 'Virginia',
    WA: 'Washington',
    WV: 'West Virginia',
    WI: 'Wisconsin',
    WY: 'Wyoming',
    DC: 'District Of Columbia'
  });

  const US_STATE_CODE_BY_NAME = Object.freeze(
    Object.fromEntries(
      Object.entries(US_STATE_NAME_BY_CODE).map(([code, name]) => [normalizeFieldText(name), code])
    )
  );

  const MONTH_NAME_BY_KEY = Object.freeze({
    jan: 'January',
    january: 'January',
    feb: 'February',
    february: 'February',
    mar: 'March',
    march: 'March',
    apr: 'April',
    april: 'April',
    may: 'May',
    jun: 'June',
    june: 'June',
    jul: 'July',
    july: 'July',
    aug: 'August',
    august: 'August',
    sep: 'September',
    sept: 'September',
    september: 'September',
    oct: 'October',
    october: 'October',
    nov: 'November',
    november: 'November',
    dec: 'December',
    december: 'December'
  });

  function normalizeProfileText(value, maxLen = 800) {
    return clipText(value, maxLen);
  }

  function splitFullNameParts(fullName) {
    const normalized = normalizeProfileText(fullName, 200);
    if (!normalized) {
      return { firstName: '', lastName: '' };
    }

    const parts = normalized.split(/\s+/).filter(Boolean);
    return {
      firstName: parts[0] || '',
      lastName: parts.length > 1 ? parts.slice(1).join(' ') : ''
    };
  }

  function parseMonthYearParts(rawDate) {
    const full = normalizeProfileText(rawDate, 120);
    if (!full) {
      return { full: '', month: '', year: '' };
    }

    const normalized = normalizeFieldText(full);
    const monthToken = normalized.match(
      /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/
    )?.[1] || '';
    const month = monthToken ? MONTH_NAME_BY_KEY[monthToken] || monthToken : '';
    const year = full.match(/\b(19|20)\d{2}\b/)?.[0] || '';

    return { full, month, year };
  }

  function buildFieldIdentityText(field) {
    return normalizeFieldText(
      [
        field?.label,
        field?.name,
        field?.id,
        field?.placeholder,
        field?.autocomplete
      ]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(' ')
    );
  }

  function buildFieldContextText(field) {
    const identity = buildFieldIdentityText(field);
    const question = normalizeFieldText(field?.question || '');
    return `${identity} ${question}`.trim();
  }

  function pickCountryValueForField(rawCountry, field) {
    const countryText = normalizeProfileText(rawCountry, 80);
    const preferred = countryText || 'United States of America';
    const preferredNorm = normalizeFieldText(preferred);
    const usRequested = /\b(united states|usa|u s a|us)\b/.test(preferredNorm);
    const candidates = usRequested
      ? ['United States of America', 'United States', 'USA', 'US']
      : [preferred];

    const options = Array.isArray(field?.options) ? field.options : [];
    if (!options.length) {
      return candidates[0];
    }

    const getLabel = (option) => String(option?.label || option?.value || '').trim();
    const getNorm = (option) => normalizeFieldText(getLabel(option));

    for (const candidate of candidates) {
      const candidateNorm = normalizeFieldText(candidate);
      if (!candidateNorm) {
        continue;
      }

      const exact = options.find((option) => {
        const labelNorm = getNorm(option);
        const valueNorm = normalizeFieldText(option?.value || '');
        return labelNorm === candidateNorm || valueNorm === candidateNorm;
      });
      if (exact) {
        return getLabel(exact);
      }
    }

    if (usRequested) {
      const usPrefixes = ['united states of america', 'united states'];
      for (const prefix of usPrefixes) {
        const prefixNorm = normalizeFieldText(prefix);
        const prefixMatch = options.find((option) => {
          const labelNorm = getNorm(option);
          if (!labelNorm.startsWith(prefixNorm)) {
            return false;
          }
          if (/\bminor outlying\b/.test(labelNorm)) {
            return false;
          }
          return true;
        });
        if (prefixMatch) {
          return getLabel(prefixMatch);
        }
      }
    }

    const best = findBestOptionWithAliases(options, preferred);
    if (best) {
      return String(best.label || best.value || '').trim();
    }

    return candidates[0];
  }

  function pickStateValueForField(rawState, field) {
    const stateText = normalizeProfileText(rawState, 80);
    if (!stateText) {
      return '';
    }

    let code = '';
    let name = '';

    const compact = stateText.replace(/\./g, '').trim();
    if (/^[a-z]{2}$/i.test(compact)) {
      code = compact.toUpperCase();
      name = US_STATE_NAME_BY_CODE[code] || '';
    } else {
      const maybeCode = US_STATE_CODE_BY_NAME[normalizeFieldText(stateText)] || '';
      if (maybeCode) {
        code = maybeCode;
        name = US_STATE_NAME_BY_CODE[maybeCode] || '';
      }
    }

    const options = Array.isArray(field?.options) ? field.options : [];
    const candidates = [stateText, name, code].filter(Boolean);
    if (options.length) {
      for (const candidate of candidates) {
        const option = findBestOption(options, candidate);
        if (option) {
          return String(option.label || option.value || '').trim();
        }
      }
      // Options in dynamic UIs may be partial during initial scan.
      // Fall back to canonical state text so apply-time retry can resolve it.
      return name || code || stateText;
    }

    return name || code || stateText;
  }

  function pickOptionOrRawFieldValue(field, preferredValues) {
    const candidates = Array.isArray(preferredValues)
      ? preferredValues.map((value) => normalizeProfileText(value, 180)).filter(Boolean)
      : [];
    if (!candidates.length) {
      return '';
    }

    const options = Array.isArray(field?.options) ? field.options : [];
    if (!options.length) {
      return candidates[0];
    }

    for (const candidate of candidates) {
      const option = findBestOptionWithAliases(options, candidate);
      if (!option) {
        continue;
      }
      return String(option.label || option.value || '').trim();
    }

    return candidates[0];
  }

  function pickEducationSchoolValue(entry, field) {
    const school = normalizeProfileText(entry?.school || entry?.school_name || entry?.institution, 180);
    const explicitFallback = normalizeProfileText(
      entry?.school_fallback_if_missing || entry?.school_fallback || entry?.school_if_not_found,
      120
    );
    const degreeText = normalizeFieldText(entry?.degree || entry?.education_level || '');
    const implicitFallback = /\bbachelor/.test(degreeText) ? 'Other' : '';
    const fallback = explicitFallback || implicitFallback;
    const options = Array.isArray(field?.options) ? field.options : [];

    if (!options.length) {
      return school || fallback;
    }

    const schoolMatch = school ? findBestOptionWithAliases(options, school) : null;
    if (schoolMatch) {
      return String(schoolMatch.label || schoolMatch.value || '').trim();
    }

    const fallbackMatch = fallback ? findBestOptionWithAliases(options, fallback) : null;
    if (fallbackMatch) {
      return String(fallbackMatch.label || fallbackMatch.value || '').trim();
    }

    return fallback || school;
  }

  function buildSkillsFillValue(field, skills) {
    const normalizedSkills = Array.isArray(skills) ? skills.filter(Boolean) : [];
    if (!normalizedSkills.length) {
      return '';
    }

    const options = Array.isArray(field?.options) ? field.options : [];
    const maxSelect = Math.max(1, Number(field?.max_select || 5));
    if (!options.length) {
      return normalizedSkills.slice(0, maxSelect).join(', ');
    }

    const picks = [];
    const seen = new Set();
    for (const skill of normalizedSkills) {
      const option = findBestOption(options, skill);
      if (!option) {
        continue;
      }

      const value = String(option.label || option.value || '').trim();
      const key = normalizeFieldText(value);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      picks.push(value);

      if (picks.length >= maxSelect) {
        break;
      }
    }

    if (!picks.length) {
      return '';
    }

    return picks.join(', ');
  }

  async function loadAutofillProfileSnapshot() {
    try {
      const resp = await sendRuntimeMessage({ type: 'get-autofill-profile' });
      if (!resp?.ok) {
        return null;
      }
      const profile = resp?.data?.profile;
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        return null;
      }
      return profile;
    } catch {
      return null;
    }
  }

  function normalizeFillKey(fill) {
    const fieldId = String(fill?.field_id || '').trim();
    const value = normalizeFieldText(fill?.value || '');
    return `${fieldId}|${value}`;
  }

  function mergeAiAndFallbackFills(aiFills, fallbackFills) {
    const merged = [];
    const seen = new Set();

    const append = (fill) => {
      const fieldId = String(fill?.field_id || '').trim();
      const value = String(fill?.value || '').trim();
      if (!fieldId || !value) {
        return;
      }
      const key = normalizeFillKey({ field_id: fieldId, value });
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push({ field_id: fieldId, value });
    };

    for (const fill of Array.isArray(aiFills) ? aiFills : []) {
      append(fill);
    }

    for (const fill of Array.isArray(fallbackFills) ? fallbackFills : []) {
      append(fill);
    }

    return merged;
  }

  function applyProfileFillConstraints(fills, fields, profile) {
    const safeFills = Array.isArray(fills) ? fills : [];
    const fieldMap = new Map(
      (Array.isArray(fields) ? fields : [])
        .map((field) => [String(field?.field_id || '').trim(), field])
        .filter(([fieldId]) => Boolean(fieldId))
    );

    const middleNameValue = normalizeProfileText(profile?.middle_name || profile?.middleName || '', 80);

    return safeFills.filter((fill) => {
      const fieldId = String(fill?.field_id || '').trim();
      if (!fieldId) {
        return false;
      }

      const field = fieldMap.get(fieldId);
      if (!field) {
        return true;
      }

      const identityContext = buildFieldIdentityText(field);
      if (!identityContext) {
        return true;
      }

      if (!middleNameValue && (/\bmiddle\b(?:\s+\w+){0,2}\s+\bname\b/.test(identityContext) || /\bmiddle_name\b/.test(identityContext))) {
        return false;
      }

      return true;
    });
  }

  function buildRuleBasedAutofillFills(fields, profile) {
    const safeFields = Array.isArray(fields) ? fields : [];
    if (!safeFields.length || !profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return [];
    }

    const fullName = normalizeProfileText(profile.full_name || profile.name, 180);
    const { firstName, lastName } = splitFullNameParts(fullName);
    const skills = Array.isArray(profile.skills)
      ? profile.skills.map((item) => normalizeProfileText(item, 80)).filter(Boolean).slice(0, 60)
      : [];
    const experiences = Array.isArray(profile.experience)
      ? profile.experience.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      : [];
    const educations = Array.isArray(profile.education)
      ? profile.education.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      : [];
    const experienceIndexByType = {
      company: 0,
      title: 0,
      start: 0,
      end: 0,
      description: 0
    };
    const educationIndexByType = {
      school: 0,
      degree: 0,
      discipline: 0,
      start: 0,
      end: 0
    };

    const nextExperienceValue = (bucket, valueFn) => {
      if (!experiences.length) {
        return '';
      }
      const index = Math.min(experienceIndexByType[bucket] || 0, experiences.length - 1);
      experienceIndexByType[bucket] = (experienceIndexByType[bucket] || 0) + 1;
      const entry = experiences[index] || {};
      return normalizeProfileText(valueFn(entry), 800);
    };

    const nextEducationValue = (bucket, valueFn) => {
      if (!educations.length) {
        return '';
      }
      const index = Math.min(educationIndexByType[bucket] || 0, educations.length - 1);
      educationIndexByType[bucket] = (educationIndexByType[bucket] || 0) + 1;
      const entry = educations[index] || {};
      return normalizeProfileText(valueFn(entry), 800);
    };

    const fills = [];
    const used = new Set();

    for (const field of safeFields) {
      const fieldId = String(field?.field_id || '').trim();
      if (!fieldId || used.has(fieldId)) {
        continue;
      }

      const kind = String(field?.kind || '').trim().toLowerCase();
      if (kind === 'checkbox') {
        continue;
      }

      const identityContext = buildFieldIdentityText(field);
      const context = buildFieldContextText(field);
      const primaryContext = identityContext || context;
      if (!primaryContext) {
        continue;
      }
      const isEducationContext = /\b(education|academic|degree|discipline|major|minor|field of study|school|university|college|institution)\b/.test(context);

      let value = '';

      if (/\bemail\b/.test(primaryContext)) {
        value = normalizeProfileText(profile.email, 180);
      } else if (/\b(first|given|forename)\b(?:\s+\w+){0,2}\s+\bname\b/.test(primaryContext) || /\bfirst_name\b/.test(primaryContext)) {
        value = firstName;
      } else if (/\bmiddle\b(?:\s+\w+){0,2}\s+\bname\b/.test(primaryContext) || /\bmiddle_name\b/.test(primaryContext)) {
        value = normalizeProfileText(profile.middle_name || profile.middleName, 80);
      } else if (/\b(last|family|sur)\b(?:\s+\w+){0,2}\s+\bname\b/.test(primaryContext) || /\blast_name\b/.test(primaryContext)) {
        value = lastName;
      } else if (
        /\b(full|legal|preferred)\s+name\b/.test(primaryContext) ||
        (/\bname\b/.test(primaryContext) && !/\b(company|employer|reference|manager|supervisor|school|university|first|middle|last|family|sur)\b/.test(primaryContext))
      ) {
        value = fullName;
      } else if (/\b(phone|mobile|cell|telephone)\b/.test(primaryContext) && !/\b(country|code|extension|ext)\b/.test(primaryContext)) {
        value = normalizeProfileText(profile.phone, 80);
      } else if (/\b(address|street)\b/.test(primaryContext) && !/(\bemail\b|\burl\b|\bwebsite\b)/.test(primaryContext)) {
        const isLine2 =
          /\baddress(?:\s+line)?\s*(2|ii|second)\b/.test(primaryContext) ||
          /\b(line\s*2|apt|apartment|suite|unit|address2)\b/.test(primaryContext);
        value = isLine2
          ? normalizeProfileText(profile.address_line2 || profile.address2, 180)
          : normalizeProfileText(profile.address, 220);
      } else if (/\bcity\b|\btown\b/.test(primaryContext)) {
        value = normalizeProfileText(profile.current_city || profile.city, 120);
      } else if (/\bstate\b|\bprovince\b|\bregion\b/.test(primaryContext)) {
        value = pickStateValueForField(profile.current_state || profile.state, field);
      } else if (/\bpostal\b|\bzip\b/.test(primaryContext)) {
        value = normalizeProfileText(profile.postal_code || profile.zip_code || profile.zip, 24);
      } else if (/\bcountry\b/.test(primaryContext)) {
        value = pickCountryValueForField(profile.country, field);
      } else if (/\blinkedin\b/.test(primaryContext)) {
        value = normalizeProfileText(profile.linkedin, 220);
      } else if (/\bgithub\b/.test(primaryContext)) {
        value = normalizeProfileText(profile.github, 220);
      } else if (
        /\b(portfolio|personal site|website|homepage|url|site)\b/.test(primaryContext) &&
        !/\b(company|employer|linkedin|github)\b/.test(primaryContext)
      ) {
        value = normalizeProfileText(profile.portfolio || profile.website, 220);
      } else if (
        /\b(work authorization|authorized to work|work permit|visa|sponsorship|sponsor|clearance|citizen|citizenship)\b/.test(context)
      ) {
        value = normalizeProfileText(profile.work_authorization, 300);
      } else if (
        /\b(school|university|college|institution)\b/.test(primaryContext) &&
        isEducationContext
      ) {
        value = nextEducationValue('school', (entry) => pickEducationSchoolValue(entry, field));
      } else if (
        /\bdegree\b/.test(primaryContext) &&
        !/\b(proficiency|angle|temperature)\b/.test(primaryContext) &&
        isEducationContext
      ) {
        value = nextEducationValue('degree', (entry) => pickOptionOrRawFieldValue(field, [entry.degree]));
      } else if (
        /\b(discipline|major|field of study|speciali[sz]ation|program)\b/.test(primaryContext) &&
        isEducationContext
      ) {
        value = nextEducationValue('discipline', (entry) => pickOptionOrRawFieldValue(field, [entry.discipline, entry.major]));
      } else if (
        /\bstart\b/.test(primaryContext) &&
        /\b(date|month|year)\b/.test(primaryContext) &&
        isEducationContext
      ) {
        value = nextEducationValue('start', (entry) => {
          const parsed = parseMonthYearParts(entry.start_date);
          if (/\bmonth\b/.test(primaryContext) && parsed.month) {
            return parsed.month;
          }
          if (/\byear\b/.test(primaryContext) && parsed.year) {
            return parsed.year;
          }
          return parsed.full;
        });
      } else if (
        /\bend\b/.test(primaryContext) &&
        /\b(date|month|year|present|current)\b/.test(primaryContext) &&
        isEducationContext
      ) {
        value = nextEducationValue('end', (entry) => {
          const parsed = parseMonthYearParts(entry.end_date);
          if (/\bmonth\b/.test(primaryContext) && parsed.month) {
            return parsed.month;
          }
          if (/\byear\b/.test(primaryContext) && parsed.year) {
            return parsed.year;
          }
          return parsed.full;
        });
      } else if (
        /\b(skill|skills|technology|technologies|tech stack|programming language|expertise|tools)\b/.test(primaryContext)
      ) {
        value = buildSkillsFillValue(field, skills) || skills.slice(0, 12).join(', ');
      } else if (
        /\b(company|employer|organization|organisation)\b/.test(primaryContext) &&
        /\b(experience|employment|work|history|current|previous|recent|role|position)\b/.test(primaryContext)
      ) {
        value = nextExperienceValue('company', (entry) => entry.company_name || entry.company || entry.employer);
      } else if (
        /\b(job title|title|position|role)\b/.test(primaryContext) &&
        /\b(experience|employment|work|history|current|previous|recent|company)\b/.test(primaryContext)
      ) {
        value = nextExperienceValue('title', (entry) => entry.role_title || entry.title || entry.position);
      } else if (/\bstart\b/.test(primaryContext) && /\b(date|month|year)\b/.test(primaryContext)) {
        value = nextExperienceValue('start', (entry) => {
          const parsed = parseMonthYearParts(entry.start_date);
          if (/\bmonth\b/.test(primaryContext) && parsed.month) {
            return parsed.month;
          }
          if (/\byear\b/.test(primaryContext) && parsed.year) {
            return parsed.year;
          }
          return parsed.full;
        });
      } else if (/\bend\b/.test(primaryContext) && /\b(date|month|year|present|current)\b/.test(primaryContext)) {
        value = nextExperienceValue('end', (entry) => {
          const parsed = parseMonthYearParts(entry.end_date);
          if (/\bmonth\b/.test(primaryContext) && parsed.month) {
            return parsed.month;
          }
          if (/\byear\b/.test(primaryContext) && parsed.year) {
            return parsed.year;
          }
          return parsed.full;
        });
      } else if (
        /\b(description|summary|responsibilit|achievement|accomplishment|bullet|dutie)\b/.test(primaryContext) &&
        /\b(experience|employment|work|history|role|position|company)\b/.test(primaryContext)
      ) {
        value = nextExperienceValue(
          'description',
          (entry) => entry.description || entry.responsibilities || entry.summary
        );
      }

      const trimmedValue = String(value || '').trim();
      if (!trimmedValue) {
        continue;
      }

      if (
        Array.isArray(field.options) &&
        field.options.length &&
        (kind === 'select' || kind === 'radio_group' || kind === 'combobox')
      ) {
        const option = findBestOptionWithAliases(field.options, trimmedValue);
        if (!option && kind !== 'combobox') {
          continue;
        }
        const optionValue = String(option?.label || option?.value || '').trim();
        if (!optionValue && kind !== 'combobox') {
          continue;
        }
        fills.push({ field_id: fieldId, value: optionValue || trimmedValue });
      } else {
        fills.push({ field_id: fieldId, value: trimmedValue });
      }
      used.add(fieldId);
    }

    return fills;
  }

  function getAriaLabelledText(el) {
    const idRefs = String(el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((v) => v.trim())
      .filter(Boolean);

    if (!idRefs.length) {
      return '';
    }

    const text = idRefs
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => node.innerText || node.textContent || '')
      .join(' ');

    return clipText(text);
  }

  function getFieldLabel(el) {
    const ariaLabel = clipText(el.getAttribute('aria-label'));
    if (ariaLabel) {
      return ariaLabel;
    }

    const labelled = getAriaLabelledText(el);
    if (labelled) {
      return labelled;
    }

    const id = el.getAttribute('id');
    if (id) {
      const escapedId = globalThis.CSS?.escape
        ? globalThis.CSS.escape(id)
        : id.replace(/["\\]/g, '\\$&');
      const forLabel = document.querySelector(`label[for="${escapedId}"]`);
      if (forLabel) {
        const text = clipText(forLabel.innerText || forLabel.textContent);
        if (text) {
          return text;
        }
      }
    }

    const parentLabel = el.closest('label');
    if (parentLabel) {
      const text = clipText(parentLabel.innerText || parentLabel.textContent);
      if (text) {
        return text;
      }
    }

    return clipText(el.getAttribute('placeholder'));
  }

  function getFieldQuestion(el) {
    const container = el.closest('fieldset,[role="group"],[class*="question"],[class*="form"],[data-test-form-element]');
    if (!container) {
      return '';
    }
    return clipText(container.innerText || container.textContent, 320);
  }

  function isElementFillable(el) {
    if (!el || el.disabled) {
      return false;
    }

    if (el.readOnly && el.tagName !== 'SELECT') {
      return false;
    }

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isSkippableInputType(type) {
    return /^(hidden|submit|reset|button|image|file)$/i.test(type);
  }

  function buildRadioGroupKey(input, index) {
    const formRef = input.form?.id || input.form?.getAttribute('name') || 'no_form';
    const name = input.getAttribute('name') || input.getAttribute('id') || `radio_${index}`;
    return `${formRef}|${name}`;
  }

  function isElementVisible(el) {
    if (!el) {
      return false;
    }

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function parseMaxSelectionCount(...textParts) {
    const text = textParts
      .map((value) => String(value || ''))
      .join(' ')
      .toLowerCase();

    if (!text) {
      return null;
    }

    const upToMatch = text.match(/\b(?:select|choose|pick)?\s*(?:up to|max(?:imum)? of)?\s*(\d{1,2})\b/i);
    if (upToMatch) {
      const count = Number(upToMatch[1]);
      if (Number.isFinite(count) && count >= 1 && count <= 30) {
        return count;
      }
    }

    return null;
  }

  function getListboxIdForControl(control) {
    const raw = `${control.getAttribute('aria-controls') || ''} ${control.getAttribute('aria-owns') || ''}`;
    const ids = raw
      .split(/\s+/)
      .map((v) => v.trim())
      .filter(Boolean);

    for (const id of ids) {
      const node = document.getElementById(id);
      if (!node) {
        continue;
      }
      if (node.getAttribute('role') === 'listbox' || node.querySelector('[role="option"], option')) {
        return id;
      }
    }

    return '';
  }

  function collectOptionsFromContainer(container) {
    if (!container) {
      return [];
    }

    const out = [];
    const seen = new Set();
    const nodes = Array.from(container.querySelectorAll(CHOICE_OPTION_NODE_SELECTOR)).slice(0, MAX_CUSTOM_OPTION_SCAN);

    for (const node of nodes) {
      const label = clipText(node.innerText || node.textContent || '', 120);
      const value = clipText(
        node.getAttribute('value') ||
        node.getAttribute('data-value') ||
        label,
        120
      );
      if (!label && !value) {
        continue;
      }

      const key = `${normalizeFieldText(label)}|${normalizeFieldText(value)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ label, value });

      if (out.length >= MAX_FORM_OPTIONS) {
        break;
      }
    }

    return out;
  }

  function collectFormFields() {
    formFieldRegistry.clear();

    const fields = [];
    const radiosByGroup = new Map();
    const registeredControls = new WeakSet();
    const controls = Array.from(document.querySelectorAll('input,textarea,select'));
    let nextId = 1;

    for (let i = 0; i < controls.length; i += 1) {
      if (fields.length >= MAX_FORM_FIELDS) {
        break;
      }

      const el = controls[i];
      if (!isElementFillable(el)) {
        continue;
      }

      const tag = el.tagName.toLowerCase();
      const name = clipText(el.getAttribute('name'), 120);
      const id = clipText(el.getAttribute('id'), 120);
      const placeholder = clipText(el.getAttribute('placeholder'), 140);
      const autocomplete = clipText(el.getAttribute('autocomplete'), 80);
      const label = getFieldLabel(el);
      const question = getFieldQuestion(el);
      const required = Boolean(el.required || el.getAttribute('aria-required') === 'true');

      if (tag === 'input') {
        const inputType = String(el.getAttribute('type') || 'text').toLowerCase();
        if (isSkippableInputType(inputType)) {
          continue;
        }

        const role = String(el.getAttribute('role') || '').toLowerCase();
        const hasListboxPopup = String(el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox';
        if ((role === 'combobox' || hasListboxPopup) && inputType !== 'checkbox' && inputType !== 'radio') {
          continue;
        }

        if (inputType === 'radio') {
          const key = buildRadioGroupKey(el, i);
          if (!radiosByGroup.has(key)) {
            radiosByGroup.set(key, {
              name,
              label,
              question,
              required,
              inputs: []
            });
          }

          const bucket = radiosByGroup.get(key);
          bucket.inputs.push(el);
          if (!bucket.label && label) {
            bucket.label = label;
          }
          if (!bucket.question && question) {
            bucket.question = question;
          }
          bucket.required = bucket.required || required;
          continue;
        }

        const fieldId = `f_${nextId++}`;
        const kind = inputType === 'checkbox' ? 'checkbox' : 'text';

        fields.push({
          field_id: fieldId,
          kind,
          tag,
          input_type: inputType,
          label,
          question,
          name,
          id,
          placeholder,
          autocomplete,
          required,
          current_value: kind === 'checkbox' ? (el.checked ? 'checked' : 'unchecked') : clipText(el.value, 140)
        });

        formFieldRegistry.set(fieldId, { kind, element: el, inputType });
        registeredControls.add(el);
        continue;
      }

      if (tag === 'textarea') {
        const role = String(el.getAttribute('role') || '').toLowerCase();
        const hasListboxPopup = String(el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox';
        if (role === 'combobox' || hasListboxPopup) {
          continue;
        }

        const fieldId = `f_${nextId++}`;
        fields.push({
          field_id: fieldId,
          kind: 'text',
          tag,
          input_type: 'textarea',
          label,
          question,
          name,
          id,
          placeholder,
          autocomplete,
          required,
          current_value: clipText(el.value, 140)
        });
        formFieldRegistry.set(fieldId, { kind: 'text', element: el, inputType: 'textarea' });
        registeredControls.add(el);
        continue;
      }

      if (tag === 'select') {
        const fieldId = `f_${nextId++}`;
        const options = Array.from(el.options)
          .slice(0, MAX_FORM_OPTIONS)
          .map((option) => ({
            label: clipText(option.textContent || option.label, 120),
            value: clipText(option.value, 120)
          }))
          .filter((option) => option.label || option.value);

        fields.push({
          field_id: fieldId,
          kind: 'select',
          tag,
          input_type: 'select',
          label,
          question,
          name,
          id,
          placeholder,
          autocomplete,
          required,
          current_value: clipText(el.value, 120),
          options
        });
        formFieldRegistry.set(fieldId, { kind: 'select', element: el, options });
        registeredControls.add(el);
      }
    }

    for (const bucket of radiosByGroup.values()) {
      if (fields.length >= MAX_FORM_FIELDS) {
        break;
      }

      const options = bucket.inputs
        .slice(0, MAX_FORM_OPTIONS)
        .map((input) => {
          const optionLabel = getFieldLabel(input);
          return {
            label: optionLabel || clipText(input.value, 120),
            value: clipText(input.value, 120)
          };
        })
        .filter((option) => option.label || option.value);

      if (!options.length) {
        continue;
      }

      const fieldId = `f_${nextId++}`;
      fields.push({
        field_id: fieldId,
        kind: 'radio_group',
        tag: 'input',
        input_type: 'radio',
        label: bucket.label,
        question: bucket.question,
        name: bucket.name,
        required: bucket.required,
        options
      });

      formFieldRegistry.set(fieldId, { kind: 'radio_group', inputs: bucket.inputs, options });
      for (const input of bucket.inputs) {
        registeredControls.add(input);
      }
    }

    const customChoiceControls = Array.from(
      document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], [role="listbox"][aria-multiselectable="true"]')
    );

    for (const rawControl of customChoiceControls) {
      if (fields.length >= MAX_FORM_FIELDS) {
        break;
      }

      let control = rawControl;
      const rawRole = String(rawControl.getAttribute('role') || '').toLowerCase();

      if (rawRole === 'listbox') {
        const listboxId = rawControl.getAttribute('id');
        if (!listboxId) {
          continue;
        }
        const linkedControl = document.querySelector(
          `[aria-controls~="${listboxId}"], [aria-owns~="${listboxId}"], [aria-labelledby~="${listboxId}"]`
        );
        if (!linkedControl || !isElementFillable(linkedControl)) {
          continue;
        }
        control = linkedControl;
      }

      if (!isElementFillable(control) || registeredControls.has(control)) {
        continue;
      }

      const listboxId = getListboxIdForControl(control);
      const listboxNode = listboxId ? document.getElementById(listboxId) : null;
      const options = collectOptionsFromContainer(listboxNode || control.closest('[role="combobox"], [class*="select"]'));
      const label = getFieldLabel(control);
      const question = getFieldQuestion(control);
      const required = Boolean(control.required || control.getAttribute('aria-required') === 'true');
      const name = clipText(control.getAttribute('name'), 120);
      const id = clipText(control.getAttribute('id'), 120);
      const placeholder = clipText(control.getAttribute('placeholder'), 140);
      const autocomplete = clipText(control.getAttribute('autocomplete'), 80);

      const hasSkillSignal = /\bskill(s)?\b/i.test(`${label} ${question} ${placeholder}`);
      const explicitMax = parseMaxSelectionCount(label, question, placeholder, control.getAttribute('aria-label'));
      const listboxMulti = listboxNode?.getAttribute('aria-multiselectable') === 'true';
      const isMulti = Boolean(listboxMulti || explicitMax > 1 || hasSkillSignal);
      const maxSelect = isMulti ? (explicitMax || 5) : 1;
      const kind = isMulti ? 'multi_select' : 'combobox';
      const currentValue = clipText(control.value || control.innerText || control.textContent || '', 140);

      const fieldId = `f_${nextId++}`;
      fields.push({
        field_id: fieldId,
        kind,
        tag: control.tagName.toLowerCase(),
        input_type: control.getAttribute('type') || kind,
        label,
        question,
        name,
        id,
        placeholder,
        autocomplete,
        required,
        current_value: currentValue,
        options,
        max_select: maxSelect
      });

      formFieldRegistry.set(fieldId, {
        kind,
        element: control,
        options,
        listboxId,
        maxSelect,
        allowFreeText: control.matches('input,textarea,[contenteditable="true"]')
      });
      registeredControls.add(control);
    }

    return fields;
  }

  function parseBooleanValue(value) {
    const normalized = normalizeFieldText(value);
    if (/^(true|yes|y|1|checked|on)$/i.test(normalized)) {
      return true;
    }
    if (/^(false|no|n|0|unchecked|off)$/i.test(normalized)) {
      return false;
    }
    return null;
  }

  function findBestOption(options, desiredValue) {
    if (!Array.isArray(options) || !options.length) {
      return null;
    }

    const desired = normalizeFieldText(desiredValue);
    if (!desired) {
      return null;
    }

    let best = null;
    let bestScore = -1;

    for (const option of options) {
      const labelNorm = normalizeFieldText(option.label);
      const valueNorm = normalizeFieldText(option.value);
      let score = 0;

      if (desired === labelNorm || desired === valueNorm) {
        score = 100;
      } else if (labelNorm && desired.includes(labelNorm)) {
        score = 90;
      } else if (labelNorm && labelNorm.includes(desired)) {
        score = 85;
      } else if (valueNorm && desired.includes(valueNorm)) {
        score = 80;
      } else if (valueNorm && valueNorm.includes(desired)) {
        score = 75;
      }

      if (score > bestScore) {
        best = option;
        bestScore = score;
      }
    }

    return bestScore >= 75 ? best : null;
  }

  function expandDesiredOptionTokens(desiredValue) {
    const raw = String(desiredValue || '').trim();
    if (!raw) {
      return [];
    }

    const out = [];
    const seen = new Set();
    const add = (token) => {
      const value = String(token || '').trim();
      if (!value) {
        return;
      }
      const key = normalizeFieldText(value);
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push(value);
    };

    add(raw);

    const compactCode = raw.replace(/[^a-z]/gi, '').toUpperCase();
    if (/^[A-Z]{2}$/.test(compactCode) && US_STATE_NAME_BY_CODE[compactCode]) {
      add(compactCode);
      add(US_STATE_NAME_BY_CODE[compactCode]);
    }

    const normalizedRaw = normalizeFieldText(raw);
    const mappedCode = US_STATE_CODE_BY_NAME[normalizedRaw];
    if (mappedCode) {
      add(mappedCode);
      add(US_STATE_NAME_BY_CODE[mappedCode] || '');
    }

    return out;
  }

  function findBestOptionWithAliases(options, desiredValue) {
    const candidates = expandDesiredOptionTokens(desiredValue);
    for (const token of candidates) {
      const match = findBestOption(options, token);
      if (match) {
        return match;
      }
    }
    return null;
  }

  function getLiveSelectOptions(selectEl) {
    if (!selectEl || selectEl.tagName?.toLowerCase() !== 'select') {
      return [];
    }

    return Array.from(selectEl.options || [])
      .slice(0, MAX_CUSTOM_OPTION_SCAN)
      .map((option) => ({
        label: clipText(option.textContent || option.label, 120),
        value: clipText(option.value, 120)
      }))
      .filter((option) => option.label || option.value);
  }

  async function findSelectMatchWithRetries(target, desiredValue) {
    for (let attempt = 0; attempt < CHOICE_MATCH_MAX_ATTEMPTS; attempt += 1) {
      const liveOptions = getLiveSelectOptions(target.element);
      const options = liveOptions.length ? liveOptions : (Array.isArray(target.options) ? target.options : []);
      const match = findBestOptionWithAliases(options, desiredValue);
      if (match) {
        return match;
      }

      if (attempt < CHOICE_MATCH_MAX_ATTEMPTS - 1) {
        await sleep(CHOICE_MATCH_RETRY_DELAY_MS * (attempt + 1));
      }
    }

    return null;
  }

  async function findChoiceMatchWithRetries(target, desiredValue) {
    const controlEl = target?.element;
    const canType = Boolean(controlEl?.matches('input,textarea'));

    for (let attempt = 0; attempt < CHOICE_MATCH_MAX_ATTEMPTS; attempt += 1) {
      if (!canType) {
        applyChoiceSearchInput(target, desiredValue);
      }

      const candidates = getChoiceOptionCandidates(target);
      const match = findBestOptionWithAliases(candidates, desiredValue);
      if (match) {
        return match;
      }

      if (attempt < CHOICE_MATCH_MAX_ATTEMPTS - 1) {
        if (controlEl) {
          openChoiceControl(controlEl);
          if (canType) {
            setNativeInputValue(controlEl, desiredValue);
          } else if (controlEl.isContentEditable) {
            setContentEditableValue(controlEl, desiredValue);
          }
        }
        await sleep(CHOICE_MATCH_RETRY_DELAY_MS * (attempt + 1));
      }
    }

    return null;
  }

  function setNativeInputValue(el, nextValue) {
    const prototype = Object.getPrototypeOf(el);
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (valueSetter) {
      valueSetter.call(el, nextValue);
    } else {
      el.value = nextValue;
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function setNativeCheckedValue(el, nextChecked) {
    const prototype = Object.getPrototypeOf(el);
    const checkedSetter = Object.getOwnPropertyDescriptor(prototype, 'checked')?.set;
    if (checkedSetter) {
      checkedSetter.call(el, nextChecked);
    } else {
      el.checked = nextChecked;
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function triggerClick(el) {
    if (!el) {
      return;
    }
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (typeof el.focus === 'function') {
      el.focus();
    }

    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
    }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true }));
    }
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    if (typeof el.click === 'function') {
      el.click();
    }
  }

  function openChoiceControl(controlEl) {
    if (!controlEl) {
      return;
    }

    if (typeof controlEl.focus === 'function') {
      controlEl.focus();
    }
    triggerClick(controlEl);
    controlEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, composed: true }));
  }

  function getElementCenter(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      return { x: 0, y: 0 };
    }
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function pickClosestElement(referenceEl, elements) {
    const candidates = Array.isArray(elements) ? elements.filter(Boolean) : [];
    if (!candidates.length) {
      return null;
    }

    const ref = getElementCenter(referenceEl);
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const el of candidates) {
      const point = getElementCenter(el);
      const dx = point.x - ref.x;
      const dy = point.y - ref.y;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        best = el;
        bestDistance = distance;
      }
    }

    return best;
  }

  function findNearbyChoiceSearchInput(target) {
    const controlEl = target?.element;
    const searchInputs = Array.from(
      document.querySelectorAll(
        'input[type="search"], input[placeholder*="search" i], input[aria-label*="search" i], [role="searchbox"] input'
      )
    ).filter((el) => isElementFillable(el));

    if (!searchInputs.length) {
      return null;
    }

    if (target?.listboxId) {
      const listbox = document.getElementById(target.listboxId);
      if (listbox) {
        const scoped = searchInputs.filter((input) => {
          const container = input.closest('[role="dialog"], [role="listbox"], [class*="popup"], [class*="menu"], [class*="dropdown"]');
          return Boolean(container && container.contains(listbox) || listbox.contains(container));
        });
        if (scoped.length) {
          return pickClosestElement(controlEl, scoped);
        }
      }
    }

    return pickClosestElement(controlEl, searchInputs);
  }

  function applyChoiceSearchInput(target, desiredValue) {
    const searchInput = findNearbyChoiceSearchInput(target);
    if (!searchInput) {
      return false;
    }

    setNativeInputValue(searchInput, desiredValue);
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, composed: true }));
    return true;
  }

  function setContentEditableValue(el, value) {
    if (!el || !el.isContentEditable) {
      return;
    }

    el.textContent = value;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function getChoiceOptionCandidates(target) {
    const root = target.element?.closest('form,[role="dialog"],main') || document;
    const nodes = [];
    const seenNodes = new Set();
    const pushNodes = (candidateNodes) => {
      for (const node of candidateNodes) {
        if (!node || seenNodes.has(node)) {
          continue;
        }
        seenNodes.add(node);
        nodes.push(node);
        if (nodes.length >= MAX_CUSTOM_OPTION_SCAN * 3) {
          break;
        }
      }
    };

    if (target.listboxId) {
      const listbox = document.getElementById(target.listboxId);
      if (listbox) {
        pushNodes(Array.from(listbox.querySelectorAll(CHOICE_OPTION_NODE_SELECTOR)));
      }
    }

    // First pass: scoped container near control.
    pushNodes(Array.from(root.querySelectorAll(CHOICE_OPTION_NODE_SELECTOR)));

    // Second pass: global nodes (Workday and similar UIs often render dropdown portals outside forms).
    pushNodes(Array.from(document.querySelectorAll(CHOICE_OPTION_NODE_SELECTOR)));

    if (!nodes.length) {
      return [];
    }

    const referenceEl = target.element;
    const sortedNodes = referenceEl
      ? nodes
          .map((node) => {
            const point = getElementCenter(node);
            const ref = getElementCenter(referenceEl);
            const distance = Math.hypot(point.x - ref.x, point.y - ref.y);
            return { node, distance };
          })
          .sort((a, b) => a.distance - b.distance)
          .map((entry) => entry.node)
      : nodes;

    const limitedNodes = sortedNodes.slice(0, MAX_CUSTOM_OPTION_SCAN * 2);

    const out = [];
    const seen = new Set();

    for (const node of limitedNodes) {
      if (!isElementVisible(node)) {
        continue;
      }

      const label = clipText(node.innerText || node.textContent || '', 120);
      const value = clipText(
        node.getAttribute('value') ||
        node.getAttribute('data-value') ||
        node.getAttribute('data-automation-id') ||
        label,
        120
      );
      if (!label && !value) {
        continue;
      }

      const key = `${normalizeFieldText(label)}|${normalizeFieldText(value)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ label, value, element: node });

      if (out.length >= MAX_CUSTOM_OPTION_SCAN) {
        break;
      }
    }

    return out;
  }

  function parseDesiredList(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return [];
    }

    const canonical = raw.replace(/\s*\|\s*/g, ',');
    let parts = canonical
      .split(/[\n,;]+/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length <= 1 && /\s+\band\b\s+/i.test(raw)) {
      parts = raw
        .split(/\s+\band\b\s+/i)
        .map((part) => part.trim())
        .filter(Boolean);
    }

    const out = [];
    const seen = new Set();
    for (const part of parts) {
      const normalized = normalizeFieldText(part);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      out.push(part);
    }
    return out;
  }

  async function applyComboboxField(target, value) {
    const controlEl = target.element;
    if (!controlEl) {
      return false;
    }

    openChoiceControl(controlEl);

    if (controlEl.matches('input,textarea')) {
      setNativeInputValue(controlEl, value);
    } else if (controlEl.isContentEditable) {
      setContentEditableValue(controlEl, value);
    }

    await sleep(OPTION_INTERACTION_DELAY_MS);

    const match = await findChoiceMatchWithRetries(target, value);
    if (!match) {
      if (target.allowFreeText && controlEl.matches('input,textarea')) {
        controlEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, composed: true }));
        controlEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true, composed: true }));
        return true;
      }
      if (target.allowFreeText && controlEl.isContentEditable) {
        return true;
      }
      return false;
    }

    triggerClick(match.element);
    await sleep(OPTION_INTERACTION_DELAY_MS);
    return true;
  }

  async function applyMultiSelectField(target, value) {
    const desiredList = parseDesiredList(value);
    if (!desiredList.length) {
      return false;
    }

    const maxSelect = Math.max(1, Number(target.maxSelect || desiredList.length));
    let applied = 0;

    for (const token of desiredList) {
      if (applied >= maxSelect) {
        break;
      }

      openChoiceControl(target.element);

      if (target.element?.matches('input,textarea')) {
        setNativeInputValue(target.element, token);
      } else if (target.element?.isContentEditable) {
        setContentEditableValue(target.element, token);
      }

      await sleep(OPTION_INTERACTION_DELAY_MS);

      const match = await findChoiceMatchWithRetries(target, token);
      if (!match) {
        continue;
      }

      triggerClick(match.element);
      applied += 1;
      await sleep(OPTION_INTERACTION_DELAY_MS);
    }

    return applied > 0;
  }

  async function applyAutofillField(fill) {
    const fieldId = String(fill?.field_id || '').trim();
    const value = String(fill?.value || '').trim();
    if (!fieldId || !value) {
      return false;
    }

    const target = formFieldRegistry.get(fieldId);
    if (!target) {
      return false;
    }

    if (target.kind === 'text') {
      setNativeInputValue(target.element, value);
      return true;
    }

    if (target.kind === 'checkbox') {
      const bool = parseBooleanValue(value);
      if (bool === null) {
        return false;
      }
      setNativeCheckedValue(target.element, bool);
      return true;
    }

    if (target.kind === 'select') {
      const match = await findSelectMatchWithRetries(target, value);
      if (!match) {
        return false;
      }

      const desiredValue = String(match.value || '').trim();
      if (desiredValue) {
        setNativeInputValue(target.element, desiredValue);
      } else {
        const liveOptions = Array.from(target.element.options || []);
        const labelMatch = liveOptions.find(
          (option) => normalizeFieldText(option.textContent || option.label) === normalizeFieldText(match.label)
        );
        if (!labelMatch) {
          return false;
        }
        setNativeInputValue(target.element, labelMatch.value);
      }

      return true;
    }

    if (target.kind === 'radio_group') {
      const options = target.options || [];
      const match = findBestOptionWithAliases(options, value);
      if (!match) {
        return false;
      }

      const radio = target.inputs.find((input) => {
        const optionLabel = getFieldLabel(input);
        return (
          normalizeFieldText(optionLabel) === normalizeFieldText(match.label) ||
          normalizeFieldText(input.value) === normalizeFieldText(match.value)
        );
      });

      if (!radio) {
        return false;
      }

      setNativeCheckedValue(radio, true);
      return true;
    }

    if (target.kind === 'combobox') {
      return await applyComboboxField(target, value);
    }

    if (target.kind === 'multi_select') {
      return await applyMultiSelectField(target, value);
    }

    return false;
  }

  async function applyAutofillFills(fills) {
    const matches = Array.isArray(fills) ? fills : [];
    let applied = 0;
    let pending = matches.slice();

    for (let pass = 0; pass < AUTOFILL_MAX_APPLY_PASSES && pending.length; pass += 1) {
      const nextPending = [];

      for (const fill of pending) {
        if (await applyAutofillField(fill)) {
          applied += 1;
        } else {
          nextPending.push(fill);
        }
      }

      pending = nextPending;
      if (pending.length && pass < AUTOFILL_MAX_APPLY_PASSES - 1) {
        await sleep(AUTOFILL_RETRY_DELAY_MS * (pass + 1));
      }
    }

    return { applied, matched: matches.length, pending: pending.length };
  }

  async function callAutofillMatcher(payload) {
    const resp = await sendRuntimeMessage({ type: 'autofill-form', ...payload });
    if (!resp?.ok) {
      throw new Error(resp?.error || 'Unknown error from worker');
    }
    return resp.data || { fills: [] };
  }

  async function runAutofill() {
    if (autofillInFlight) {
      return;
    }

    autofillInFlight = true;
    ui.autofillBtn.disabled = true;
    const wasCompact = panel.classList.contains('compact');
    const previousTag = ui.tag.textContent;
    const profileSnapshotPromise = loadAutofillProfileSnapshot();
    let fields = [];

    setCompact(true);
    ui.tag.textContent = 'Autofill';
    setStatus('Scanning form fields...', true);

    try {
      fields = collectFormFields();
      if (!fields.length) {
        setStatus('No fillable fields found on this page', false);
        return;
      }

      setStatus(`Matching ${fields.length} fields with AI...`, true);
      const result = await callAutofillMatcher({
        page_url: location.href,
        page_title: getPageTitle().slice(0, MAX_TITLE_CHARS),
        fields
      });

      const aiFills = Array.isArray(result?.fills) ? result.fills : [];
      const profile = await profileSnapshotPromise;
      const fallbackFills = buildRuleBasedAutofillFills(fields, profile);
      let fills = mergeAiAndFallbackFills(aiFills, fallbackFills);
      fills = applyProfileFillConstraints(fills, fields, profile);

      let sourceLabel = 'AI';
      if (!aiFills.length && fallbackFills.length) {
        sourceLabel = 'fallback';
      } else if (aiFills.length && fallbackFills.length) {
        sourceLabel = 'AI + fallback';
      }

      if (!fills.length) {
        setStatus('No confident matches from AI or fallback', false);
        return;
      }

      let outcome = await applyAutofillFills(fills);

      if (outcome.applied <= 0) {
        setStatus('No fields were filled (low confidence)', false);
        return;
      }

      setStatus(`Filled ${outcome.applied}/${outcome.matched} fields (${sourceLabel})`, false);
    } catch (err) {
      console.error('[JTS] autofill error:', err);
      const message = String(err?.message || err || '');
      const profile = await profileSnapshotPromise;
      const fallbackFills = applyProfileFillConstraints(
        buildRuleBasedAutofillFills(fields, profile),
        fields,
        profile
      );
      if (fallbackFills.length) {
        const fallbackOutcome = await applyAutofillFills(fallbackFills);
        if (fallbackOutcome.applied > 0) {
          setStatus(`Filled ${fallbackOutcome.applied}/${fallbackOutcome.matched} fields (fallback)`, false);
          return;
        }
      }

      if (/profile|profile\.local\.json|form profile/i.test(message)) {
        setStatus('Set profile via Edit Profile', false);
      } else if (/missing openai api key|openai_api_key|\.env|environment variable/i.test(message)) {
        setStatus('Set OPENAI_API_KEY in .env', false);
      } else {
        setStatus('Autofill error (see console)', false);
      }
    } finally {
      autofillInFlight = false;
      ui.autofillBtn.disabled = false;
      if (!wasCompact) {
        setCompact(false);
        ui.tag.textContent = previousTag;
      }
    }
  }

  async function openProfileEditor() {
    if (openProfileInFlight) {
      return;
    }

    openProfileInFlight = true;
    ui.profileBtn.disabled = true;

    try {
      const resp = await sendRuntimeMessage({ type: 'open-profile-editor' });
      if (!resp?.ok) {
        throw new Error(resp?.error || 'Could not open profile editor');
      }

      const url = String(resp?.url || '').trim();
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }

      setStatus('Profile editor opened', false);
    } catch (err) {
      console.error('[JTS] open profile editor error:', err);
      setStatus('Could not open profile editor', false);
    } finally {
      openProfileInFlight = false;
      ui.profileBtn.disabled = false;
    }
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

    if (!isJobDescription) {
      setCompact(true);
      ui.tag.textContent = 'Not JD';
      ui.title.textContent = '';
      setPlainValueEl(ui.sponsorship, '-');
      setPlainValueEl(ui.years, '-');
      setPlainValueEl(ui.jobType, '-');
      setPlainValueEl(ui.applicants, '-');
      setPlainValueEl(ui.salary, '-');
      setStatus('Not a job description', false);
      return;
    }

    setCompact(false);
    ui.tag.textContent = 'Job page';
    ui.title.textContent = truncate(pageTitle || 'Job description', MAX_TITLE_CHARS);
    setSponsorshipValueEl(
      ui.sponsorship,
      result.sponsorship_or_clearance || 'Not mentioned',
      result.sponsorship_status
    );
    setPlainValueEl(ui.years, result.years_experience || 'Not mentioned');
    setEmploymentTypeValueEl(
      ui.jobType,
      result.employment_type || 'Not mentioned',
      result.employment_type_status
    );
    setPlainValueEl(ui.applicants, result.applicants_count || 'Not mentioned');
    setPlainValueEl(ui.salary, result.salary_range || 'Not mentioned');
    setStatus('Job description detected', false);
  }

  async function checkAndAnalyze() {
    if (!ensureHostMounted()) {
      return;
    }

    const pageText = extractLikelyPageText();
    const fullPageText = cleanText(document.body?.innerText || '');
    const pageContextText = buildPageContextText(fullPageText);
    const applicantSignals = extractApplicantSignals(fullPageText);
    const pageTitle = getPageTitle();
    const modelKeyText = pageText || pageContextText || applicantSignals;

    if (!modelKeyText || modelKeyText.length < MIN_TEXT_CHARS) {
      setCompact(true);
      ui.tag.textContent = 'Page scan';
      ui.title.textContent = '';
      setStatus('Waiting for text...', false);
      return;
    }

    const pageKey = computePageKey(pageTitle, pageText, pageContextText, applicantSignals);

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
    setStatus('Analyzing page...', true);
    inFlightPageKey = pageKey;

    try {
      const result = await callOpenAI({
        page_url: location.href,
        page_title: pageTitle.slice(0, MAX_TITLE_CHARS),
        page_text: pageText.slice(0, MAX_PAGE_CHARS),
        page_context_text: pageContextText,
        page_applicant_signals: applicantSignals
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

      if (/missing openai api key|openai_api_key|\.env|environment variable/i.test(message)) {
        ui.tag.textContent = 'Config';
        setStatus('Set OPENAI_API_KEY in .env', false);
      } else {
        ui.tag.textContent = 'Error';
        setStatus('API error (see console)', false);
      }
    } finally {
      if (inFlightPageKey === pageKey) {
        inFlightPageKey = null;
      }
    }
  }

  ui.autofillBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void runAutofill();
  });

  ui.profileBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openProfileEditor();
  });

  hookHistory();

  const observer = new MutationObserver(() => {
    ensureHostMounted();
    debounce(checkAndAnalyze, DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', applyHostPlacement, { passive: true });
  window.addEventListener('scroll', applyHostPlacement, { passive: true });
  window.addEventListener('locationchange', () => debounce(checkAndAnalyze, 150));

  debounce(checkAndAnalyze, 400);
})();
