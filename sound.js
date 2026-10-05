// =====================================================
//  sound.js — 呼吸訓練遊戲廳的音效 / 背景音樂引擎
// =====================================================
// 全部用 Web Audio 即時合成，不載入任何音檔 → 沒有授權問題，
// 也不會增加網頁載入體積。旋律選用公共領域童謠
// （小星星 = Ah! vous dirai-je maman、兩隻老虎 = Frère Jacques）。
//
// 用法（已在 index.html 接好）：
//   import Sound from "./sound.js";
//   Sound.unlock();            // 必須在使用者手勢裡呼叫一次（點擊/觸控）
//   Sound.startMusic("calm");  // 開始背景音樂；"calm"|"twinkle"|"tiger"
//   Sound.stopMusic();
//   Sound.sfx("great");        // 音效：great/good/miss/pop/launch/tick
//   Sound.setEnabled(true/false);
//   Sound.setVolume(0.0~1.0);
//
// 手機重點：瀏覽器禁止自動播放，AudioContext 一定要在「使用者點過
// 畫面之後」才建立/恢復。unlock() 就是做這件事，請務必綁在手勢上。
// =====================================================

const A4 = 440;
const midi = (m) => A4 * Math.pow(2, (m - 69) / 12);

// --- 童謠（公共領域）。音符格式 [MIDI音高, 幾拍]，0 = 休止 ---
const MELODIES = {
  // 小星星
  twinkle: {
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
  // 兩隻老虎（Frère Jacques）
  tiger: {
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

// --- 和弦進行（給 calm 氛圍樂用），每格一小節的根音 MIDI ---
const CALM = { bpm: 68, chords: [57, 53, 60, 55] }; // Am F C G

const Sound = {
  ctx: null,
  master: null,
  musicGain: null,
  sfxGain: null,
  enabled: true,
  volume: 0.6,

  _timer: null,
  _nextTime: 0,
  _track: null,
  _step: 0,

  // ---- 必須在使用者手勢（click / touchend）裡呼叫 ----
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;                 // 太舊的瀏覽器，靜音但不崩
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? this.volume : 0;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.9;
      this.musicGain.connect(this.master);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 1.0;
      this.sfxGain.connect(this.master);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return true;
  },

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.linearRampToValueAtTime(on ? this.volume : 0, t + 0.08);
    }
  },

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.enabled) {
      const t = this.ctx.currentTime;
      this.master.gain.linearRampToValueAtTime(this.volume, t + 0.08);
    }
  },

  // =============== 背景音樂 ===============
  startMusic(name = "calm") {
    if (!this.unlock()) return;              // 沒手勢解鎖過就不會有聲音
    this.stopMusic();
    this._track = name;
    this._step = 0;
    this._nextTime = this.ctx.currentTime + 0.1;
    // 用 lookahead 排程器，每 25ms 檢查一次，提前 0.3 秒把音排進去
    this._timer = setInterval(() => this._scheduler(), 25);
  },

  stopMusic() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._track = null;
  },

  _scheduler() {
    if (!this.ctx || !this._track) return;
    const AHEAD = 0.3;
    while (this._nextTime < this.ctx.currentTime + AHEAD) {
      if (this._track === "calm") this._scheduleCalmBar(this._nextTime);
      else this._scheduleMelodyStep(this._nextTime);
    }
  },

  // ---- calm：一小節的和弦墊 + 柔和低音 ----
  _scheduleCalmBar(t) {
    const beat = 60 / CALM.bpm;
    const bar = beat * 4;
    const root = CALM.chords[this._step % CALM.chords.length];
    // 和弦墊（根 + 三度 + 五度），慢起慢收
    [0, 4, 7].forEach((iv, i) => {
      this._pad(midi(root + 12 + iv), t, bar * 0.98, 0.05 - i * 0.008);
    });
    // 低音（每小節第 1、3 拍）
    this._pluck(midi(root), t, beat * 1.4, 0.10);
    this._pluck(midi(root), t + beat * 2, beat * 1.4, 0.08);
    this._step++;
    this._nextTime += bar;
  },

  // ---- 童謠：一次排一個音符 ----
  _scheduleMelodyStep(t) {
    const mel = MELODIES[this._track];
    if (!mel) { this._nextTime += 0.5; return; }
    const beat = 60 / mel.bpm;
    const [m, beats] = mel.notes[this._step % mel.notes.length];
    const dur = beats * beat;
    if (m > 0) {
      this._bell(midi(m), t, dur);
      // 每個音順手補一點低八度的根，讓旋律有厚度
      if (this._step % 2 === 0) this._pluck(midi(m - 24), t, beat, 0.05);
    }
    this._step++;
    this._nextTime += dur;
  },

  // =============== 合成單元 ===============
  _pad(freq, t, dur, gain) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "triangle"; o.frequency.value = freq;
    o.connect(g); g.connect(this.musicGain);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
  },

  _pluck(freq, t, dur, gain) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine"; o.frequency.value = freq;
    o.connect(g); g.connect(this.musicGain);
    g.gain.setValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  },

  _bell(freq, t, dur) {
    // 木琴/音樂盒感：基音 + 兩個泛音，快速衰減
    [[1, 0.12], [2, 0.05], [3, 0.02]].forEach(([mult, gain]) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = "sine"; o.frequency.value = freq * mult;
      o.connect(g); g.connect(this.musicGain);
      g.gain.setValueAtTime(gain, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.min(dur, 0.6));
      o.start(t); o.stop(t + Math.min(dur, 0.6) + 0.02);
    });
  },

  // =============== 音效 ===============
  sfx(kind) {
    if (!this.unlock() || !this.enabled) return;
    const t = this.ctx.currentTime;
    const tone = (freq, start, dur, gain, type = "sine") => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type; o.frequency.value = freq;
      o.connect(g); g.connect(this.sfxGain);
      g.gain.setValueAtTime(gain, t + start + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.start(t + start); o.stop(t + start + dur + 0.02);
    };
    switch (kind) {
      case "great":                                  // 上行三連音：成功
        tone(784, 0, 0.18, 0.22); tone(1047, 0.09, 0.18, 0.22);
        tone(1568, 0.18, 0.30, 0.22);
        break;
      case "good":                                   // 兩音：還可以
        tone(587, 0, 0.14, 0.18); tone(880, 0.08, 0.20, 0.18);
        break;
      case "miss":                                   // 低柔一聲：沒塗到
        tone(300, 0, 0.22, 0.16, "triangle");
        break;
      case "pop":                                    // 氣球吹滿爆開
        tone(1200, 0, 0.05, 0.25); tone(500, 0.04, 0.16, 0.20, "triangle");
        break;
      case "launch":                                 // 彈弓發射
        this._sweep(300, 1100, 0.22, 0.2);
        break;
      case "tick":                                   // 節拍輕點
        tone(1000, 0, 0.04, 0.10);
        break;
      default: break;
    }
  },

  _sweep(f0, f1, dur, gain) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    o.connect(g); g.connect(this.sfxGain);
    g.gain.setValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  },
};

export default Sound;
