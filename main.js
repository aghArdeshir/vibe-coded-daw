import { Engine } from './audio-engine.js';
import { Timeline } from './timeline.js';
import { PianoRoll } from './piano-roll.js';
import { Recorder } from './recorder.js';
import { Library } from './library.js';

const $ = (id) => document.getElementById(id);

const engine = new Engine();
const recorder = new Recorder(engine);
let busy = false; // true while a recording is being set up

// ---------- UI pieces ----------

const timeline = new Timeline(engine, $('timeline'), {
  onSeek: (t) => {
    if (!recorder.active) engine.seek(t);
  },
  onRemove: removeTrack,
  onArm: armTrack,
  onEdit: openEditor,
  onDropLoop: dropLoop,
  onClipsChanged: () => {
    timeline.dirty = true;
    if (!recorder.active) engine.resync();
  },
});

const library = new Library(engine, $('library'), {
  status: (msg, err) => setStatus(msg, err),
  onToggle: (open) => $('toggle-lib').classList.toggle('active', open),
});

const roll = new PianoRoll(engine, $('editor'), {
  onChange: () => {
    timeline.dirty = true;
    engine.resync();
  },
  onClose: () => timeline.setEditing(null),
});

function setStatus(msg, isError = false) {
  const s = $('status');
  s.textContent = msg;
  s.classList.toggle('err', isError);
}

// ---------- tracks ----------

function addAudioTrack(name) {
  const n = engine.tracks.filter((t) => t.kind === 'audio').length + 1;
  const t = engine.addAudioTrack(name || `Audio ${n}`);
  timeline.addTrack(t);
  return t;
}

function addMidiTrack(name) {
  const n = engine.tracks.filter((t) => t.kind === 'midi').length + 1;
  const t = engine.addMidiTrack(name || `MIDI ${n}`);
  timeline.addTrack(t);
  return t;
}

async function removeTrack(track) {
  if (recorder.active && recorder.track === track) await stopRecording(true);
  if (roll.track === track) roll.close();
  engine.removeTrack(track);
  timeline.removeTrack(track);
}

function armTrack(track) {
  if (recorder.active) return;
  const on = !track.armed;
  for (const t of engine.tracks) if (t.kind === 'audio') t.armed = false;
  track.armed = on;
  timeline.refresh();
  if (on) setStatus(`“${track.name}” is armed. Press ● to record while the rest of the song plays (headphones recommended).`);
}

function openEditor(track) {
  roll.open(track);
  timeline.setEditing(track);
}

// A loop was dropped from the library: onto an audio lane -> clip on that lane,
// anywhere else -> a new audio track. `time` is already snapped to the beat grid.
async function dropLoop({ loopId, track, time }) {
  const loop = library.get(loopId);
  if (!loop) return;
  try {
    setStatus(`Loading “${loop.name}”…`);
    const buffer = await library.getBuffer(loop);
    if (!track || !engine.tracks.includes(track)) track = addAudioTrack(loop.name);
    const clip = track.addClip(buffer, time, 0, loop.name);
    timeline.select(track, clip);
    timeline.dirty = true;
    if (!recorder.active) engine.resync();
    const bpmNote =
      loop.bpm && Math.abs(loop.bpm - engine.bpm) > 0.5
        ? ` Note: the loop is ${loop.bpm} BPM but the project is ${engine.bpm} BPM.`
        : '';
    setStatus(`Placed “${loop.name}” on “${track.name}”.${bpmNote}`);
    library.render(); // shows the now-known duration
  } catch (err) {
    setStatus(`Could not load “${loop.name}”: ${err.message || err}`, true);
  }
}

// ---------- importing audio ----------

const isAudioFile = (f) => /\.(wav|wave|mp3)$/i.test(f.name) || f.type.startsWith('audio/');

async function importFiles(fileList) {
  const files = [...fileList];
  for (const f of files) {
    if (!isAudioFile(f)) {
      setStatus(`Skipped “${f.name}” — only WAV and MP3 files are supported.`, true);
      continue;
    }
    try {
      setStatus(`Decoding ${f.name}…`);
      const buffer = await engine.ctx.decodeAudioData(await f.arrayBuffer());
      const track = addAudioTrack(f.name.replace(/\.[^.]+$/, ''));
      track.addClip(buffer, 0, 0, f.name.replace(/\.[^.]+$/, ''));
      setStatus(`Added “${f.name}” (${buffer.duration.toFixed(1)} s, ${buffer.numberOfChannels} ch).`);
    } catch (err) {
      setStatus(`Could not decode “${f.name}”: ${err.message || err}`, true);
    }
  }
  timeline.dirty = true;
}

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const overLibrary = (e) => e.target instanceof Element && !!e.target.closest('#library');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('dropzone').classList.add('show');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  $('dropmsg').textContent = overLibrary(e)
    ? 'Drop to add to the loop library'
    : 'Drop WAV / MP3 files to add them as tracks';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('dropzone').classList.remove('show');
  }
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').classList.remove('show');
  if (overLibrary(e)) {
    if (library.collapsed) library.setCollapsed(false);
    library.addFiles(e.dataTransfer.files);
  } else {
    importFiles(e.dataTransfer.files);
  }
});

$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  importFiles(e.target.files);
  e.target.value = '';
});

// ---------- transport ----------

const latencyOverride = () => parseFloat($('latency').value);

async function startRecording() {
  if (recorder.active || busy) return;
  busy = true;
  try {
    let track = engine.tracks.find((t) => t.armed);
    if (!track) {
      track = addAudioTrack(); // no armed track: create an empty one and record into it
      track.armed = true;
      timeline.refresh();
    }
    await recorder.prepare();
    recorder.begin(track, latencyOverride());
    engine.play();
    setStatus(`Recording into “${track.name}”… press ● again to punch out, ■ to stop.`);
  } catch (err) {
    const denied = err && err.name === 'NotAllowedError';
    setStatus(denied ? 'Microphone permission was denied.' : `Cannot record: ${err.message || err}`, true);
  } finally {
    busy = false;
  }
}

async function stopRecording(discard = false) {
  const res = await recorder.finish();
  if (res && !discard) {
    res.track.addClip(res.buffer, res.start, res.offset, 'Recording');
    setStatus(`Recorded ${res.buffer.duration.toFixed(1)} s into “${res.track.name}” (latency compensation ${Math.round(res.comp * 1000)} ms).`);
  }
  timeline.dirty = true;
}

async function togglePlay() {
  if (recorder.active) {
    await stopRecording();
    engine.pause();
  } else if (engine.playing) {
    engine.pause();
  } else {
    engine.play();
  }
}

async function stopTransport() {
  if (recorder.active) await stopRecording();
  engine.stop();
  timeline.el.scrollLeft = 0;
}

$('btn-play').addEventListener('click', togglePlay);
$('btn-stop').addEventListener('click', stopTransport);
$('btn-rec').addEventListener('click', () => (recorder.active ? stopRecording() : startRecording()));
$('toggle-lib').addEventListener('click', () => library.toggle());
$('add-audio').addEventListener('click', () => addAudioTrack());
$('add-midi').addEventListener('click', () => {
  const t = addMidiTrack();
  openEditor(t);
});

$('bpm').addEventListener('change', (e) => {
  const v = Math.min(300, Math.max(30, parseFloat(e.target.value) || 120));
  e.target.value = v;
  engine.bpm = v;
  roll.dirty = true;
  timeline.dirty = true;
  engine.resync();
});

const zoomToPps = (v) => 10 * 2 ** ((v / 100) * 6); // 10 .. 640 px per second
$('zoom').addEventListener('input', (e) => timeline.setZoom(zoomToPps(+e.target.value)));
timeline.setZoom(zoomToPps(+$('zoom').value));

$('master').addEventListener('input', (e) => engine.setMasterDb(+e.target.value));

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const typing = (tag === 'INPUT' && e.target.type !== 'range') || tag === 'SELECT' || tag === 'TEXTAREA';
  if (typing) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    // Piano-roll note if one is selected there, otherwise the selected clip.
    if (roll.track && roll.sel) roll.deleteSelected();
    else timeline.deleteSelected();
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault(); // also stops the browser's "bookmark page" shortcut
    timeline.duplicateSelected();
  } else if (e.key === 'Home') {
    e.preventDefault();
    if (!recorder.active) {
      engine.seek(0);
      timeline.el.scrollLeft = 0;
    }
  }
});

// Buttons shouldn't keep focus (otherwise Space would "click" them again).
document.addEventListener('click', (e) => {
  if (e.target instanceof HTMLButtonElement) e.target.blur();
});

// Browsers start AudioContexts suspended until a user gesture.
const wake = () => engine.ctx.resume();
window.addEventListener('pointerdown', wake, { once: true });
window.addEventListener('keydown', wake, { once: true });

// ---------- frame loop ----------

const fmtTime = (sec) => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
};

let lastKey = '';
function updateTransportUI() {
  const key = `${engine.playing}|${recorder.active}`;
  if (key === lastKey) return;
  lastKey = key;
  $('btn-play').textContent = engine.playing ? '⏸' : '▶';
  $('btn-play').classList.toggle('active', engine.playing);
  $('btn-rec').classList.toggle('active', recorder.active);
}

function tick() {
  const pos = engine.position;
  $('time').textContent = fmtTime(pos);
  const beats = (pos * engine.bpm) / 60;
  $('bars').textContent = `Bar ${Math.floor(beats / 4) + 1} · Beat ${Math.floor(beats % 4) + 1}`;

  // stop automatically a moment after the last clip/note
  if (engine.playing && !recorder.active && engine.duration > 0 && pos > engine.duration + 0.3) {
    engine.stop();
    timeline.el.scrollLeft = 0;
  }

  timeline.setLength(engine.duration);
  timeline.setPlayhead(engine.position, engine.playing);
  timeline.updateMeters();
  if (timeline.dirty || recorder.active) timeline.redraw();
  roll.tick();
  updateTransportUI();
  requestAnimationFrame(tick);
}

setStatus('Drop WAV/MP3 files to add tracks, or create a MIDI / audio track to get started. Space = play/pause.');
requestAnimationFrame(tick);
