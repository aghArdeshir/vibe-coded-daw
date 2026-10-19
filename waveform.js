// Waveform peak data (min/max per bucket) and drawing helpers.

export const BUCKET = 256; // samples per peak bucket

export class Peaks {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.min = [];
    this.max = [];
    this._lo = 1;
    this._hi = -1;
    this._n = 0;
  }

  get duration() {
    return (this.min.length * BUCKET) / this.sampleRate;
  }

  // Incremental push (used for live recording). channels: Float32Array[]
  push(channels) {
    const len = channels[0].length;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][i];
        if (v < this._lo) this._lo = v;
        if (v > this._hi) this._hi = v;
      }
      if (++this._n === BUCKET) {
        this.min.push(this._lo);
        this.max.push(this._hi);
        this._lo = 1;
        this._hi = -1;
        this._n = 0;
      }
    }
  }

  static fromBuffer(buffer) {
    const p = new Peaks(buffer.sampleRate);
    const n = buffer.length;
    const nb = Math.ceil(n / BUCKET);
    const min = new Float32Array(nb);
    const max = new Float32Array(nb);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let b = 0; b < nb; b++) {
        let lo = c ? min[b] : 1;
        let hi = c ? max[b] : -1;
        const end = Math.min(n, (b + 1) * BUCKET);
        for (let i = b * BUCKET; i < end; i++) {
          const v = d[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        min[b] = lo;
        max[b] = hi;
      }
    }
    p.min = min;
    p.max = max;
    return p;
  }
}

// Draws only the visible part of a clip. All units are CSS pixels / seconds.
export function drawClip(g, peaks, o) {
  const { clipStart, offset, duration, viewStart, pps, w, h, color, bg } = o;
  const x0 = Math.max(0, Math.floor((clipStart - viewStart) * pps));
  const x1 = Math.min(w, Math.ceil((clipStart + duration - viewStart) * pps));
  if (x1 <= x0) return;

  g.fillStyle = bg;
  g.fillRect(x0, 2, x1 - x0, h - 4);
  g.fillStyle = color;

  const bps = peaks.sampleRate / BUCKET; // buckets per second
  const nb = peaks.min.length;
  const mid = h / 2;
  const amp = (h - 8) / 2;

  for (let x = x0; x < x1; x++) {
    const t0 = viewStart + x / pps - clipStart + offset;
    const b0 = Math.max(0, Math.floor(t0 * bps));
    let b1 = Math.ceil((t0 + 1 / pps) * bps);
    if (b1 <= b0) b1 = b0 + 1;
    if (b0 >= nb) break;
    if (b1 > nb) b1 = nb;
    let lo = 1;
    let hi = -1;
    for (let b = b0; b < b1; b++) {
      if (peaks.min[b] < lo) lo = peaks.min[b];
      if (peaks.max[b] > hi) hi = peaks.max[b];
    }
    const y0 = mid - hi * amp;
    const y1 = mid - lo * amp;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

// Beat/bar grid shared by lanes.
export function drawGrid(g, viewStart, pps, w, h, bpm) {
  const spb = 60 / bpm;
  const beatPx = spb * pps;
  const first = Math.floor(viewStart / spb);
  g.lineWidth = 1;
  for (let b = Math.max(0, first); ; b++) {
    const x = Math.round((b * spb - viewStart) * pps) + 0.5;
    if (x > w) break;
    if (x < 0) continue;
    const bar = b % 4 === 0;
    if (!bar && beatPx < 8) continue;
    g.strokeStyle = bar ? '#2d333d' : '#22262d';
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
  }
}
