/**
 * Souty - Main window: recorder + history cards + settings
 */

const COPY_ICON = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
const DELETE_ICON = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
// History badges; 'prompt' is the retired AI Prompt mode, kept so old entries still show it
const MODE_BADGES = { translate: 'ترجمة', prompt: 'AI Prompt' };

document.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('visualizer-canvas');
  const timerDisplay = document.getElementById('timer-display');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  const btnRecordToggle = document.getElementById('btn-record-toggle');
  const iconMic = document.getElementById('icon-mic');
  const iconStop = document.getElementById('icon-stop');
  const btnPauseToggle = document.getElementById('btn-pause-toggle');
  const iconPause = document.getElementById('icon-pause');
  const iconResume = document.getElementById('icon-resume');
  const btnCancel = document.getElementById('btn-cancel');

  const historyList = document.getElementById('history-list');
  const btnClearHistory = document.getElementById('btn-clear-history');

  const btnSettings = document.getElementById('btn-settings');
  const settingsModal = document.getElementById('settings-modal');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const inputApiKey = document.getElementById('input-api-key');
  const btnToggleKeyVisibility = document.getElementById('btn-toggle-key-visibility');
  const selectModel = document.getElementById('select-model');
  const selectTargetLanguage = document.getElementById('select-target-language');
  const checkAutoCopy = document.getElementById('check-auto-copy');

  // Banked Keys elements
  const bankedKeysModal = document.getElementById('banked-keys-modal');
  const btnOpenBankedKeys = document.getElementById('btn-open-banked-keys');
  const btnCloseBankedKeys = document.getElementById('btn-close-banked-keys');
  const btnSaveBankedKeys = document.getElementById('btn-save-banked-keys');
  const btnAddBankedKey = document.getElementById('btn-add-banked-key');
  const bankedKeysListEl = document.getElementById('banked-keys-list');
  const bankedKeysEmptyEl = document.getElementById('banked-keys-empty');
  const btnBankedText = document.getElementById('btn-banked-text');
  let bankedKeysList = [];

  const toastContainer = document.getElementById('toast-container');
  const modeOptions = document.querySelectorAll('.mode-option');

  let currentSettings = await window.electronAPI.getSettings();
  applyMode(currentSettings.mode);

  const audioRecorder = new AudioRecorder(
    canvas,
    (state) => updateUIState(state),
    (timerStr) => { timerDisplay.textContent = timerStr; }
  );

  await migrateLocalHistory();
  renderHistory();

  // Main process owns history.json and tells us whenever it changes (overlay or this window)
  window.electronAPI.history.onChanged(() => renderHistory());
  window.electronAPI.onSettingsChanged((settings) => {
    currentSettings = settings;
    applyMode(settings.mode);
  });

  // History used to live in localStorage; move it into history.json once
  async function migrateLocalHistory() {
    try {
      const raw = localStorage.getItem('souty_history');
      if (!raw) return;
      await window.electronAPI.history.import(JSON.parse(raw));
      localStorage.removeItem('souty_history');
    } catch (e) {
      console.error('History migration failed:', e); // keep localStorage so it can retry next launch
    }
  }

  // =========================================================================
  // Mode: default transcription or translation
  // =========================================================================

  function applyMode(mode) {
    modeOptions.forEach((btn) => {
      const active = btn.dataset.mode === (mode || 'default');
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', String(active));
    });
  }

  modeOptions.forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentSettings = await window.electronAPI.saveSettings({ mode: btn.dataset.mode });
      applyMode(currentSettings.mode);
    });
  });

  // =========================================================================
  // Recording
  // =========================================================================

  btnRecordToggle.addEventListener('click', async () => {
    if (audioRecorder.state === 'idle') await startRecording();
    else await stopAndTranscribe();
  });

  btnPauseToggle.addEventListener('click', () => {
    if (audioRecorder.state === 'recording') audioRecorder.pause();
    else if (audioRecorder.state === 'paused') audioRecorder.resume();
  });

  btnCancel.addEventListener('click', () => {
    if (audioRecorder.state !== 'idle') {
      audioRecorder.cancel();
      showToast('تم إلغاء التسجيل');
    }
  });

  async function startRecording() {
    if (!currentSettings.apiKey) {
      showToast('أضف مفتاح API من الإعدادات أولاً', 'error');
      openSettingsModal();
      return;
    }
    try {
      await audioRecorder.start();
    } catch (err) {
      console.error(err);
      showToast('تعذر الوصول للمايكروفون. تأكد من توصيله وإعطاء الصلاحية.', 'error', 4000);
    }
  }

  async function stopAndTranscribe() {
    setProcessingUI(true, 'جاري الإيقاف...');

    try {
      const result = await audioRecorder.stop();
      if (!result || !result.blob) return;

      if (result.duration < 1 && result.blob.size < 2000) {
        showToast('التسجيل قصير جداً', 'error');
        return;
      }

      setProcessingUI(true, currentSettings.mode === 'translate' ? 'جاري الترجمة...' : 'جاري التفريغ...');

      const response = await window.electronAPI.transcribeAudio({
        base64Audio: result.base64,
        format: result.format,
        modelOverride: currentSettings.model
      });

      if (!response || !response.success) {
        showToast(response?.error || 'حدث خطأ أثناء التفريغ', 'error', 6000);
        return;
      }

      const text = (response.text || '').trim();
      if (!text) {
        showToast('لم يتم التقاط كلام واضح');
        return;
      }

      await window.electronAPI.history.add({ duration: result.duration, text, mode: response.mode }); // list re-renders on history-changed

      if (currentSettings.autoCopy) {
        await window.electronAPI.copyText(text);
        showToast('تم التفريغ والنسخ', 'success');
      } else {
        showToast('تم التفريغ', 'success');
      }
    } catch (err) {
      console.error('Transcription error:', err);
      showToast(err.message || 'حدث خطأ أثناء التفريغ', 'error', 6000);
    } finally {
      setProcessingUI(false);
    }
  }

  function updateUIState(state) {
    const recording = state === 'recording';
    const paused = state === 'paused';
    const active = recording || paused;

    iconMic.style.display = active ? 'none' : 'block';
    iconStop.style.display = active ? 'block' : 'none';
    btnRecordToggle.classList.toggle('recording', active);
    btnRecordToggle.title = active ? 'إنهاء وتفريغ' : 'بدء التسجيل';

    btnPauseToggle.disabled = !active;
    iconPause.style.display = paused ? 'none' : 'block';
    iconResume.style.display = paused ? 'block' : 'none';
    btnPauseToggle.title = paused ? 'استئناف' : 'إيقاف مؤقت';
    btnCancel.disabled = !active;

    timerDisplay.classList.toggle('recording', recording);
    statusDot.className = `status-dot ${recording ? 'recording' : paused ? 'paused' : 'idle'}`;
    statusText.textContent = recording ? 'جاري الاستماع...' : paused ? 'متوقف مؤقتاً' : 'جاهز للتسجيل';
  }

  function setProcessingUI(isProcessing, message) {
    if (isProcessing) {
      btnRecordToggle.disabled = true;
      btnPauseToggle.disabled = true;
      btnCancel.disabled = true;
      statusDot.className = 'status-dot processing';
      statusText.textContent = message;
    } else {
      btnRecordToggle.disabled = false;
      updateUIState(audioRecorder.state);
    }
  }

  // =========================================================================
  // History cards
  // =========================================================================

  function dayLabel(date) {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'اليوم';
    if (date.toDateString() === yesterday.toDateString()) return 'أمس';
    return date.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  async function renderHistory() {
    const history = await window.electronAPI.history.list();
    historyList.replaceChildren();
    btnClearHistory.hidden = history.length === 0;

    if (history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty-state';
      empty.innerHTML = '<p>لسه مفيش تسجيلات.</p><p>اضغط <kbd dir="ltr">Ctrl + Space</kbd> في أي برنامج واتكلم.</p>';
      historyList.append(empty);
      return;
    }

    let lastDay = '';
    history.forEach((item) => {
      const date = new Date(item.timestamp);
      const day = dayLabel(date);
      if (day !== lastDay) {
        const heading = document.createElement('h3');
        heading.className = 'history-day';
        heading.textContent = day;
        historyList.append(heading);
        lastDay = day;
      }
      historyList.append(createHistoryCard(item, date));
    });
  }

  function createHistoryCard(item, date) {
    const card = document.createElement('article');
    card.className = 'history-item';

    const time = document.createElement('time');
    time.className = 'history-item-time';
    time.dateTime = item.timestamp;
    time.textContent = date.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });

    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    meta.append(time);
    if (MODE_BADGES[item.mode]) {
      const badge = document.createElement('span');
      badge.className = 'history-item-badge';
      badge.textContent = MODE_BADGES[item.mode];
      meta.append(badge);
    }

    const text = document.createElement('p');
    text.className = 'history-item-text';
    text.dir = 'auto'; // Arabic → RTL, English → LTR, per item
    text.textContent = item.text;

    const actions = document.createElement('div');
    actions.className = 'history-item-actions';

    const btnCopy = document.createElement('button');
    btnCopy.className = 'icon-btn';
    btnCopy.title = 'نسخ';
    btnCopy.setAttribute('aria-label', 'نسخ');
    btnCopy.innerHTML = COPY_ICON;
    btnCopy.addEventListener('click', async () => {
      await window.electronAPI.copyText(item.text);
      btnCopy.innerHTML = CHECK_ICON;
      btnCopy.classList.add('copied');
      setTimeout(() => {
        btnCopy.innerHTML = COPY_ICON;
        btnCopy.classList.remove('copied');
      }, 1500);
    });

    const btnDelete = document.createElement('button');
    btnDelete.className = 'icon-btn icon-btn-danger';
    btnDelete.title = 'حذف';
    btnDelete.setAttribute('aria-label', 'حذف');
    btnDelete.innerHTML = DELETE_ICON;
    btnDelete.addEventListener('click', () => window.electronAPI.history.delete(item.id));

    actions.append(btnCopy, btnDelete);
    card.append(meta, text, actions);
    return card;
  }

  btnClearHistory.addEventListener('click', () => {
    if (confirm('مسح كل التسجيلات من السجل؟')) {
      window.electronAPI.history.clear();
    }
  });

  // OpenRouter or Google AI Studio (old AIza… or new AQ.… keys); main.js picks the provider from the prefix
  const KEY_PATTERN = /^(sk-or-|AIza|AQ\.)/;

  const AVAILABLE_MODELS = [
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', providers: ['google', 'openrouter'] },
    { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', providers: ['google', 'openrouter'] },
    { id: 'microsoft/mai-transcribe-2', name: 'MAI-Transcribe 2', providers: ['openrouter'] }
  ];

  function getProviderInfo(key) {
    const trimmed = (key || '').trim();
    if (trimmed.startsWith('sk-or-')) return { name: 'OpenRouter', className: 'openrouter' };
    if (/^(AIza|AQ\.)/.test(trimmed)) return { name: 'Google AI', className: 'google' };
    if (!trimmed) return { name: 'فارغ', className: 'unknown' };
    return { name: 'غير معروف', className: 'unknown' };
  }

  function updateModelOptions(key, preferredModel) {
    const prov = getProviderInfo(key);
    // When the primary key is Google, show only Google-supported models; otherwise OpenRouter-supported models
    const targetProvider = prov.className === 'google' ? 'google' : 'openrouter';
    const currentSelection = preferredModel !== undefined ? preferredModel : selectModel.value;

    const filteredModels = AVAILABLE_MODELS.filter(m => m.providers.includes(targetProvider));

    selectModel.innerHTML = '';
    filteredModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      selectModel.appendChild(opt);
    });

    if (filteredModels.some(m => m.id === currentSelection)) {
      selectModel.value = currentSelection;
    } else {
      selectModel.value = filteredModels[0].id;
    }
  }

  function updateBankedKeysSummary() {
    const count = (bankedKeysList || []).filter(k => k && k.trim()).length;
    if (btnBankedText) {
      btnBankedText.textContent = count > 0 ? `إدارة المفاتيح (${count})` : 'إدارة المفاتيح';
    }
  }

  function renderBankedKeys() {
    bankedKeysListEl.innerHTML = '';
    if (bankedKeysList.length === 0) {
      bankedKeysEmptyEl.style.display = 'flex';
    } else {
      bankedKeysEmptyEl.style.display = 'none';
      bankedKeysList.forEach((key, index) => {
        const item = document.createElement('div');
        item.className = 'banked-key-item';

        const priorityBadge = document.createElement('span');
        priorityBadge.className = 'key-item-priority';
        priorityBadge.textContent = `#${index + 1}`;

        const inputWrapper = document.createElement('div');
        inputWrapper.className = 'key-item-input-wrapper';

        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'key-item-input';
        input.value = key;
        input.placeholder = 'sk-or-v1-… أو AIza… أو AQ.…';
        input.spellcheck = false;
        input.dir = 'ltr';

        const providerPill = document.createElement('span');
        const prov = getProviderInfo(key);
        providerPill.className = `provider-pill ${prov.className}`;
        providerPill.textContent = prov.name;

        input.addEventListener('input', () => {
          bankedKeysList[index] = input.value;
          const p = getProviderInfo(input.value);
          providerPill.className = `provider-pill ${p.className}`;
          providerPill.textContent = p.name;
        });

        inputWrapper.append(input, providerPill);

        const btnToggleVisibility = document.createElement('button');
        btnToggleVisibility.type = 'button';
        btnToggleVisibility.className = 'key-item-btn';
        btnToggleVisibility.title = 'إظهار / إخفاء المفتاح';
        btnToggleVisibility.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        btnToggleVisibility.addEventListener('click', () => {
          input.type = input.type === 'password' ? 'text' : 'password';
        });

        const btnDelete = document.createElement('button');
        btnDelete.type = 'button';
        btnDelete.className = 'key-item-btn key-item-btn-delete';
        btnDelete.title = 'حذف المفتاح';
        btnDelete.innerHTML = DELETE_ICON;
        btnDelete.addEventListener('click', () => {
          bankedKeysList.splice(index, 1);
          renderBankedKeys();
          updateBankedKeysSummary();
        });

        item.append(priorityBadge, inputWrapper, btnToggleVisibility, btnDelete);
        bankedKeysListEl.append(item);
      });
    }
  }

  function openBankedKeysModal() {
    renderBankedKeys();
    bankedKeysModal.classList.add('active');
  }

  function closeBankedKeysModal() {
    bankedKeysModal.classList.remove('active');
  }

  btnOpenBankedKeys.addEventListener('click', openBankedKeysModal);
  btnCloseBankedKeys.addEventListener('click', closeBankedKeysModal);
  bankedKeysModal.addEventListener('click', (e) => {
    if (e.target === bankedKeysModal) closeBankedKeysModal();
  });

  btnAddBankedKey.addEventListener('click', () => {
    bankedKeysList.push('');
    renderBankedKeys();
    const inputs = bankedKeysListEl.querySelectorAll('.key-item-input');
    if (inputs.length > 0) {
      inputs[inputs.length - 1].focus();
    }
  });

  btnSaveBankedKeys.addEventListener('click', () => {
    const cleaned = bankedKeysList.map(k => k.trim()).filter(Boolean);
    const badKeyIndex = cleaned.findIndex(k => !KEY_PATTERN.test(k));
    if (badKeyIndex !== -1) {
      showToast(`المفتاح الاحتياطي رقم ${badKeyIndex + 1} مش مفتاح OpenRouter أو Google صحيح`, 'error', 4000);
      return;
    }
    bankedKeysList = [...new Set(cleaned)];
    updateBankedKeysSummary();
    closeBankedKeysModal();
    showToast('تم تحديث قائمة المفاتيح الاحتياطية', 'info');
  });

  function openSettingsModal() {
    inputApiKey.value = currentSettings.apiKey || '';
    bankedKeysList = [...(currentSettings.bankedKeys || [])];
    updateBankedKeysSummary();
    updateModelOptions(inputApiKey.value, currentSettings.model);
    selectTargetLanguage.value = currentSettings.targetLanguage || 'English';
    checkAutoCopy.checked = currentSettings.autoCopy !== false;
    settingsModal.classList.add('active');
  }

  function closeSettingsModal() {
    settingsModal.classList.remove('active');
  }

  btnSettings.addEventListener('click', openSettingsModal);
  btnCloseSettings.addEventListener('click', closeSettingsModal);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });

  inputApiKey.addEventListener('input', () => {
    updateModelOptions(inputApiKey.value);
  });

  btnToggleKeyVisibility.addEventListener('click', () => {
    inputApiKey.type = inputApiKey.type === 'password' ? 'text' : 'password';
  });

  btnSaveSettings.addEventListener('click', async () => {
    const apiKey = inputApiKey.value.trim();
    if (apiKey && !KEY_PATTERN.test(apiKey)) {
      showToast('المفتاح لازم يكون من OpenRouter (sk-or-…) أو Google AI Studio (AIza… أو AQ.…)', 'error', 4000);
      return;
    }

    const prov = getProviderInfo(apiKey);
    const chosenModel = AVAILABLE_MODELS.find(m => m.id === selectModel.value);
    if (prov.className === 'google' && chosenModel && !chosenModel.providers.includes('google')) {
      showToast('الموديل المختار غير مدعوم عبر مفتاح Google', 'error', 4500);
      return;
    }

    const cleanedBanked = bankedKeysList.map(k => k.trim()).filter(Boolean);
    const badLine = cleanedBanked.findIndex(k => !KEY_PATTERN.test(k));
    if (badLine !== -1) {
      showToast(`المفتاح الاحتياطي رقم ${badLine + 1} مش مفتاح OpenRouter أو Google صحيح`, 'error', 4000);
      return;
    }

    currentSettings = await window.electronAPI.saveSettings({
      apiKey,
      bankedKeys: [...new Set(cleanedBanked)].filter(k => k !== apiKey),
      model: selectModel.value,
      targetLanguage: selectTargetLanguage.value,
      autoCopy: checkAutoCopy.checked
    });
    closeSettingsModal();
    showToast('تم حفظ الإعدادات', 'success');
  });

  // =========================================================================
  // Keyboard: Space toggles recording, Esc closes settings
  // =========================================================================

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (bankedKeysModal.classList.contains('active')) {
        closeBankedKeysModal();
        return;
      }
      if (settingsModal.classList.contains('active')) {
        closeSettingsModal();
        return;
      }
    }
    const el = document.activeElement;
    const isEditing = el && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName);
    if (e.code === 'Space' && !isEditing && !settingsModal.classList.contains('active') && !bankedKeysModal.classList.contains('active')) {
      e.preventDefault();
      btnRecordToggle.click();
    }
  });

  // =========================================================================
  // Toasts
  // =========================================================================

  function showToast(message, type = 'info', duration = 2500) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.append(toast);
    setTimeout(() => {
      toast.style.transition = 'all 0.3s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(15px)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
});
