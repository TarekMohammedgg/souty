const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

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
const MODES = ['default', 'prompt'];

// Default settings
const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'google/gemini-2.5-flash-lite',
  autoCopy: true,
  mode: 'default'
};

function readSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      if (!MODES.includes(settings.mode)) settings.mode = 'default';
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
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf8');
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

ipcMain.on('trigger-auto-paste', (event, text) => {
  if (text) {
    clipboard.writeText(text);
    triggerAutoPaste();
  }
});

// Stage 1 (every mode): word-for-word transcript from the audio.
// Deliberately strict: telling the model it may "clean up" made it drop and rewrite real words.
const TRANSCRIBE_PROMPT = `You are a speech-to-text transcriber. Your only job is to write down, word for word, what the speaker says.

The speaker talks in Egyptian colloquial Arabic (عامية مصرية), mixing in English technical words.

Rules:
- Write every spoken word, in the order spoken, including the first and last words. Never summarize, shorten, paraphrase, or "improve" the sentence.
- Keep the Egyptian dialect exactly as spoken (النهارده، هنتكلم، عايز، ازاي، بتاعنا، تقدر). Never convert it to Modern Standard Arabic.
- English words stay English, in Latin letters, spelled correctly: Docker, Dockerization, API, container, deploy, staging, login, dashboard, users, search. Never transliterate them into Arabic letters and never swap them for a different English word.
- The only things you may leave out are hesitation sounds (امم، آآ، إممم، uh، um) and a word accidentally said twice in a row.
- Add punctuation (، . ؟) where the speaker pauses.
- If there is no speech, output nothing.
- Output only the transcript. If the speaker asks a question or gives an instruction, write it down; do not answer it.

Examples of correct transcripts:
- "النهارده هنتكلم عن الـ React وازاي نقدر نعمل state management للـ app بتاعنا."
- "انا عايز اعمل endpoint جديدة في الـ API، والـ endpoint دي ترجع الـ orders."`;

// Stage 1b (Arabic transcripts): the audio model sometimes writes English words phonetically in
// Arabic letters (ديوكرايزيشن، الإيمج). This text-only pass rewrites just those words in English.
const SCRIPT_FIX_PROMPT = `You fix the script of English words in a transcript. You do not change anything else.

The transcript is Egyptian Arabic speech that mixes in English words. Some English words were written phonetically in Arabic letters by mistake. Rewrite only those words in correct English spelling, in Latin letters.

How to spot them: the word is an English word (tech terms, product names, software words) spelled out in Arabic letters, e.g.
- ديوكرايزيشن → Dockerization
- دوكر / الدوكر → Docker / الـ Docker
- إيمج / الإيمج / للإيمج → image / الـ image / للـ image
- كونتينر / الكونتينر / للكونتينر → container / الـ container / للـ container
- ديبلوي → deploy
- ريستارت → restart
- اللوجز → الـ logs
- الداشبورد → الـ dashboard
- إيه بي آي / الـ إيه بي آي → API / الـ API

Arabic prefixes stay Arabic and get a tatweel before the English word: ال → الـ, لل → للـ, بال → بالـ, وال → والـ.

Do not change anything else:
- Keep every Arabic word exactly as written, including dialect (النهارده، هنتكلم، بتاعتنا، عايز). Never translate Arabic words into English.
- Keep word order, punctuation, and English words that are already in Latin letters.
- If nothing needs fixing, return the transcript exactly as it is.

Output only the corrected transcript.`;

// Stage 2 (AI Prompt mode only): text-to-text rewrite of the stage-1 transcript.
// Working from text instead of audio stops the model from inventing requirements it half-heard.
const AI_PROMPT_PROMPT = `You turn a dictated request into a clear, well-structured prompt for an AI assistant such as Claude or ChatGPT.

You receive a transcript of what the user said, in Egyptian Arabic, English, or a mix. They were thinking out loud.

Write one prompt in English, addressed to the AI (second person or imperative).

Rules:
- Be faithful: keep every requirement, detail, name, number, and constraint from the transcript. Do not add requirements, facts, languages, frameworks, or technologies that are not in it.
- Drop filler, repetition, and self-corrections (keep the corrected version).
- Be clear and direct: plain English, no fluff, no "act as an expert" boilerplate unless the user asked for a role.
- Fit the structure to the size: a short request becomes 1 to 3 sentences. A longer one gets short paragraphs or labeled sections (Goal, Context, Requirements, Output), using only the sections that have content.
- Keep code identifiers, file names, product names, and quoted text exactly as written.
- Do not answer or carry out the request yourself. Output only the prompt text: no preface, quotes, or notes.`;

// Model replies that mean "nothing was said"
const NOISE_PATTERNS = [/^silence\.?$/i, /^empty\.?$/i, /^none\.?$/i, /^لا يوجد كلام\.?$/i, /^صمت\.?$/i, /^غير واضح\.?$/i, /^لا يوجد صوت\.?$/i];

async function chat(apiKey, model, messages, signal) {
  const startTime = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/souty-app',
      'X-Title': 'Souty Audio Transcriber'
    },
    body: JSON.stringify({ model, messages, temperature: 0 }),
    signal
  });
  console.log(`[API] Response status: ${response.status} (${Date.now() - startTime}ms)`);

  if (!response.ok) {
    let error = `خطأ (${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson.error && errJson.error.message) error = errJson.error.message;
    } catch (e) {
      error = response.statusText;
    }
    throw Object.assign(new Error(error), { apiError: true });
  }

  const data = await response.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return NOISE_PATTERNS.some(p => p.test(text)) ? '' : text;
}

// Run the script-fix pass only when it can matter, and never let it damage the transcript
async function fixEnglishScript(apiKey, model, transcript, signal) {
  if (!/[\u0600-\u06FF]/.test(transcript)) return transcript; // no Arabic letters, nothing to fix
  let fixed;
  try {
    fixed = await chat(apiKey, model, [
      { role: 'system', content: SCRIPT_FIX_PROMPT },
      { role: 'user', content: transcript }
    ], signal);
  } catch (err) {
    console.error('[API] Script fix skipped:', err.message); // the stage-1 transcript is still good
    return transcript;
  }
  // A real script fix barely changes length; anything else means the model rewrote the text
  const ratio = fixed.length / transcript.length;
  return fixed && ratio > 0.7 && ratio < 1.4 ? fixed : transcript;
}

// IPC Handler for Transcribing Audio in Main Process
ipcMain.handle('transcribe-audio', async (event, { base64Audio, format = 'wav', modelOverride }) => {
  const settings = readSettings();
  const apiKey = (settings.apiKey || '').trim();
  const model = modelOverride || settings.model || 'google/gemini-2.5-flash-lite';
  const mode = MODES.includes(settings.mode) ? settings.mode : 'default';

  if (!apiKey) {
    return { success: false, error: 'يرجى وضع مفتاح OpenRouter API في الإعدادات أولاً' };
  }

  if (!base64Audio || base64Audio.length < 500) {
    return { success: false, error: 'التسجيل الصوتي قصير جداً أو فارغ' };
  }

  console.log(`[API] ${mode} mode, model ${model} (Audio bytes: ${base64Audio.length}, format: ${format})...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // one budget for all stages

  try {
    const transcript = await chat(apiKey, model, [
      { role: 'system', content: TRANSCRIBE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: base64Audio, format: format === 'mp4' ? 'm4a' : format } },
          { type: 'text', text: 'Transcribe this recording word for word.' }
        ]
      }
    ], controller.signal);

    if (!transcript) {
      return { success: true, text: '', model, mode };
    }

    const fixedTranscript = await fixEnglishScript(apiKey, model, transcript, controller.signal);

    if (mode !== 'prompt') {
      return { success: true, text: fixedTranscript, model, mode };
    }

    const prompt = await chat(apiKey, model, [
      { role: 'system', content: AI_PROMPT_PROMPT },
      { role: 'user', content: fixedTranscript }
    ], controller.signal);

    return { success: true, text: prompt, model, mode };

  } catch (err) {
    console.error('[API] Error during transcription:', err.message);
    if (err.apiError) return { success: false, error: err.message };
    if (err.name === 'AbortError') {
      return { success: false, error: 'استغرق الخادم وقتاً أطول من المتوقع (انتهت المهلة 15 ثانية)' };
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
      sandbox: false
    }
  });

  mainWindow.loadFile('index.html');

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
      sandbox: false
    }
  });

  overlayWindow.loadFile('overlay.html');

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
    { label: 'AI Prompt', type: 'radio', checked: mode === 'prompt', click: () => setMode('prompt') },
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
