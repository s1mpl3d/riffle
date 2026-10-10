const { spawn } = require('child_process');

const SR = 22050;
const FRAME = 2048;
const HOP = 512;
const FPS = SR / HOP;
const BANDS = 24;
const MIN_JUMP = 8;
const MAX_BRANCHES = 4;
const VERSION = 2;

const tick = () => new Promise(r => setImmediate(r));

function decode(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-hide_banner', '-nostats', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { windowsHide: true });
    const chunks = [];
    let size = 0;
    const limit = SR * 4 * 60 * 20;
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size > limit) { try { proc.kill('SIGKILL'); } catch (e) {} return; }
      chunks.push(c);
    });
    proc.on('error', reject);
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const n = buf.length >> 2;
      if (n < SR * 10) return reject(new Error('track too short'));
      const ab = new ArrayBuffer(n * 4);
      buf.copy(Buffer.from(ab), 0, 0, n * 4);
      resolve(new Float32Array(ab));
    });
  });
}

function makeFft(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const a = start + k, b = a + half;
          const wr = cos[k * step], wi = sin[k * step];
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

// per frame: onset strength, 12 pitch classes, 12 timbre coefficients, loudness in dB
async function frameFeatures(pcm) {
  const nFrames = Math.floor((pcm.length - FRAME) / HOP) + 1;
  const bins = FRAME / 2 + 1;
  const fft = makeFft(FRAME);
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1));

  const pitchOf = new Int8Array(bins).fill(-1);
  const bandOf = new Int8Array(bins).fill(-1);
  const lo = Math.log(60), hi = Math.log(8000);
  for (let k = 1; k < bins; k++) {
    const f = k * SR / FRAME;
    if (f >= 55 && f <= 4200) pitchOf[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 21) % 12;
    if (f >= 60 && f < 8000) bandOf[k] = Math.min(BANDS - 1, Math.floor((Math.log(f) - lo) / (hi - lo) * BANDS));
  }
  const dct = [];
  for (let c = 1; c <= 12; c++) {
    const row = new Float64Array(BANDS);
    for (let b = 0; b < BANDS; b++) row[b] = Math.cos(Math.PI * c * (b + 0.5) / BANDS);
    dct.push(row);
  }

  const onset = new Float32Array(nFrames);
  const chroma = new Float32Array(nFrames * 12);
  const timbre = new Float32Array(nFrames * 12);
  const loud = new Float32Array(nFrames);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  let prev = new Float64Array(bins), cur = new Float64Array(bins);
  const band = new Float64Array(BANDS);

  for (let t = 0; t < nFrames; t++) {
    if (t % 200 === 0) await tick();
    const off = t * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = pcm[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    band.fill(0);
    let flux = 0, power = 0;
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      power += p;
      cur[k] = Math.log1p(Math.sqrt(p));
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
      if (pitchOf[k] >= 0) chroma[t * 12 + pitchOf[k]] += p;
      if (bandOf[k] >= 0) band[bandOf[k]] += p;
    }
    onset[t] = t ? flux : 0;
    loud[t] = 10 * Math.log10(power / bins + 1e-12);
    for (let b = 0; b < BANDS; b++) band[b] = Math.log10(band[b] + 1e-10);
    for (let c = 0; c < 12; c++) {
      let s = 0;
      for (let b = 0; b < BANDS; b++) s += dct[c][b] * band[b];
      timbre[t * 12 + c] = s;
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return { nFrames, onset, chroma, timbre, loud };
}

// tempo in 8 s windows, smoothed with viterbi so it can drift but not jump an octave
async function localPeriods(o, mean, globalLag, minLag, maxLag) {
  const n = o.length;
  const W = Math.round(8 * FPS), H = Math.round(FPS);
  const per = new Float64Array(n).fill(globalLag);
  if (n < W * 1.5) return per;
  const lags = [];
  for (let L = minLag; L <= maxLag; L++) lags.push(L);
  const centers = [], acs = [];
  for (let c = W >> 1; c + (W >> 1) <= n; c += H) {
    if (centers.length % 6 === 0) await tick();
    const s0 = c - (W >> 1), s1 = c + (W >> 1);
    const ac = new Float64Array(maxLag + 2);
    let v0 = 0;
    for (let i = s0; i < s1; i++) v0 += (o[i] - mean) ** 2;
    v0 = v0 / (s1 - s0) || 1;
    for (let L = minLag - 1; L <= maxLag + 1; L++) {
      let sum = 0;
      for (let i = s0 + L; i < s1; i++) sum += (o[i] - mean) * (o[i - L] - mean);
      ac[L] = sum / (s1 - s0 - L) / v0;
    }
    centers.push(c);
    acs.push(ac);
  }
  const prior = (L) => 0.5 * Math.log2(L / globalLag) ** 2;
  const trans = (a, b) => 20 * Math.log2(a / b) ** 2;
  let total = lags.map(L => acs[0][L] - prior(L));
  const back = [];
  for (let w = 1; w < acs.length; w++) {
    if (w % 100 === 0) await tick();
    const bk = new Int16Array(lags.length);
    total = lags.map((L, k) => {
      let best = -Infinity;
      for (let q = 0; q < lags.length; q++) {
        const v = total[q] - trans(L, lags[q]);
        if (v > best) { best = v; bk[k] = q; }
      }
      return best + acs[w][L] - prior(L);
    });
    back.push(bk);
  }
  let k = total.indexOf(Math.max(...total));
  const path = new Array(acs.length);
  for (let w = acs.length - 1; w >= 0; w--) {
    const L = lags[k], ac = acs[w];
    const den = ac[L - 1] - 2 * ac[L] + ac[L + 1];
    path[w] = den < 0 ? L + Math.max(-0.5, Math.min(0.5, 0.5 * (ac[L - 1] - ac[L + 1]) / den)) : L;
    if (w > 0) k = back[w - 1][k];
  }
  for (let t = 0; t < n; t++) {
    if (t <= centers[0]) { per[t] = path[0]; continue; }
    if (t >= centers[centers.length - 1]) { per[t] = path[path.length - 1]; continue; }
    const w = Math.floor((t - centers[0]) / H);
    const f = (t - centers[w]) / H;
    per[t] = path[w] * (1 - f) + path[w + 1] * f;
  }
  return per;
}

// beats by dynamic programming over the onset curve (Ellis 2007), with a period that follows the local tempo
async function trackBeats(onsetRaw) {
  const n = onsetRaw.length;
  const o = new Float64Array(n);
  const W = 16;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += onsetRaw[i];
    if (i >= W) acc -= onsetRaw[i - W];
    o[i] = Math.max(0, onsetRaw[i] - acc / Math.min(i + 1, W));
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += o[i];
  mean /= n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (o[i] - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  for (let i = 0; i < n; i++) o[i] /= sd;

  const minLag = Math.floor(FPS * 60 / 200), maxLag = Math.ceil(FPS * 60 / 60);
  const ref = FPS * 60 / 120;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += (o[i] - mean / sd) * (o[i - lag] - mean / sd);
    ac[lag] = s / (n - lag);
  }
  let best = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const w = Math.exp(-0.5 * (Math.log2(lag / ref) / 0.9) ** 2);
    if (ac[lag] * w > bestScore) { bestScore = ac[lag] * w; best = lag; }
  }
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const den = a - 2 * b + c;
  const period = den ? best + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : best;
  await tick();

  const per = await localPeriods(o, mean / sd, period, minLag, maxLag);
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    if (t % 2000 === 0) await tick();
    const P = per[t];
    const lo = Math.round(P / 2), hi = Math.round(P * 2);
    let bestPrev = -1, bestVal = -Infinity;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - 100 * Math.log((t - p) / P) ** 2;
      if (v > bestVal) { bestVal = v; bestPrev = p; }
    }
    score[t] = o[t] + (bestPrev >= 0 ? bestVal : 0);
    back[t] = bestPrev;
  }
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(per[n - 1])); t < n; t++) if (score[t] > score[end]) end = t;
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();
  const sorted = [...per].sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1];
  return { beats, bpm: 60 * FPS / median, period: median };
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

async function buildGraph(f, beatFrames, period) {
  const nb = beatFrames.length;
  const feat = [];
  for (let i = 0; i < nb; i++) {
    const s = beatFrames[i], e = i + 1 < nb ? beatFrames[i + 1] : Math.min(f.nFrames, s + Math.round(period));
    const ch = new Float64Array(12), tb = new Float64Array(12);
    let lmax = -Infinity, cnt = 0;
    for (let t = s; t < Math.max(e, s + 1) && t < f.nFrames; t++, cnt++) {
      for (let k = 0; k < 12; k++) { ch[k] += f.chroma[t * 12 + k]; tb[k] += f.timbre[t * 12 + k]; }
      if (f.loud[t] > lmax) lmax = f.loud[t];
    }
    const cmax = Math.max(...ch) || 1;
    for (let k = 0; k < 12; k++) { ch[k] /= cmax; tb[k] /= cnt || 1; }
    feat.push({ ch, tb, loud: lmax, dur: e - s });
  }
  for (let k = 0; k < 12; k++) {
    let m = 0, v = 0;
    for (const x of feat) m += x.tb[k];
    m /= nb;
    for (const x of feat) v += (x.tb[k] - m) ** 2;
    const sd = Math.sqrt(v / nb) || 1;
    for (const x of feat) x.tb[k] = (x.tb[k] - m) / sd;
  }
  const dist = (i, j) => {
    const A = feat[i], B = feat[j];
    let dt = 0, dc = 0;
    for (let k = 0; k < 12; k++) { dt += (A.tb[k] - B.tb[k]) ** 2; dc += (A.ch[k] - B.ch[k]) ** 2; }
    return Math.sqrt(dt / 12) + 2 * Math.sqrt(dc / 12) + Math.abs(A.loud - B.loud) / 20 + 2 * Math.abs(A.dur - B.dur) / period;
  };
  // a jump i -> j plays what follows j after beat i, so the beats around both should match too
  const ctx = (i, j) => {
    let s = 2 * dist(i, j), w = 2;
    if (i > 0 && j > 0) { s += dist(i - 1, j - 1); w++; }
    if (i + 1 < nb && j + 1 < nb) { s += dist(i + 1, j + 1); w++; }
    return s / w;
  };

  const branches = [];
  const bests = [];
  for (let i = 0; i < nb; i++) {
    if (i % 8 === 0) await tick();
    const cand = [];
    for (let j = 0; j < nb - 1; j++) {
      if (Math.abs(i - j) < MIN_JUMP) continue;
      cand.push([j, ctx(i, j)]);
    }
    cand.sort((x, y) => x[1] - y[1]);
    const top = cand.slice(0, MAX_BRANCHES).map(([j, d]) => [j, Math.round(d * 1000) / 1000]);
    branches.push(top);
    if (top.length) bests.push(top[0][1]);
  }

  let exit = null;
  for (let i = Math.floor(nb * 0.85); i < nb - 1; i++) {
    for (const [j, d] of branches[i]) {
      if (j < i - MIN_JUMP && (!exit || d < exit.d)) exit = { from: i, to: j, d };
    }
  }
  return { branches, threshold: Math.round(quantile(bests, 0.25) * 1000) / 1000, exit };
}

async function analyzePcm(pcm) {
  const f = await frameFeatures(pcm);
  const { beats: beatFrames, bpm, period } = await trackBeats(f.onset);
  if (beatFrames.length < 32) throw new Error('not enough beats');
  const graph = await buildGraph(f, beatFrames, period);
  const toSec = (t) => Math.round((t * HOP + FRAME / 2) / SR * 1000) / 1000;
  return {
    version: VERSION,
    duration: Math.round(pcm.length / SR * 1000) / 1000,
    bpm: Math.round(bpm * 10) / 10,
    beats: beatFrames.map(toSec),
    ...graph
  };
}

async function analyzeFile(ffmpeg, file) {
  return analyzePcm(await decode(ffmpeg, file));
}

module.exports = { analyzeFile, analyzePcm, VERSION, SR };
