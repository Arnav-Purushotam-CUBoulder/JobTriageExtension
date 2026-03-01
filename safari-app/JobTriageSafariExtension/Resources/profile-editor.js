(() => {
  'use strict';

  const form = document.getElementById('profile-form');
  const statusEl = document.getElementById('status');
  const saveBtn = document.getElementById('save-btn');
  const reloadBtn = document.getElementById('reload-btn');
  const resetBtn = document.getElementById('reset-btn');

  const basicFieldIds = [
    'full_name',
    'email',
    'phone',
    'current_city',
    'current_state',
    'address',
    'postal_code',
    'linkedin',
    'work_authorization',
    'disability_status',
    'github',
    'portfolio'
  ];

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeBlockText(value) {
    return String(value || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.classList.remove('error', 'success');
    if (kind) {
      statusEl.classList.add(kind);
    }
  }

  async function sendRuntimeMessage(payload) {
    if (globalThis.browser?.runtime?.sendMessage) {
      return await globalThis.browser.runtime.sendMessage(payload);
    }

    return await new Promise((resolve, reject) => {
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

  function parseSkills(rawValue) {
    const text = normalizeBlockText(rawValue);
    if (!text) {
      return [];
    }

    const out = [];
    const seen = new Set();
    const parts = text
      .split(/[\n,;|]+/)
      .map((part) => normalizeText(part))
      .filter(Boolean);

    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(part);
      if (out.length >= 120) {
        break;
      }
    }

    return out;
  }

  function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (!el) {
      return;
    }
    el.value = String(value || '');
  }

  function getInputValue(id) {
    const el = document.getElementById(id);
    if (!el) {
      return '';
    }
    return String(el.value || '');
  }

  function applyProfile(profile) {
    const safeProfile = profile && typeof profile === 'object' ? profile : {};

    for (const fieldId of basicFieldIds) {
      setInputValue(fieldId, safeProfile[fieldId] || '');
    }
    setInputValue(
      'disability_status',
      safeProfile.disability_status || safeProfile.disabilityStatus || safeProfile['Disability Status'] || safeProfile.disability || ''
    );

    const skills = Array.isArray(safeProfile.skills)
      ? safeProfile.skills.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    setInputValue('skills', skills.join(', '));

    const exp = Array.isArray(safeProfile.experience) ? safeProfile.experience : [];
    const exp1 = exp[0] && typeof exp[0] === 'object' ? exp[0] : {};
    const exp2 = exp[1] && typeof exp[1] === 'object' ? exp[1] : {};

    setInputValue('exp1_company_name', exp1.company_name || '');
    setInputValue('exp1_role_title', exp1.role_title || '');
    setInputValue('exp1_start_date', exp1.start_date || '');
    setInputValue('exp1_end_date', exp1.end_date || '');
    setInputValue('exp1_description', exp1.description || '');

    setInputValue('exp2_company_name', exp2.company_name || '');
    setInputValue('exp2_role_title', exp2.role_title || '');
    setInputValue('exp2_start_date', exp2.start_date || '');
    setInputValue('exp2_end_date', exp2.end_date || '');
    setInputValue('exp2_description', exp2.description || '');

    const education = Array.isArray(safeProfile.education) ? safeProfile.education : [];
    const edu1 = education[0] && typeof education[0] === 'object' ? education[0] : {};
    const edu2 = education[1] && typeof education[1] === 'object' ? education[1] : {};

    setInputValue('edu1_school', edu1.school || edu1.school_name || '');
    setInputValue('edu1_school_fallback_if_missing', edu1.school_fallback_if_missing || '');
    setInputValue('edu1_degree', edu1.degree || '');
    setInputValue('edu1_discipline', edu1.discipline || '');
    setInputValue('edu1_start_date', edu1.start_date || '');
    setInputValue('edu1_end_date', edu1.end_date || '');

    setInputValue('edu2_school', edu2.school || edu2.school_name || '');
    setInputValue('edu2_school_fallback_if_missing', edu2.school_fallback_if_missing || '');
    setInputValue('edu2_degree', edu2.degree || '');
    setInputValue('edu2_discipline', edu2.discipline || '');
    setInputValue('edu2_start_date', edu2.start_date || '');
    setInputValue('edu2_end_date', edu2.end_date || '');
  }

  function collectExperience(index) {
    const prefix = `exp${index}_`;
    const companyName = normalizeText(getInputValue(`${prefix}company_name`));
    const roleTitle = normalizeText(getInputValue(`${prefix}role_title`));
    const startDate = normalizeText(getInputValue(`${prefix}start_date`));
    const endDate = normalizeText(getInputValue(`${prefix}end_date`));
    const description = normalizeBlockText(getInputValue(`${prefix}description`));

    if (!companyName && !roleTitle && !startDate && !endDate && !description) {
      return null;
    }

    const item = {};
    if (companyName) item.company_name = companyName;
    if (roleTitle) item.role_title = roleTitle;
    if (startDate) item.start_date = startDate;
    if (endDate) item.end_date = endDate;
    if (description) item.description = description;
    return item;
  }

  function collectEducation(index) {
    const prefix = `edu${index}_`;
    const school = normalizeText(getInputValue(`${prefix}school`));
    const schoolFallback = normalizeText(getInputValue(`${prefix}school_fallback_if_missing`));
    const degree = normalizeText(getInputValue(`${prefix}degree`));
    const discipline = normalizeText(getInputValue(`${prefix}discipline`));
    const startDate = normalizeText(getInputValue(`${prefix}start_date`));
    const endDate = normalizeText(getInputValue(`${prefix}end_date`));

    if (!school && !schoolFallback && !degree && !discipline && !startDate && !endDate) {
      return null;
    }

    const item = {};
    if (school) item.school = school;
    if (schoolFallback) item.school_fallback_if_missing = schoolFallback;
    if (degree) item.degree = degree;
    if (discipline) item.discipline = discipline;
    if (startDate) item.start_date = startDate;
    if (endDate) item.end_date = endDate;
    return item;
  }

  function buildProfileFromForm() {
    const profile = {};

    for (const fieldId of basicFieldIds) {
      const value = normalizeText(getInputValue(fieldId));
      if (value) {
        profile[fieldId] = value;
      }
    }

    const skills = parseSkills(getInputValue('skills'));
    if (skills.length) {
      profile.skills = skills;
    }

    const experience = [];
    const exp1 = collectExperience(1);
    const exp2 = collectExperience(2);
    if (exp1) {
      experience.push(exp1);
    }
    if (exp2) {
      experience.push(exp2);
    }
    if (experience.length) {
      profile.experience = experience;
    }

    const education = [];
    const edu1 = collectEducation(1);
    const edu2 = collectEducation(2);
    if (edu1) {
      education.push(edu1);
    }
    if (edu2) {
      education.push(edu2);
    }
    if (education.length) {
      profile.education = education;
    }

    return profile;
  }

  function sourceLabel(source) {
    switch (String(source || '').trim().toLowerCase()) {
      case 'storage':
        return 'saved local profile';
      case 'file':
        return 'profile.local.json';
      case 'env_json':
        return '.env JSON fallback';
      case 'env_profile_keys':
        return '.env PROFILE_* fallback';
      default:
        return 'defaults';
    }
  }

  async function loadProfile() {
    setStatus('Loading profile...');

    const resp = await sendRuntimeMessage({ type: 'get-autofill-profile' });
    if (!resp?.ok) {
      throw new Error(resp?.error || 'Could not load profile');
    }

    const profile = resp?.data?.profile || {};
    const source = sourceLabel(resp?.data?.source);
    applyProfile(profile);
    setStatus(`Loaded from ${source}.`, 'success');
  }

  async function saveProfile() {
    const profile = buildProfileFromForm();
    const resp = await sendRuntimeMessage({ type: 'save-autofill-profile', profile });
    if (!resp?.ok) {
      throw new Error(resp?.error || 'Could not save profile');
    }

    setStatus('Profile saved locally.', 'success');
  }

  async function resetProfile() {
    const resp = await sendRuntimeMessage({ type: 'reset-autofill-profile' });
    if (!resp?.ok) {
      throw new Error(resp?.error || 'Could not reset profile');
    }

    applyProfile(resp?.data?.profile || {});
    setStatus('Reset to file defaults.', 'success');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveBtn.disabled = true;
    try {
      await saveProfile();
    } catch (error) {
      setStatus(String(error?.message || error), 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  reloadBtn.addEventListener('click', async () => {
    reloadBtn.disabled = true;
    try {
      await loadProfile();
    } catch (error) {
      setStatus(String(error?.message || error), 'error');
    } finally {
      reloadBtn.disabled = false;
    }
  });

  resetBtn.addEventListener('click', async () => {
    resetBtn.disabled = true;
    try {
      await resetProfile();
    } catch (error) {
      setStatus(String(error?.message || error), 'error');
    } finally {
      resetBtn.disabled = false;
    }
  });

  void loadProfile().catch((error) => {
    setStatus(String(error?.message || error), 'error');
  });
})();
