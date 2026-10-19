// Microphone / line-in recorder built on an AudioWorklet.
//
// Flow: prepare() (permission + worklet) -> begin(track) -> engine.play() -> finish()
// The recorded audio is placed on the timeline using the worklet's frame counter,
// minus the round-trip latency (output + input), so it lines up with what the
// performer was hearing.

import { Peaks } from './waveform.js';

export class Recorder {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.track = null;
    this._workletLoaded = false;
  }

  async prepare() {
    const ctx = this.engine.ctx;
    await ctx.resume();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access needs a secure context (https:// or http://localhost).');
    }
    if (!this._workletLoaded) {
      await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
      this._workletLoaded = true;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
  }

  // overrideMs: manual latency compensation in ms, or NaN for automatic estimate
  begin(track, overrideMs) {
    const ctx = this.engine.ctx;
    const settings = this.stream.getAudioTracks()[0].getSettings();
    const auto = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + (settings.latency || 0);
    this.comp = Number.isFinite(overrideMs) ? overrideMs / 1000 : auto;

    this.track = track;
    this.active = true;
    this.chunks = [];
    this.frames = 0;
    this.first = null; // timeline position (s) of the first recorded sample, before compensation
    this.numCh = 0;
    this.peaks = new Peaks(ctx.sampleRate);
    track.recording = { peaks: this.peaks, start: null };

    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: 'max',
    });
    this.sink = ctx.createGain(); // silent sink: keeps the worklet pulled, no monitoring
    this.sink.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);

    this._done = new Promise((res) => (this._resolveDone = res));
    this.node.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(m) {
    if (m.done) {
      this._resolveDone();
      return;
    }
    const ctx = this.engine.ctx;
    if (this.first === null) {
      this.first = m.frame / ctx.sampleRate - this.engine.startedAt;
      this.numCh = m.channels.length;
      this.track.recording.start = this.first - this.comp;
    }
    const chans = m.channels.slice(0, this.numCh);
    this.chunks.push(chans);
    this.frames += chans[0].length;
    this.peaks.push(chans);
  }

  async finish() {
    if (!this.active) return null;
    this.active = false;
    this.node.port.postMessage('stop');
    await Promise.race([this._done, new Promise((r) => setTimeout(r, 800))]);

    this.source.disconnect();
    this.node.disconnect();
    this.sink.disconnect();
    this.node.port.onmessage = null;
    this.stream.getTracks().forEach((t) => t.stop());

    const track = this.track;
    track.recording = null;
    if (!this.frames) return null;

    const ctx = this.engine.ctx;
    const buffer = ctx.createBuffer(this.numCh, this.frames, ctx.sampleRate);
    for (let c = 0; c < this.numCh; c++) {
      const data = new Float32Array(this.frames);
      let o = 0;
      for (const chunk of this.chunks) {
        data.set(chunk[c], o);
        o += chunk[c].length;
      }
      buffer.copyToChannel(data, c);
    }
    this.chunks = [];

    let start = this.first - this.comp;
    let offset = 0;
    if (start < 0) {
      offset = -start; // trim anything that would land before time zero
      start = 0;
    }
    return { track, buffer, start, offset, comp: this.comp };
  }
}
