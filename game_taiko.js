// 呼吸太鼓 — 氣球為主版。
//   流程:吸氣熱身(短長條) -> 吸氣氣球(慢慢吹大,跟吹氣球那款遊戲同一套機制)
//        -> 吐氣熱身(2秒) -> 吐氣氣球(一樣的機制)
//   沒有點狀音符。吸氣前只安排吸氣的練習,不摻吐氣;吐氣前用一段 2 秒的吐氣熱身。
//
// 氣球段完全比照 game_balloon.js 的蓄力公式:力道在 LO~HI 之間,
// 蓄力速度從 FILL_BASE 線性內插到 FILL_MAX,力道越大長得越快;
// 沒吹的時候用 LEAK 慢慢消。
//
// 判定原則(跟之前討論的一致):完全不看分類器判斷的「方向」,只看「有沒有氣流／
// 氣流多大」。每個音符本身(顏色 + 文字)已經告訴玩家該吸氣還是吐氣,遊戲只確認
// 玩家有沒有確實在吹/吸,不去驗證分類器判斷的方向對不對。

const ONSET = 12;           // 一般的「有氣流」門檻(熱身長條用)
const HOLD_LEAD = 0.2;
const JUDGE_DELAY = 0.25;
const RATIO_GREAT = 0.70;
const RATIO_GOOD = 0.35;
const SCROLL_SPEED = 130;   // px/s

// 氣球段的蓄力公式,跟 game_balloon.js 完全一致
const BALLOON_ONSET = 8;
const BALLOON_LO = 10;
const BALLOON_HI = 150;
const BALLOON_FILL_BASE = 1;
const BALLOON_FILL_MAX = 3;
const BALLOON_LEAK = 0.1;

const SC_GREAT = 300, SC_GOOD = 100;
const GA_MISS = -4.0, GA_GREAT = 3.0, GA_GOOD = 1.2;
const GA_BALLOON_PASS = 12, GA_BALLOON_HALF = 4, GA_BALLOON_FAIL = -6;
const GAUGE_CLEAR = 80;

// ---------------------------------------------------------------------
// 課表:吸氣熱身 -> 吸氣氣球 -> 吐氣熱身(2秒) -> 吐氣氣球
// ---------------------------------------------------------------------
function buildChart(){
  const notes = [];
  let t = 0.6;

  // 吸氣熱身(短長條,只練吸氣,不摻吐氣)
  notes.push({type:"hold", kind:"inhale", t, dur:2.0, end:t+2.0, holdHit:0, judged:null});
  t += 2.0 + 0.8;

  // 吸氣氣球
  notes.push({type:"balloon", kind:"inhale", t, dur:6, fill:0, judged:null});
  t += 6 + 1.4;

  // 吐氣熱身(固定 2 秒)
  notes.push({type:"hold", kind:"exhale", t, dur:2.0, end:t+2.0, holdHit:0, judged:null});
  t += 2.0 + 0.8;

  // 吐氣氣球
  notes.push({type:"balloon", kind:"exhale", t, dur:6, fill:0, judged:null});
  t += 6 + 1.0;

  return { notes, total: t };
}

let S, CHART;

function reset(api){
  CHART = buildChart();
  S = {
    running:false, done:false, t:-1.0,
    score:0, combo:0, bestCombo:0, gauge:30,
    counts:{great:0, good:0, miss:0},
    flash:0, judgeText:null, judgeUntil:0, judgeCol:null,
    liveFlow:0, stageLabel:"",
  };
}
function primaryLabel(){
  return S.done ? "再玩一次" : (S.running ? "重新開始" : "開始");
}
function primary(api){
  reset(api); S.running=true; S.t=-1.0;
}

function popJudge(text, col, api){
  S.judgeText=text; S.judgeCol=col; S.judgeUntil=S.t+0.6;
}

function judgeHold(note, api){
  const ratio = note.holdHit / Math.max(note.dur, 0.01);
  let result;
  if(ratio >= RATIO_GREAT) result="great";
  else if(ratio >= RATIO_GOOD) result="good";
  else result="miss";
  note.judged = result;
  S.counts[result]++;
  if(result==="miss"){
    S.combo=0; S.gauge=Math.max(0,S.gauge+GA_MISS);
    popJudge("不可", api.colors.dim, api);
  } else {
    S.combo++; S.bestCombo=Math.max(S.bestCombo,S.combo);
    const base = result==="great"? SC_GREAT : SC_GOOD;
    const bonus = 1+Math.min(S.combo,50)*0.01;
    S.score += Math.round(base*bonus);
    S.gauge = Math.min(100, S.gauge + (result==="great"?GA_GREAT:GA_GOOD));
    popJudge(result==="great"?"良":"可", result==="great"?api.colors.gold:api.colors.green, api);
  }
}

function judgeBalloon(note, api){
  let result, gaugeDelta, scoreBase;
  if(note.fill>=1.0){ result="great"; gaugeDelta=GA_BALLOON_PASS; scoreBase=SC_GREAT*2; }
  else if(note.fill>=0.6){ result="good"; gaugeDelta=GA_BALLOON_HALF; scoreBase=SC_GOOD*1.5; }
  else { result="miss"; gaugeDelta=GA_BALLOON_FAIL; scoreBase=0; }
  note.judged=result;
  S.counts[result==="great"?"great":result==="good"?"good":"miss"]++;
  if(result==="miss"){ S.combo=0; popJudge("氣球沒吹滿", api.colors.dim, api); }
  else { S.combo++; S.bestCombo=Math.max(S.bestCombo,S.combo); S.score+=Math.round(scoreBase);
    popJudge(result==="great"?"氣球吹滿！":"氣球有到一半！", result==="great"?api.colors.gold:api.colors.green, api); }
  S.gauge = Math.max(0, Math.min(100, S.gauge+gaugeDelta));
}

function update(dt, input, api){
  S.liveFlow = input.flow||0;
  if(!S.running) return;

  S.t += dt;
  if(S.t > CHART.total + 1.0){ S.running=false; S.done=true; return; }

  const flow = input.flow||0;
  const blowing = flow >= ONSET;

  // 目前所在的段落標籤(給畫面顯示用)
  let stage = "";
  for(const n of CHART.notes){
    if(n.type==="hold" && S.t>=n.t-1 && S.t<=n.end+1){ stage = n.kind==="inhale"?"吸氣熱身":"吐氣熱身"; break; }
    if(n.type==="balloon" && S.t>=n.t-1 && S.t<=n.t+n.dur+1){ stage = n.kind==="inhale"?"吸氣氣球":"吐氣氣球"; break; }
  }
  S.stageLabel = stage;

  for(const n of CHART.notes){
    if(n.judged!==null) continue;

    if(n.type==="hold"){
      if(n.t - HOLD_LEAD <= S.t && S.t <= n.end){
        if(blowing){
          const wasZero = n.holdHit<=0.001;
          n.holdHit = Math.min(n.dur, n.holdHit+dt);
          S.flash=1;
          if(wasZero) popJudge("抓住了！維持住～", api.colors.green, api);
        }
      } else if(S.t > n.end + JUDGE_DELAY){
        judgeHold(n, api);
      }
    }

    else if(n.type==="balloon"){
      const end = n.t + n.dur;
      if(S.t >= n.t && S.t <= end){
        if(flow >= BALLOON_ONSET && flow >= BALLOON_LO){
          const frac = Math.max(0, Math.min(1, (flow-BALLOON_LO)/(BALLOON_HI-BALLOON_LO)));
          const rate = BALLOON_FILL_BASE + (BALLOON_FILL_MAX-BALLOON_FILL_BASE)*frac;
          n.fill = Math.min(1, n.fill + rate*dt);
          S.flash=1;
          n._liveMsg = n.fill>0.8? "快滿了！再撐一下！" : "蓄力中，很好！";
        } else {
          n.fill = Math.max(0, n.fill - BALLOON_LEAK*dt);
          n._liveMsg = flow>0 ? "再用力一點！" : null;
        }
        if(n.fill>=1.0){ judgeBalloon(n, api); } // 提早吹滿,馬上結算,不用等到段落結束
      } else if(S.t > end + JUDGE_DELAY){
        judgeBalloon(n, api);
      }
    }
  }
  S.flash = Math.max(0, S.flash - dt*4);
}

function render(g,w,h,api){
  const C=g.colors;
  g.ctx.fillStyle=C.header; g.ctx.fillRect(0,0,w,50);
  g.text("呼吸太鼓",18,25,20,C.cream,"left");
  g.text(`分數 ${S.score}　連段 ${S.combo}`,w-18,18,15,C.gold,"right");
  g.text(`最佳連段 ${S.bestCombo}`,w-18,38,13,C.dim,"right",false);

  const laneY = h*0.40, laneH = 55, judgeX = w*0.16;
  const top=laneY-laneH, bot=laneY+laneH;

  g.rrect(0,top,w,bot,0); g.fill(C.track);
  g.ctx.globalAlpha=0.4; g.rrect(0,top,judgeX,bot,0); g.fill(C.panel); g.ctx.globalAlpha=1;
  g.line(0,top,w,top,"#39405f",1);
  g.line(0,bot,w,bot,"#39405f",1);
  if(S.flash>0.05){ g.ctx.globalAlpha=S.flash*0.5; g.rrect(judgeX-6,top,judgeX+6,bot,0); g.fill(C.gold); g.ctx.globalAlpha=1; }
  g.line(judgeX,top-10,judgeX,bot+10,C.cream,3);

  // 魂條
  const gx0=60, gx1=w-60, gy=64;
  g.text("魂",gx0-20,gy,13,C.dim,"right",false);
  g.rrect(gx0,gy-9,gx1,gy+9,6); g.fill(C.track);
  const clearX=gx0+(gx1-gx0)*GAUGE_CLEAR/100;
  const gw=(gx1-gx0)*S.gauge/100;
  g.rrect(gx0,gy-9,gx0+Math.max(2,gw),gy+9,6); g.fill(S.gauge>=GAUGE_CLEAR?C.gold:C.redBr);
  g.line(clearX,gy-14,clearX,gy+14,C.cream,2);
  g.text(`${Math.round(S.gauge)}%`,gx1+14,gy,14,C.cream,"left");

  if(S.stageLabel) g.text(`【${S.stageLabel}】`, judgeX, top-24, 15, C.gold, "left", false);

  if(!S.running && !S.done){
    g.text("呼吸太鼓：氣球為主",w/2,laneY-30,28,C.cream);
    g.text("先吸氣熱身，接著吹一顆吸氣氣球；再吐氣熱身，最後吹一顆吐氣氣球",w/2,laneY+10,15,C.dim,"center",false);
    g.text("氣球段：力道越大長越快，吹滿才算過關",w/2,laneY+34,15,C.dim,"center",false);
    return;
  }

  // 音符渲染
  for(const n of CHART.notes){
    const isInhale = n.kind==="inhale";
    let base = isInhale? C.redBr : C.blue;

    if(n.type==="hold"){
      const x0 = judgeX + (n.t - S.t)*SCROLL_SPEED;
      const x1 = judgeX + (n.end - S.t)*SCROLL_SPEED;
      if(x1 < -40 || x0 > w+40) continue;
      let col = base;
      if(n.judged==="miss") col = "#5c6280";
      g.rrect(x0,laneY-24,x1,laneY+24,14); g.fill(col);
      if(n.holdHit>0){
        const fx = x0 + (n.holdHit/n.dur)*(x1-x0);
        g.rrect(x0,laneY-24,fx,laneY+24,14); g.fill(C.gold);
      }
      g.stroke(C.goldDk,2);
      if(x1-x0>46) g.text(isInhale?"吸氣":"吐氣", (x0+x1)/2, laneY, 14, "#1b1f2e");
    }

    else if(n.type==="balloon"){
      const x0 = judgeX + (n.t - S.t)*SCROLL_SPEED;
      const x1 = judgeX + ((n.t+n.dur) - S.t)*SCROLL_SPEED;
      if(x1 < -60 || x0 > w+60) continue;
      const cy = laneY;
      const active = S.t>=n.t && S.t<=n.t+n.dur && n.judged===null;
      // 底槽
      g.rrect(x0, cy-30, x1, cy+30, 16); g.fill(C.track); g.stroke(C.goldDk,2);
      const fillW = (x1-x0)*n.fill;
      g.rrect(x0, cy-30, x0+Math.max(4,fillW), cy+30, 16);
      g.fill(n.fill>=1?C.gold:base);
      const label = active
        ? (n._liveMsg ? `${n._liveMsg}　${Math.round(n.fill*100)}%` : `${Math.round(n.fill*100)}%`)
        : (n.judged? (n.judged==="great"?"氣球滿了！":n.judged==="good"?"半滿":"沒吹滿") : (isInhale?"吸氣把氣球吹滿":"吐氣把氣球吹滿"));
      if(x1-x0>80) g.text(label,(x0+x1)/2, cy, 14, "#1b1f2e");
    }
  }

  // 即時流速
  const mx0=judgeX, mx1=w-40, my=h*0.72;
  g.text("即時氣流",mx0,my-18,13,C.dim,"left",false);
  g.rrect(mx0,my,mx1,my+22,8); g.fill(C.track);
  const frac=Math.min(1,(S.liveFlow||0)/150);
  if(frac>0.02){ g.rrect(mx0,my,mx0+(mx1-mx0)*frac,my+22,8); g.fill(C.gold); }
  g.text(`${Math.round(S.liveFlow||0)}`,mx1+14,my+11,14,C.cream,"left");

  if(S.judgeText && S.t < S.judgeUntil){
    const age = 0.6-(S.judgeUntil-S.t);
    g.text(S.judgeText, judgeX, laneY-70-age*40, 26, S.judgeCol);
  }

  if(S.done){
    g.text("演奏結束！",w/2,laneY-30,32,C.gold);
    const passed = S.gauge>=GAUGE_CLEAR;
    g.text(passed? "合格 🎉" : "再挑戰一次！",w/2,laneY+6,20,passed?C.green:C.redBr);
    g.text(`良 ${S.counts.great||0}　可 ${S.counts.good||0}　不可 ${S.counts.miss||0}`,w/2,laneY+36,14,C.cream,"center",false);
  }
}

export default { title:"呼吸太鼓", reset, primaryLabel, primary, update, render };
