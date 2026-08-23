// =====================================================================
//  breath_algorithm.js — 由 breath_classifier.py 產生(結構與凍結版一致)
// =====================================================================
//  輸入:裝置只提供的 FFT 頻帶資料  bands = {1: e1, 2: e2, ... 20: e20}
//  輸出:analyze(bands) -> { active, direction, flow, confidence }
//
//  係數由 fit_js_model_from_data() 從你的裝置實測 CSV 訓練資料擬合而來(見終端機輸出的擬合細節)。
//  方向判定只使用 5~20kHz 頻帶(1~4kHz 對這個裝置沒有鑑別力,已排除)。
// =====================================================================

export const MODEL = {
  version: "web-2.0-fitted-5to20",
  bands: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20],

  // 是否「正在吹」:低頻總能量門檻(這裡的『低』指 5~20kHz 範圍內的低半段)
  active: { minEnergy: 16227, lowBands: [5,6,7,8] },

  // 方向判定:score>0 視為吐氣。
  // 用 numBand/denBand 這組頻帶比值(實測鑑別力最強),再加 5~20kHz 範圍內的高/低頻能量比。
  direction: {
    numBand: 8, denBand: 9,
    wRatio: 0.5734, bRatio: 2.0517,
    wHighLow: 0.4266, bHighLow: 1.0246,
    lowBands: [5,6,7,8],
    highBands: [9,10,11,12,13,14,15,16,17,18,19,20],
  },

  // FFT 能量 -> 流量代理(遊戲會自我校準 baseline,所以「單調遞增」比絕對值重要)
  flow: {
    weightBands: [5,6,7,8,9,10,11,12,13,14],
    gain: 0.1158,
    curve: "sqrt",
    energyScale: 1e6,
    max: 220,
  },
};

// ------- 小工具 -------
function bandSum(bands, keys) {
  let s = 0;
  for (const k of keys) s += (bands[k] || 0);
  return s;
}

// ------- 特徵(訓練/推論共用,若日後接模型用得到) -------
export function featurizeBands(bands) {
  const D = MODEL.direction;
  const b = MODEL.bands.map((k) => bands[k] || 0);
  const total = b.reduce((a, x) => a + x, 0) + 1e-9;
  const logB = b.map((x) => Math.log1p(x));
  const centroid = b.reduce((a, x, i) => a + (i + 1) * x, 0) / total;
  const low = bandSum(bands, D.lowBands) + 1e-9;
  const high = bandSum(bands, D.highBands) + 1e-9;
  const ratio = (bands[D.numBand] || 0) / ((bands[D.denBand] || 0) + 1e-9);
  return [...logB, Math.log1p(total), centroid, ratio, high / low];
}

// ------- 是否正在吹 -------
export function isActive(bands) {
  return bandSum(bands, MODEL.active.lowBands) >= MODEL.active.minEnergy;
}

// ------- 方向:吸氣 / 吐氣 -------
export function predictDirection(bands) {
  const D = MODEL.direction;
  const low = bandSum(bands, D.lowBands) + 1e-9;
  const high = bandSum(bands, D.highBands) + 1e-9;
  const ratio = (bands[D.numBand] || 0) / ((bands[D.denBand] || 0) + 1e-9);
  const score = D.wRatio * (ratio - D.bRatio) + D.wHighLow * (high / low - D.bHighLow);
  const mode = score > 0 ? "exhalation" : "inhalation";
  const confidence = Math.max(0, Math.min(1, 0.5 + Math.abs(score) * 0.5));
  return { mode, confidence, score };
}

// ------- 流量估計(能量代理;可被訓練模型取代) -------
export function estimateFlow(bands) {
  const F = MODEL.flow;
  let e = bandSum(bands, F.weightBands) / F.energyScale;
  if (e < 0) e = 0;
  let v;
  if (F.curve === "sqrt") v = Math.sqrt(e);
  else if (F.curve === "log") v = Math.log1p(e);
  else v = e;
  return Math.min(F.max, F.gain * v * 100);
}

// ------- 對外主函式:一次給遊戲要的全部 -------
export function analyze(bands) {
  if (!bands) return { active: false, direction: null, flow: 0, confidence: 0 };
  const active = isActive(bands);
  if (!active) return { active: false, direction: null, flow: 0, confidence: 0 };
  const dir = predictDirection(bands);
  const flow = estimateFlow(bands);
  return { active: true, direction: dir.mode, flow, confidence: dir.confidence };
}

// ------- 解析裝置的 [FFT] 文字行 -> bands 物件 -------
// 例:"[FFT] 1k:1234567 2k:890123 3k:..."
export function parseFFTLine(line) {
  if (!line || line.indexOf("[FFT]") < 0) return null;
  const bands = {};
  const re = /(\d+)\s*k\s*:\s*([-+]?\d*\.?\d+)/gi;
  let m, found = false;
  while ((m = re.exec(line)) !== null) {
    const k = parseInt(m[1], 10);
    const v = parseFloat(m[2]);
    if (k >= 1 && k <= 20 && !Number.isNaN(v)) { bands[k] = v; found = true; }
  }
  return found ? bands : null;
}

export function status() {
  return `算法 v${MODEL.version}(透明式;可換訓練模型)`;
}

export default { MODEL, analyze, parseFFTLine, predictDirection, estimateFlow,
                 isActive, featurizeBands, status };
