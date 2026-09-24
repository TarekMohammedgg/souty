/**
 * Souty - Native MediaRecorder (WebM Opus) with High-Sensitivity Live Visualizer
 * Robust, lightweight, hardware-accelerated, zero Garbage Collection issues
 */

class AudioRecorder {
  constructor(canvasElement, onStateChange, onTimerUpdate) {
    this.canvas = canvasElement;
    this.canvasCtx = canvasElement ? canvasElement.getContext('2d') : null;
    this.onStateChange = onStateChange || (() => {});
    this.onTimerUpdate = onTimerUpdate || (() => {});

    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.sourceNode = null;
    this.animationId = null;

    this.state = 'idle'; // 'idle', 'recording', 'paused'
    this.startTime = 0;
    this.pausedTime = 0;
    this.totalDuration = 0;
    this.timerInterval = null;

    this.initCanvasResize();
  }

  initCanvasResize() {
    if (!this.canvas) return;
    const resize = () => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this.canvas.width = Math.round(rect.width);
        this.canvas.height = Math.round(rect.height);
      }
    };
    window.addEventListener('resize', resize);
    setTimeout(resize, 50);
  }

  async start() {
    if (this.state === 'recording') return;

    try {
      // 1. Microphone access with noise suppression
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      // 2. AudioContext & Analyser for Live Waveform
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass();
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128; // Snappy responsiveness
      this.analyser.smoothingTimeConstant = 0.65;

      this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
      this.sourceNode.connect(this.analyser);

      // 3. MediaRecorder (WebM Opus)
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      }
      this.mimeType = mimeType;

      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: this.mimeType,
        audioBitsPerSecond: 64000 // High speech clarity, small payload
      });

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.audioChunks.push(e.data);
        }
      };

      this.mediaRecorder.start(250); // Slice every 250ms

      // 4. Timer setup
      this.startTime = Date.now();
      this.totalDuration = 0;
      this.pausedTime = 0;
      this.startTimer();

      this.state = 'recording';
      this.onStateChange(this.state);

      // 5. Start Visualizer loop
      this.drawVisualizer();

    } catch (err) {
      console.error('Failed to start audio recording:', err);
      this.cleanup();
      throw err;
    }
  }

  pause() {
    if (this.state !== 'recording') return;
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
    }
    this.pausedTime = Date.now();
    clearInterval(this.timerInterval);
    this.state = 'paused';
    this.onStateChange(this.state);
  }

  resume() {
    if (this.state !== 'paused') return;
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
    }
    if (this.pausedTime > 0) {
      this.startTime += (Date.now() - this.pausedTime);
      this.pausedTime = 0;
    }
    this.startTimer();
    this.state = 'recording';
    this.onStateChange(this.state);
  }

  async stop() {
    if (this.state === 'idle') return null;

    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        this.cleanup();
        return resolve(null);
      }

      this.mediaRecorder.onstop = async () => {
        const finalDuration = this.totalDuration;
        const audioBlob = new Blob(this.audioChunks, { type: this.mimeType || 'audio/webm' });
        // OpenRouter does not accept webm, so send 16kHz mono WAV
        const converted = await AudioConverter.toWavBase64(audioBlob);

        this.cleanup();
        this.state = 'idle';
        this.onStateChange(this.state);

        resolve({
          blob: audioBlob,
          base64: converted.base64,
          format: converted.format,
          duration: finalDuration
        });
      };

      try {
        if (this.mediaRecorder.state !== 'inactive') {
          this.mediaRecorder.stop();
        } else {
          this.cleanup();
          resolve(null);
        }
      } catch (e) {
        this.cleanup();
        resolve(null);
      }
    });
  }

  cancel() {
    this.cleanup();
    this.state = 'idle';
    this.onStateChange(this.state);
    this.onTimerUpdate('00:00');
  }

  startTimer() {
    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.totalDuration = Math.floor((Date.now() - this.startTime) / 1000);
      const minutes = String(Math.floor(this.totalDuration / 60)).padStart(2, '0');
      const seconds = String(this.totalDuration % 60).padStart(2, '0');
      this.onTimerUpdate(`${minutes}:${seconds}`);
    }, 200);
  }

  cleanup() {
    clearInterval(this.timerInterval);

    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }

    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {}
      this.audioCtx = null;
    }

    this.mediaRecorder = null;
    this.audioChunks = [];
    this.analyser = null;
    this.sourceNode = null;

    this.drawIdleVisualizer();
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        const base64 = result.substring(result.indexOf(',') + 1);
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  drawVisualizer() {
    if (!this.canvas || !this.canvasCtx || !this.analyser) return;

    const ctx = this.canvasCtx;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      if (this.state !== 'recording' && this.state !== 'paused') {
        this.drawIdleVisualizer();
        return;
      }

      this.animationId = requestAnimationFrame(render);

      // Auto-sync canvas internal pixel dimensions with CSS layout
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width > 0 && (this.canvas.width !== Math.round(rect.width) || this.canvas.height !== Math.round(rect.height))) {
        this.canvas.width = Math.round(rect.width);
        this.canvas.height = Math.round(rect.height);
      }

      const width = this.canvas.width || 300;
      const height = this.canvas.height || 80;

      if (this.state === 'paused') {
        this.drawPausedVisualizer();
        return;
      }

      this.analyser.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, width, height);

      const barCount = Math.min(36, Math.floor(width / 8));
      const barSpacing = 4;
      const totalSpacing = barSpacing * (barCount - 1);
      const barWidth = Math.max(3, (width - totalSpacing) / barCount);
      const step = Math.max(1, Math.floor((bufferLength * 0.75) / barCount));

      const barColor = getComputedStyle(this.canvas).color; // themed via CSS `color`

      for (let i = 0; i < barCount; i++) {
        const rawValue = dataArray[i * step] || 0;
        const normalized = rawValue / 255;
        // Boost speech sensitivity for prominent lively bouncing
        const boosted = Math.min(1, Math.pow(normalized, 0.7) * 2.2);

        const minHeight = 4;
        const barHeight = Math.max(minHeight, boosted * (height * 0.9));

        const x = i * (barWidth + barSpacing);
        const y = (height - barHeight) / 2;

        ctx.fillStyle = barColor;
        this.roundRect(ctx, x, y, barWidth, barHeight, barWidth / 2);
      }
    };

    render();
  }

  drawIdleVisualizer() {
    if (!this.canvas || !this.canvasCtx) return;
    const ctx = this.canvasCtx;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0) {
      this.canvas.width = Math.round(rect.width);
      this.canvas.height = Math.round(rect.height);
    }
    const width = this.canvas.width || 300;
    const height = this.canvas.height || 80;

    ctx.clearRect(0, 0, width, height);

    const barCount = Math.min(36, Math.floor(width / 8));
    const barSpacing = 4;
    const totalSpacing = barSpacing * (barCount - 1);
    const barWidth = Math.max(3, (width - totalSpacing) / barCount);
    const barHeight = 4;

    ctx.fillStyle = getComputedStyle(this.canvas).color;
    ctx.globalAlpha = 0.25;

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + barSpacing);
      const y = (height - barHeight) / 2;
      this.roundRect(ctx, x, y, barWidth, barHeight, barWidth / 2);
    }
    ctx.globalAlpha = 1;
  }

  drawPausedVisualizer() {
    if (!this.canvas || !this.canvasCtx) return;
    const ctx = this.canvasCtx;
    const width = this.canvas.width || 300;
    const height = this.canvas.height || 80;

    ctx.clearRect(0, 0, width, height);

    const barCount = Math.min(36, Math.floor(width / 8));
    const barSpacing = 4;
    const totalSpacing = barSpacing * (barCount - 1);
    const barWidth = Math.max(3, (width - totalSpacing) / barCount);

    ctx.fillStyle = 'rgba(255, 169, 70, 0.7)'; // orange accent

    for (let i = 0; i < barCount; i++) {
      const x = i * (barWidth + barSpacing);
      const wave = Math.sin((i / barCount) * Math.PI * 4) * 6;
      const barHeight = Math.max(4, 6 + wave);
      const y = (height - barHeight) / 2;
      this.roundRect(ctx, x, y, barWidth, barHeight, barWidth / 2);
    }
  }

  roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }
}

window.AudioRecorder = AudioRecorder;
