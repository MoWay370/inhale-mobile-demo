// 呼吸節奏 — 太鼓達人式。跟著上下移動的標準線一吸一吐,對準了就得分。
// 吸氣 = 上方(正值,綠);吐氣 = 下方(負值,藍)。移植自教育標準線程式。

// (mode, flow_Lpm, duration_sec)。0 = 休息。
const PROGRAM = [
  ["inhalation",0,3],
  ["inhalation",60,2],["inhalation",0,3],["exhalation",60,3],["inhalation",0,2],
  ["inhalation",60,2],["inhalation",0,3],["exhalation",60,3],["inhalation",0,2],
  ["inhalation",90,1.5],["inhalation",0,2],["exhalation",50,6],["inhalation",0,3],
  ["inhalation",90,1.5],["inhalation",0,2],["exhalation",50,6],["inhalation",0,3],
  ["inhalation",120,1],["inhalation",0,3],["exhalation",100,2],["inhalation",0,3],
  ["inhalation",40,3],["inhalation",0,2],["exhalation",40,4],["inhalation",0,2],
  ["inhalation",30,3],["inhalation",0,2],["exhalation",30,4],["inhalation",0,3],
];
const SCALE = 130;      // 垂直對應的最大 L/min
const TOL = 34;         // 命中容差(長輩友善,放寬)
const SPEED = 90;       // 每秒像素捲動速度
const RAMP = 0.4;

function buildCurve(){
  const pts=[]; let t=0;
  for(const [mode,flow,dur] of PROGRAM){
    if(flow===0){ pts.push({t,v:0}); t+=dur; pts.push({t,v:0}); continue; }
    const tgt = mode==="inhalation"? flow : -flow;
    const rd=Math.min(RAMP,dur*0.3), hold=Math.max(0,dur-2*rd);
    pts.push({t,v:0}); t+=rd; pts.push({t,v:tgt}); t+=hold; pts.push({t,v:tgt}); t+=rd; pts.push({t,v:0});
  }
  return { pts, total:t };
}
function valueAt(curve, tt){
  const p=curve.pts; if(tt<=p[0].t) return 0; if(tt>=p[p.length-1].t) return 0;
  for(let i=1;i<p.length;i++){ if(tt<=p[i].t){ const a=p[i-1],b=p[i];
    const f=(b.t-a.t)>1e-6?(tt-a.t)/(b.t-a.t):0; return a.v+(b.v-a.v)*f; } }
  return 0;
}

let S, CURVE;
function reset(api){
  CURVE = buildCurve();
  S = { running:false, t:0, score:0, hits:0, combo:0, bestCombo:0, done:false,
    trace:[], rings:[], lastHitSeg:-1 };
}
function primaryLabel(){ return S.running ? "重新開始" : (S.done?"再玩一次":"開始"); }
function primary(api){ reset(api); S.running=true; }

function update(dt, input, api){
  if(!S.running){ return; }
  S.t += dt;
  if(S.t > CURVE.total + 1){ S.running=false; S.done=true; return; }
  // 玩家目前 signed 值(吸+ / 吐-),映射到 L/min 尺度
  const player = input.signed; // 已是 +吸 / -吐 的 flow proxy
  S.trace.push({t:S.t, v:player}); if(S.trace.length>240) S.trace.shift();
  // 命中判定:標準線在 now 線的值,與玩家比對
  const guide = valueAt(CURVE, S.t);
  if(Math.abs(guide) > 8){ // 非休息段
    if(Math.abs(player-guide) <= TOL){
      S.combo++; S.bestCombo=Math.max(S.bestCombo,S.combo); S.score+=10+Math.min(20,S.combo);
      S._hit=true;
    } else if(Math.abs(player) < 6){ /* 沒吹,不扣連段但斷combo */ S.combo=0; }
    else { S.combo=0; }
  }
  const alive=[]; for(const r of S.rings){ r.life-=dt; if(r.life>0) alive.push(r); } S.rings=alive;
  if(S._hit){ S._hit=false; if(S.rings.length<40) S.rings.push({life:0.5}); }
}

function render(g,w,h,api){
  const C=g.colors;
  g.ctx.fillStyle=C.header; g.ctx.fillRect(0,0,w,50);
  g.text("呼吸節奏",18,25,20,C.cream,"left");
  g.text(`分數 ${S.score}　連段 ${S.combo}`,w-18,18,15,C.gold,"right");
  g.text(`最佳連段 ${S.bestCombo}`,w-18,38,13,C.dim,"right",false);

  const midY=(50+h)/2, nowX=w*0.28, pxPerSec=SPEED;
  const yOf=(v)=> midY - (v/SCALE)*((h-90)/2);
  // 中線與 now 線
  g.line(0,midY,w,midY,"#6a2530",1);
  g.line(nowX,60,nowX,h-16,C.gold,3);
  g.text("現在",nowX,h-8,12,C.gold);
  g.text("吸氣 ↑",70,72,14,C.green,"left"); g.text("吐氣 ↓",70,h-30,14,C.blue,"left");

  if(!S.running && !S.done){
    g.text("跟著標準線一吸一吐",w/2,midY-30,30,C.cream);
    g.text("線在上方就吸氣、在下方就吐氣，對準亮線就得分",w/2,midY+16,17,C.dim,"center",false);
    g.text("沒接裝置:按住 ↑ 吸、↓ 吐 試玩",w/2,midY+48,14,C.dim,"center",false);
    return;
  }

  // 畫捲動的標準線(未來的線從右邊過來)
  const tStart=S.t-(nowX/pxPerSec), tEnd=S.t+((w-nowX)/pxPerSec);
  let started=false;
  g.ctx.lineWidth=4; g.ctx.setLineDash([]);
  for(let seg=0; seg<2; seg++){ // 分兩色畫(綠吸/藍吐)
    g.ctx.beginPath(); started=false;
    for(let tt=tStart; tt<=tEnd; tt+=0.05){
      const v=valueAt(CURVE,tt); const on = seg===0? v>0 : v<0;
      const x=nowX+(tt-S.t)*pxPerSec, y=yOf(v);
      if(on){ if(!started){ g.ctx.moveTo(x,y); started=true; } else g.ctx.lineTo(x,y); }
      else { started=false; }
    }
    g.ctx.strokeStyle = seg===0? C.green : C.blue; g.ctx.globalAlpha=0.9; g.ctx.stroke(); g.ctx.globalAlpha=1;
  }
  // 玩家軌跡(紅)
  g.ctx.beginPath(); let ps=false;
  for(const pt of S.trace){ const x=nowX+(pt.t-S.t)*pxPerSec; const y=yOf(pt.v);
    if(x<0) continue; if(!ps){ g.ctx.moveTo(x,y); ps=true; } else g.ctx.lineTo(x,y); }
  g.ctx.strokeStyle=C.redBr; g.ctx.lineWidth=3; g.ctx.stroke();
  // now 線上的玩家點
  const guide=valueAt(CURVE,S.t);
  const py=yOf(S.trace.length? S.trace[S.trace.length-1].v : 0);
  g.circle(nowX,py,9,C.red);
  // 命中光環
  for(const r of S.rings){ g.ctx.globalAlpha=r.life*2; g.circle(nowX,yOf(guide),14+(0.5-r.life)*40,C.gold,false); g.ctx.globalAlpha=1; }
  // 當前指示
  const label = Math.abs(guide)<8? "休息" : (guide>0? "吸　氣" : "吐　氣");
  g.text(label,w/2,64+18,22, Math.abs(guide)<8? C.dim : (guide>0?C.green:C.blue));

  if(S.done){ g.text("完成！辛苦了",w/2,midY-20,40,C.gold);
    g.text(`分數 ${S.score}　最佳連段 ${S.bestCombo}`,w/2,midY+24,22,C.cream); }
}

export default { title:"呼吸節奏", reset, primaryLabel, primary, update, render };
