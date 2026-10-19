// Engine: AudioContext, master bus, transport and track list.

import { AudioTrack, MidiTrack } from './tracks.js';

const LEAD = 0.06; // seconds of scheduling lead-in when starting playback

export class Engine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.tracks = [];
    this.bpm = 120;
    this.playing = false;
    this.startedAt = 0; // ctx time at which timeline position 0 occurs
    this.pausedAt = 0; // timeline position while stopped
  }

  get position() {
    return this.playing ? Math.max(0, this.ctx.currentTime - this.startedAt) : this.pausedAt;
  }

  get duration() {
    return this.tracks.reduce((m, t) => Math.max(m, t.endTime()), 0);
  }

  addAudioTrack(name) {
    const t = new AudioTrack(this, name);
    this.tracks.push(t);
    t.applyMix(this.tracks.some((x) => x.solo));
    return t;
  }

  addMidiTrack(name) {
    const t = new MidiTrack(this, name);
    this.tracks.push(t);
    t.applyMix(this.tracks.some((x) => x.solo));
    return t;
  }

  removeTrack(track) {
    track.destroy();
    this.tracks = this.tracks.filter((t) => t !== track);
    this.updateMix();
  }

  updateMix() {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) t.applyMix(anySolo);
  }

  setMasterDb(db) {
    this.master.gain.setTargetAtTime(db <= -60 ? 0 : 10 ** (db / 20), this.ctx.currentTime, 0.015);
  }

  play() {
    if (this.playing) return;
    this.ctx.resume();
    const from = this.pausedAt;
    this.startedAt = this.ctx.currentTime + LEAD - from;
    this.playing = true;
    for (const t of this.tracks) t.schedule(this.startedAt, from);
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.position;
    this.playing = false;
    for (const t of this.tracks) t.stopAll();
  }

  stop() {
    this.pause();
    this.pausedAt = 0;
  }

  seek(sec) {
    sec = Math.max(0, sec);
    if (this.playing) {
      for (const t of this.tracks) t.stopAll();
      this.startedAt = this.ctx.currentTime + LEAD - sec;
      for (const t of this.tracks) t.schedule(this.startedAt, sec);
    } else {
      this.pausedAt = sec;
    }
  }

  // Re-schedule everything from the current position (after edits during playback).
  resync() {
    if (this.playing) this.seek(this.position);
  }
}
