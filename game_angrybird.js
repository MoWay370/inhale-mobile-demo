// 吸氣彈弓鳥 — 偵測吸氣流速(單次爆發,peak inhale)。一口氣裡吸得最用力的
// 那一瞬間(peak flow)直接決定發射力道。不做物理模擬、不算距離高低,
// 純粹依「力道等級」播放三種固定的動畫:小力道、中力道、力道夠大。
// 只有「力道夠大」這一級才會真的打倒城牆,其餘兩級都只是預錄好的過程動畫。
const P = {
  ONSET: 10,           // 低於這個流速不算開始吸氣
  REF_MAX: 60,          // peak flow 達到這個值,力道視為 100%(可依裝置實測調整)
  MED_THRESH: 0.40,     // 力道 >= 這個比例,算「中」
  BIG_THRESH: 0.85,     // 力道 >= 這個比例,算「夠大」,城牆才會倒
  GROUND_Y_RATIO: 0.82,
  WALL: { xr: 0.80, halfW: 34, heightRatio: 0.30, pts: 50 },
  // 三種固定動畫的參數:飛行時間、終點位置、拋物線頂點位置(都用畫面比例表示)
  ANIM: {
    small:  { dur: 0.55, endXR: 0.26, apexXR: 0.16, apexYRatio: 0.10 },
    medium: { dur: 0.85, endXR: 0.50, apexXR: 0.32, apexYRatio: 0.20 },
    big:    { dur: 1.10, endXR: 0.80, apexXR: 0.48, apexYRatio: 0.34 }, // 終點就是城牆位置
  },
};

let S;

function reset(api){
  S = {
    phase: "aim",            // aim(等待吸氣) -> flight(播放固定動畫) -> result(結算,等按鈕)
    peak: 0,
    power: 0,
    tier: null,               // "small" / "medium" / "big"
    animT: 0,
    wrong: false,
    liveFlow: 0,
    bx: 0, by: 0, trail: [],
    round: 1,
    score: api.store.get("angrybird_score", 0),
    best: api.store.get("angrybird_best", 0),
    wallBroken: false,
    rubble: [],
    msg: "深吸一口氣，用最大的力氣打倒城牆！",
    msgCol: api.colors.cream,
    shake: 0,
  };
}
function primaryLabel(){
  return S.phase==="result" ? "再射一次" : "";
}
function primary(api){
  if(S.phase!=="result") return;
  S.phase="aim"; S.peak=0; S.power=0; S.tier=null; S.animT=0; S.trail=[]; S.rubble=[];
  S.msg="深吸一口氣，用最大的力氣打倒城牆！"; S.msgCol=api.colors.cream;
  S.round += 1;
  if(S.wallBroken) S.wallBroken=false; // 重新蓋一面牆
}

function tierOf(power){
  if(power >= P.BIG_THRESH) return "big";
  if(power >= P.MED_THRESH) return "medium";
  return "small";
}

function launch(api){
  S.power = Math.max(0, Math.min(1, S.peak / P.REF_MAX));
  S.tier = tierOf(S.power);
  S.animT = 0;
  S.phase = "flight";
  S.trail = [];
}

// 二次貝茲曲線,算固定動畫路徑上某個進度 t(0~1) 的座標
function bezierPoint(p0, p1, p2, t){
  const u = 1-t;
  return {
    x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
    y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y,
  };
}

function update(dt, input, api){
  S.liveFlow = 0; S.wrong = false;

  if(S.phase==="aim"){
    if(input.direction==="inhalation" && input.flow>P.ONSET){
      S.liveFlow = input.flow;
      S.peak = Math.max(S.peak, input.flow); // 只記錄這口氣的最高瞬間值,不做時間累積
      const pct = Math.round(Math.min(1,S.peak/P.REF_MAX)*100);
      S.msg = pct<40? "吸氣中…用最大的力氣吸！" : pct<85? "快到了！再吸大力一點！" : "力道足夠了！鬆口氣發射！";
      S.msgCol = api.colors.gold;
    } else if(input.direction==="exhalation" && input.flow>P.ONSET){
      S.wrong = true;
      S.msg = "這款要用「吸氣」喔～"; S.msgCol=api.colors.gold;
    } else {
      if(S.peak > 0.01) launch(api);
    }
    return;
  }

  if(S.phase==="flight"){
    const w = api.canvasW || 800, h = api.canvasH || 500;
    const groundY = h*P.GROUND_Y_RATIO;
    const cfg = P.ANIM[S.tier];

    S.animT += dt;
    const t = Math.min(1, S.animT / cfg.dur);
    const eased = 1-(1-t)*(1-t); // ease-out,飛行前段快、後段緩,看起來比較自然

    const p0 = { x: w*0.12, y: groundY-70 };
    const p1 = { x: w*cfg.apexXR, y: groundY - h*cfg.apexYRatio };
    const p2 = { x: w*cfg.endXR, y: S.tier==="big" ? (groundY - h*P.WALL.heightRatio*0.5) : groundY };
    const pos = bezierPoint(p0, p1, p2, eased);
    S.bx = pos.x; S.by = pos.y;
    S.trail.push({x:S.bx, y:S.by}); if(S.trail.length>60) S.trail.shift();

    if(t >= 1){
      if(S.tier==="big"){
        S.wallBroken = true;
        S.score += P.WALL.pts; api.store.set("angrybird_score", S.score);
        S.best = Math.max(S.best, P.WALL.pts); api.store.set("angrybird_best", S.best);
        S.shake = 1;
        spawnRubble(w*cfg.endXR, groundY - h*P.WALL.heightRatio, h);
        S.msg = `轟！城牆倒了！+${P.WALL.pts} 分`; S.msgCol=api.colors.gold;
      } else if(S.tier==="medium"){
        S.msg = "力道普通，飛到半路就掉下來了，再吸大力一點！"; S.msgCol=api.colors.cream;
      } else {
        S.msg = "力道太小，只飛了一點點～再吸更用力一點！"; S.msgCol=api.colors.cream;
      }
      S.phase = "result";
    }
    return;
  }

  // result 階段
  S.shake = Math.max(0, S.shake - dt*3);
  for(const r of S.rubble){ r.vy+=560*dt; r.x+=r.vx*dt; r.y+=r.vy*dt; r.life-=dt; }
  S.rubble = S.rubble.filter(r=>r.life>0);
}

function spawnRubble(x, topY, h){
  for(let i=0;i<24;i++){
    const a=Math.random()*Math.PI-Math.PI/2;
    const spd=(80+Math.random()*180);
    S.rubble.push({
      x:(Math.random()*2-1)*P.WALL.halfW, y:(Math.random()*-1)*h*P.WALL.heightRatio,
      vx:Math.cos(a)*spd, vy:-Math.abs(Math.sin(a)*spd)-40,
      life:0.9+Math.random()*0.6, sz:4+Math.random()*6,
    });
  }
}

function drawWall(g, wallX, groundY, h){
  const wallH = h*P.WALL.heightRatio;
  const left = wallX-P.WALL.halfW, right = wallX+P.WALL.halfW;
  const rows = 5, cols = 3;
  const bh = wallH/rows, bw = (right-left)/cols;
  for(let r=0;r<rows;r++){
    const offset = (r%2===0) ? 0 : bw*0.5;
    for(let c=-1;c<cols+1;c++){
      const bx1 = left + c*bw + offset;
      const bx2 = bx1 + bw - 3;
      if(bx2<left-2 || bx1>right+2) continue;
      const by1 = groundY - (r+1)*bh;
      const by2 = by1 + bh - 3;
      g.rrect(Math.max(bx1,left), by1, Math.min(bx2,right), by2, 2);
      g.fill("#b8862a"); g.stroke("#6a4a1a",1);
    }
  }
}

function render(g,w,h,api){
  api.canvasW = w; api.canvasH = h;
  const C=g.colors;
  const sx=(Math.random()*2-1)*S.shake*8, sy=(Math.random()*2-1)*S.shake*8;

  g.ctx.fillStyle=C.header; g.ctx.fillRect(0,0,w,50);
  g.text("吸氣彈弓鳥",18,25,20,C.cream,"left");
  g.text(`分數 ${S.score}`,w-18,18,15,C.gold,"right");
  g.text(`第 ${S.round} 發`,w-18,38,13,C.dim,"right",false);

  const groundY=h*P.GROUND_Y_RATIO+sy;
  g.line(0,groundY,w,groundY,"#6a2530",2);
  g.ctx.fillStyle="#3a2a12"; g.ctx.fillRect(0,groundY,w,h-groundY);

  const slingX=w*0.12+sx, slingY=groundY-70;
  const wallX=P.WALL.xr*w+sx;

  if(!S.wallBroken) drawWall(g, wallX, groundY, h);
  else g.text("🏚️",wallX,groundY-30+sy,34,C.dim);

  for(const r of S.rubble){
    g.ctx.globalAlpha=Math.max(0,Math.min(1,r.life));
    g.circle(wallX+r.x+sx, groundY-h*P.WALL.heightRatio+r.y+sy, r.sz, "#b8862a");
    g.ctx.globalAlpha=1;
  }

  // 力道條(吸氣中即時顯示目前這口氣抓到的peak,三個等級用刻度標示)
  if(S.phase==="aim"){
    const barX=slingX, barTop=slingY-90, barBot=slingY-10;
    g.rrect(barX-14,barTop,barX+14,barBot,8); g.fill(C.track); g.stroke(C.goldDk,2);
    const curPower = Math.max(0, Math.min(1, S.peak / P.REF_MAX));
    const fillY = barBot - (barBot-barTop)*curPower;
    g.rrect(barX-10,fillY,barX+10,barBot-2,6); g.fill(curPower>=P.BIG_THRESH?C.gold:curPower>=P.MED_THRESH?C.green:C.redBr);
    const medY = barBot - (barBot-barTop)*P.MED_THRESH;
    const bigY = barBot - (barBot-barTop)*P.BIG_THRESH;
    g.line(barX-18,medY,barX+18,medY,C.dim,1,[3,3]);
    g.line(barX-18,bigY,barX+18,bigY,C.redBr,2,[3,3]);
    const pull = curPower*46;
    g.circle(slingX-pull*0.6, slingY+pull*0.5, 16, "#e6402f");
    g.circle(slingX-pull*0.6-6, slingY+pull*0.5-4, 4, "#2a0a10");
  }
  g.line(slingX-14, slingY+30, slingX-14, slingY-40, "#7a5a2a", 6);
  g.line(slingX+14, slingY+30, slingX+14, slingY-40, "#7a5a2a", 6);

  if(S.phase==="flight"){
    for(let i=0;i<S.trail.length;i++){
      const p=S.trail[i]; const a=i/S.trail.length;
      g.ctx.globalAlpha=a*0.5; g.circle(p.x+sx,p.y+sy,4,C.cream); g.ctx.globalAlpha=1;
    }
    g.circle(S.bx+sx, S.by+sy, 16, "#e6402f");
    g.circle(S.bx+sx-6, S.by+sy-4, 4, "#2a0a10");
  }

  g.text(S.msg, w/2, 78, Math.min(22,w*0.028), S.msgCol);
  if(S.wrong) g.text("記得是「吸氣」喔～", w/2, 108, 15, C.gold);
  if(S.phase==="aim") g.text(`目前力道 ${Math.round(Math.min(1,S.peak/P.REF_MAX)*100)}%　（需要 ${Math.round(P.BIG_THRESH*100)}% 以上）`, w/2, h-18, 15, C.cream);
  if(S.phase==="result") g.text("按「再射一次」繼續", w/2, h-18, 15, C.dim, "center", false);
  g.text(`個人最高單發 ${S.best} 分`, 18, h-14, 13, C.dim, "left", false);
}

export default { title:"吸氣彈弓鳥", reset, primaryLabel, primary, update, render };
