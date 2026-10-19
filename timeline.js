// Timeline: ruler, track rows (header controls + waveform/notes lane), playhead.
// Lane canvases are only as wide as the viewport and redraw on scroll, so very
// long projects never hit canvas size limits.

import { drawClip, drawGrid } from './waveform.js';

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

    tl.bindScrub(this.canvas);
    if (track.kind === 'midi') this.canvas.addEventListener('dblclick', () => tl.cb.onEdit(track));
    this.refresh();
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

    el.style.setProperty('--head-w', `${HEAD_W}px`);
    el.style.setProperty('--row-h', `${ROW_H}px`);
    el.innerHTML = `
      <div class="inner">
        <div class="row ruler-row"><div class="head corner">Tracks</div><div class="lane"><canvas></canvas></div></div>
        <div class="rows"></div>
        <div class="hint">Drop WAV or MP3 files anywhere to add tracks — or use “+ Audio” / “+ MIDI” above.</div>
        <div class="playhead"></div>
      </div>`;
    this.inner = el.querySelector('.inner');
    this.rows = el.querySelector('.rows');
    this.hint = el.querySelector('.hint');
    this.playhead = el.querySelector('.playhead');
    this.ruler = el.querySelector('.ruler-row canvas');
    this.bindScrub(this.ruler);

    el.addEventListener('scroll', () => (this.dirty = true), { passive: true });
    new ResizeObserver(() => (this.dirty = true)).observe(el);
    this._layout();
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
  bindScrub(canvas) {
    let down = false;
    const seek = (e) => {
      const r = canvas.getBoundingClientRect();
      this.cb.onSeek(Math.max(0, this.viewStart + (e.clientX - r.left) / this.pps));
    };
    canvas.addEventListener('pointerdown', (e) => {
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
