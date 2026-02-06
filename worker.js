// worker.js (MV3 service worker)
const OPENAI_MODEL = 'gpt-4.1-mini';
const OPENAI_API_KEY_FALLBACK = '';
const API_KEY_STORAGE_KEY = 'openai_api_key';

const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
const browserStorage = globalThis.browser?.storage?.local;
const chromeStorage = globalThis.chrome?.storage?.local;

console.log('[worker] loaded');

if (!runtime) {
  console.error('[worker] runtime API unavailable.');
}

runtime?.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ ok: true, pong: true });
    return false;
  }

  if (msg?.type === 'set-api-key') {
    (async () => {
      try {
        const key = normalizeApiKey(msg.api_key);
        if (!key) {
          throw new Error('API key cannot be empty.');
        }
        await saveStoredApiKey(key);
        sendResponse({ ok: true, saved: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  if (msg?.type === 'clear-api-key') {
    (async () => {
      try {
        await removeStoredApiKey();
        sendResponse({ ok: true, cleared: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  if (msg?.type !== 'analyze-page') {
    return false;
  }

  (async () => {
    try {
      const pageText = String(msg.page_text || '').trim();
      const pageTitle = String(msg.page_title || '').trim();
      const pageUrl = String(msg.page_url || '').trim();

      if (pageText.length < 80) {
        sendResponse({
          ok: true,
          data: {
            is_job_description: false,
            sponsorship_or_clearance: 'Not applicable',
            years_experience: 'Not applicable'
          }
        });
        return;
      }

      const apiKey = await getConfiguredApiKey();
      if (!apiKey) {
        throw new Error('Missing OpenAI API key. Use the widget button to set it.');
      }

      const requestBody = {
        model: OPENAI_MODEL,
        input: [
          {
            role: 'system',
            content: 'You classify web pages as job descriptions and extract hiring constraints. Be strict: only mark true for a single role posting with explicit duties/requirements.'
          },
          {
            role: 'user',
            content:
`Analyze this web page and return JSON only.

PAGE URL:
${pageUrl}

PAGE TITLE:
${pageTitle}

PAGE TEXT:
"""${pageText}"""

Rules:
- is_job_description: true only if this page is clearly a specific job posting / job description.
- If is_job_description is false, set sponsorship_or_clearance and years_experience to "Not applicable".
- If is_job_description is true and a field is missing, use "Not mentioned".
- Keep sponsorship_or_clearance and years_experience concise (2-5 words).`
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
                'sponsorship_or_clearance',
                'years_experience'
              ],
              properties: {
                is_job_description: {
                  type: 'boolean',
                  description: 'Whether the page is a specific role posting / JD.'
                },
                sponsorship_or_clearance: {
                  type: 'string',
                  description: '2-5 words. If JD=false use Not applicable. If JD=true and absent use Not mentioned.'
                },
                years_experience: {
                  type: 'string',
                  description: '2-5 words. If JD=false use Not applicable. If JD=true and absent use Not mentioned.'
                }
              }
            },
            strict: true
          }
        }
      };

      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

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

  return true;
});

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

  const stored = await getStoredApiKey();
  return normalizeApiKey(stored);
}

async function getStoredApiKey() {
  if (!browserStorage && !chromeStorage) {
    return '';
  }

  const result = await storageGet(API_KEY_STORAGE_KEY);
  return result?.[API_KEY_STORAGE_KEY] || '';
}

async function saveStoredApiKey(key) {
  if (!browserStorage && !chromeStorage) {
    throw new Error('Extension storage API is unavailable.');
  }

  await storageSet({ [API_KEY_STORAGE_KEY]: key });
}

async function removeStoredApiKey() {
  if (!browserStorage && !chromeStorage) {
    return;
  }

  await storageRemove(API_KEY_STORAGE_KEY);
}

async function storageGet(key) {
  if (browserStorage) {
    return browserStorage.get(key);
  }

  return new Promise((resolve, reject) => {
    chromeStorage.get(key, (value) => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(value || {});
    });
  });
}

async function storageSet(value) {
  if (browserStorage) {
    return browserStorage.set(value);
  }

  return new Promise((resolve, reject) => {
    chromeStorage.set(value, () => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function storageRemove(key) {
  if (browserStorage) {
    return browserStorage.remove(key);
  }

  return new Promise((resolve, reject) => {
    chromeStorage.remove(key, () => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
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

function normalizeResult(raw) {
  const isJobDescription = Boolean(raw?.is_job_description);

  let sponsorship = normalizeShortText(raw?.sponsorship_or_clearance);
  let years = normalizeShortText(raw?.years_experience);

  if (!isJobDescription) {
    sponsorship = 'Not applicable';
    years = 'Not applicable';
  } else {
    sponsorship = sponsorship || 'Not mentioned';
    years = years || 'Not mentioned';
  }

  return {
    is_job_description: isJobDescription,
    sponsorship_or_clearance: sponsorship,
    years_experience: years
  };
}

function normalizeShortText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}
