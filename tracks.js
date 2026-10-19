// Track classes. Each track owns its own channel strip:
//   input -> fader -> panner -> gate (mute/solo) -> master
//                                  \-> meter (analyser)

import { Peaks, BUCKET } from './waveform.js';
import { playNote } from './synth.js';

let nextId = 1;
const dbToGain = (db) => (db <= -60 ? 0 : 10 ** (db / 20));

class Track {
  constructor(engine, name, kind) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.id = nextId++;
    this.name = name;
    this.kind = kind;
    this.volumeDb = 0;
    this.pan = 0;
    this.mute = false;
    this.solo = false;
    this.voices = new Set();

    const ctx = this.ctx;
    this.input = ctx.createGain();
    this.fader = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.gate = ctx.createGain();
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 512;
    this._meterBuf = new Float32Array(512);

    this.input.connect(this.fader);
    this.fader.connect(this.panner);
    this.panner.connect(this.gate);
    this.gate.connect(engine.master);
    this.gate.connect(this.meter);
  }

  setVolumeDb(db) {
    this.volumeDb = db;
    this.fader.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.015);
  }

  setPan(p) {
    this.pan = p;
    this.panner.pan.setTargetAtTime(p, this.ctx.currentTime, 0.015);
  }

  applyMix(anySolo) {
    const audible = !this.mute && (!anySolo || this.solo);
    this.gate.gain.setTargetAtTime(audible ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  level() {
    this.meter.getFloatTimeDomainData(this._meterBuf);
    let peak = 0;
    for (let i = 0; i < this._meterBuf.length; i++) {
      const a = Math.abs(this._meterBuf[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  _track(node) {
    this.voices.add(node);
    node.onended = () => this.voices.delete(node);
  }

  stopAll() {
    for (const n of this.voices) {
      try { n.stop(); } catch { /* not started / already stopped */ }
      n.disconnect();
    }
    this.voices.clear();
  }

  destroy() {
    this.stopAll();
    for (const n of [this.input, this.fader, this.panner, this.gate, this.meter]) n.disconnect();
  }
}

export class AudioTrack extends Track {
  constructor(engine, name) {
    super(engine, name, 'audio');
    this.clips = []; // { buffer, peaks, start, offset, duration } (seconds)
    this.armed = false;
    this.recording = null; // { peaks, start } while recording
  }

  addClip(buffer, start = 0, offset = 0, name = '', peaks = null) {
    const duration = buffer.duration - offset;
    if (duration <= 0) return null;
    const clip = { name, buffer, peaks: peaks || Peaks.fromBuffer(buffer), start, offset, duration };
    this.clips.push(clip);
    return clip;
  }

  schedule(startedAt, from) {
    for (const c of this.clips) {
      if (c.start + c.duration <= from) continue;
      const skip = Math.max(0, from - c.start);
      const src = this.ctx.createBufferSource();
      src.buffer = c.buffer;
      src.connect(this.input);
      src.start(startedAt + c.start + skip, c.offset + skip, c.duration - skip);
      this._track(src);
    }
  }

  endTime() {
    let end = 0;
    for (const c of this.clips) end = Math.max(end, c.start + c.duration);
    const r = this.recording;
    if (r && r.start != null) end = Math.max(end, r.start + (r.peaks.min.length * BUCKET) / r.peaks.sampleRate);
    return end;
  }
}

export class MidiTrack extends Track {
  constructor(engine, name) {
    super(engine, name, 'midi');
    this.notes = []; // { pitch, start (beats), dur (beats), vel }
    this.synth = this.ctx.createChannelMerger(2); // stereo synth bus
    this.synth.connect(this.input);
  }

  schedule(startedAt, from) {
    const spb = 60 / this.engine.bpm;
    for (const n of this.notes) {
      const ns = n.start * spb;
      const ne = (n.start + n.dur) * spb;
      if (ne <= from) continue;
      const s = Math.max(ns, from);
      const oscs = playNote(this.ctx, this.synth, {
        pitch: n.pitch,
        time: startedAt + s,
        duration: ne - s,
        velocity: n.vel,
      });
      oscs.forEach((o) => this._track(o));
    }
  }

  preview(pitch, duration = 0.35) {
    this.ctx.resume();
    const oscs = playNote(this.ctx, this.synth, {
      pitch,
      time: this.ctx.currentTime + 0.005,
      duration,
      velocity: 0.8,
    });
    oscs.forEach((o) => this._track(o));
  }

  endTime() {
    const spb = 60 / this.engine.bpm;
    let end = 0;
    for (const n of this.notes) end = Math.max(end, (n.start + n.dur) * spb);
    return end;
  }

  destroy() {
    super.destroy();
    this.synth.disconnect();
  }
}
