(function (global) {
  'use strict';

  const LOOKAHEAD = 0.35;
  const FADE = 0.012;
  const MIN_CHANCE = 0.18;
  const MAX_CHANCE = 0.5;
  const CHANCE_STEP = 0.09;
  const MIN_GAP = 4;
  const MIN_DISTANCE = 16;

  // the <audio> element keeps playing silently as the clock the rest of the app reads
  class JukeboxPlayer {
    constructor(engine, audioEl) {
      this.engine = engine;
      this.audio = audioEl;
      this.buffer = null;
      this.a = null;
      this.active = false;
      this.runs = [];
      this.timer = null;
      this.seekTimers = [];
      this.selfSeek = 0;
      this.jumps = 0;
      this.onJump = null;
      this.onBeat = null;
      this._onPlay = () => this._restart();
      this._onPause = () => this._halt();
      this._onSeeked = () => {
        if (this.selfSeek > 0) { this.selfSeek--; return; }
        if (!this.audio.paused) this._restart();
      };
    }

    async load(url, analysis) {
      const ctx = this.engine.ctx;
      const data = await (await fetch(url)).arrayBuffer();
      this.buffer = await ctx.decodeAudioData(data);
      this.a = analysis;
      this.threshold = analysis.threshold;
    }

    start() {
      if (!this.buffer || this.active) return;
      this.active = true;
      const { mediaSource, normA, ctx } = this.engine;
      try { mediaSource.disconnect(normA); } catch (e) {}
      // still pulled through a muted node, or the element's clock stalls
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      mediaSource.connect(this.sink);
      this.sink.connect(normA);
      this.out = ctx.createGain();
      this.out.connect(normA);
      this.audio.addEventListener('play', this._onPlay);
      this.audio.addEventListener('pause', this._onPause);
      this.audio.addEventListener('seeked', this._onSeeked);
      if (!this.audio.paused) this._restart();
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      this._halt();
      this.audio.removeEventListener('play', this._onPlay);
      this.audio.removeEventListener('pause', this._onPause);
      this.audio.removeEventListener('seeked', this._onSeeked);
      try { this.out.disconnect(); } catch (e) {}
      try { this.engine.mediaSource.disconnect(this.sink); this.sink.disconnect(); } catch (e) {}
      try { this.engine.mediaSource.connect(this.engine.normA); } catch (e) {}
      this.buffer = null;
      this.a = null;
    }

    get beatCount() { return this.a ? this.a.beats.length : 0; }

    setThreshold(t) { this.threshold = t; }

    _beatEnd(i) {
      const b = this.a.beats;
      return i + 1 < b.length ? b[i + 1] : Math.min(this.a.duration, b[i] + (b[i] - b[i - 1]));
    }

    _beatAt(t) {
      const b = this.a.beats;
      let lo = 0, hi = b.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (b[mid] <= t) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    _halt() {
      clearInterval(this.timer);
      this.timer = null;
      this.seekTimers.forEach(clearTimeout);
      this.seekTimers = [];
      const now = this.engine.ctx.currentTime;
      for (const r of this.runs) {
        try { r.gain.gain.setTargetAtTime(0, now, FADE / 3); r.src.stop(now + FADE * 2); } catch (e) {}
      }
      this.runs = [];
    }

    _rate() { return this.audio.playbackRate || 1; }

    _startRun(when, offset) {
      const ctx = this.engine.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this._rate();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + FADE);
      src.connect(gain);
      gain.connect(this.out);
      src.start(when, Math.max(0, offset));
      const run = { src, gain };
      src.onended = () => { this.runs = this.runs.filter(r => r !== run); };
      this.runs.push(run);
      return run;
    }

    _restart() {
      if (!this.active) return;
      this._halt();
      const ctx = this.engine.ctx;
      const pos = this.audio.currentTime || 0;
      const when = ctx.currentTime + 0.03;
      this.current = this._startRun(when, pos);
      const i = this._beatAt(pos);
      this.cursor = i + 1;
      this.boundary = when + (this._beatEnd(i) - pos) / this._rate();
      this.chance = MIN_CHANCE;
      this.sinceJump = 0;
      this.timer = setInterval(() => this._schedule(), 50);
      this._schedule();
    }

    _choose(i) {
      const a = this.a;
      const last = a.beats.length - 1;
      if (a.exit && i === a.exit.from) return a.exit.to;
      if (i >= last - 1) return a.exit ? a.exit.to : 0;
      if (this.sinceJump < MIN_GAP) return null;
      const options = (a.branches[i] || []).filter(([j, d]) => d <= this.threshold && Math.abs(j - i) >= MIN_DISTANCE);
      if (!options.length || Math.random() >= this.chance) {
        this.chance = Math.min(MAX_CHANCE, this.chance + (options.length ? CHANCE_STEP : 0));
        return null;
      }
      this.chance = MIN_CHANCE;
      return options[Math.floor(Math.random() * options.length)][0];
    }

    _schedule() {
      const ctx = this.engine.ctx;
      const rate = this._rate();
      while (this.boundary < ctx.currentTime + LOOKAHEAD) {
        const i = this.cursor - 1;
        const j = this._choose(i);
        const when = this.boundary;
        if (j === null) {
          this.sinceJump++;
          if (this.onBeat) this.onBeat(this.cursor, when);
          this.boundary = when + (this._beatEnd(this.cursor) - this.a.beats[this.cursor]) / rate;
          this.cursor++;
          continue;
        }
        const next = j + 1;
        const old = this.current;
        old.gain.gain.setValueAtTime(1, when);
        old.gain.gain.linearRampToValueAtTime(0, when + FADE);
        old.src.stop(when + FADE + 0.01);
        this.current = this._startRun(when, this.a.beats[next]);
        this.jumps++;
        this.sinceJump = 0;
        if (this.onJump) this.onJump(i, next, when);
        if (this.onBeat) this.onBeat(next, when);
        const target = this.a.beats[next];
        const delay = Math.max(0, (when - ctx.currentTime) * 1000);
        this.seekTimers.push(setTimeout(() => {
          if (!this.active) return;
          this.selfSeek++;
          this.audio.currentTime = target;
        }, delay));
        this.boundary = when + (this._beatEnd(next) - target) / rate;
        this.cursor = next + 1;
      }
    }
  }

  global.JukeboxPlayer = JukeboxPlayer;
})(window);
