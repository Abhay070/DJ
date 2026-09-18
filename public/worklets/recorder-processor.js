/**
 * RecorderProcessor - taps the master bus and ships raw float blocks to the
 * main thread. Recording captures the exact samples that reach the output, so
 * an exported mix is bit-identical to what was heard (no re-render, no encode
 * round-trip on the WAV path).
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data.type === 'start') this.recording = true;
      else if (e.data.type === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.recording && input && input.length) {
      const left = input[0];
      const right = input.length > 1 ? input[1] : input[0];
      if (left && left.length) {
        const l = new Float32Array(left);
        const r = new Float32Array(right);
        this.port.postMessage({ type: 'chunk', left: l, right: r }, [l.buffer, r.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
