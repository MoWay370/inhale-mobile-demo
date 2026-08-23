// 吹氣球 — 持久穩定吐氣(耐力)。穩穩地把氣持續吐出去,讓氣球越吹越大,撐住就放飛。
const P = { ONSET:8, LO:10, HI:150, FILL_BASE:0.5, FILL_MAX:3, LEAK:0.1, HOLD_TARGET:1.0,
  WIN_SIZE:1.0, GENTLE:0.6 };

let S;
function reset(api){
  S = { size:0, flew:false, flyY:0, success:api.store.get("balloon_best",0),
    inBand:0, fb:"深吸一口氣，穩穩地把氣吐出去～", fbCol:api.colors.cream,
    steadyBonus:0, wrong:false, sparkle:[], hue:0, running:true };
}
function primaryLabel(){ return "換一顆氣球"; }
function primary(api){ const b=S.success; reset(api); S.success=b; }

function update(dt, input, api){
  // 只吃吐氣
  let flow=0; S.wrong=false;
  if(input.direction==="exhalation") flow=input.flow;
  else if(input.direction==="inhalation" && input.flow>P.ONSET) S.wrong=true;

  if(S.flew){ S.flyY += dt*0.6; for(const s of S.sparkle){ s.life-=dt; s.y-=dt*40; }
    S.sparkle=S.sparkle.filter(s=>s.life>0);
    if(S.flyY>1.4){ /* 等使用者按換一顆 */ } return; }

  const blowing = flow>=P.LO;
  if(blowing){
    // 力道越大脹越快:在 LO~HI 之間,線性內插 FILL_BASE ~ FILL_MAX,超過 HI 就固定用 FILL_MAX(不再懲罰太用力)
    const t = Math.max(0, Math.min(1, (flow-P.LO)/(P.HI-P.LO)));
    const rate = P.FILL_BASE + (P.FILL_MAX-P.FILL_BASE)*t;
    S.size=Math.min(1, S.size + rate*dt); S.inBand+=dt;
    S.fb = t<0.3? "很好，繼續吹～" : t<0.7? "力道不錯，氣球快脹滿了！" : "全力衝刺！快好了！";
    S.fbCol=api.colors.green;
  }
  else { S.size=Math.max(0, S.size - P.LEAK*dt); if(flow>0){ S.inBand=0; S.fb="再吹強一點，氣球才會脹～"; S.fbCol=api.colors.cream; } }

  S.hue=(S.hue+dt*40)%360;
  // 吹滿且穩住 -> 放飛
  if(S.size>=0.999){
    S.flew=true; S.flyY=0; S.success+=1; api.store.set("balloon_best",Math.max(S.success, api.store.get("balloon_best",0)));
    S.fb="放飛成功！太棒了 🎉"; S.fbCol=api.colors.gold;
    for(let i=0;i<28;i++){ S.sparkle.push({x:(Math.random()*2-1),y:0,life:0.8+Math.random()*0.6,
      col:[api.colors.gold,api.colors.redBr,api.colors.green,api.colors.blue][i%4],sz:3+Math.random()*4}); }
  }
  S.liveFlow=flow;
}

function render(g,w,h,api){
  const C=g.colors;
  g.ctx.fillStyle=C.header; g.ctx.fillRect(0,0,w,50);
  g.text("吹氣球",18,25,20,C.cream,"left");
  g.text(`放飛 ${S.success} 顆`,w-18,25,15,C.gold,"right");

  const cx=w*0.5, groundY=h-70;
  // 力道條(左側直條):LO以上都算有效,越用力顏色越亮,不再有「太用力」的懲罰
  const mx=48, top=110, bot=h-90, span=bot-top;
  g.rrect(mx-16,top,mx+16,bot,10); g.fill(C.track); g.stroke(C.goldDk,2);
  const yOf=(v)=> bot - Math.max(0,Math.min(1,v/P.HI))*span;
  // 綠色有效帶:從 LO 往上到頂都算有效(力道越大越好)
  g.ctx.globalAlpha=0.35; g.rrect(mx-14,top,mx+14,yOf(P.LO),6); g.fill(C.green); g.ctx.globalAlpha=1;
  const fv=S.liveFlow||0;
  const fvBarColor = fv>=P.LO ? C.green : C.redBr;
  g.rrect(mx-12,yOf(fv),mx+12,bot-2,8); g.fill(fvBarColor);
  g.text("力道",mx,bot+16,12,C.dim);
  g.text("越用力越快脹",mx+26,(top+yOf(P.LO))/2,12,C.green,"left");

  // 氣球
  const flyOff = S.flew? S.flyY*(groundY+120) : 0;
  const by = groundY - 40 - S.size*220 - flyOff;
  const R = 26 + S.size*120;
  // 綁繩
  if(!S.flew || S.flyY<0.2) g.line(cx, by+R, cx, groundY, C.dim,2);
  // 球體
  const grd=g.ctx.createRadialGradient(cx-R*0.3,by-R*0.3,R*0.2,cx,by,R);
  const hue=S.hue;
  grd.addColorStop(0,`hsl(${hue},90%,75%)`); grd.addColorStop(1,`hsl(${hue},80%,55%)`);
  g.ctx.fillStyle=grd; g.ctx.beginPath(); g.ctx.ellipse(cx,by,R*0.92,R,0,0,6.283); g.ctx.fill();
  g.ctx.fillStyle=`hsl(${hue},80%,55%)`; g.ctx.beginPath(); g.ctx.moveTo(cx-6,by+R-2); g.ctx.lineTo(cx+6,by+R-2); g.ctx.lineTo(cx,by+R+10); g.ctx.fill();
  // 高光
  g.ctx.globalAlpha=0.5; g.circle(cx-R*0.32,by-R*0.34,R*0.16,"#ffffff"); g.ctx.globalAlpha=1;

  // 地面
  g.line(0,groundY,w,groundY,"#6a2530",2);

  // 進度
  g.text(`${Math.round(S.size*100)}%`,cx,by,Math.max(16,R*0.5),"#2a0a10");

  // sparkle
  for(const s of S.sparkle){ g.ctx.globalAlpha=Math.max(0,s.life); g.circle(cx+s.x*140,by+s.y*160,s.sz,s.col); g.ctx.globalAlpha=1; }

  // feedback
  g.text(S.fb,w/2,84,Math.min(26,w*0.033),S.fbCol);
  if(S.wrong) g.text("這款是「吐氣」喔～",w/2,116,16,C.gold);
  g.text(`力道 ${Math.round(S.liveFlow||0)}`,cx,groundY+20,15,C.cream);
}

export default { title:"吹氣球", reset, primaryLabel, primary, update, render };
