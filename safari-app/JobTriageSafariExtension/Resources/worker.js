// worker.js (MV3 service worker)
const OPENAI_MODEL = 'gpt-4.1-mini';
const OPENAI_API_KEY_FALLBACK = '';
const ENV_FILE_PATH = '.env';
const PROFILE_FILE_PATH = 'profile.local.json';
const PROFILE_EDITOR_PAGE_PATH = 'profile-editor.html';
const PROFILE_STORAGE_KEY = 'form_fill_profile_v1';
const OPENAI_TIMEOUT_MS = 45000;
const ENV_LOAD_TIMEOUT_MS = 2500;
const MAX_AUTOFILL_FIELDS = 180;
const MAX_AUTOFILL_OPTIONS = 30;
const ENV_CACHE_TTL_MS = 60_000;

const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
let envValuesPromise = null;
let envValuesLoadedAt = 0;

console.log('[worker] loaded');

if (!runtime) {
  console.error('[worker] runtime API unavailable.');
}

runtime?.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ ok: true, pong: true });
    return false;
  }

  if (msg?.type === 'analyze-page') {
    handleAnalyzePage(msg, sendResponse);
    return true;
  }

  if (msg?.type === 'autofill-form') {
    handleAutofillForm(msg, sendResponse);
    return true;
  }

  if (msg?.type === 'open-profile-editor') {
    handleOpenProfileEditor(sendResponse);
    return true;
  }

  if (msg?.type === 'get-autofill-profile') {
    handleGetAutofillProfile(sendResponse);
    return true;
  }

  if (msg?.type === 'save-autofill-profile') {
    handleSaveAutofillProfile(msg, sendResponse);
    return true;
  }

  if (msg?.type === 'reset-autofill-profile') {
    handleResetAutofillProfile(sendResponse);
    return true;
  }

  return false;
});

function handleAnalyzePage(msg, sendResponse) {
  (async () => {
    try {
      const pageText = String(msg.page_text || '').trim();
      const pageContextText = String(msg.page_context_text || '').trim();
      const pageApplicantSignals = String(msg.page_applicant_signals || '').trim();
      const pageTitle = String(msg.page_title || '').trim();
      const pageUrl = String(msg.page_url || '').trim();
      const analysisText = [pageText, pageContextText, pageApplicantSignals]
        .sort((a, b) => b.length - a.length)[0] || '';

      if (analysisText.length < 80) {
        sendResponse({
          ok: true,
          data: {
            is_job_description: false,
            sponsorship_status: 'not_applicable',
            sponsorship_or_clearance: 'Not applicable',
            years_experience: 'Not applicable',
            employment_type_status: 'not_applicable',
            employment_type: 'Not applicable',
            applicants_count: 'Not applicable',
            salary_range: 'Not applicable'
          }
        });
        return;
      }

      const apiKey = await getConfiguredApiKey();
      if (!apiKey) {
        throw new Error('Missing OpenAI API key. Set OPENAI_API_KEY in .env at the project root, then rebuild/reinstall the extension.');
      }

      const requestBody = {
        model: OPENAI_MODEL,
        input: [
          {
            role: 'system',
            content: 'You classify web pages as job descriptions and extract hiring constraints. Mark true when the page contains one specific role posting, even if surrounding UI includes navigation, recommendations, or other job listings.'
          },
          {
            role: 'user',
            content:
`Analyze this web page and return JSON only.

PAGE URL:
${pageUrl}

PAGE TITLE:
${pageTitle}

PRIMARY JOB SECTION TEXT:
"""${pageText}"""

FULL PAGE TEXT:
"""${pageContextText || pageText}"""

APPLICANT SIGNALS (targeted excerpts from the page):
"""${pageApplicantSignals || 'None'}"""

Rules:
- is_job_description: true if this page clearly contains at least one specific role posting / job description.
- Ignore surrounding site chrome, sidebars, suggested jobs, and recommendation widgets when deciding is_job_description.
- If there is any indication visa sponsorship is unavailable, sponsorship_status must be "not_available".
- If a clearance requirement blocks most sponsorship cases, sponsorship_status should be "clearance_required".
- If sponsorship is explicitly available, sponsorship_status should be "available".
- If status is unclear, sponsorship_status should be "unknown".
- If job type is clearly full-time, employment_type_status should be "full_time".
- If job type is clearly contract/contractor/temp/freelance, employment_type_status should be "contract".
- If unclear, employment_type_status should be "unknown".
- For applicants_count, scan APPLICANT SIGNALS first, then FULL PAGE TEXT, then PRIMARY JOB SECTION TEXT.
- If both approximate and exact counts exist, always return the exact numeric count.
- For applicants_count, if an exact numeric count is explicitly present anywhere, return exact format "<N> applicants" (for example "37 applicants").
- Do not convert an explicit exact number into "Over ...".
- Only return "Over N applicants" when the page explicitly says "over N applicants" or equivalent wording.
- If you see "Candidates who clicked apply" with "<N> total", return "<N> applicants".
- If both "total" and a time-window count (e.g. "in the past day") are shown, prefer the "total" value.
- If no applicant count is present, return "Not mentioned".
- For salary_range, return concise text like "$166K/yr - $282K/yr" or "Not mentioned".
- If is_job_description is false, set sponsorship_status and employment_type_status to "not_applicable" and all other fields to "Not applicable".
- If is_job_description is true and a field is missing, use "Not mentioned".`
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'job_page_triage',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'is_job_description',
                'sponsorship_status',
                'sponsorship_or_clearance',
                'years_experience',
                'employment_type_status',
                'employment_type',
                'applicants_count',
                'salary_range'
              ],
              properties: {
                is_job_description: {
                  type: 'boolean',
                  description: 'Whether the page is a specific role posting / JD.'
                },
                sponsorship_status: {
                  type: 'string',
                  enum: [
                    'available',
                    'not_available',
                    'clearance_required',
                    'unknown',
                    'not_applicable'
                  ],
                  description: 'Structured sponsorship status.'
                },
                sponsorship_or_clearance: {
                  type: 'string',
                  description: 'Concise explanation (2-8 words). If JD=false use Not applicable. If JD=true and absent use Not mentioned.'
                },
                years_experience: {
                  type: 'string',
                  description: '2-5 words. If JD=false use Not applicable. If JD=true and absent use Not mentioned.'
                },
                employment_type_status: {
                  type: 'string',
                  enum: [
                    'full_time',
                    'contract',
                    'unknown',
                    'not_applicable'
                  ],
                  description: 'Structured employment type status.'
                },
                employment_type: {
                  type: 'string',
                  description: 'Concise employment type label (e.g. Full-time, Contract, Not mentioned).'
                },
                applicants_count: {
                  type: 'string',
                  description: 'If present, concise count phrase (e.g. Over 100 applicants).'
                },
                salary_range: {
                  type: 'string',
                  description: 'If present, concise salary range phrase.'
                }
              }
            },
            strict: true
          }
        }
      };

      const res = await fetchWithTimeout(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        },
        OPENAI_TIMEOUT_MS,
        'OpenAI request timed out'
      );

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`OpenAI HTTP ${res.status}: ${bodyText}`);
      }

      const data = await res.json();
      const parsed = parseModelOutput(data);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Could not parse model output.');
      }

      const normalized = normalizeResult(parsed);
      sendResponse({ ok: true, data: normalized });
    } catch (error) {
      console.error('[worker] analyze-page error:', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
}

function handleAutofillForm(msg, sendResponse) {
  (async () => {
    try {
      const fields = sanitizeAutofillFields(msg?.fields);
      if (!fields.length) {
        throw new Error('No fillable form fields were provided.');
      }

      const apiKey = await getConfiguredApiKey();
      if (!apiKey) {
        throw new Error('Missing OpenAI API key. Set OPENAI_API_KEY in .env at the project root, then rebuild/reinstall the extension.');
      }

      const profile = await getAutofillProfile();
      if (!profile || !Object.keys(profile).length) {
        throw new Error('Missing form profile. Set values in profile.local.json or use the Profile Editor page.');
      }

      const pageUrl = String(msg.page_url || '').trim();
      const pageTitle = String(msg.page_title || '').trim();

      const requestBody = {
        model: OPENAI_MODEL,
        input: [
          {
            role: 'system',
            content: 'You map a candidate profile to webpage form fields. Use only provided profile data. Do not invent values.'
          },
          {
            role: 'user',
            content:
`Return JSON only.

PAGE URL:
${pageUrl}

PAGE TITLE:
${pageTitle}

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

FORM FIELDS:
${JSON.stringify(fields, null, 2)}

Rules:
- For each field, include a fill only when reasonably confident.
- Never fabricate missing personal details.
- Prioritize profile keys about location/address/postal code for matching location fields.
- For city/state fields, prioritize current_city and current_state.
- For state/province dropdowns, choose an exact matching option label/value (state name or abbreviation).
- Use profile experience fields for work history sections (company, title, start/end date, description).
- When multiple experience entries are present, map experience[0] to the first work-history block, then experience[1], and so on.
- Use profile education fields for education sections (school, degree, discipline, start/end date).
- If an education school value is not found in dropdown options and profile provides school_fallback_if_missing, use that fallback (for example "Other").
- Use profile skills list for skill fields.
- For disability self-identification fields, use profile disability_status and select exactly one of yes/no/prefer-not options.
- For selects/radios, value should match one of the provided option labels or option values.
- For kind "combobox", prefer one exact option label/value when options are provided.
- For kind "multi_select", return a comma-separated list of option labels/values.
- For kind "multi_select", do not exceed max_select when provided.
- For skills text fields, return a concise comma-separated list from profile skills.
- For checkbox fields, use "true" or "false".
- For text fields, return concise direct values only (no explanations).
- Skip fields you cannot confidently map.`
          }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'autofill_matches',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['fills'],
              properties: {
                fills: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['field_id', 'value', 'confidence'],
                    properties: {
                      field_id: { type: 'string' },
                      value: { type: 'string' },
                      confidence: {
                        type: 'string',
                        enum: ['high', 'medium', 'low']
                      }
                    }
                  }
                }
              }
            },
            strict: true
          }
        }
      };

      const res = await fetchWithTimeout(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        },
        OPENAI_TIMEOUT_MS,
        'OpenAI request timed out'
      );

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`OpenAI HTTP ${res.status}: ${bodyText}`);
      }

      const data = await res.json();
      const parsed = parseModelOutput(data);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Could not parse model output for form autofill.');
      }

      const allowedIds = fields.map((f) => f.field_id);
      const fills = normalizeAutofillMatches(parsed, allowedIds);
      sendResponse({ ok: true, data: { fills } });
    } catch (error) {
      console.error('[worker] autofill-form error:', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
}

function handleOpenProfileEditor(sendResponse) {
  (async () => {
    try {
      const opened = await openProfileEditorPage();
      sendResponse({ ok: true, ...opened });
    } catch (error) {
      console.error('[worker] open-profile-editor error:', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
}

function handleGetAutofillProfile(sendResponse) {
  (async () => {
    try {
      const resolved = await loadAutofillProfileWithSource();
      sendResponse({
        ok: true,
        data: {
          profile: resolved.profile || {},
          source: resolved.source
        }
      });
    } catch (error) {
      console.error('[worker] get-autofill-profile error:', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
}

function handleSaveAutofillProfile(msg, sendResponse) {
  (async () => {
    try {
      const profile = sanitizeProfileObject(msg?.profile);
      if (!profile || !Object.keys(profile).length) {
        throw new Error('Profile is empty. Fill at least one profile field before saving.');
      }

      await writeStoredValue(PROFILE_STORAGE_KEY, profile);
      sendResponse({ ok: true, data: { profile, source: 'storage' } });
    } catch (error) {
      console.error('[worker] save-autofill-profile error:', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
}

function handleResetAutofillProfile(sendResponse) {
  (async () => {
    try {
      await removeStoredValue(PROFILE_STORAGE_KEY);
      const resolved = await loadAutofillProfileWithSource();
      sendResponse({
        ok: true,
        data: {
          profile: resolved.profile || {},
          source: resolved.source
        }
      });
    } catch (error) {
      console.error('[worker] reset-autofill-profile error:', error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
}

function normalizeApiKey(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .trim();
}

async function getConfiguredApiKey() {
  const fallback = normalizeApiKey(OPENAI_API_KEY_FALLBACK);
  if (fallback) {
    return fallback;
  }

  let envValues = await getEnvValues();
  let envKey = normalizeApiKey(envValues.OPENAI_API_KEY || '');
  if (envKey) {
    return envKey;
  }

  // Retry once with forced reload to avoid stale empty-cache reads.
  envValues = await getEnvValues({ forceReload: true });
  envKey = normalizeApiKey(envValues.OPENAI_API_KEY || '');
  return envKey;
}

async function getEnvValues(options = {}) {
  const forceReload = Boolean(options?.forceReload);
  const now = Date.now();
  const cacheExpired = now - envValuesLoadedAt > ENV_CACHE_TTL_MS;

  if (forceReload || !envValuesPromise || cacheExpired) {
    envValuesPromise = (async () => {
      const envText = await loadEnvFileText(forceReload);
      return parseEnvEntries(envText);
    })();
    envValuesLoadedAt = now;
  }

  return envValuesPromise;
}

async function getAutofillProfile() {
  const resolved = await loadAutofillProfileWithSource();
  return resolved.profile;
}

async function loadAutofillProfileWithSource() {
  const fileProfile = await loadProfileFileObject();
  const storedProfile = await readStoredValue(PROFILE_STORAGE_KEY);
  const sanitizedStored = sanitizeProfileObject(storedProfile);

  if (fileProfile && sanitizedStored) {
    const merged = sanitizeProfileObject(mergeProfileData(fileProfile, sanitizedStored));
    if (merged && Object.keys(merged).length) {
      return { profile: merged, source: 'file+storage' };
    }
  }

  if (sanitizedStored && Object.keys(sanitizedStored).length) {
    return { profile: sanitizedStored, source: 'storage' };
  }

  if (fileProfile && Object.keys(fileProfile).length) {
    return { profile: fileProfile, source: 'file' };
  }

  const envValues = await getEnvValues();
  const jsonCandidates = [
    envValues.FORM_FILL_PROFILE_JSON,
    envValues.APPLICANT_PROFILE_JSON,
    envValues.CANDIDATE_PROFILE_JSON
  ];

  for (const candidate of jsonCandidates) {
    if (!candidate) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate);
      const profile = sanitizeProfileObject(parsed);
      if (profile) {
        return { profile, source: 'env_json' };
      }
    } catch {
      // no-op
    }
  }

  const profile = buildProfileFromEnvValues(envValues);
  const sanitizedProfile = sanitizeProfileObject(profile);
  if (sanitizedProfile) {
    return { profile: sanitizedProfile, source: 'env_profile_keys' };
  }

  return { profile: null, source: 'none' };
}

function mergeProfileData(baseProfile, overrideProfile, depth = 0) {
  if (depth > 6) {
    return overrideProfile ?? baseProfile ?? null;
  }

  const base = sanitizeProfileValue(baseProfile, depth);
  const override = sanitizeProfileValue(overrideProfile, depth);

  if (base === null || base === undefined) {
    return override;
  }
  if (override === null || override === undefined) {
    return base;
  }

  const baseIsArray = Array.isArray(base);
  const overrideIsArray = Array.isArray(override);
  if (baseIsArray || overrideIsArray) {
    if (!baseIsArray) {
      return override;
    }
    if (!overrideIsArray) {
      return override;
    }
    return mergeProfileArrays(base, override, depth + 1);
  }

  const baseIsObject = typeof base === 'object';
  const overrideIsObject = typeof override === 'object';
  if (!baseIsObject || !overrideIsObject) {
    return override;
  }

  const out = { ...base };
  const allKeys = new Set([...Object.keys(base), ...Object.keys(override)]);
  for (const key of allKeys) {
    if (!(key in override)) {
      continue;
    }

    const mergedValue = mergeProfileData(base[key], override[key], depth + 1);
    if (mergedValue === null || mergedValue === undefined) {
      continue;
    }
    out[key] = mergedValue;
  }

  return out;
}

function mergeProfileArrays(baseArray, overrideArray, depth) {
  const base = Array.isArray(baseArray) ? baseArray : [];
  const override = Array.isArray(overrideArray) ? overrideArray : [];

  if (!override.length) {
    return base;
  }
  if (!base.length) {
    return override;
  }

  const maxLength = Math.max(base.length, override.length);
  const out = [];

  for (let index = 0; index < maxLength; index += 1) {
    const merged = mergeProfileData(base[index], override[index], depth + 1);
    if (merged === null || merged === undefined) {
      continue;
    }
    out.push(merged);
  }

  return out.length ? out : override;
}

function buildProfileFromEnvValues(envValues) {
  const profile = {};
  const experienceByIndex = new Map();

  for (const [key, value] of Object.entries(envValues || {})) {
    if (!key.startsWith('PROFILE_')) {
      continue;
    }

    const trimmed = normalizeShortText(value);
    if (!trimmed) {
      continue;
    }

    const rawProfileKey = key.slice('PROFILE_'.length);
    if (!rawProfileKey) {
      continue;
    }

    const experienceMatch = rawProfileKey.match(/^EXPERIENCE_(\d+)_(.+)$/);
    if (experienceMatch) {
      const experienceIndex = Number(experienceMatch[1]);
      if (!Number.isFinite(experienceIndex) || experienceIndex < 1 || experienceIndex > 50) {
        continue;
      }

      const experienceKey = toSnakeCaseKey(experienceMatch[2]);
      if (!experienceKey) {
        continue;
      }

      if (!experienceByIndex.has(experienceIndex)) {
        experienceByIndex.set(experienceIndex, {});
      }
      experienceByIndex.get(experienceIndex)[experienceKey] = trimmed;
      continue;
    }

    const profileKey = toSnakeCaseKey(rawProfileKey);
    if (!profileKey) {
      continue;
    }

    if (profileKey === 'skills') {
      const skills = parseProfileSkillsList(trimmed);
      if (skills.length) {
        profile.skills = skills;
      }
      continue;
    }

    profile[profileKey] = trimmed;
  }

  const experience = Array.from(experienceByIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1])
    .filter((item) => Object.keys(item).length);

  if (experience.length) {
    profile.experience = experience;
  }

  return profile;
}

function parseProfileSkillsList(rawValue) {
  const text = normalizeShortText(rawValue);
  if (!text) {
    return [];
  }

  let parts = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      parts = parsed
        .map((item) => normalizeShortText(item))
        .filter(Boolean);
    }
  } catch {
    // no-op
  }

  if (!parts.length) {
    let working = text;
    if (working.startsWith('[') && working.endsWith(']')) {
      working = working.slice(1, -1);
    }

    parts = working
      .split(/[,;\n|]+/)
      .map((item) => normalizeShortText(item))
      .filter(Boolean);

    if (parts.length <= 1 && /\s+\band\b\s+/i.test(working)) {
      parts = working
        .split(/\s+\band\b\s+/i)
        .map((item) => normalizeShortText(item))
        .filter(Boolean);
    }
  }

  const out = [];
  const seen = new Set();
  for (const item of parts) {
    const cleaned = normalizeShortText(item).replace(/^["']|["']$/g, '');
    if (!cleaned) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(cleaned.slice(0, 80));

    if (out.length >= 80) {
      break;
    }
  }

  return out;
}

function toSnakeCaseKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getRuntimeURL(path) {
  if (globalThis.browser?.runtime?.getURL) {
    return globalThis.browser.runtime.getURL(path);
  }

  if (globalThis.chrome?.runtime?.getURL) {
    return globalThis.chrome.runtime.getURL(path);
  }

  return '';
}

async function loadEnvFileText(forceReload = false) {
  const envUrl = getRuntimeURL(ENV_FILE_PATH);
  if (!envUrl) {
    return '';
  }

  const requestUrl = forceReload ? `${envUrl}${envUrl.includes('?') ? '&' : '?'}t=${Date.now()}` : envUrl;

  try {
    const response = await fetchWithTimeout(
      requestUrl,
      { cache: forceReload ? 'reload' : 'no-store' },
      ENV_LOAD_TIMEOUT_MS,
      'Timed out loading .env from extension bundle'
    );
    if (!response.ok) {
      return '';
    }
    return await response.text();
  } catch (error) {
    console.warn('[worker] could not load .env file from extension bundle:', error);
    return '';
  }
}

async function loadProfileFileObject() {
  const profileUrl = getRuntimeURL(PROFILE_FILE_PATH);
  if (!profileUrl) {
    return null;
  }

  try {
    const response = await fetchWithTimeout(
      profileUrl,
      { cache: 'no-store' },
      ENV_LOAD_TIMEOUT_MS,
      'Timed out loading profile.local.json from extension bundle'
    );
    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    const parsed = JSON.parse(text);
    return sanitizeProfileObject(parsed);
  } catch (error) {
    console.warn('[worker] could not load profile.local.json from extension bundle:', error);
    return null;
  }
}

function getStorageArea() {
  if (globalThis.browser?.storage?.local) {
    return globalThis.browser.storage.local;
  }

  if (globalThis.chrome?.storage?.local) {
    return globalThis.chrome.storage.local;
  }

  return null;
}

function getRuntimeLastErrorMessage() {
  return String(
    globalThis.browser?.runtime?.lastError?.message ||
    globalThis.chrome?.runtime?.lastError?.message ||
    ''
  ).trim();
}

async function readStoredValue(key) {
  const storage = getStorageArea();
  if (!storage || !key) {
    return null;
  }

  if (storage.get.length <= 1) {
    const out = await storage.get(key);
    return out?.[key] ?? null;
  }

  return await new Promise((resolve, reject) => {
    storage.get(key, (out) => {
      const err = getRuntimeLastErrorMessage();
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve(out?.[key] ?? null);
    });
  });
}

async function writeStoredValue(key, value) {
  const storage = getStorageArea();
  if (!storage || !key) {
    return;
  }

  if (storage.set.length <= 1) {
    await storage.set({ [key]: value });
    return;
  }

  await new Promise((resolve, reject) => {
    storage.set({ [key]: value }, () => {
      const err = getRuntimeLastErrorMessage();
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve();
    });
  });
}

async function removeStoredValue(key) {
  const storage = getStorageArea();
  if (!storage || !key) {
    return;
  }

  if (storage.remove.length <= 1) {
    await storage.remove(key);
    return;
  }

  await new Promise((resolve, reject) => {
    storage.remove(key, () => {
      const err = getRuntimeLastErrorMessage();
      if (err) {
        reject(new Error(err));
        return;
      }
      resolve();
    });
  });
}

async function openProfileEditorPage() {
  if (typeof runtime?.openOptionsPage === 'function') {
    try {
      const maybePromise = runtime.openOptionsPage();
      if (maybePromise && typeof maybePromise.then === 'function') {
        await maybePromise;
      }
      return { opened: true };
    } catch (error) {
      console.warn('[worker] runtime.openOptionsPage failed, falling back to URL open.', error);
    }
  }

  return { opened: false, url: getRuntimeURL(PROFILE_EDITOR_PAGE_PATH) };
}

async function fetchWithTimeout(url, options, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseEnvEntries(envText) {
  const text = String(envText || '');
  const out = {};
  if (!text) {
    return out;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    let line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('export ')) {
      line = line.slice(7).trim();
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const varName = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (!value) {
      out[varName] = '';
      continue;
    }

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const commentStart = value.indexOf(' #');
      if (commentStart >= 0) {
        value = value.slice(0, commentStart).trim();
      }
    }

    out[varName] = value;
  }

  return out;
}

function parseModelOutput(data) {
  if (data && typeof data.output_parsed === 'object' && data.output_parsed !== null) {
    return data.output_parsed;
  }

  if (typeof data?.output_text === 'string') {
    try {
      return JSON.parse(data.output_text);
    } catch {
      // no-op
    }
  }

  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const part of content) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          try {
            return JSON.parse(part.text);
          } catch {
            // no-op
          }
        }
        if (part?.type === 'output_json' && typeof part?.json === 'object' && part.json !== null) {
          return part.json;
        }
      }
    }
  }

  if (Array.isArray(data?.choices) && data.choices[0]?.message?.content) {
    const text = data.choices[0].message.content;
    try {
      return JSON.parse(text);
    } catch {
      // no-op
    }
  }

  return null;
}

function sanitizeAutofillFields(rawFields) {
  const fields = Array.isArray(rawFields) ? rawFields : [];
  const out = [];
  const seenIds = new Set();

  for (const field of fields) {
    if (out.length >= MAX_AUTOFILL_FIELDS) {
      break;
    }

    const fieldId = normalizeShortText(field?.field_id).slice(0, 64);
    if (!fieldId || seenIds.has(fieldId)) {
      continue;
    }
    seenIds.add(fieldId);

    const options = Array.isArray(field?.options)
      ? field.options
          .slice(0, MAX_AUTOFILL_OPTIONS)
          .map((option) => ({
            label: normalizeShortText(option?.label).slice(0, 140),
            value: normalizeShortText(option?.value).slice(0, 140)
          }))
          .filter((option) => option.label || option.value)
      : [];

    out.push({
      field_id: fieldId,
      kind: normalizeShortText(field?.kind).slice(0, 30),
      tag: normalizeShortText(field?.tag).slice(0, 20),
      input_type: normalizeShortText(field?.input_type).slice(0, 30),
      label: normalizeShortText(field?.label).slice(0, 220),
      question: normalizeShortText(field?.question).slice(0, 320),
      name: normalizeShortText(field?.name).slice(0, 120),
      id: normalizeShortText(field?.id).slice(0, 120),
      placeholder: normalizeShortText(field?.placeholder).slice(0, 180),
      autocomplete: normalizeShortText(field?.autocomplete).slice(0, 80),
      required: Boolean(field?.required),
      current_value: normalizeShortText(field?.current_value).slice(0, 180),
      max_select: Number.isFinite(Number(field?.max_select))
        ? Math.max(1, Math.min(30, Number(field.max_select)))
        : null,
      options
    });
  }

  return out;
}

function sanitizeProfileObject(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return null;
  }

  const sanitized = sanitizeProfileValue(profile, 0);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return null;
  }

  return Object.keys(sanitized).length ? sanitized : null;
}

function sanitizeProfileValue(rawValue, depth) {
  if (depth > 4) {
    return null;
  }

  if (typeof rawValue === 'string') {
    const value = normalizeShortText(rawValue).slice(0, 800);
    return value || null;
  }

  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : null;
  }

  if (typeof rawValue === 'boolean') {
    return rawValue;
  }

  if (Array.isArray(rawValue)) {
    const out = [];
    for (const item of rawValue.slice(0, 60)) {
      const sanitizedItem = sanitizeProfileValue(item, depth + 1);
      if (sanitizedItem === null || sanitizedItem === undefined) {
        continue;
      }

      if (Array.isArray(sanitizedItem) && !sanitizedItem.length) {
        continue;
      }

      if (sanitizedItem && typeof sanitizedItem === 'object' && !Array.isArray(sanitizedItem) && !Object.keys(sanitizedItem).length) {
        continue;
      }

      out.push(sanitizedItem);
    }

    return out.length ? out : null;
  }

  if (!rawValue || typeof rawValue !== 'object') {
    return null;
  }

  const out = {};
  let count = 0;
  for (const [rawKey, nestedValue] of Object.entries(rawValue)) {
    if (count >= 120) {
      break;
    }

    const key = toSnakeCaseKey(rawKey).slice(0, 100);
    if (!key) {
      continue;
    }

    const sanitizedValue = sanitizeProfileValue(nestedValue, depth + 1);
    if (sanitizedValue === null || sanitizedValue === undefined) {
      continue;
    }

    if (Array.isArray(sanitizedValue) && !sanitizedValue.length) {
      continue;
    }

    if (sanitizedValue && typeof sanitizedValue === 'object' && !Array.isArray(sanitizedValue) && !Object.keys(sanitizedValue).length) {
      continue;
    }

    out[key] = sanitizedValue;
    count += 1;
  }

  return Object.keys(out).length ? out : null;
}

function normalizeAutofillMatches(raw, allowedFieldIds) {
  const allowed = new Set((Array.isArray(allowedFieldIds) ? allowedFieldIds : []).map((id) => String(id)));
  const fills = Array.isArray(raw?.fills) ? raw.fills : [];
  const out = [];
  const seen = new Set();

  for (const item of fills) {
    const fieldId = normalizeShortText(item?.field_id).slice(0, 64);
    if (!fieldId || !allowed.has(fieldId) || seen.has(fieldId)) {
      continue;
    }

    const value = normalizeShortText(item?.value).slice(0, 500);
    if (!value) {
      continue;
    }

    const confidence = normalizeShortText(item?.confidence).toLowerCase();
    if (confidence === 'low') {
      continue;
    }

    out.push({
      field_id: fieldId,
      value,
      confidence: confidence === 'high' ? 'high' : 'medium'
    });
    seen.add(fieldId);
  }

  return out;
}

function normalizeResult(raw) {
  const isJobDescription = Boolean(raw?.is_job_description);

  let sponsorship = normalizeShortText(raw?.sponsorship_or_clearance);
  let years = normalizeShortText(raw?.years_experience);
  let employmentType = normalizeShortText(raw?.employment_type);
  let applicants = normalizeApplicantsCount(raw?.applicants_count);
  let salary = normalizeShortText(raw?.salary_range);

  let sponsorshipStatus = normalizeSponsorshipStatus(raw?.sponsorship_status, isJobDescription);
  let employmentTypeStatus = normalizeEmploymentTypeStatus(raw?.employment_type_status, isJobDescription);

  if (!isJobDescription) {
    sponsorshipStatus = 'not_applicable';
    employmentTypeStatus = 'not_applicable';
    sponsorship = 'Not applicable';
    years = 'Not applicable';
    employmentType = 'Not applicable';
    applicants = 'Not applicable';
    salary = 'Not applicable';
  } else {
    sponsorship = sponsorship || 'Not mentioned';
    years = years || 'Not mentioned';
    employmentType = employmentType || 'Not mentioned';
    applicants = applicants || 'Not mentioned';
    salary = salary || 'Not mentioned';
    if (sponsorshipStatus === 'not_applicable') {
      sponsorshipStatus = 'unknown';
    }
    if (employmentTypeStatus === 'not_applicable') {
      employmentTypeStatus = 'unknown';
    }
  }

  return {
    is_job_description: isJobDescription,
    sponsorship_status: sponsorshipStatus,
    sponsorship_or_clearance: sponsorship,
    years_experience: years,
    employment_type_status: employmentTypeStatus,
    employment_type: employmentType,
    applicants_count: applicants,
    salary_range: salary
  };
}

function normalizeEmploymentTypeStatus(status, isJobDescription) {
  if (!isJobDescription) {
    return 'not_applicable';
  }

  const normalized = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (/^(full_time|contract|unknown|not_applicable)$/.test(normalized)) {
    return normalized === 'not_applicable' ? 'unknown' : normalized;
  }

  return 'unknown';
}

function normalizeSponsorshipStatus(status, isJobDescription) {
  if (!isJobDescription) {
    return 'not_applicable';
  }

  const normalized = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (/^(available|not_available|clearance_required|unknown|not_applicable)$/.test(normalized)) {
    return normalized === 'not_applicable' ? 'unknown' : normalized;
  }

  return 'unknown';
}

function normalizeApplicantsCount(value) {
  const text = normalizeShortText(value);
  if (!text) {
    return '';
  }

  if (/^not applicable$/i.test(text)) {
    return 'Not applicable';
  }

  if (/^not mentioned$/i.test(text)) {
    return 'Not mentioned';
  }

  const exactMatch = text.match(
    /\b(\d[\d,]*)\s*(?:\+)?\s*(?:total|applicants?|people\s+clicked\s+apply|candidates?\s+who\s+clicked\s+apply|clicked\s+apply)\b/i
  );
  if (exactMatch) {
    return `${exactMatch[1]} applicants`;
  }

  const clickedApplyTotalMatch = text.match(/\bcandidates?\s+who\s+clicked\s+apply[\s\S]{0,40}?\b(\d[\d,]*)\b/i);
  if (clickedApplyTotalMatch) {
    return `${clickedApplyTotalMatch[1]} applicants`;
  }

  const bareNumberMatch = text.match(/^\s*(\d[\d,]*)\s*$/);
  if (bareNumberMatch) {
    return `${bareNumberMatch[1]} applicants`;
  }

  const overMatch = text.match(/\bover\s+(\d[\d,]*)\b/i);
  if (overMatch) {
    return `Over ${overMatch[1]} applicants`;
  }

  return text;
}

function normalizeShortText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}
