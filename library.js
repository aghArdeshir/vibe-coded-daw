// Loop library sidebar.
//
// Loops come from loops/index.json (served next to the app) and from files the
// user adds during the session. Every item is an HTML5 drag source; the timeline
// accepts the LOOP_MIME payload. Items also have a preview button.

export const LOOP_MIME = 'application/x-webdaw-loop';

const MANIFEST_URL = new URL('./loops/index.json', import.meta.url);
const COLLAPSE_KEY = 'webdaw.library.collapsed';

const fmtDur = (s) => (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';

export class Library {
  constructor(engine, root, cb = {}) {
    this.engine = engine;
    this.root = root;
    this.cb = cb;
    this.loops = [];
    this.filter = '';
    this.playing = null; // { loop, src }
    this._decoding = new Map(); // loop.id -> Promise<AudioBuffer>
    this._seq = 0;

    this.list = root.querySelector('.lib-list');
    this.search = root.querySelector('.lib-search');
    this.collapseBtn = root.querySelector('.lib-collapse');
    this.fileInput = root.querySelector('.lib-file');

    this.collapseBtn.addEventListener('click', () => this.toggle());
    root.querySelector('.lib-add').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      this.addFiles(this.fileInput.files);
      this.fileInput.value = '';
    });
    this.search.addEventListener('input', () => {
      this.filter = this.search.value.trim().toLowerCase();
      this.render();
    });

    // Preview/stop buttons and drag sources use event delegation.
    this.list.addEventListener('click', (e) => {
      const btn = e.target.closest('.lp');
      if (btn) this.preview(this.get(btn.closest('.loop').dataset.id));
    });
    this.list.addEventListener('dragstart', (e) => {
      const el = e.target.closest?.('.loop');
      if (!el) return;
      e.dataTransfer.setData(LOOP_MIME, el.dataset.id);
      e.dataTransfer.setData('text/plain', this.get(el.dataset.id)?.name || 'loop');
      e.dataTransfer.effectAllowed = 'copy';
      document.body.classList.add('dragging-loop');
    });
    this.list.addEventListener('dragend', () => document.body.classList.remove('dragging-loop'));

    let collapsed = false;
    try {
      collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch { /* storage unavailable */ }
    this.setCollapsed(collapsed);

    this.loadManifest();
  }

  // ---- open / collapse ----

  get collapsed() {
    return this.root.classList.contains('collapsed');
  }

  setCollapsed(on) {
    this.root.classList.toggle('collapsed', on);
    this.collapseBtn.textContent = on ? '»' : '«';
    this.collapseBtn.title = on ? 'Open loop library' : 'Collapse loop library';
    this.collapseBtn.setAttribute('aria-expanded', String(!on));
    this.cb.onToggle?.(!on);
    try {
      localStorage.setItem(COLLAPSE_KEY, on ? '1' : '0');
    } catch { /* storage unavailable */ }
  }

  toggle() {
    this.setCollapsed(!this.collapsed);
  }

  // ---- data ----

  get(id) {
    return this.loops.find((l) => l.id === id);
  }

  async loadManifest() {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const m of data.loops || []) {
        if (!m.file) continue;
        this.loops.push({
          id: `m${this._seq++}`,
          name: m.name || m.file.replace(/^.*\//, '').replace(/\.[^.]+$/, ''),
          category: m.category || 'Loops',
          bpm: Number(m.bpm) || null,
          license: m.license || '',
          url: new URL(`./loops/${m.file}`, import.meta.url).href,
        });
      }
    } catch (err) {
      this.manifestError = err.message || String(err);
    }
    this.render();
  }

  addFiles(fileList) {
    let added = 0;
    for (const f of fileList) {
      if (!/\.(wav|wave|mp3)$/i.test(f.name) && !f.type.startsWith('audio/')) continue;
      const bpm = /(\d{2,3})\s*bpm/i.exec(f.name);
      this.loops.push({
        id: `f${this._seq++}`,
        name: f.name.replace(/\.[^.]+$/, ''),
        category: 'This session',
        bpm: bpm ? Number(bpm[1]) : null,
        license: '',
        file: f,
      });
      added++;
    }
    this.render();
    if (added) this.cb.status?.(`Added ${added} loop${added > 1 ? 's' : ''} to the library (kept until you reload the page).`);
    return added;
  }

  // Decoded AudioBuffer for a loop (cached).
  getBuffer(loop) {
    if (loop.buffer) return Promise.resolve(loop.buffer);
    if (!this._decoding.has(loop.id)) {
      const p = (async () => {
        const data = loop.file
          ? await loop.file.arrayBuffer()
          : await (await fetch(loop.url)).arrayBuffer();
        loop.buffer = await this.engine.ctx.decodeAudioData(data);
        loop.duration = loop.buffer.duration;
        return loop.buffer;
      })();
      p.catch(() => this._decoding.delete(loop.id));
      this._decoding.set(loop.id, p);
    }
    return this._decoding.get(loop.id);
  }

  // ---- preview ----

  stopPreview() {
    if (!this.playing) return;
    const { src } = this.playing;
    this.playing = null;
    try { src.stop(); } catch { /* already stopped */ }
    src.disconnect();
  }

  async preview(loop) {
    if (!loop) return;
    const wasThis = this.playing?.loop === loop;
    this.stopPreview();
    if (wasThis) return this.render();
    try {
      await this.engine.ctx.resume();
      const buffer = await this.getBuffer(loop);
      if (this.playing) this.stopPreview(); // another preview won the race
      const src = this.engine.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true; // loops audition as loops
      const gain = this.engine.ctx.createGain();
      gain.gain.value = 0.8;
      src.connect(gain).connect(this.engine.ctx.destination);
      src.start();
      this.playing = { loop, src };
    } catch (err) {
      this.cb.status?.(`Could not load “${loop.name}”: ${err.message || err}`, true);
    }
    this.render();
  }

  // ---- rendering ----

  render() {
    const list = this.list;
    list.textContent = '';

    const shown = this.loops.filter(
      (l) => !this.filter || `${l.name} ${l.category}`.toLowerCase().includes(this.filter),
    );

    if (!shown.length) {
      const p = document.createElement('p');
      p.className = 'lib-empty';
      if (this.loops.length) {
        p.textContent = 'No loops match your filter.';
      } else {
        p.innerHTML =
          'No loops yet.<br><br>Put audio files in the <code>loops/</code> folder and list them in ' +
          '<code>loops/index.json</code>, or press <b>+ Add</b> (or drop files here) to load some for this session.' +
          (this.manifestError ? `<br><br><span class="dim">(${this.manifestError})</span>` : '');
      }
      list.append(p);
      return;
    }

    const groups = new Map();
    for (const l of shown) {
      if (!groups.has(l.category)) groups.set(l.category, []);
      groups.get(l.category).push(l);
    }

    for (const [cat, items] of groups) {
      const h = document.createElement('div');
      h.className = 'lib-cat';
      h.textContent = cat;
      list.append(h);

      for (const l of items) {
        const el = document.createElement('div');
        el.className = 'loop';
        el.draggable = true;
        el.dataset.id = l.id;
        const on = this.playing?.loop === l;
        el.classList.toggle('playing', on);

        const btn = document.createElement('button');
        btn.className = 'lp';
        btn.textContent = on ? '■' : '▶';
        btn.title = on ? 'Stop preview' : 'Preview';
        btn.draggable = false;

        const txt = document.createElement('div');
        txt.className = 'ltxt';
        const name = document.createElement('div');
        name.className = 'lname';
        name.textContent = l.name;
        const meta = document.createElement('div');
        meta.className = 'lmeta';
        meta.textContent = [l.bpm && `${l.bpm} BPM`, l.duration && fmtDur(l.duration), l.license]
          .filter(Boolean)
          .join(' · ');
        txt.append(name, meta);

        el.append(btn, txt);
        el.title = `${l.name} — drag onto the timeline`;
        list.append(el);
      }
    }
  }
}
