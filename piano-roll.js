// Very basic piano-roll editor for a MidiTrack.
//   click empty cell  -> add note (drag to move)
//   drag note         -> move
//   drag right edge   -> resize
//   right-click / Del -> remove

const MIN_PITCH = 36; // C2
const MAX_PITCH = 96; // C7
const ROW_H = 16;
const PPB = 48; // pixels per beat
const KEY_W = 56;
const ROWS = MAX_PITCH - MIN_PITCH + 1;
const GRID_H = ROWS * ROW_H;

const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);

export class PianoRoll {
  constructor(engine, root, cb) {
    this.engine = engine;
    this.root = root;
    this.cb = cb;
    this.track = null;
    this.sel = null;
    this.drag = null;
    this.beats = 32;
    this.lastDur = 1;
    this.dirty = true;
    this._lastPos = -1;

    this.scroll = root.querySelector('.roll-scroll');
    this.title = root.querySelector('.roll-title');
    this.snapSel = root.querySelector('.roll-snap');
    root.querySelector('.roll-close').addEventListener('click', () => this.close());

    const wrap = document.createElement('div');
    wrap.className = 'roll-wrap';
    this.keys = document.createElement('canvas');
    this.grid = document.createElement('canvas');
    this.grid.style.touchAction = 'none';
    wrap.append(this.keys, this.grid);
    this.scroll.append(wrap);
    this.gk = this.keys.getContext('2d');
    this.gg = this.grid.getContext('2d');

    this.grid.addEventListener('pointerdown', (e) => this._down(e));
    this.grid.addEventListener('pointermove', (e) => this._move(e));
    this.grid.addEventListener('pointerup', () => this._up());
    this.grid.addEventListener('pointercancel', () => this._up());
    this.grid.addEventListener('contextmenu', (e) => e.preventDefault());
    this.keys.addEventListener('pointerdown', (e) => {
      const p = MAX_PITCH - Math.floor((e.clientY - this.keys.getBoundingClientRect().top) / ROW_H);
      if (this.track && p >= MIN_PITCH && p <= MAX_PITCH) this.track.preview(p);
    });
  }

  get snap() {
    return parseFloat(this.snapSel.value) || 0.25;
  }

  open(track) {
    this.track = track;
    this.sel = null;
    this.root.hidden = false;
    this.title.textContent = `Piano roll — ${track.name}`;
    this._fit(true);
    const n = track.notes;
    const avg = n.length ? n.reduce((s, x) => s + x.pitch, 0) / n.length : 66;
    this.scroll.scrollTop = Math.max(0, (MAX_PITCH - avg) * ROW_H - this.scroll.clientHeight / 2);
    this.scroll.scrollLeft = 0;
    this.dirty = true;
  }

  close() {
    this.track = null;
    this.drag = null;
    this.root.hidden = true;
    this.cb.onClose?.();
  }

  deleteSelected() {
    if (!this.track || !this.sel) return;
    this.track.notes = this.track.notes.filter((n) => n !== this.sel);
    this.sel = null;
    this._changed();
  }

  // ---- layout ----

  _fit(force = false) {
    if (!this.track) return;
    let maxEnd = 0;
    for (const n of this.track.notes) maxEnd = Math.max(maxEnd, n.start + n.dur);
    const beats = Math.max(32, Math.ceil((maxEnd + 8) / 4) * 4);
    if (!force && beats === this.beats) return;
    this.beats = beats;
    const dpr = window.devicePixelRatio || 1;
    const size = (c, w, h) => {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    };
    size(this.keys, KEY_W, GRID_H);
    size(this.grid, beats * PPB, GRID_H);
    this.dpr = dpr;
    this.dirty = true;
  }

  // ---- drawing ----

  _drawKeys() {
    const g = this.gk;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      const y = (MAX_PITCH - p) * ROW_H;
      g.fillStyle = isBlack(p) ? '#15171b' : '#d8dce3';
      g.fillRect(0, y, KEY_W, ROW_H);
      g.fillStyle = '#8a93a2';
      g.fillRect(0, y + ROW_H - 1, KEY_W, 1);
      if (p % 12 === 0) {
        g.fillStyle = '#333';
        g.fillText(`C${Math.floor(p / 12) - 1}`, KEY_W - 22, y + ROW_H / 2);
      }
    }
  }

  _drawGrid() {
    const g = this.gg;
    const W = this.beats * PPB;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    for (let p = MIN_PITCH; p <= MAX_PITCH; p++) {
      const y = (MAX_PITCH - p) * ROW_H;
      g.fillStyle = isBlack(p) ? '#171a1f' : '#1f242a';
      g.fillRect(0, y, W, ROW_H);
      if (p % 12 === 0) {
        g.fillStyle = '#2f3641';
        g.fillRect(0, y + ROW_H - 1, W, 1);
      }
    }

    const snap = this.snap;
    for (let b = 0; b <= this.beats; b += snap) {
      if (b % 1 !== 0 && snap * PPB < 8) continue;
      g.fillStyle = b % 4 === 0 ? '#3a414c' : b % 1 === 0 ? '#2b313a' : '#232830';
      g.fillRect(Math.round(b * PPB), 0, 1, GRID_H);
    }

    for (const n of this.track.notes) {
      if (n.pitch < MIN_PITCH || n.pitch > MAX_PITCH) continue;
      const x = n.start * PPB;
      const y = (MAX_PITCH - n.pitch) * ROW_H;
      g.fillStyle = n === this.sel ? '#b6f59f' : '#7ddc6a';
      g.fillRect(x + 0.5, y + 1, Math.max(2, n.dur * PPB - 1), ROW_H - 2);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x + n.dur * PPB - 4, y + 1, 3, ROW_H - 2);
    }

    const px = this.engine.position * (this.engine.bpm / 60) * PPB;
    g.fillStyle = '#fff';
    g.fillRect(Math.round(px), 0, 1, GRID_H);
  }

  tick() {
    if (!this.track) return;
    const pos = this.engine.position;
    if (this.dirty || pos !== this._lastPos) {
      if (this.engine.playing) {
        const px = KEY_W + pos * (this.engine.bpm / 60) * PPB;
        const sl = this.scroll.scrollLeft;
        if (px > sl + this.scroll.clientWidth - 20 || px < sl + KEY_W) {
          this.scroll.scrollLeft = Math.max(0, px - KEY_W - 20);
        }
      }
      this._lastPos = pos;
      if (this.dirty) this._drawKeys();
      this.dirty = false;
      this._drawGrid();
    }
  }

  // ---- interaction ----

  _pt(e) {
    const r = this.grid.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return { x, y, beat: x / PPB, pitch: MAX_PITCH - Math.floor(y / ROW_H) };
  }

  _hit(beat, pitch) {
    const notes = this.track.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.pitch === pitch && beat >= n.start && beat < n.start + n.dur) return n;
    }
    return null;
  }

  _down(e) {
    if (!this.track) return;
    const { x, beat, pitch } = this._pt(e);
    if (pitch < MIN_PITCH || pitch > MAX_PITCH) return;
    const hit = this._hit(beat, pitch);

    if (e.button === 2) {
      if (hit) {
        this.track.notes = this.track.notes.filter((n) => n !== hit);
        if (this.sel === hit) this.sel = null;
        this._changed();
      }
      return;
    }
    if (e.button !== 0) return;

    this.grid.setPointerCapture(e.pointerId);
    if (hit) {
      this.sel = hit;
      const edge = x >= (hit.start + hit.dur) * PPB - 7;
      this.drag = { mode: edge ? 'resize' : 'move', note: hit, dx: beat - hit.start };
      this.track.preview(hit.pitch, 0.25);
    } else {
      const snap = this.snap;
      const start = Math.max(0, Math.floor(beat / snap) * snap);
      const note = { pitch, start, dur: this.lastDur, vel: 0.8 };
      this.track.notes.push(note);
      this.sel = note;
      this.drag = { mode: 'move', note, dx: beat - start };
      this.track.preview(pitch, 0.25);
    }
    this.dirty = true;
  }

  _move(e) {
    if (!this.track) return;
    const { x, beat, pitch } = this._pt(e);
    if (!this.drag) {
      const hit = this._hit(beat, pitch);
      this.grid.style.cursor = hit && x >= (hit.start + hit.dur) * PPB - 7 ? 'ew-resize' : hit ? 'grab' : 'crosshair';
      return;
    }
    const { mode, note, dx } = this.drag;
    const snap = this.snap;
    if (mode === 'move') {
      note.start = Math.max(0, Math.round((beat - dx) / snap) * snap);
      const p = Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch));
      if (p !== note.pitch) {
        note.pitch = p;
        this.track.preview(p, 0.2);
      }
    } else {
      note.dur = Math.max(snap, Math.round((beat - note.start) / snap) * snap);
      this.lastDur = note.dur;
    }
    this.dirty = true;
  }

  _up() {
    if (!this.drag) return;
    this.drag = null;
    this._changed();
  }

  _changed() {
    this._fit();
    this.dirty = true;
    this.cb.onChange();
  }
}
