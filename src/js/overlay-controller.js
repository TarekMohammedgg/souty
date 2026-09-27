/**
 * Souty - Floating pill: record → (pause/resume) → transcribe → paste into the user's app
 * Ctrl+Space finishes, X / Esc cancels.
 */

// Same names as the mode switch in the main window
const MODE_LABELS = { default: 'تفريغ', translate: 'ترجمة' };
// Short target-language tag for the chip, keyed by the settings value (fallback: first two letters)
const LANG_TAGS = {
  'English': 'EN', 'Modern Standard Arabic': 'AR', 'French': 'FR', 'German': 'DE', 'Spanish': 'ES', 'Italian': 'IT',
  'Portuguese': 'PT', 'Turkish': 'TR', 'Russian': 'RU', 'Chinese (Simplified)': 'ZH', 'Japanese': 'JA', 'Korean': 'KO'
};

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('overlay-canvas');
  const timerText = document.getElementById('timer-text');
  const recordIndicator = document.getElementById('record-indicator');
  const overlayStatus = document.getElementById('overlay-status');
  const modeChip = document.getElementById('mode-chip');
  const modeChipLabel = document.getElementById('mode-chip-label');
  const pill = document.getElementById('floating-pill');
  const btnPause = document.getElementById('btn-overlay-pause');
  const iconPause = document.getElementById('icon-pause');
  const iconResume = document.getElementById('icon-resume');
  const btnCancel = document.getElementById('btn-overlay-cancel');

  const audioRecorder = new AudioRecorder(canvas, (state) => {
    const paused = state === 'paused';
    iconPause.style.display = paused ? 'none' : 'block';
    iconResume.style.display = paused ? 'block' : 'none';
    btnPause.title = paused ? 'استئناف' : 'إيقاف مؤقت';
    btnPause.setAttribute('aria-label', btnPause.title);
    if (state === 'recording' || paused) {
      recordIndicator.className = paused ? 'record-indicator paused' : 'record-indicator';
    }
  }, (timerStr) => {
    timerText.textContent = timerStr;
  });

  let isProcessing = false;
  let safetyTimeout = null;
  let currentMode = 'default';
  let targetLanguage = 'English';

  // Status messages take the timer + chip space so they fit on one line
  function showStatus(text) {
    pill.classList.add('has-status');
    overlayStatus.textContent = text;
    overlayStatus.title = text;
  }

  function showMode(mode) {
    currentMode = MODE_LABELS[mode] ? mode : 'default';
    const tag = LANG_TAGS[targetLanguage] || targetLanguage.slice(0, 2).toUpperCase();
    modeChipLabel.textContent = currentMode === 'translate' ? `${MODE_LABELS.translate} ${tag}` : MODE_LABELS[currentMode];
    modeChip.title = currentMode === 'translate'
      ? `ترجمة إلى ${targetLanguage} — اضغط للتبديل للتفريغ`
      : 'اضغط للتبديل للترجمة';
    modeChip.dataset.mode = currentMode;
  }

  // The mode is read when the recording is sent, so switching mid-recording applies to it
  async function toggleMode() {
    if (isProcessing) return;
    const next = currentMode === 'translate' ? 'default' : 'translate';
    showMode(next); // instant feedback
    showMode(await window.overlayAPI.setMode(next));
  }

  function hideLater(ms) {
    setTimeout(() => window.overlayAPI.hideOverlay(), ms);
  }

  async function startRecording() {
    if (isProcessing) return;
    clearTimeout(safetyTimeout);

    const settings = await window.overlayAPI.getSettings();
    targetLanguage = settings.targetLanguage || 'English';
    showMode(settings.mode);

    if (!settings.apiKey) {
      showStatus('أضف مفتاح API من الإعدادات');
      hideLater(2500);
      return;
    }

    timerText.textContent = '00:00';
    pill.classList.remove('has-status');
    // Grey until the mic is actually capturing (~40ms, ~400ms on first use); the recorder's
    // 'recording' state turns it red, so people don't start talking before audio is recorded
    recordIndicator.className = 'record-indicator starting';
    btnPause.disabled = false;
    modeChip.disabled = false;

    try {
      await audioRecorder.start();
    } catch (err) {
      console.error('Failed to start overlay recording:', err);
      showStatus('تعذر تشغيل المايكروفون');
      hideLater(2200);
    }
  }

  async function stopAndTranscribe() {
    if (isProcessing) return;
    if (audioRecorder.state === 'idle') {
      window.overlayAPI.hideOverlay();
      return;
    }

    isProcessing = true;
    btnPause.disabled = true;
    modeChip.disabled = true;
    recordIndicator.className = 'record-indicator processing';
    showStatus(currentMode === 'translate' ? 'جاري الترجمة...' : 'جاري التفريغ...');

    safetyTimeout = setTimeout(() => {
      if (isProcessing) {
        isProcessing = false;
        recordIndicator.className = 'record-indicator';
        showStatus('انتهت المهلة، حاول تاني');
        hideLater(2000);
      }
    }, 16000);

    try {
      const result = await audioRecorder.stop();
      if (!result || !result.blob) {
        window.overlayAPI.hideOverlay();
        return;
      }

      if (result.duration < 1 && result.blob.size < 2000) {
        showStatus('التسجيل قصير جداً');
        hideLater(1200);
        return;
      }

      const response = await window.overlayAPI.transcribeAudio({
        base64Audio: result.base64,
        format: result.format
      });

      if (!response || !response.success) {
        recordIndicator.className = 'record-indicator';
        showStatus((response?.error || 'حدث خطأ بالتفريغ').slice(0, 40));
        hideLater(2500);
        return;
      }

      const text = (response.text || '').trim();
      if (!text) {
        window.overlayAPI.hideOverlay(); // silence: close quietly
        return;
      }

      // Trailing space so back-to-back dictations don't glue together
      window.overlayAPI.autoPaste(text + ' ');
      window.overlayAPI.addHistory({ text, duration: result.duration, mode: response.mode });

      recordIndicator.className = 'record-indicator done';
      showStatus('تمت الكتابة ✓');
      hideLater(900);
    } catch (err) {
      console.error('Overlay transcribe error:', err);
      recordIndicator.className = 'record-indicator';
      showStatus((err.message || 'خطأ بالتفريغ').slice(0, 40));
      hideLater(2500);
    } finally {
      clearTimeout(safetyTimeout);
      isProcessing = false;
    }
  }

  function togglePause() {
    if (isProcessing) return;
    if (audioRecorder.state === 'recording') audioRecorder.pause();
    else if (audioRecorder.state === 'paused') audioRecorder.resume();
  }

  function cancelRecording() {
    if (isProcessing) return;
    clearTimeout(safetyTimeout);
    audioRecorder.cancel();
    window.overlayAPI.hideOverlay();
  }

  btnPause.addEventListener('click', togglePause);
  btnCancel.addEventListener('click', cancelRecording);
  modeChip.addEventListener('click', toggleMode);

  // Esc works here once the pill has focus (after a click); otherwise the global Esc shortcut sends cancel
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelRecording();
  });

  window.overlayAPI.onStartRecord(startRecording);
  window.overlayAPI.onStopRecord(stopAndTranscribe);
  window.overlayAPI.onCancelRecord(cancelRecording);
});
