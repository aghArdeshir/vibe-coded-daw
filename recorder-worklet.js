// Runs on the audio thread: forwards raw input blocks to the main thread
// together with the exact frame number, so recordings can be placed on the
// timeline sample-accurately.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stopping = false;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.stopping = true;
    };
  }

  process(inputs) {
    if (this.stopping) {
      this.port.postMessage({ done: true });
      return false;
    }
    const input = inputs[0];
    if (input && input.length) {
      const channels = input.map((c) => c.slice());
      this.port.postMessage({ frame: currentFrame, channels }, channels.map((c) => c.buffer));
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
