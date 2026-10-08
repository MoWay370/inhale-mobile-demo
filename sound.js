// =====================================================
//  sound.js — 呼吸訓練遊戲廳的互動音訊引擎
// =====================================================
// 設計重點：
//   1. 音質：所有聲音經過「低通 → 殘響 → 限幅器」的主匯流排，
//      包絡平滑不爆音，聽起來溫暖不廉價。
//   2. 與遊戲結合：核心是「呼吸樂器」——玩家吹氣就發聲，
//      吹越用力音越高越亮；吸氣偏亮、吐氣偏暖。這是即時的聽覺
//      生理回饋，host 每一幀呼叫 breath(flow, signed) 餵進來，
//      四個遊戲自動都有。事件（吹滿、擊倒、發射）再疊上音效。
//
// 全部 Web Audio 即時合成，不載入任何音檔 → 無授權問題、不增體積。
// 背景旋律為公共領域童謠（小星星、兩隻老虎）。
//
// 手機重點：瀏覽器禁止自動播放，AudioContext 必須在使用者手勢
// （點擊/觸控）裡建立，unlock() 就是做這件事。
//
// API：
//   Sound.unlock()                     手勢裡呼叫一次
//   Sound.breath(flow, signed)         每幀呼叫，flow=L/min，signed>0吸<0吐
//   Sound.startMusic("calm"|"twinkle"|"tiger")
//   Sound.stopMusic()
//   Sound.sfx("great"|"good"|"miss"|"pop"|"launch"|"boom"|"tick")
//   Sound.setEnabled(bool)  Sound.setVolume(0~1)
// =====================================================

const A4 = 440;
const midi = (m) => A4 * Math.pow(2, (m - 69) / 12);

const MELODIES = {
  twinkle: {                                   // 小星星（公共領域）
    bpm: 96,
    notes: [
      [60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2],
      [65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2],
      [67,1],[67,1],[65,1],[65,1],[64,1],[64,1],[62,2],
      [67,1],[67,1],[65,1],[65,1],[64,1],[64,1],[62,2],
      [60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2],
      [65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2],
    ],
  },
  tiger: {                                     // 兩隻老虎 / Frère Jacques（公共領域）
    bpm: 104,
    notes: [
      [60,1],[62,1],[64,1],[60,1], [60,1],[62,1],[64,1],[60,1],
      [64,1],[65,1],[67,2],        [64,1],[65,1],[67,2],
      [67,.5],[69,.5],[67,.5],[65,.5],[64,1],[60,1],
      [67,.5],[69,.5],[67,.5],[65,.5],[64,1],[60,1],
      [60,1],[55,1],[60,2],        [60,1],[55,1],[60,2],
    ],
  },
};
const CALM = { bpm: 66, chords: [57, 53, 60, 55] };   // Am F C G

const Sound = {
  ctx: null,
  enabled: true,
  volume: 0.6,

  // 節點
  _comp: null, _master: null, _lp: null, _busDry: null,
  _revIn: null, _musicGain: null, _sfxGain: null, _breath: null,

  // 背景音樂排程
  _timer: null, _nextTime: 0, _track: null, _step: 0,

  // ---------- 必須在使用者手勢裡呼叫 ----------
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const ctx = this.ctx = new AC();

      // 主匯流排：busDry → 低通 → master(音量) → 限幅器 → 喇叭
      const comp = this._comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -6; comp.knee.value = 24;
      comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.18;
      comp.connect(ctx.destination);

      const master = this._master = ctx.createGain();
      master.gain.value = this.enabled ? this.volume : 0;
      master.connect(comp);

      const lp = this._lp = ctx.createBiquadFilter();  // 修掉刺耳高頻
      lp.type = "lowpass"; lp.frequency.value = 7200; lp.Q.value = 0.6;
      lp.connect(master);

      const busDry = this._busDry = ctx.createGain();
      busDry.gain.value = 1.0;
      busDry.connect(lp);

      // 殘響：三條有回授的延遲，營造小空間的溫暖尾音
      const revIn = this._revIn = ctx.createGain();
      revIn.gain.value = 1.0;
      const wet = ctx.createGain(); wet.gain.value = 0.22; wet.connect(lp);
      [0.063, 0.091, 0.117].forEach((dt) => {
        const d = ctx.createDelay(1.0); d.delayTime.value = dt;
        const fb = ctx.createGain(); fb.gain.value = 0.36;
        const rlp = ctx.createBiquadFilter();
        rlp.type = "lowpass"; rlp.frequency.value = 2800;
        revIn.connect(d); d.connect(rlp); rlp.connect(fb); fb.connect(d);
        rlp.connect(wet);
      });

      const musicGain = this._musicGain = ctx.createGain();
      musicGain.gain.value = 0.3;            // 合成備援音樂：調低，不搶戲
      musicGain.connect(busDry); musicGain.connect(revIn);

      const sfxGain = this._sfxGain = ctx.createGain();
      sfxGain.gain.value = 2.0;              // 音效：調大聲
      sfxGain.connect(busDry); sfxGain.connect(revIn);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return true;
  },

  setEnabled(on) {
    this.enabled = !!on;
    if (this._master) {
      const t = this.ctx.currentTime;
      this._master.gain.cancelScheduledValues(t);
      this._master.gain.linearRampToValueAtTime(on ? this.volume : 0, t + 0.08);
    }
  },
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this._master && this.enabled)
      this._master.gain.linearRampToValueAtTime(this.volume, this.ctx.currentTime + 0.08);
  },

  // =====================================================
  //  呼吸樂器：與遊戲結合的核心（host 每幀呼叫）
  // =====================================================
  _ensureBreath() {
    if (this._breath || !this.ctx) return;
    const ctx = this.ctx;
    const o1 = ctx.createOscillator(); o1.type = "sine";
    const o2 = ctx.createOscillator(); o2.type = "triangle"; o2.detune.value = 6;
    const filt = ctx.createBiquadFilter(); filt.type = "lowpass";
    filt.frequency.value = 500; filt.Q.value = 3;
    const g = ctx.createGain(); g.gain.value = 0;
    o1.connect(filt); o2.connect(filt); filt.connect(g);
    g.connect(this._busDry); g.connect(this._revIn);
    o1.frequency.value = 200; o2.frequency.value = 400;
    o1.start(); o2.start();
    this._breath = { o1, o2, filt, g };
  },

  breath(flow, signed) {
    if (!this.unlock() || !this.enabled) return;
    this._ensureBreath();
    const b = this._breath, t = this.ctx.currentTime, TC = 0.07;
    const active = (flow || 0) > 8;
    const lvl = active ? Math.min((flow || 0) / 150, 1) : 0;

    // 吸氣偏高亮、吐氣偏低暖
    const dir = signed > 0 ? 1 : signed < 0 ? -1 : 0;
    const base = 170 + lvl * 240 + dir * 30;
    const cutoff = 350 + lvl * 3400 + (dir > 0 ? 400 : 0);
    const gain = lvl * 0.17;

    b.o1.frequency.setTargetAtTime(base, t, 0.05);
    b.o2.frequency.setTargetAtTime(base * 2.01, t, 0.05);
    b.filt.frequency.setTargetAtTime(cutoff, t, TC);
    b.g.gain.setTargetAtTime(gain, t, active ? 0.03 : 0.12);
    // 註：不再隨呼吸調背景音樂音量（原本的 ducking 會讓音樂忽大忽小、聽起來很怪）
  },

  _silenceBreath() {
    if (this._breath)
      this._breath.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  },

  // =====================================================
  //  背景音樂
  // =====================================================
  startMusic(name = "calm") {
    if (!this.unlock()) return;
    this.stopMusic();
    this._track = name; this._step = 0;
    this._nextTime = this.ctx.currentTime + 0.1;
    this._timer = setInterval(() => this._scheduler(), 25);
  },
  stopMusic() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._track = null;
    this._silenceBreath();
  },
  _scheduler() {
    if (!this.ctx || !this._track) return;
    while (this._nextTime < this.ctx.currentTime + 0.3) {
      if (this._track === "calm") this._calmBar(this._nextTime);
      else this._melodyStep(this._nextTime);
    }
  },
  _calmBar(t) {
    const beat = 60 / CALM.bpm, bar = beat * 4;
    const root = CALM.chords[this._step % CALM.chords.length];
    // 稀疏琶音（根→五度→八度→三度，一拍一顆），乾淨不糊，取代原本會打架的和弦墊
    [0, 7, 12, 16].forEach((iv, i) => this._bell(midi(root + 12 + iv), t + i * beat, beat * 1.2));
    this._pluck(midi(root), t, beat * 2, 0.05);   // 很輕的低音根
    this._step++; this._nextTime += bar;
  },
  _melodyStep(t) {
    const mel = MELODIES[this._track];
    if (!mel) { this._nextTime += 0.5; return; }
    const beat = 60 / mel.bpm;
    const [m, beats] = mel.notes[this._step % mel.notes.length];
    const dur = beats * beat;
    if (m > 0) {
      this._bell(midi(m), t, dur);
      if (this._step % 2 === 0) this._pluck(midi(m - 24), t, beat, 0.05);
    }
    this._step++; this._nextTime += dur;
  },

  // =====================================================
  //  合成單元
  // =====================================================
  _pad(freq, t, dur, gain) {
    const o = this.ctx.createOscillator(), o2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "triangle"; o.frequency.value = freq;
    o2.type = "sine"; o2.frequency.value = freq; o2.detune.value = -7;   // 微失諧更厚
    o.connect(g); o2.connect(g);
    g.connect(this._musicGain); g.connect(this._revIn);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  },
  _pluck(freq, t, dur, gain) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "sine"; o.frequency.value = freq;
    o.connect(g); g.connect(this._musicGain); g.connect(this._revIn);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.012);           // 小爬升消爆音
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  },
  _bell(freq, t, dur) {
    [[1, 0.11], [2, 0.045], [3, 0.02], [4.1, 0.012]].forEach(([mult, gain]) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = "sine"; o.frequency.value = freq * mult;
      o.connect(g); g.connect(this._musicGain); g.connect(this._revIn);
      const d = Math.min(dur, 0.7);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.start(t); o.stop(t + d + 0.02);
    });
  },

  // =====================================================
  //  事件音效
  // =====================================================
  sfx(kind) {
    if (!this.unlock() || !this.enabled) return;
    const t = this.ctx.currentTime;
    const tone = (freq, start, dur, gain, type = "sine") => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.value = freq;
      o.connect(g); g.connect(this._sfxGain);
      g.gain.setValueAtTime(0.0001, t + start);
      g.gain.linearRampToValueAtTime(gain, t + start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.start(t + start); o.stop(t + start + dur + 0.02);
    };
    switch (kind) {
      case "great":                                        // 上行三連音
        tone(784, 0, 0.20, 0.20); tone(1047, 0.09, 0.20, 0.20); tone(1568, 0.18, 0.34, 0.20);
        break;
      case "good":
        tone(587, 0, 0.16, 0.17); tone(880, 0.09, 0.22, 0.17);
        break;
      case "miss":
        tone(330, 0, 0.24, 0.15, "triangle"); tone(247, 0.06, 0.26, 0.12, "triangle");
        break;
      case "pop":                                          // 氣球吹滿爆開
        tone(1400, 0, 0.04, 0.22); tone(600, 0.03, 0.18, 0.18, "triangle");
        tone(950, 0.02, 0.10, 0.14);
        break;
      case "launch":                                       // 彈弓發射
        this._sweep(260, 1150, 0.26, 0.18);
        break;
      case "boom":                                         // 城牆擊倒
        this._sweep(220, 60, 0.45, 0.28, "sawtooth");
        tone(90, 0, 0.42, 0.26, "triangle"); tone(140, 0, 0.3, 0.16, "sine");
        break;
      case "tick":
        tone(1000, 0, 0.04, 0.09);
        break;
      default: break;
    }
  },
  _sweep(f0, f1, dur, gain, type = "sawtooth") {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    o.connect(g); g.connect(this._sfxGain);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  },
};

export default Sound;
