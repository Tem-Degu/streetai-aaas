// Lightweight energy-based voice activity detector for the real-time pipeline.
//
// Operates on 16 kHz PCM16 frames. It is deliberately simple (RMS + hangover
// counters) so it has zero dependencies and near-zero latency. Its two jobs:
//   1. Endpointing for the segmented STT path (decide when the caller stopped).
//   2. Barge-in detection (caller starts speaking while the bot is talking).
//
// For production over a phone line, Silero VAD (ONNX) is a drop-in upgrade with
// better noise robustness; the interface here (process(frame) -> event) is the
// same so it can be swapped without touching the pipeline.

export class EnergyVAD {
  /**
   * @param {object} [o]
   * @param {number} [o.threshold=0.015] Normalised RMS (0..1) to count a frame as speech.
   * @param {number} [o.startFrames=3]   Consecutive speech frames to declare start (~start latency).
   * @param {number} [o.endFrames=25]    Consecutive silence frames to declare end (~hangover).
   */
  constructor({ threshold = 0.015, startFrames = 3, endFrames = 25 } = {}) {
    this.threshold = threshold;
    this.startFrames = startFrames;
    this.endFrames = endFrames;
    this.speaking = false;
    this._above = 0;
    this._below = 0;
  }

  /**
   * Feed one frame. Returns 'start', 'end', or null.
   * @param {Int16Array} frame
   */
  process(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const s = frame[i] / 32768;
      sum += s * s;
    }
    const rms = frame.length ? Math.sqrt(sum / frame.length) : 0;

    if (rms >= this.threshold) { this._above++; this._below = 0; }
    else { this._below++; this._above = 0; }

    if (!this.speaking && this._above >= this.startFrames) {
      this.speaking = true;
      return 'start';
    }
    if (this.speaking && this._below >= this.endFrames) {
      this.speaking = false;
      return 'end';
    }
    return null;
  }

  reset() {
    this.speaking = false;
    this._above = 0;
    this._below = 0;
  }
}
