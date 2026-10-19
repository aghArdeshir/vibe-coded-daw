// Timeline: ruler, track rows (header controls + waveform/notes lane), playhead.
// Lane canvases are only as wide as the viewport and redraw on scroll, so very
// long projects never hit canvas size limits.

import { drawClip, drawGrid } from './waveform.js';
import { LOOP_MIME } from './library.js';

export const HEAD_W = 248;
export const ROW_H = 108;
const RULER_H = 28;

const AUDIO_COLOR = '#4cc2ff';
const AUDIO_BG = 'rgba(76,194,255,0.10)';
const REC_COLOR = '#ff6b78';
const REC_BG = 'rgba(255,77,94,0.12)';
const NOTE_COLOR = '#7ddc6a';

const fmtDb = (db) => (db <= -60 ? '-∞ dB' : `${db.toFixed(1)} dB`);
const fmtPan = (p) => (Math.abs(p) < 0.005 ? 'C' : `${Math.round(Math.abs(p) * 100)}${p < 0 ? 'L' : 'R'}`);

function sizeCanvas(c, w, h, dpr) {
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (c.width !== pw || c.height !== ph) {
    c.width = pw;
    c.height = ph;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  }
}

class TrackView {
  constructor(track, tl) {
    this.track = track;
    this.tl = tl;
    this._lvl = 0;

    const row = (this.row = document.createElement('div'));
    row.className = `row ${track.kind}`;
    row.innerHTML = `
      <div class="head">
        <div class="line1">
          <input class="name" spellcheck="false" title="Rename track">
          <button class="del" title="Remove track">✕</button>
        </div>
        <div class="line2">
          <button class="tbtn mute" title="Mute">M</button>
          <button class="tbtn solo" title="Solo">S</button>
          ${
            track.kind === 'audio'
              ? '<button class="tbtn arm" title="Arm for recording">●</button>'
              : '<button class="tbtn edit" title="Open piano roll">Edit</button>'
          }
          <div class="meter"><i></i></div>
        </div>
        <label class="slider"><span>Vol</span><input class="vol" type="range" min="-60" max="6" step="0.1" title="Double-click to reset"><output class="volv"></output></label>
        <label class="slider"><span>Pan</span><input class="pan" type="range" min="-1" max="1" step="0.01" title="Double-click to center"><output class="panv"></output></label>
      </div>
      <div class="lane"><canvas></canvas></div>`;

    const q = (s) => row.querySelector(s);
    this.canvas = q('canvas');
    this.g = this.canvas.getContext('2d');
    this.meterEl = q('.meter i');
    this.muteBtn = q('.mute');
    this.soloBtn = q('.solo');
    this.armBtn = q('.arm');
    this.vol = q('.vol');
    this.pan = q('.pan');
    this.volv = q('.volv');
    this.panv = q('.panv');
    this.nameEl = q('.name');

    this.nameEl.value = track.name;
    this.nameEl.addEventListener('input', () => (track.name = this.nameEl.value));
    q('.del').addEventListener('click', () => tl.cb.onRemove(track));

    this.muteBtn.addEventListener('click', () => {
      track.mute = !track.mute;
      tl.engine.updateMix();
      tl.refresh();
    });
    this.soloBtn.addEventListener('click', () => {
      track.solo = !track.solo;
      tl.engine.updateMix();
      tl.refresh();
    });
    this.armBtn?.addEventListener('click', () => tl.cb.onArm(track));
    q('.edit')?.addEventListener('click', () => tl.cb.onEdit(track));

    this.vol.value = track.volumeDb;
    this.vol.addEventListener('input', () => {
      track.setVolumeDb(+this.vol.value);
      this.volv.textContent = fmtDb(track.volumeDb);
    });
    this.vol.addEventListener('dblclick', () => {
      this.vol.value = 0;
      this.vol.dispatchEvent(new Event('input'));
    });

    this.pan.value = track.pan;
    this.pan.addEventListener('input', () => {
      track.setPan(+this.pan.value);
      this.panv.textContent = fmtPan(track.pan);
    });
    this.pan.addEventListener('dblclick', () => {
      this.pan.value = 0;
      this.pan.dispatchEvent(new Event('input'));
    });

    this.volv.textContent = fmtDb(track.volumeDb);
    this.panv.textContent = fmtPan(track.pan);

    // On audio lanes a press on a clip selects/drags it; elsewhere it scrubs the playhead.
    tl.bindScrub(this.canvas, track.kind === 'audio' ? (e) => this._pressClip(e) : null);
    if (track.kind === 'midi') this.canvas.addEventListener('dblclick', () => tl.cb.onEdit(track));
    this.refresh();
  }

  clipAt(t) {
    const clips = this.track.clips;
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i];
      if (t >= c.start && t < c.start + c.duration) return c;
    }
    return null;
  }

  _pressClip(e) {
    const clip = this.clipAt(this.tl.timeAt(e.clientX));
    if (!clip) {
      this.tl.select(null);
      return false;
    }
    this.tl.select(this.track, clip);
    this.tl.beginClipDrag(this, clip, e);
    return true;
  }

  refresh() {
    const t = this.track;
    const anySolo = this.tl.engine.tracks.some((x) => x.solo);
    this.muteBtn.classList.toggle('on', t.mute);
    this.soloBtn.classList.toggle('on', t.solo);
    this.armBtn?.classList.toggle('on', !!t.armed);
    this.row.classList.toggle('quiet', t.mute || (anySolo && !t.solo));
  }

  updateMeter() {
    const t = this.track;
    const lv = t.ctx.state === 'running' ? t.level() : 0;
    this._lvl = Math.max(lv, this._lvl * 0.9);
    const db = 20 * Math.log10(this._lvl || 1e-5);
    const pct = Math.max(0, Math.min(1, (db + 60) / 60));
    this.meterEl.style.width = `${100 - pct * 100}%`;
  }

  draw(viewStart, w, pps, dpr, bpm) {
    const h = ROW_H - 1;
    sizeCanvas(this.canvas, w, h, dpr);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#181b20';
    g.fillRect(0, 0, w, h);
    drawGrid(g, viewStart, pps, w, h, bpm);

    const t = this.track;
    if (t.kind === 'audio') {
      for (const c of t.clips) {
        drawClip(g, c.peaks, {
          clipStart: c.start, offset: c.offset, duration: c.duration,
          viewStart, pps, w, h, color: AUDIO_COLOR, bg: AUDIO_BG,
        });
        this._clipChrome(g, c, viewStart, pps, w, h);
      }
      const r = t.recording;
      if (r && r.start != null) {
        drawClip(g, r.peaks, {
          clipStart: r.start, offset: 0, duration: r.peaks.duration,
          viewStart, pps, w, h, color: REC_COLOR, bg: REC_BG,
        });
      }
      if (!t.clips.length && !r) this._hint(g, h, 'Empty — arm ● and press Record, or drop an audio file here');
    } else {
      if (!t.notes.length) {
        this._hint(g, h, 'Empty MIDI track — double-click or press Edit to open the piano roll');
      } else {
        const spb = 60 / bpm;
        let lo = 127;
        let hi = 0;
        for (const n of t.notes) {
          if (n.pitch < lo) lo = n.pitch;
          if (n.pitch > hi) hi = n.pitch;
        }
        const range = Math.max(12, hi - lo + 1);
        const nh = Math.min(8, (h - 16) / range);
        const y0 = (h - range * nh) / 2;
        g.fillStyle = NOTE_COLOR;
        for (const n of t.notes) {
          const x = (n.start * spb - viewStart) * pps;
          const nw = n.dur * spb * pps;
          if (x + nw < 0 || x > w) continue;
          g.fillRect(x, y0 + (hi - n.pitch) * nh, Math.max(1.5, nw - 1), Math.max(2, nh - 1));
        }
      }
    }
  }

  // Clip name label and selection outline.
  _clipChrome(g, c, viewStart, pps, w, h) {
    const x0 = (c.start - viewStart) * pps;
    const cw = c.duration * pps;
    if (x0 > w || x0 + cw < 0) return;
    const sel = this.tl.selected?.clip === c;
    if (c.name) {
      g.save();
      g.beginPath();
      g.rect(x0, 2, cw, h - 4);
      g.clip();
      g.font = '11px system-ui, sans-serif';
      g.textBaseline = 'top';
      g.fillStyle = 'rgba(0,0,0,0.55)';
      const tw = g.measureText(c.name).width;
      const lx = Math.max(x0, 0);
      g.fillRect(lx, 2, tw + 10, 16);
      g.fillStyle = '#e8edf4';
      g.fillText(c.name, lx + 5, 5);
      g.restore();
    }
    g.strokeStyle = sel ? '#ffffff' : 'rgba(76,194,255,0.55)';
    g.lineWidth = sel ? 2 : 1;
    g.strokeRect(x0 + 0.5, 2.5, Math.max(1, cw - 1), h - 5);
    g.lineWidth = 1;
  }

  _hint(g, h, text) {
    g.fillStyle = '#4a525e';
    g.font = '12px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(text, 14, h / 2);
  }
}

export class Timeline {
  constructor(engine, el, cb) {
    this.engine = engine;
    this.el = el;
    this.cb = cb;
    this.pps = 80;
    this.lengthSec = 30;
    this.views = new Map();
    this.dirty = true;
    this.following = true;
    this.selected = null; // { track, clip }

    el.style.setProperty('--head-w', `${HEAD_W}px`);
    el.style.setProperty('--row-h', `${ROW_H}px`);
    el.innerHTML = `
      <div class="inner">
        <div class="row ruler-row"><div class="head corner">Tracks</div><div class="lane"><canvas></canvas></div></div>
        <div class="rows"></div>
        <div class="hint">Drag a loop from the library, or drop WAV / MP3 files anywhere — or use “+ Audio” / “+ MIDI” above.</div>
        <div class="playhead"></div>
        <div class="dropmark" hidden></div>
      </div>`;
    this.inner = el.querySelector('.inner');
    this.dropmark = el.querySelector('.dropmark');
    this.rows = el.querySelector('.rows');
    this.hint = el.querySelector('.hint');
    this.playhead = el.querySelector('.playhead');
    this.ruler = el.querySelector('.ruler-row canvas');
    this.bindScrub(this.ruler);

    el.addEventListener('scroll', () => (this.dirty = true), { passive: true });
    new ResizeObserver(() => (this.dirty = true)).observe(el);
    this._layout();
    this._bindLoopDrop();
  }

  // ---- coordinates ----

  // Timeline time (s) under a client x. Unclamped.
  timeAt(clientX) {
    const r = this.el.getBoundingClientRect();
    return (clientX - r.left - HEAD_W + this.el.scrollLeft) / this.pps;
  }

  snap(t) {
    const spb = 60 / this.engine.bpm;
    return Math.round(t / spb) * spb;
  }

  viewAtY(clientY) {
    for (const v of this.views.values()) {
      const r = v.row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return v;
    }
    return null;
  }

  // ---- loop drag & drop from the library ----

  _bindLoopDrop() {
    const el = this.el;
    const isLoop = (e) => e.dataTransfer && [...e.dataTransfer.types].includes(LOOP_MIME);
    let over = null;

    const clear = () => {
      this.dropmark.hidden = true;
      over?.row.classList.remove('drop-target');
      over = null;
    };

    el.addEventListener('dragover', (e) => {
      if (!isLoop(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const t = e.altKey ? Math.max(0, this.timeAt(e.clientX)) : Math.max(0, this.snap(this.timeAt(e.clientX)));
      let view = this.viewAtY(e.clientY);
      if (view && view.track.kind !== 'audio') view = null; // MIDI lanes can't hold audio: new track instead
      if (view !== over) {
        over?.row.classList.remove('drop-target');
        view?.row.classList.add('drop-target');
        over = view;
      }
      const top = view ? view.row.offsetTop : this.rows.offsetTop + this.rows.offsetHeight;
      this.dropmark.style.left = `${HEAD_W + t * this.pps}px`;
      this.dropmark.style.top = `${top}px`;
      this.dropmark.style.height = `${ROW_H}px`;
      this.dropmark.classList.toggle('newtrack', !view);
      this.dropmark.hidden = false;
    });

    el.addEventListener('dragleave', (e) => {
      if (isLoop(e) && !el.contains(e.relatedTarget)) clear();
    });

    el.addEventListener('drop', (e) => {
      if (!isLoop(e)) return;
      e.preventDefault();
      const loopId = e.dataTransfer.getData(LOOP_MIME);
      const t = e.altKey ? Math.max(0, this.timeAt(e.clientX)) : Math.max(0, this.snap(this.timeAt(e.clientX)));
      const track = over ? over.track : null;
      clear();
      document.body.classList.remove('dragging-loop');
      this.cb.onDropLoop?.({ loopId, track, time: t });
    });
  }

  // ---- clip selection & editing ----

  select(track, clip) {
    this.selected = clip ? { track, clip } : null;
    this.dirty = true;
  }

  // Drag a clip horizontally (snapped to beats; hold Alt for free) and
  // vertically onto another audio track.
  beginClipDrag(view, clip, e) {
    const canvas = view.canvas;
    canvas.setPointerCapture(e.pointerId);
    const grab = this.timeAt(e.clientX) - clip.start;
    let cur = view;
    let moved = false;

    const move = (ev) => {
      moved = true;
      let s = this.timeAt(ev.clientX) - grab;
      if (!ev.altKey) s = this.snap(s);
      clip.start = Math.max(0, s);
      const over = this.viewAtY(ev.clientY);
      if (over && over !== cur && over.track.kind === 'audio') {
        cur.track.clips.splice(cur.track.clips.indexOf(clip), 1);
        over.track.clips.push(clip);
        cur = over;
        this.selected = { track: over.track, clip };
      }
      this.dirty = true;
    };
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      if (moved) this.cb.onClipsChanged?.();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  deleteSelected() {
    const s = this.selected;
    if (!s) return false;
    const i = s.track.clips.indexOf(s.clip);
    if (i >= 0) s.track.clips.splice(i, 1);
    this.selected = null;
    this.dirty = true;
    this.cb.onClipsChanged?.();
    return true;
  }

  // Copy the selected clip right after itself (handy for repeating a loop).
  duplicateSelected() {
    const s = this.selected;
    if (!s) return false;
    const copy = { ...s.clip, start: s.clip.start + s.clip.duration };
    s.track.clips.push(copy);
    this.selected = { track: s.track, clip: copy };
    this.dirty = true;
    this.cb.onClipsChanged?.();
    return true;
  }

  get viewW() {
    return Math.max(100, this.el.clientWidth - HEAD_W);
  }

  get viewStart() {
    return this.el.scrollLeft / this.pps;
  }

  _layout() {
    this.inner.style.setProperty('--lane-w', `${this.lengthSec * this.pps}px`);
  }

  setZoom(pps) {
    const vs = this.viewStart;
    this.pps = pps;
    this._layout();
    this.el.scrollLeft = vs * pps;
    this.dirty = true;
  }

  setLength(sec) {
    const L = Math.max(30, Math.ceil(sec + 10));
    if (L !== this.lengthSec) {
      this.lengthSec = L;
      this._layout();
      this.dirty = true;
    }
  }

  // Click or drag on a canvas to move the playhead.
  // `claim(e)` may return true to take over the press (e.g. dragging a clip).
  bindScrub(canvas, claim = null) {
    let down = false;
    const seek = (e) => {
      const r = canvas.getBoundingClientRect();
      this.cb.onSeek(Math.max(0, this.viewStart + (e.clientX - r.left) / this.pps));
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (claim && claim(e)) return;
      down = true;
      canvas.setPointerCapture(e.pointerId);
      seek(e);
    });
    canvas.addEventListener('pointermove', (e) => down && seek(e));
    canvas.addEventListener('pointerup', () => (down = false));
    canvas.addEventListener('pointercancel', () => (down = false));
  }

  addTrack(track) {
    const v = new TrackView(track, this);
    this.views.set(track, v);
    this.rows.append(v.row);
    this.hint.hidden = true;
    this.dirty = true;
    return v;
  }

  removeTrack(track) {
    const v = this.views.get(track);
    if (!v) return;
    v.row.remove();
    this.views.delete(track);
    if (this.selected?.track === track) this.selected = null;
    this.hint.hidden = this.views.size > 0;
    this.refresh();
    this.dirty = true;
  }

  setEditing(track) {
    for (const v of this.views.values()) v.row.classList.toggle('editing', v.track === track);
  }

  refresh() {
    for (const v of this.views.values()) v.refresh();
  }

  updateMeters() {
    for (const v of this.views.values()) v.updateMeter();
  }

  setPlayhead(pos, playing) {
    const x = pos * this.pps;
    const left = this.el.scrollLeft;
    if (playing && this.following && (x < left || x > left + this.viewW - 20)) {
      this.el.scrollLeft = Math.max(0, x - 40);
    }
    this.playhead.style.transform = `translateX(${x}px)`;
    const rel = x - this.el.scrollLeft;
    this.playhead.style.display = rel >= 0 && rel <= this.viewW ? '' : 'none';
  }

  redraw() {
    this.dirty = false;
    const dpr = window.devicePixelRatio || 1;
    const w = this.viewW;
    const vs = this.viewStart;
    const bpm = this.engine.bpm;
    this._drawRuler(vs, w, dpr, bpm);
    for (const v of this.views.values()) v.draw(vs, w, this.pps, dpr, bpm);
  }

  _drawRuler(vs, w, dpr, bpm) {
    const h = RULER_H - 1;
    sizeCanvas(this.ruler, w, h, dpr);
    const g = this.ruler.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1b1e24';
    g.fillRect(0, 0, w, h);

    const pps = this.pps;
    const spb = 60 / bpm;
    const barSec = spb * 4;
    const barPx = barSec * pps;
    const step = [1, 2, 4, 8, 16, 32, 64, 128].find((s) => s * barPx >= 48) || 256;

    // beat ticks
    if (spb * pps >= 10) {
      g.strokeStyle = '#323843';
      g.beginPath();
      for (let b = Math.max(0, Math.floor(vs / spb)); ; b++) {
        const x = Math.round((b * spb - vs) * pps) + 0.5;
        if (x > w) break;
        if (b % 4 === 0) continue;
        g.moveTo(x, h - 6);
        g.lineTo(x, h);
      }
      g.stroke();
    }

    // bar ticks + numbers
    g.strokeStyle = '#4a525e';
    g.fillStyle = '#8a93a2';
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'top';
    const first = Math.max(0, Math.floor(vs / barSec));
    for (let bar = first - (first % step); ; bar += step) {
      const x = Math.round((bar * barSec - vs) * pps) + 0.5;
      if (x > w) break;
      if (x < -40) continue;
      g.beginPath();
      g.moveTo(x, 12);
      g.lineTo(x, h);
      g.stroke();
      g.fillText(String(bar + 1), x + 4, 3);
    }
  }
}
