const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, clipboard, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { TRANSCRIBE_PROMPT, TRANSCRIBE_INSTRUCTION, FIX_ENGLISH_PROMPT, translatePrompt } = require('./src/prompts');
const { tidyTranscript } = require('./src/tidy-transcript');

// Bypass Chromium Autoplay policy so AudioContext and Web Audio Analyser work immediately without requiring user clicks
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let hookProcess = null;
let lastHotkeyTime = 0;
let targetHwnd = ''; // window the user was typing in when recording started
// Native helpers can't run from inside app.asar; the installer keeps them in app.asar.unpacked
const nativeDir = __dirname.replace('app.asar', 'app.asar.unpacked');
const winHelper = path.join(nativeDir, 'win-helper.exe');
app.isQuitting = false;

// .ico holds 16–256px sizes so Windows picks a sharp one for taskbar, tray and Alt+Tab
const iconPath = path.join(__dirname, process.platform === 'win32' ? 'src/assets/icon.ico' : 'src/assets/icon.png');
if (process.platform === 'win32') app.setAppUserModelId('com.souty.app'); // own taskbar identity instead of "Electron"
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const historyPath = path.join(app.getPath('userData'), 'history.json');
const HISTORY_LIMIT = 200;
const MODES = ['default', 'translate'];
// Supported models
const MODELS = [
  'google/gemini-2.5-flash',
  'google/gemini-3.1-flash-lite',
  'microsoft/mai-transcribe-2'
];
// Speech-to-text only models: OpenRouter's /audio/transcriptions, no prompt (it's ignored), then a text fix pass
const isOpenRouterStt = (model) => model.startsWith('microsoft/mai-transcribe');

// Default settings
const DEFAULT_SETTINGS = {
  apiKey: '',
  bankedKeys: [],
  model: 'google/gemini-2.5-flash',
  autoCopy: true,
  mode: 'default',
  targetLanguage: 'English'
};

// API keys are encrypted at rest with Windows DPAPI (safeStorage) under *Enc fields; decrypted only in memory.
// Falls back to plain text when encryption isn't available (e.g. no login keyring) so a key is never lost.
const canEncrypt = () => safeStorage.isEncryptionAvailable();
const encryptKey = (key) => canEncrypt() && key ? safeStorage.encryptString(key).toString('base64') : key;
const decryptKey = (value, enc) => enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : (value || '');

function readSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const settings = { ...DEFAULT_SETTINGS, ...raw };
      settings.apiKey = decryptKey(raw.apiKey, raw.apiKeyEnc);
      settings.bankedKeys = Array.isArray(raw.bankedKeysEnc)
        ? raw.bankedKeysEnc.map(enc => decryptKey(null, enc))
        : (Array.isArray(raw.bankedKeys) ? raw.bankedKeys : []);
      delete settings.apiKeyEnc;
      delete settings.bankedKeysEnc;
      if (!MODES.includes(settings.mode)) settings.mode = 'default';
      if (!MODELS.includes(settings.model)) settings.model = MODELS[0];
      return settings;
    }
  } catch (e) {
    console.error('Failed to read settings.json:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

function writeSettings(newSettings) {
  try {
    const current = readSettings();
    const updated = { ...current, ...newSettings };
    const onDisk = { ...updated };
    if (canEncrypt()) {
      onDisk.apiKeyEnc = encryptKey(updated.apiKey || '');
      onDisk.bankedKeysEnc = (updated.bankedKeys || []).map(encryptKey);
      delete onDisk.apiKey;
      delete onDisk.bankedKeys;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(onDisk, null, 2), 'utf8');
    return updated;
  } catch (e) {
    console.error('Failed to write settings.json:', e);
    return readSettings();
  }
}

// History: one JSON file in userData
function readHistory() {
  try {
    const items = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return Array.isArray(items) ? items : [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Keep a corrupt file aside instead of overwriting it on the next save
      try { fs.renameSync(historyPath, historyPath.replace(/\.json$/, `.corrupt-${Date.now()}.json`)); } catch (_) {}
      console.error('Failed to read history.json:', e.message);
    }
    return [];
  }
}

function writeHistory(items) {
  const tmp = historyPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, historyPath); // atomic replace: a crash never leaves a half-written file
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history-changed');
  return items;
}

function isValidItem(item) {
  return item && typeof item.id === 'string' && typeof item.text === 'string' && !isNaN(new Date(item.timestamp));
}

ipcMain.handle('history:list', () => readHistory());

ipcMain.handle('history:add', (event, item) => {
  const text = String(item?.text || '').trim();
  if (!text) return null;
  const entry = {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    duration: Number(item.duration) || 0,
    text,
    mode: MODES.includes(item.mode) ? item.mode : 'default'
  };
  writeHistory([entry, ...readHistory()].slice(0, HISTORY_LIMIT));
  return entry;
});

ipcMain.handle('history:delete', (event, id) => writeHistory(readHistory().filter(i => i.id !== id)));
ipcMain.handle('history:clear', () => writeHistory([]));

// One-time migration of the old localStorage history (merged by id, so re-running is harmless)
ipcMain.handle('history:import', (event, items) => {
  const current = readHistory();
  if (!Array.isArray(items)) return current;
  const ids = new Set(current.map(i => i.id));
  const incoming = items.filter(i => isValidItem(i) && !ids.has(i.id));
  if (!incoming.length) return current;
  const merged = [...current, ...incoming]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, HISTORY_LIMIT);
  return writeHistory(merged);
});

// Low-Level Native Keyboard Hook Process Management
function startHotkeyHook() {
  const hookExe = path.join(nativeDir, 'hotkey-hook.exe');
  if (!fs.existsSync(hookExe)) {
    console.warn('[HOOK] hotkey-hook.exe not found at', hookExe);
    return;
  }

  try {
    hookProcess = spawn(hookExe, [], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    hookProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('HOTKEY_TRIGGERED')) {
        const now = Date.now();
        if (now - lastHotkeyTime > 400) {
          lastHotkeyTime = now;
          console.log('[HOOK] Global Ctrl+Space detected via native hook!');
          toggleOverlay();
        }
      }
    });

    hookProcess.stderr.on('data', (data) => {
      console.error('[HOOK STDERR]:', data.toString());
    });

    hookProcess.on('exit', (code) => {
      console.log(`[HOOK] Process exited with code ${code}`);
      hookProcess = null;
      if (!app.isQuitting) {
        setTimeout(startHotkeyHook, 2000);
      }
    });

    hookProcess.on('error', (err) => {
      console.error('[HOOK] Process error:', err);
    });

    console.log('[HOOK] Native low-level keyboard hook active.');
  } catch (err) {
    console.error('[HOOK] Failed to spawn hotkey-hook:', err);
  }
}

function stopHotkeyHook() {
  if (hookProcess) {
    try {
      hookProcess.kill();
    } catch (e) {}
    hookProcess = null;
  }
}

// Remember which window has focus before the overlay appears
function captureTargetWindow() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    execFile(winHelper, ['capture'], (err, stdout) => {
      targetHwnd = err ? '' : stdout.trim();
      resolve();
    });
  });
}

// Refocus the captured window and send Ctrl+V as virtual keys (works with Arabic keyboard layout too)
function triggerAutoPaste() {
  if (process.platform !== 'win32') return;
  execFile(winHelper, ['paste', targetHwnd || '0'], (err) => {
    if (err) console.error('[AUTO-PASTE] Failed:', err.message);
    else console.log(`[AUTO-PASTE] Pasted into window ${targetHwnd}`);
  });
}

// IPC Handlers
ipcMain.handle('get-app-settings', () => readSettings());
ipcMain.handle('save-app-settings', (event, newSettings) => {
  const updated = writeSettings(newSettings);
  buildTrayMenu();
  return updated;
});

function setMode(mode) {
  if (!MODES.includes(mode)) return;
  writeSettings({ mode });
  buildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings-changed', readSettings());
}

// From the floating pill's mode chip
ipcMain.handle('set-mode', (event, mode) => {
  setMode(mode);
  return readSettings().mode;
});

// Renderer copies go through here: navigator.clipboard is denied when the window isn't focused
ipcMain.handle('copy-text', (event, text) => clipboard.writeText(String(text ?? '')));

ipcMain.on('trigger-auto-paste', (event, text) => {
  if (text) {
    clipboard.writeText(text);
    triggerAutoPaste();
  }
});

// Transcription: one Gemini call per recording (plus one text call in Translate mode).
// The provider comes from the key's shape, so one settings field accepts either key.
const DEFAULT_MODEL = MODELS[0];

// Model replies that mean "nothing was said"
const NOISE_PATTERNS = [/^silence\.?$/i, /^empty\.?$/i, /^none\.?$/i, /^لا يوجد كلام\.?$/i, /^صمت\.?$/i, /^غير واضح\.?$/i, /^لا يوجد صوت\.?$/i];

// Google's defaults sometimes block ordinary Arabic mid-sentence; dictation of the user's own speech needs none
const GOOGLE_SAFETY_OFF = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map(category => ({ category, threshold: 'BLOCK_NONE' }));

const AUDIO_MIME = { wav: 'audio/wav', webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/mp4', mp3: 'audio/mp3', ogg: 'audio/ogg' };

function detectProvider(apiKey) {
  if (apiKey.startsWith('sk-or-')) return 'openrouter';
  if (/^(AIza|AQ\.)/.test(apiKey)) return 'google'; // AQ. = AI Studio's newer key format
  return null;
}

// retryable: this key can't serve the request (quota, bad key, no credit, model unavailable), so a banked key might
const apiError = (message, retryable = false) => Object.assign(new Error(message), { apiError: true, retryable });

// input: { text, audio?: { data, format } } → model reply text
async function generate({ apiKey, model, system, input, signal }) {
  const provider = detectProvider(apiKey);
  // Gemini 3.x can't turn thinking off; "minimal" is its lowest (and fastest) level
  const isGemini3 = model.includes('gemini-3');
  const isSttOnly = isOpenRouterStt(model);
  const startTime = Date.now();

  if (isSttOnly && provider === 'google') {
    // retryable: a banked OpenRouter key can still serve it
    throw apiError(`موديل ${model} متاح فقط عبر مفتاح OpenRouter (sk-or-…)`, true);
  }

  if (provider === 'openrouter') {
    if (isSttOnly && input.audio) {
      const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/TarekMohammedgg/souty',
          'X-Title': 'Souty Audio Transcriber'
        },
        // MAI-Transcribe ignores prompt and language hints (same output with or without them), so none are sent
        body: JSON.stringify({
          model,
          input_audio: {
            data: input.audio.data,
            format: input.audio.format === 'mp4' ? 'm4a' : input.audio.format
          }
        }),
        signal
      });
      const data = await response.json().catch(() => ({}));
      console.log(`[API] openrouter stt ${model} ${response.status} (${Date.now() - startTime}ms)`);
      if (!response.ok || data.error) throw apiError(data.error?.message || `خطأ (${response.status})`, true);
      return (data.text || '').trim();
    }

    const content = [{ type: 'text', text: input.text }];
    if (input.audio) {
      content.unshift({ type: 'input_audio', input_audio: { data: input.audio.data, format: input.audio.format === 'mp4' ? 'm4a' : input.audio.format } });
    }
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/TarekMohammedgg/souty',
        'X-Title': 'Souty Audio Transcriber'
      },
      body: JSON.stringify({ model, temperature: 0, ...(isGemini3 && { reasoning: { effort: 'minimal' } }), messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
      signal
    });
    const data = await response.json().catch(() => ({}));
    console.log(`[API] openrouter ${model} ${response.status} (${Date.now() - startTime}ms)`);
    if (!response.ok || data.error) throw apiError(data.error?.message || `خطأ (${response.status})`, true);
    const choice = data.choices?.[0] || {};
    if (choice.finish_reason === 'content_filter') throw apiError('الموديل وقف التفريغ في النص، جرّب تاني');
    return (choice.message?.content || '').trim();
  }

  if (provider === 'google') {
    const parts = [{ text: input.text }];
    if (input.audio) {
      parts.unshift({ inline_data: { mime_type: AUDIO_MIME[input.audio.format] || 'audio/wav', data: input.audio.data } });
    }
    const id = model.replace(/^google\//, '');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, thinkingConfig: isGemini3 ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 } },
        safetySettings: GOOGLE_SAFETY_OFF
      }),
      signal
    });
    const data = await response.json().catch(() => ({}));
    console.log(`[API] google ${id} ${response.status} (${Date.now() - startTime}ms)`);
    if (response.status === 429) throw apiError('وصلت لحد الاستخدام في مفتاح Google، استنى دقيقة وجرّب تاني', true);
    if (!response.ok || data.error) throw apiError(data.error?.message || `خطأ (${response.status})`, true);
    const candidate = data.candidates?.[0];
    if (!candidate) throw apiError(`Google رفض الطلب (${data.promptFeedback?.blockReason || 'no candidates'})`);
    if (candidate.finishReason === 'SAFETY') throw apiError('الموديل وقف التفريغ في النص، جرّب تاني');
    return (candidate.content?.parts || []).map(p => p.text || '').join('').trim();
  }

  throw apiError('المفتاح مش معروف: لازم يكون مفتاح OpenRouter (sk-or-…) أو Google AI Studio (AIza… أو AQ.…)', true);
}

// Tries the main key, then each banked key, until one can serve the request.
// ponytail: always starts from the main key; each limited key costs one fast failed request. Add a per-key cooldown if that latency shows up.
async function generateWithKeys(keys, request) {
  for (let i = 0; i < keys.length; i++) {
    try {
      return await generate({ ...request, apiKey: keys[i] });
    } catch (err) {
      if (!err.retryable) throw err;
      if (i === keys.length - 1) {
        if (keys.length > 1) err.message = `كل المفاتيح (${keys.length}) فشلت، آخر خطأ: ${err.message}`;
        throw err;
      }
      console.warn(`[API] key ${i + 1}/${keys.length} failed (${err.message.slice(0, 80)}), trying the next one`);
    }
  }
}

ipcMain.handle('transcribe-audio', async (event, { base64Audio, format = 'wav', modelOverride }) => {
  const settings = readSettings();
  const apiKey = (settings.apiKey || '').trim();
  // Main key first, then the banked fallbacks in the order the user listed them
  const keys = [...new Set([apiKey, ...(settings.bankedKeys || [])].map(k => k.trim()).filter(Boolean))];
  const model = modelOverride || settings.model || DEFAULT_MODEL;
  const mode = MODES.includes(settings.mode) ? settings.mode : 'default';

  if (!apiKey) {
    return { success: false, error: 'يرجى وضع مفتاح API في الإعدادات أولاً' };
  }
  if (!base64Audio || base64Audio.length < 500) {
    return { success: false, error: 'التسجيل الصوتي قصير جداً أو فارغ' };
  }

  console.log(`[API] ${mode} mode, model ${model} (Audio bytes: ${base64Audio.length}, format: ${format})...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // long recordings and Pro need more than 15s

  try {
    let reply = await generateWithKeys(keys, {
      model, system: TRANSCRIBE_PROMPT, signal: controller.signal,
      input: { text: TRANSCRIBE_INSTRUCTION, audio: { data: base64Audio, format } }
    });
    // Speech-to-text models misspell English words or write them in Arabic letters; a Gemini text pass fixes only those
    // (skipped for all-English text: nothing to fix there, and the pass sometimes added الـ to it)
    if (isOpenRouterStt(model) && /[؀-ۿ]/.test(reply)) {
      reply = await generateWithKeys(keys, {
        model: DEFAULT_MODEL, system: FIX_ENGLISH_PROMPT, signal: controller.signal, input: { text: reply }
      });
    }
    const transcript = NOISE_PATTERNS.some(p => p.test(reply)) ? '' : tidyTranscript(reply);

    if (!transcript || mode !== 'translate') {
      return { success: true, text: transcript, model, mode };
    }

    // Translate the transcript in translate mode using the conversational model
    const translationModel = isOpenRouterStt(model) ? DEFAULT_MODEL : model;
    const translation = await generateWithKeys(keys, {
      model: translationModel, system: translatePrompt(settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage), signal: controller.signal,
      input: { text: transcript }
    });
    return { success: true, text: translation, model, mode };

  } catch (err) {
    console.error('[API] Error during transcription:', err.message);
    if (err.apiError) return { success: false, error: err.message };
    if (err.name === 'AbortError') {
      return { success: false, error: 'استغرق الخادم وقتاً أطول من المتوقع (انتهت المهلة 60 ثانية)' };
    }
    return { success: false, error: `تعذر الاتصال بالخادم: ${err.message}` };
  } finally {
    clearTimeout(timeoutId);
  }
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 820,
    minWidth: 840,
    minHeight: 650,
    backgroundColor: '#FFFFEB',
    icon: iconPath,
    show: false,
    autoHideMenuBar: true,
    title: 'صوتي | Souty',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: true
    }
  });

  mainWindow.loadFile('index.html');

  // Links (e.g. "get your API key") open in the user's browser, not a new app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Nothing in this window should ever navigate away from index.html (dropped file, stray link, etc.)
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // When clicking close button (X), hide to Tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone') return true;
    return false;
  });

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') return callback(true);
    return callback(false);
  });
}

function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  const width = 380;
  const height = 76;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + workArea.height - height - 35);

  overlayWindow = new BrowserWindow({
    width: width,
    height: height,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    hasShadow: false,
    // focusable:false made Windows swallow ~1 in 5 clicks on the pill buttons.
    // showInactive() still keeps focus in the user's app until they click the pill,
    // and hide-overlay hands focus back to that app.
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: true
    }
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  overlayWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media' || permission === 'microphone') return true;
    return false;
  });

  overlayWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone') return callback(true);
    return callback(false);
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function showAndStartRecording() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    overlayWindow.webContents.once('did-finish-load', () => {
      showAndStartRecording();
    });
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const width = 380;
  const height = 76;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + workArea.height - height - 35);

  if (overlayWindow.isMinimized()) {
    overlayWindow.restore();
  }

  overlayWindow.setBounds({ x, y, width, height });
  overlayWindow.setOpacity(1.0);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // showInactive keeps keyboard focus in the user's app (show() activates the window on Windows)
  overlayWindow.showInactive();

  // Esc cancels while the pill is visible (released again in hide-overlay)
  if (!globalShortcut.isRegistered('Escape')) {
    globalShortcut.register('Escape', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('cancel-overlay-recording');
      }
    });
  }

  console.log(`[OVERLAY] Showing overlay window at (${x}, ${y}, ${width}x${height})...`);
  overlayWindow.webContents.send('start-overlay-recording');
}

async function toggleOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.webContents.send('stop-overlay-recording');
    return;
  }
  await captureTargetWindow();
  showAndStartRecording();
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayMenu() {
  if (!tray) return;
  const mode = readSettings().mode;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'تسجيل (Ctrl + Space)', click: () => toggleOverlay() },
    { type: 'separator' },
    { label: 'تفريغ', type: 'radio', checked: mode === 'default', click: () => setMode('default') },
    { label: 'ترجمة', type: 'radio', checked: mode === 'translate', click: () => setMode('translate') },
    { type: 'separator' },
    { label: 'فتح صوتي', click: showMainWindow },
    { label: 'خروج', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function createTray() {
  try {
    tray = new Tray(iconPath);
    tray.setToolTip('صوتي | Ctrl + Space للتسجيل');
    buildTrayMenu();
    tray.on('click', () => {
      if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
      else showMainWindow();
    });
  } catch (err) {
    console.warn('Tray creation warning:', err);
  }
}

// IPC Handlers
ipcMain.on('hide-overlay', () => {
  globalShortcut.unregister('Escape');
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const hadFocus = overlayWindow.isFocused();
    overlayWindow.hide();
    if (hadFocus && process.platform === 'win32' && targetHwnd) {
      execFile(winHelper, ['focus', targetHwnd], () => {});
    }
  }
});

// App Lifecycle
// One instance only: a second launch just brings the existing window forward
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  createMainWindow();
  createOverlayWindow();
  createTray();

  // Start native driver-level hook for Ctrl + Space (bypasses Windows IME & works everywhere)
  startHotkeyHook();

  // Register multiple hotkeys: Ctrl+Space (standard) + Ctrl+Shift+Space (fallback if Windows IME conflicts)
  try {
    const ok = globalShortcut.register('CommandOrControl+Space', () => {
      const now = Date.now();
      if (now - lastHotkeyTime > 400) {
        lastHotkeyTime = now;
        console.log('[SHORTCUT] Ctrl+Space pressed!');
        toggleOverlay();
      }
    });
    console.log(`[SHORTCUT] CommandOrControl+Space registered: ${ok}`);
  } catch (e) {
    console.error('[SHORTCUT] Register Ctrl+Space error:', e);
  }

  try {
    const ok = globalShortcut.register('Ctrl+Shift+Space', () => {
      const now = Date.now();
      if (now - lastHotkeyTime > 400) {
        lastHotkeyTime = now;
        console.log('[SHORTCUT] Ctrl+Shift+Space pressed!');
        toggleOverlay();
      }
    });
    console.log(`[SHORTCUT] Ctrl+Shift+Space registered: ${ok}`);
  } catch (e) {
    console.error('[SHORTCUT] Register Ctrl+Shift+Space error:', e);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopHotkeyHook();
});

app.on('will-quit', () => {
  stopHotkeyHook();
  globalShortcut.unregisterAll();
});
