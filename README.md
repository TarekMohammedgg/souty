<div align="center">
  <img src="src/assets/icon.svg" width="100" height="100" alt="Souty" />

  # Souty · صوتي

  **Voice-first writing for Windows — speak Arabic or English, text appears where your cursor is**

  [![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](package.json)
  [![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#)
  [![Electron](https://img.shields.io/badge/Electron-34-47848F?logo=electron)](https://electronjs.org)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
</div>

https://github.com/user-attachments/assets/b27a397a-3494-4948-a14a-688ab7280e49

---

Press **`Ctrl + Space`** from anywhere on Windows — a floating pill appears, you speak, and when you press **`Ctrl + Space`** again the transcribed text is automatically pasted into whatever window you were using.

> Designed for Egyptian Arabic mixed with English — the kind of speech developers and professionals actually use.

---

## Features

| | |
|---|---|
| **Global hotkey** | `Ctrl + Space` works from any app — browser, VS Code, Notepad, WhatsApp Desktop, Word |
| **Floating pill overlay** | Non-intrusive transparent pill at the bottom of the screen with live audio waveform |
| **Auto-paste** | Text is pasted directly into the window that had focus before recording — no manual Ctrl+V needed |
| **Egyptian Arabic + English** | Handles Arabic dialect mixed with English terms in the same sentence (`بدي أعمل deploy للـ backend`) |
| **Multiple models** | Gemini 2.5 Flash, Gemini 3.1 Flash-Lite, or MAI-Transcribe 2 (speech-to-text only, via OpenRouter) |
| **Translate mode** | Speak Arabic, receive polished English (or any target language) |
| **Key fallback** | Bank backup API keys; a quota or auth error on one key automatically tries the next |
| **System tray** | Runs silently in the tray; right-click to switch modes or start recording |
| **History** | Keeps the last 200 recordings locally with timestamps and duration |
| **High-quality audio** | 16 kHz mono PCM WAV — no WebM compression, best input for AI transcription |

---

## How It Works

```
Ctrl + Space → floating pill records 16kHz mono PCM WAV
        │
        ▼
[1] Transcribe   — one call to the selected model (audio → text)
        │           MAI-Transcribe 2 is speech-to-text only, so a Gemini
        │           text pass follows to fix misspelled English words
        ▼
[2] Clean up     — plain code, no model: fixes Arabic prefixes glued to
        │           English words (`الdashboard` → `الـ dashboard`)
        ▼
[3] Translate    — one more call, Translate mode only
        │           Produce natural, idiomatic text in the target language
        ▼
   Copied to clipboard, then auto-pasted into the original window
```

If your primary key fails (quota, invalid key, model unavailable), each banked backup key is tried in turn.

You need an API key from either provider:
- **OpenRouter** (`sk-or-…`) — gives access to all three models, including MAI-Transcribe 2
- **Google AI Studio** (`AIza…` or `AQ.…`) — Gemini models only, free tier available

---

## Quick Start

### Requirements

- **Windows 10 or 11**
- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- An **OpenRouter** ([openrouter.ai/keys](https://openrouter.ai/keys)) or **Google AI Studio** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) API key

### Install (recommended)

Download `Souty-Setup-1.0.0.exe` from [Releases](https://github.com/TarekMohammedgg/souty/releases) and run it.

The installer isn't code-signed, so Windows SmartScreen will show "Windows protected your PC". Click **More info → Run anyway**. This is expected for an independently published app without a paid signing certificate.

### Run from source

```bash
# Install dependencies
npm install

# Start the app
npm start

# Start with debug logging
npm run dev
```

### First-time setup

1. Open Souty — the settings panel appears automatically if no API key is set.
2. Paste your OpenRouter API key and click **Save**.
3. Press **`Ctrl + Space`** anywhere and start speaking.
4. Press **`Ctrl + Space`** again to stop — text is pasted into your last active window.

### Build the installer

```bash
npm run dist
# Output: dist/Souty-Setup-1.0.0.exe
```

---

## Modes

Switch modes from the tray icon or the mode chip in the overlay.

| Mode | Behaviour |
|------|-----------|
| **Transcribe** (`default`) | Writes exactly what was said — Arabic dialect, English, or mixed |
| **Translate** | Speaks Arabic → produces polished English (or another configured language) |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Space` | Start / stop recording |
| `Ctrl + Shift + Space` | Fallback hotkey (if Windows IME conflicts with Ctrl+Space) |
| `Esc` | Cancel current recording |

---

## Settings

Settings are stored in `%APPDATA%\souty-audio-transcriber\settings.json`. API keys are encrypted at rest with Windows DPAPI ([`safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)) — never written in plain text.

| Setting | Default | Description |
|---------|---------|-------------|
| `apiKey` | _(empty)_ | Primary OpenRouter or Google AI Studio key |
| `bankedKeys` | `[]` | Backup API keys tried in sequence when primary key hits limits |
| `model` | `google/gemini-2.5-flash` | `google/gemini-2.5-flash`, `google/gemini-3.1-flash-lite`, or `microsoft/mai-transcribe-2` |
| `mode` | `default` | `default` (transcribe) or `translate` |
| `targetLanguage` | `English` | Language for Translate mode output |
| `autoCopy` | `true` | Copy result to clipboard in addition to auto-paste |

---

## Project Structure

```
souty/
├── main.js                   # Electron main process — windows, tray, IPC, transcription pipeline
├── preload.js                # Secure context bridge for the main window
├── preload-overlay.js        # Secure context bridge for the overlay
├── index.html                # Main dashboard UI
├── overlay.html              # Floating pill overlay UI
├── src/
│   ├── prompts.js            # AI prompts, shared with scripts/eval
│   ├── tidy-transcript.js    # Fixes Arabic prefixes glued to English words
│   ├── js/
│   │   ├── audio-recorder.js       # 16kHz mono PCM WAV recorder
│   │   ├── audio-converter.js      # PCM → WAV encoding
│   │   ├── ui-controller.js        # Main window event handling
│   │   └── overlay-controller.js   # Overlay recording and auto-paste
│   ├── css/
│   │   ├── style.css               # Main window styles
│   │   └── overlay.css             # Overlay pill styles
│   └── assets/
│       ├── icon.svg / icon.ico / icon.png
├── scripts/eval/              # Transcription-quality eval harness for src/prompts.js
├── hotkey-hook.exe / .cs      # Native low-level keyboard hook (Ctrl+Space via Win32 API)
└── win-helper.exe / .cs       # Native helper: capture focused window HWND, send Ctrl+V
```

**Native helpers** (`hotkey-hook.exe`, `win-helper.exe`) are required for the auto-paste feature to work with Arabic keyboard layouts and apps that block standard clipboard injection. Both are built from the `.cs` files next to them with the .NET Framework `csc.exe` compiler (build command in a comment at the top of each file).

---

## Privacy

- Your audio and transcript are sent only to the provider of the API key you configured (OpenRouter or Google AI Studio) — never to any Souty-run server.
- API keys are encrypted at rest with Windows DPAPI; nothing else reads them.
- Recording history stays local, in `%APPDATA%\souty-audio-transcriber\history.json`.

---

## Development Notes

- The transcription pipeline lives entirely in `main.js` (`transcribe-audio` IPC handler). Prompts are in `src/prompts.js` and shared with `scripts/eval/` so evaluation numbers reflect the exact shipped prompts.
- `tidy-transcript.js` is plain code (no model call) that fixes an Arabic prefix glued to the following English word — the one artifact MAI-Transcribe consistently produces.
- The overlay uses `showInactive()` so keyboard focus stays in the user's original app until they explicitly click the pill.
- History is stored in `%APPDATA%\souty-audio-transcriber\history.json` with an atomic write (write to `.tmp`, then rename) to prevent corruption on crash.

---

## License

MIT — see [LICENSE](LICENSE)
