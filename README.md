# vibe-coded-daw

A tiny web-based DAW in pure native browser JS (ES modules, Web Audio, AudioWorklet). No libraries, no build step.

- Drag and drop WAV/MP3 files to add waveform tracks
- Stereo MIDI tracks with a sine synth and a basic piano roll
- Per-track mute, solo, volume fader, pan and meter
- Record into an armed audio track while the song plays

## Run

Serve the folder over http (module imports and microphone access need it):

    python3 -m http.server

then open http://localhost:8000
