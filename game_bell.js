// 敲鐘機 — 爆發吐氣(peak flow)。深吸一口氣,用力吐,把秤砣打上去敲鐘。
const P = { ONSET:12, END_LOW:7, DEBOUNCE:0.35, MAX_BURST:3.0, FAST_RISE:0.8,
  TARGET_PCT:0.75, BASE_MIN:25, CALIB_REPS:3, STIFF:38, DAMP:8, HOLD:2.0 };

let S;
function reset(api){
  S = { phase:"calib", calib:[], baseline:api.store.get("bell_base",0), best:api.store.get("bell_best",0),
    target:0, bells:0, sessionBest:0,
    inBurst:false, bStart:0, bPeak:0, peakT:0, below:null, rung:false, lastRise:0,
    puck:0, puckV:0, puckTarget:0, bellFlash:0, bellPop:0, squash:0, shake:0, willRing:false, fx:false,
    parts:[], fb:"深吸一口氣，然後用力吹！", fbCol:api.colors.cream, fbUntil:1e12, newRec:false, wrong:false };
  if(S.baseline>0){ S.phase="play"; S.target=Math.max(P.TARGET_PCT*S.baseline,P.TARGET_PCT*P.BASE_MIN); }
}
function primaryLabel(){ return S.phase==="calib" ? "" : "重新測氣力"; }
function primary(api){ S.phase="calib"; S.calib=[]; S.fb="深吸一口氣，然後用力吹！"; }

function ceiling(){ return Math.max(S.baseline*1.3, S.best*1.08, S.target*1.25, 1); }
function frac(v){ return Math.max(0,Math.min(1,v/ceiling())); }

function track(now, flow){
  if(!S.inBurst){ if(flow>=P.ONSET){ S.inBurst=true; S.bStart=now; S.bPeak=flow; S.peakT=now; S.below=null; S.rung=false; } }
  else{
    if(flow>S.bPeak){ S.bPeak=flow; S.peakT=now; }
    if(S.phase==="play" && !S.rung && S.bPeak>=S.target){ S.rung=true; S.willRing=true; S.bells++; }
    if(flow<P.END_LOW){ if(S.below===null) S.below=now; } else S.below=null;
    if((S.below&&now-S.below>P.DEBOUNCE)||(now-S.bStart>P.MAX_BURST)){
      S.inBurst=false; S.lastRise=Math.max(0.01,S.peakT-S.bStart); return "end"; }
  }
  return S.inBurst?"burst":"idle";
}
function scoreCalib(api){
  const pk=S.bPeak; if(pk<8){ S.fb="這一口太輕囉，深吸氣後用力吹～"; return; }
  S.calib.push(pk); const left=P.CALIB_REPS-S.calib.length;
  if(left>0){ S.fb=`很好！這一口 ${Math.round(pk)}。再來 ${left} 次`; S.fbCol=api.colors.gold; }
  else{ S.baseline=Math.max(Math.max(...S.calib),P.BASE_MIN);
    S.target=Math.max(P.TARGET_PCT*S.baseline,P.TARGET_PCT*P.BASE_MIN);
    api.store.set("bell_base",S.baseline);
    S.fb=`你的氣力：${Math.round(S.baseline)}　目標響鈴線：${Math.round(S.target)}`;
    S.fbCol=api.colors.gold; setTimeout(()=>{ S.phase="play"; },1400); }
}
function scorePlay(api){
  const pk=S.bPeak; S.sessionBest=Math.max(S.sessionBest,pk);
  const rang=pk>=S.target, fast=S.lastRise<=P.FAST_RISE;
  if(rang){ if(S.best>0&&pk>S.best){ S.newRec=true; S.shake=Math.max(S.shake,1); }
    S.best=Math.max(S.best,pk); api.store.set("bell_best",S.best);
    S.fb=fast?"爆發力十足！叮～":"叮！響鈴成功！"; S.fbCol=api.colors.gold; }
  else if(pk>=S.target*0.85){ S.fb="就差一點點，再一大口氣！"; S.fbCol=api.colors.cream; }
  else{ S.fb="很好，換一口氣，再用力吹！"; S.fbCol=api.colors.cream; }
  S.fbUntil=performance.now()/1000+P.HOLD;
}

function update(dt, input, api){
  const now=input.now;
  // 這款要吐氣;吸氣不算並提示
  let flow=0; S.wrong=false;
  if(input.direction==="exhalation") flow=input.flow;
  else if(input.direction==="inhalation" && input.flow>P.ONSET) S.wrong=true;
  const r=track(now,flow);
  S.puckTarget=frac(Math.max(flow,S.bPeak*(S.inBurst?1:0)));
  if(r==="end"){ if(S.phase==="calib") scoreCalib(api); else scorePlay(api); if(!S.inBurst) S.willRing=S.willRing; }
  if(r==="end" && S.phase!=="calib"){} // no-op
  if(r==="idle" && !S.inBurst) S.puckTarget=frac(0);

  // 秤砣彈簧
  const pdt=Math.min(dt,0.04);
  const acc=(S.puckTarget-S.puck)*P.STIFF - S.puckV*P.DAMP;
  S.puckV+=acc*pdt; S.puck+=S.puckV*pdt; if(S.puck<0){ S.puck=0; S.puckV=Math.max(0,S.puckV); }
  if(S.phase==="play" && S.willRing && !S.fx && S.target>0 && S.puck>=frac(S.target)*0.98){
    S.fx=true; S.bellFlash=1; S.bellPop=1; S.squash=1; S.shake=Math.max(S.shake,0.85);
    for(let i=0;i<22;i++){ const a=Math.random()*6.283,s=(0.35+Math.random()*0.65)*260;
      S.parts.push({x:0,y:0,vx:Math.cos(a)*s,vy:Math.sin(a)*s-90,life:0.6+Math.random()*0.4,
        col:[api.colors.gold,api.colors.redBr,api.colors.cream][i%3],sz:3+Math.random()*4}); }
    S._emit=true;
  }
  if(!S.inBurst && !S.willRing){ /* reset ring flags after burst ends handled below */ }
  if(r==="end"){ S.willRing=false; S.fx=false; S.bPeak=0; }
  S.bellFlash=Math.max(0,S.bellFlash-dt*2.2); S.squash=Math.max(0,S.squash-dt*4.5);
  S.bellPop=Math.max(0,S.bellPop-dt*4); S.shake=Math.max(0,S.shake-dt*3.2);
  const alive=[]; for(const p of S.parts){ p.vy+=560*dt; p.x+=p.vx*dt; p.y+=p.vy*dt; p.life-=dt; if(p.life>0)alive.push(p);} S.parts=alive;
  S.liveFlow=flow;
}

function bell(g,cx,cy,sz,glow){ const c=glow>0.05?g.colors.gold:g.colors.goldDk;
  g.ctx.fillStyle=c; g.ctx.strokeStyle=g.colors.goldDk; g.ctx.lineWidth=2;
  g.ctx.beginPath(); g.ctx.arc(cx,cy+sz*0.3,sz*0.9,Math.PI,0); g.ctx.fill(); g.ctx.stroke();
  g.rrect(cx-sz*0.95,cy+sz*0.55,cx+sz*0.95,cy+sz*0.75,4); g.ctx.fill(); g.ctx.stroke();
  if(glow>0.05){ g.ctx.strokeStyle=g.colors.gold; g.ctx.lineWidth=2; const rr=sz*(1.3+glow);
    g.ctx.beginPath(); g.ctx.ellipse(cx,cy+sz*0.2,rr,rr*0.8,0,0,6.283); g.ctx.stroke(); } }

function render(g,w,h,api){
  const C=g.colors, now=performance.now()/1000;
  // header
  g.ctx.fillStyle=C.header; g.ctx.fillRect(0,0,w,50);
  g.text(S.phase==="calib"?`測氣力　第 ${Math.min(S.calib.length+1,P.CALIB_REPS)} / ${P.CALIB_REPS} 口`:"敲鐘機",18,25,20,C.cream,"left");
  g.text(`敲響 ${S.bells} 次`,w-18,18,15,C.gold,"right");
  g.text(`本次最高 ${Math.round(S.sessionBest)}　個人最佳 ${Math.round(S.best)}`,w-18,38,13,C.dim,"right",false);
  // tower
  const sx=(Math.random()*2-1)*S.shake*9, sy=(Math.random()*2-1)*S.shake*9;
  const cx=w*0.5+sx, topY=92+sy, baseY=h-46+sy, tw=Math.min(96,w*0.18), span=baseY-topY;
  g.ctx.fillStyle=C.track; g.rrect(cx-tw/2,topY,cx+tw/2,baseY,14); g.fill(C.track); g.stroke(C.goldDk,3);
  if(S.best>0){ const yy=baseY-span*frac(S.best); g.line(cx-tw/2-30,yy,cx+tw/2+30,yy,C.goldDk,2,[6,4]);
    g.text("個人最佳",cx+tw/2+34,yy,12,C.goldDk,"left"); }
  if(S.target>0){ const yy=baseY-span*frac(S.target); g.line(cx-tw/2-34,yy,cx+tw/2+34,yy,C.redBr,4);
    g.text("目標響鈴線",cx-tw/2-40,yy,14,C.redBr,"right"); }
  const bx=cx, by=topY-2, bsz=42*(1+0.22*S.bellPop); bell(g,bx,by,bsz,S.bellFlash);
  if(S.bellFlash>0.05) g.text("叮！",bx,by-54,30,C.gold);
  for(const p of S.parts){ const a=Math.max(0,p.life); g.circle(bx+p.x,by+p.y,p.sz*(0.4+0.6*a),p.col); }
  // puck
  const st=Math.max(-0.25,Math.min(0.45,S.puckV*0.35)), sq=S.squash;
  const pw=(tw-24)*Math.max(0.4,(1-st*0.5)*(1+0.5*sq)), ph=34*Math.max(0.4,(1+st)*(1-0.45*sq));
  const cyk=baseY-span*S.puck-9;
  g.rrect(cx-pw/2,cyk-ph/2,cx+pw/2,cyk+ph/2,10); g.fill(C.gold); g.stroke("#8a5a12",3);
  g.text("氣",cx,cyk,18,"#5a3a08");
  g.text(`氣流 ${Math.round(S.liveFlow||0)}`,cx,baseY+18,15,C.cream);
  // feedback
  if(S.fb && (now<S.fbUntil||S.phase==="calib")) g.text(S.fb,w/2,h*0.30,Math.min(28,w*0.036),S.fbCol);
  if(S.newRec) g.text("★ 破紀錄！★",w/2,h*0.38,24,C.redBr);
  if(S.wrong) g.text("記得是「用力吐氣」喔～",w/2,h*0.44,18,C.gold);
}

export default { title:"敲鐘機", reset, primaryLabel, primary, update, render };
