// Match sounds, synthesised with WebAudio (no audio files, works offline):
// referee whistle, ball strikes, crowd murmur, goal roar and near-miss "ooh".
// Browsers (iOS especially) only allow audio after a user gesture, so `unlock()`
// is called from the kick-off tap.
(function () {
  let ctx = null;
  let master = null;
  let noise = null;
  let crowd = null;
  let enabled = true;
  let lastKick = 0;

  function init() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    // 2 s of pink-ish noise, reused by every noise-based sound
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      b = 0.97 * b + 0.03 * (Math.random() * 2 - 1);
      d[i] = b * 6 + (Math.random() * 2 - 1) * 0.15;
    }
    return true;
  }

  const ready = () => enabled && ctx && ctx.state === 'running';

  function noiseSource(loop) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = !!loop;
    return src;
  }

  // Pea whistle: ~2.9 kHz tone with a fast warble from the pea.
  function blow(at, dur) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 2850;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 38;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(osc.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.16, at + 0.02);
    g.gain.setValueAtTime(0.16, at + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(g).connect(master);
    osc.start(at); lfo.start(at);
    osc.stop(at + dur + 0.02); lfo.stop(at + dur + 0.02);
  }

  // kind: 'short' (foul, kick-off), 'half' (two blasts), 'end' (three, the last one long)
  function whistle(kind = 'short') {
    if (!ready()) return;
    const t = ctx.currentTime + 0.01;
    if (kind === 'short') blow(t, 0.32);
    else if (kind === 'half') { blow(t, 0.3); blow(t + 0.42, 0.7); }
    else if (kind === 'end') { blow(t, 0.3); blow(t + 0.42, 0.3); blow(t + 0.84, 1.1); }
  }

  // Thump of a boot on the ball; power 0..1 (pass .3, long ball .6, shot 1).
  function kick(power = 0.4) {
    if (!ready()) return;
    const now = ctx.currentTime;
    if (now - lastKick < 0.07) return; // at 4x playback, avoid machine-gun clicks
    lastKick = now;
    const t = now + 0.005;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140 + power * 60, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25 + power * 0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g).connect(master);
    osc.start(t); osc.stop(t + 0.14);
    const n = noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + power * 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.18 + power * 0.25, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(f).connect(ng).connect(master);
    n.start(t, Math.random()); n.stop(t + 0.06);
  }

  // Swelling crowd noise: goal roar (big) or "ooh" after a save / near miss (small).
  function swell(peak, attack, hold, release, freq) {
    if (!ready()) return;
    const t = ctx.currentTime + 0.01;
    const n = noiseSource(true);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.linearRampToValueAtTime(freq * 1.25, t + attack + hold);
    f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.001, t + attack + hold + release);
    n.connect(f).connect(g).connect(master);
    n.start(t, Math.random()); n.stop(t + attack + hold + release + 0.05);
  }
  const roar = () => swell(0.55, 0.25, 1.6, 2.4, 700);
  const ooh = () => swell(0.22, 0.12, 0.35, 0.9, 520);
  const groan = () => swell(0.18, 0.2, 0.5, 1.2, 380); // goal ruled out, chance gone

  // Ball off the woodwork: a short metallic ring.
  function post() {
    if (!ready()) return;
    const t = ctx.currentTime + 0.005;
    [880, 1320, 2010].forEach((fq, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = fq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.16 / (i + 1), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.5);
    });
    kick(0.9);
  }

  // Crowd murmur follows the danger: 0 (ball in midfield) .. 1 (in the box).
  function tension(level) {
    if (!crowd || !ctx) return;
    const v = 0.06 + 0.1 * Math.max(0, Math.min(1, level));
    crowd.g.gain.setTargetAtTime(v, ctx.currentTime, 0.5);
  }

  // Low continuous murmur for the whole match.
  function crowdStart() {
    if (!enabled || !ctx || crowd) return;
    if (ctx.state !== 'running') { ctx.resume().then(() => { if (ctx.state === 'running') crowdStart(); }); return; }
    const n = noiseSource(true);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 650;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.07, ctx.currentTime + 1.5);
    n.connect(f).connect(g).connect(master);
    n.start();
    crowd = { n, g };
  }
  function crowdStop() {
    if (!crowd || !ctx) return;
    const { n, g } = crowd;
    crowd = null;
    g.gain.cancelScheduledValues(ctx.currentTime);
    g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
    n.stop(ctx.currentTime + 0.7);
  }

  function unlock() {
    if (!enabled || !init()) return;
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) crowdStop();
    else unlock();
  }

  // Sound is decoration: a WebAudio hiccup must never interrupt the match.
  const safe = (fn) => (...args) => { try { return fn(...args); } catch (_) { return undefined; } };
  window.Sound = {
    unlock: safe(unlock), setEnabled: safe(setEnabled), whistle: safe(whistle), kick: safe(kick),
    roar: safe(roar), ooh: safe(ooh), groan: safe(groan), post: safe(post), tension: safe(tension),
    crowdStart: safe(crowdStart), crowdStop: safe(crowdStop),
    isEnabled: () => enabled,
  };
})();
