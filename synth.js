// Very simple stereo sine synth voice.
// Two slightly detuned sine oscillators: one hard left, one hard right.

export const midiToFreq = (n) => 440 * 2 ** ((n - 69) / 12);

/**
 * @param {AudioContext} ctx
 * @param {ChannelMergerNode} out  2-input merger (input 0 = left, 1 = right)
 * @returns {OscillatorNode[]} oscillators so the caller can stop them early
 */
export function playNote(ctx, out, { pitch, time, duration, velocity = 0.8 }) {
  const freq = midiToFreq(pitch);
  const peak = 0.22 * velocity;
  const attack = 0.005;
  const release = 0.08;
  const end = time + Math.max(duration, 0.03);
  const oscs = [];

  [-4, 4].forEach((cents, channel) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.detune.value = cents;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(peak, time + attack);
    env.gain.setValueAtTime(peak, Math.max(time + attack, end));
    env.gain.linearRampToValueAtTime(0, end + release);

    osc.connect(env);
    env.connect(out, 0, channel);
    osc.start(time);
    osc.stop(end + release + 0.01);
    oscs.push(osc);
  });

  return oscs;
}
