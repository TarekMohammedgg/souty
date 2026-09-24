/**
 * Souty - Audio Converter (Blob to 16kHz Mono WAV)
 * Optimizes audio size and format for speech-to-text APIs
 */

class AudioConverter {
  /**
   * Converts any recorded audio Blob into a 16kHz Mono WAV base64 string
   */
  static async toWavBase64(blob) {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextClass();
      const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close();

      const targetSampleRate = 16000; // Optimal for speech recognition
      const numFrames = Math.max(1, Math.floor(decodedBuffer.duration * targetSampleRate));

      // Offline context to resample and mixdown to mono
      const offlineCtx = new OfflineAudioContext(1, numFrames, targetSampleRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(offlineCtx.destination);
      source.start(0);

      const resampledBuffer = await offlineCtx.startRendering();
      const wavArrayBuffer = this.encodeWAV(resampledBuffer);
      const wavBlob = new Blob([wavArrayBuffer], { type: 'audio/wav' });

      return {
        base64: await this.blobToBase64(wavBlob),
        format: 'wav',
        blob: wavBlob
      };
    } catch (err) {
      console.warn('WAV conversion fallback to original blob:', err);
      // Fallback directly to original blob
      const rawBase64 = await this.blobToBase64(blob);
      let format = 'webm';
      if (blob.type.includes('mp4') || blob.type.includes('m4a')) format = 'mp4';
      if (blob.type.includes('wav')) format = 'wav';
      return {
        base64: rawBase64,
        format: format,
        blob: blob
      };
    }
  }

  static blobToBase64(blob) {
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

  static encodeWAV(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0); // Mono channel
    const sampleRate = audioBuffer.sampleRate;
    const numSamples = channelData.length;
    const bytesPerSample = 2; // 16-bit PCM
    const blockAlign = 1 * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, 'WAVE');

    // FMT sub-chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
    view.setUint16(22, 1, true);  // NumChannels (1 mono)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // BitsPerSample (16 bits)

    // Data sub-chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write PCM samples
    let offset = 44;
    for (let i = 0; i < numSamples; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return buffer;
  }

  static writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

window.AudioConverter = AudioConverter;
