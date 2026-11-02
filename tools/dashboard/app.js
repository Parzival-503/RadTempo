try{
if(typeof CSV_RAW==='undefined'){document.body.innerHTML='<h2 style="color:#d03b3b;margin:40px">ERROR: CSV data not loaded</h2>';throw 0;}
if(typeof Chart==='undefined'){document.body.innerHTML='<h2 style="color:#d03b3b;margin:40px">ERROR: Chart.js not loaded. Check internet connection.</h2>';throw 0;}
var HASCLS=(typeof CLS!=='undefined'),HASSH=(typeof SHIFTS!=='undefined');
var GOAL=(typeof DAILY_GOAL!=='undefined'&&+DAILY_GOAL>0)?+DAILY_GOAL:0;
/* Hourly rate prices TIME only - idle gaps, engaged hours, hours reclaimed.
   Deliberately never priced per study: $/study would reward reading faster. */
var RATE=(typeof HOURLY_RATE!=='undefined'&&+HOURLY_RATE>0)?+HOURLY_RATE:0;
var GOALMAP=(typeof GOALS!=='undefined'&&GOALS)?GOALS:{};
/* ---- palette (validated: see tools/palette_check) ---- */
var SF='#15152a',GRID='#1e1e3a',MUT='#7a7a99';
var MC={CR:'#199e70',CT:'#c98500',MR:'#3987e5',US:'#d55181',PET:'#9085e9'};
var MN={CR:'X-Ray',CT:'CT',MR:'MRI',US:'Ultrasound',PET:'PET/CT'};
var SPAL=['#3987e5','#d95926','#199e70','#c98500','#d55181','#008300','#9085e9','#e66767'];
var GOODC='#0ca30c',CRITC='#d03b3b',WARNC='#fab219';
/* ---- helpers ---- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function ft(s){var m=Math.floor(s/60),c=Math.round(s%60);return m+':'+String(c).padStart(2,'0');}
function fh(s){var h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h>0?h+'h '+m+'m':m+'m';}
function fhr(s){return Math.round(s/360)/10;}
function ymd(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function mdyOf(d){return (d.getMonth()+1)+'/'+d.getDate()+'/'+d.getFullYear();}
function el(id){return document.getElementById(id);}
function usd(n){var v=Math.round(n);return '$'+String(v).replace(/\B(?=(\d{3})+(?!\d))/g,',');}
function moneyFor(sec){return RATE>0?usd(sec/3600*RATE):'';}
function tbl(head,rows){var h='<div class="tblwrap"><table><thead><tr>';head.forEach(function(x){h+='<th>'+esc(x)+'</th>';});
h+='</tr></thead><tbody>';rows.forEach(function(r){h+='<tr>';r.forEach(function(c){h+='<td>'+esc(c)+'</td>';});h+='</tr>';});
return h+'</tbody></table></div>';}
/* ---- shift attribution (mirrors the AHK engine) ---- */
function evClean(t){return t.replace(/\s*\[[^\]]*\]/g,'').replace(/\*?\s*swap.*$/i,'').trim();}
function evClass(t){var u=t.toUpperCase();if(CLS.noise.some(function(k){return u.includes(k);}))return 'N';
if(CLS.off.some(function(k){return u.includes(k);}))return 'O';
if(CLS.mod.some(function(k){return u.includes(k);}))return 'M';return 'P';}
function evWin(t){var m=t.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([ap])/i);
var hf=function(hh,mm,ap){return (+hh%12)+(ap.toLowerCase()==='p'?12:0)+(mm?+mm/60:0);};
if(m){var s=hf(m[1],m[2],m[3]),e=hf(m[4],m[5],m[6]);if(e<=s)e+=24;return[s,e,true];}
if(/\bAM\b/i.test(t))return[CLS.am[0],CLS.am[1],true];
if(/\bPM\b/i.test(t))return[CLS.pm[0],CLS.pm[1],true];return[0,24,false];}
var onRe=!HASCLS?null:CLS.onsite?new RegExp(CLS.onsite,'i'):/(?!)/;
function dayPlan(raw){var P=[],M=[],ex=false;(raw||'').split(' / ').forEach(function(tok){var c=evClean(tok);if(!c)return;
var k=evClass(c),w=evWin(c);
if(k==='P')P.push({name:c,s:w[0],e:w[1],w:w[2],on:onRe.test(c)});
else if(k==='M')M.push({name:c,s:w[0],e:w[1],w:w[2]});
else if(k==='N'&&c.toUpperCase().includes('EXTRA HOURS'))ex=true;});
if(!P.length&&ex)P.push({name:'Extra Hours',s:0,e:24,w:false,on:false});return[P,M];}
function attrib(raw,t){var pm=dayPlan(raw),P=pm[0],M=pm[1];if(!P.length)return['Unscheduled',''];
var c=P.filter(function(p){return p.s<=t&&t<p.e;}),b;
if(c.length)b=c.sort(function(a,x){return (a.e-a.s)-(x.e-x.s)||x.s-a.s;})[0];
else b=P.slice().sort(function(a,x){return Math.min(Math.abs(t-a.s),Math.abs(t-a.e))-Math.min(Math.abs(t-x.s),Math.abs(t-x.e))||x.s-a.s;})[0];
var ex=M.filter(function(m){return !m.w||(m.s<=t&&t<m.e);}).map(function(m){return m.name;}).join(' + ');
return[b.name,ex];}
function modBase(m){return m.replace(/(\d{1,2})(?::(\d{2}))?\s*([ap])\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([ap])/i,'').replace(/[:\s]+$/,'').trim();}
/* ---- parse ---- */
var D=CSV_RAW.trim().split('\n').slice(1).filter(function(l){return l.trim();}).map(function(l){
var v=l.split(','),ex=(v[8]||'').trim(),raw=v[1]||'',dt=raw;
if(raw.match(/^\d{1,2}\//)){var p=raw.split('/');dt=p[2]+'-'+p[0].padStart(2,'0')+'-'+p[1].padStart(2,'0');}
var tm=(v[0]||'').match(/\s(\d{1,2}):(\d{2})$/),tt=tm?(+tm[1]+ +tm[2]/60):(+v[3]+0.5);
var sh=(v[10]||'').trim(),xr=(v[11]||'').trim();
if(HASCLS&&HASSH&&SHIFTS[raw]){var at=attrib(SHIFTS[raw],tt);sh=at[0];xr=at[1];}
/* col 13 (ActiveSec): physically-active seconds measured during the study.
   -1 means "not measured" - legacy rows, or tracking switched off. */
var av=(v[12]===undefined||String(v[12]).trim()==='')?-1:(parseInt(v[12],10));
if(isNaN(av))av=-1;
var pv=(v[13]===undefined||String(v[13]).trim()==='')?0:(parseInt(v[13],10)||0);
/* cols 15/16 (ProcCode, IVUSrc): where the row's IVU actually came from.
   "learned:n" is PowerScribe's own figure for that procedure code, "code" an
   exact table hit, "desc:0.42" the old fuzzy match against the report's prose
   and how well it scored. Blank on every row written before calibration
   existed - those are unknown, not good. */
var sv=(v[15]||'').trim();
return{ts:v[0],date:dt,dRaw:raw,day:v[2],hr:+v[3],tt:tt,sec:+v[4],fmt:v[5],mod:v[6],exam:ex,
ivu:parseFloat(v[9])||0,shift:(sh==='Unscheduled'?'':sh),extras:xr,act:av,par:pv,
code:(v[14]||'').trim(),src:sv,firm:(sv.indexOf('learned')===0||sv==='code')};});
if(!D.length){document.body.innerHTML='<h2 style="color:#7a7a99;text-align:center;margin:100px">No data yet</h2>';throw 0;}
var TODAY=ymd(new Date()),TRAW=mdyOf(new Date());
/* ---- day totals corrected against PowerScribe ----
   PowerScribe's RVU Sum for a day is the authoritative production figure;
   the log's IVU column is a per-study estimate off a table that drifts. When
   a day has been corrected on the widget, the same correction has to apply
   here or the dashboard quietly contradicts the number you were looking at -
   which is the original bug, one layer down. Keyed on the raw M/d/yyyy date,
   the same key the widget writes. */
var IADJ=(typeof IVU_ADJ!=='undefined'&&IVU_ADJ)?IVU_ADJ:{};
function dayAdj(k){return +(IADJ[k]||0);}
function sumIvu(dd){if(!dd||!dd.length)return 0;
var v=dd.filter(function(x){return x.ivu>0;}).reduce(function(a,x){return a+x.ivu;},0)
+dayAdj(dd[0].dRaw);return v>0?v:0;}
/* ---- the filler exam ----
   When the assigned worklist runs dry there is one exam type that gets read to
   top the day up. "3.4 IVU short" is not a number you can act on; "3 more lung
   screenings" is, so every deficit and every stretch of lost time is also
   quoted in that unit.
   Calibrated from the log FIRST - the IVU actually recorded and the engaged
   time actually measured - because that is ground truth for this reader. The
   value emitted from the IVU table is only the fallback for someone who has
   never read one. */
var FILL=(typeof FILLER!=='undefined'&&FILLER&&FILLER.re)?FILLER:null;
var LAD=(typeof LADDER!=='undefined'&&LADDER&&+LADDER.s>0)?{b:+LADDER.b,s:+LADDER.s}:null;
function med(a){if(!a.length)return 0;var s=a.slice().sort(function(x,y){return x-y;});
var m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;}
function r1(n){return Math.round(n*10)/10;}
/* Lowest rung strictly above v. Finishing between two rungs pays the same as
   the rung below, so the rung - not the raw number - is what is worth chasing. */
function nextRung(v){if(!LAD)return 0;if(v<LAD.b)return LAD.b;
var r=LAD.b+(Math.floor((v-LAD.b)/LAD.s)+1)*LAD.s;while(r<=v+1e-3)r+=LAD.s;return r1(r);}
/* Daily credits at an IVU total: one step past the floor is one credit, which
   is one hour. Floored, because a total between rungs pays the rung below. */
function credits(v){return LAD?Math.max(0,Math.floor((v-LAD.b)/LAD.s+1e-4)):0;}
function nCred(c){return c+(c===1?' credit':' credits');}
var FSTAT=(function(){
if(!FILL)return null;
var re;try{re=new RegExp(FILL.re,'i');}catch(e){return null;}
var hits=D.filter(function(d){return d.exam&&re.test(d.exam);});
/* median, not mean: one linked/mis-parsed row would otherwise move both */
var iv=med(hits.map(function(d){return d.ivu;}).filter(function(v){return v>0;}));
var sec=med(hits.map(function(d){return d.act>0?d.act:d.sec;}).filter(function(v){return v>0;}));
if(!(iv>0))iv=+FILL.ivu||0;
if(!(iv>0))return null;              /* nothing to denominate in - stay quiet */
return{name:FILL.n||'filler study',ivu:r1(iv),sec:sec,n:hits.length};})();
/* ---- focus engine ---- */
var FMICRO=120,FBREAK=1800;
function focusDay(rows){var iv=rows.map(function(d){var e=new Date(d.ts).getTime();return{s:e-d.sec*1000,e:e,sec:d.sec};})
.filter(function(x){return x.e>0;}).sort(function(a,b){return a.s-b.s;});
var segs=[],active=0,idle=0,gc=0,lng=0;
/* In-study idle: measured seconds inside a study with no physical input.
   Only counted for rows that actually carry a measurement (act >= 0). */
var inIdle=0,inMeas=0;
rows.forEach(function(d){if(d.act>=0){inMeas+=d.sec;var g=d.sec-d.act;if(g>0)inIdle+=g;}});
if(!iv.length)return{active:0,idle:0,gc:0,lng:0,segs:segs,inIdle:inIdle,inMeas:inMeas};
var ce=iv[0].e;active+=iv[0].sec;segs.push({t:'r',s:iv[0].sec});
for(var i=1;i<iv.length;i++){var gm=iv[i].s-ce;
if(gm>0){var g=gm/1000;
if(g>=FBREAK)segs.push({t:'b',s:g});
else if(g>FMICRO){idle+=g;gc++;if(g>lng)lng=g;segs.push({t:'i',s:g});}
else segs.push({t:'m',s:g});}
active+=iv[i].sec;segs.push({t:'r',s:iv[i].sec});if(iv[i].e>ce)ce=iv[i].e;}
return{active:active,idle:idle,gc:gc,lng:lng,segs:segs,inIdle:inIdle,inMeas:inMeas};}
function flowStrip(segs){if(!segs.length)return '';
var cap=function(x){return x.t==='b'?Math.min(x.s,240):x.s;};
var tot=segs.reduce(function(a,x){return a+cap(x);},0)||1;
var h=segs.map(function(x){var w=cap(x)/tot*100;
var col=x.t==='r'?GOODC:x.t==='i'?CRITC:x.t==='m'?'#0d5c3f':'#0c0c1e';
var tip=(x.t==='r'?'read ':x.t==='i'?'idle ':x.t==='b'?'break ':'gap ')+Math.round(x.s/60)+'m';
return '<div title="'+esc(tip)+'" style="flex:'+w.toFixed(3)+' 0 0;background:'+col+'"></div>';}).join('');
return '<div class="flow">'+h+'</div>';}
/* ---- day shape: when a day actually started and finished ----
   Start is when the FIRST study opened (sign time minus its duration), not the
   first sign - otherwise a long first read makes the day look like it began an
   hour late. Finish is the last sign. */
function hrOf(d){return d.getHours()+d.getMinutes()/60+d.getSeconds()/3600;}
function hhmm(h){h=((h%24)+24)%24;var hh=Math.floor(h),mm=Math.round((h-hh)*60);
if(mm===60){mm=0;hh=(hh+1)%24;}
return (hh%12||12)+':'+String(mm).padStart(2,'0')+(hh<12?'a':'p');}
function dayShape(dates){return dates.map(function(dt){
var dd=V.filter(function(x){return x.date===dt;});
if(dd.length<2)return null;                /* one study has no start-to-finish */
var s=Infinity,e=-Infinity;
dd.forEach(function(x){var t=new Date(x.ts).getTime();if(isNaN(t))return;
var st=t-x.sec*1000;if(st<s)s=st;if(t>e)e=t;});
if(!isFinite(s)||!isFinite(e))return null;
var hs=hrOf(new Date(s)),he=hrOf(new Date(e));
if(he<hs)he+=24;                           /* ran past midnight: unwrap the span */
var fx=focusDay(dd),g=+(GOALMAP[dd[0].dRaw]||0);
var ivu=sumIvu(dd);
return{dt:dt,dy:(dd[0].day||''),st:hs,en:he,span:he-hs,n:dd.length,
ivu:Math.round(ivu*100)/100,drift:fx.idle+(fx.inIdle||0),act:fx.active,
goal:g,hit:g>0?(ivu>=g):null};}).filter(Boolean);}
/* Least-squares fit of y on x, plus Pearson r. null when there is too little
   spread in x to fit anything - a slope through three near-identical starts is
   noise wearing a number. */
function linfit(xs,ys){var n=xs.length,i;if(n<3)return null;
var mx=0,my=0;for(i=0;i<n;i++){mx+=xs[i];my+=ys[i];}mx/=n;my/=n;
var sxy=0,sxx=0,syy=0;
for(i=0;i<n;i++){var dx=xs[i]-mx,dy=ys[i]-my;sxy+=dx*dy;sxx+=dx*dx;syy+=dy*dy;}
if(sxx<1e-6)return null;                          /* no spread in x to fit against */
if(syy<1e-6)return{m:0,b:my,r:0,n:n,flat:true};   /* y never moves - a real finding, not a failure */
var m=sxy/sxx;return{m:m,b:my-m*mx,r:sxy/Math.sqrt(sxx*syy),n:n};}
function quant(arr,p){var s=arr.slice().sort(function(a,b){return a-b;});
var i=(s.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);
return s[lo]+(s[hi]-s[lo])*(i-lo);}
function cdh(dd){if(!dd.length)return{a:0,o:0};
var a=dd.reduce(function(s,d){return s+d.sec;},0);
var st=dd.map(function(d){var e=new Date(d.ts);return{s:new Date(e-d.sec*1e3),e:e};}).sort(function(x,y){return x.s-y.s;});
var G=18e5,o=0,ss=st[0].s,se=st[0].e;
for(var i=1;i<st.length;i++){if(st[i].s-se>=G){o+=(se-ss)/1e3;ss=st[i].s;se=st[i].e;}else{if(st[i].e>se)se=st[i].e;}}
o+=(se-ss)/1e3;return{a:a,o:Math.max(o,a)};}
/* ---- chart plumbing ---- */
Chart.defaults.color=MUT;Chart.defaults.borderColor=GRID;
Chart.defaults.font.family="system-ui,-apple-system,'Segoe UI',sans-serif";Chart.defaults.font.size=11;
Chart.defaults.maintainAspectRatio=false;
Chart.defaults.plugins.tooltip.backgroundColor='#1c1c3a';Chart.defaults.plugins.tooltip.borderColor='#37376b';
Chart.defaults.plugins.tooltip.borderWidth=1;Chart.defaults.plugins.tooltip.titleColor='#fff';
Chart.defaults.plugins.tooltip.bodyColor='#d5d5e8';Chart.defaults.plugins.tooltip.padding=10;
Chart.defaults.plugins.tooltip.cornerRadius=8;Chart.defaults.plugins.tooltip.displayColors=true;
Chart.defaults.plugins.tooltip.boxWidth=10;Chart.defaults.plugins.tooltip.boxHeight=2;
var LG={position:'bottom',labels:{padding:13,usePointStyle:true,pointStyle:'circle',boxWidth:7,font:{size:11}}};
var REG={};
function mk(id,cfg){var c=el(id);if(!c)return;if(REG[id])REG[id].destroy();
cfg.options=cfg.options||{};cfg.options.responsive=true;cfg.options.maintainAspectRatio=false;
if(!cfg.options.animation)cfg.options.animation={duration:520,easing:'easeOutQuart'};
REG[id]=new Chart(c,cfg);}
function ax(title){return{beginAtZero:true,grid:{color:GRID,drawTicks:false},border:{display:false},
title:title?{display:true,text:title,color:MUT,font:{size:10}}:undefined};}
function axX(){return{grid:{display:false},border:{display:false},ticks:{maxRotation:0,autoSkip:true}};}
var BAR={borderRadius:4,borderSkipped:'bottom',maxBarThickness:24};
var STACK={borderRadius:3,maxBarThickness:24,borderWidth:2,borderColor:SF};
/* ---- animated numbers ---- */
function countUp(node,to,dec,suffix){var from=0,t0=null,dur=650;
if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches){
node.textContent=to.toFixed(dec)+(suffix||'');return;}
function step(ts){if(!t0)t0=ts;var p=Math.min(1,(ts-t0)/dur),e=1-Math.pow(1-p,3);
node.textContent=(from+(to-from)*e).toFixed(dec)+(suffix||'');if(p<1)requestAnimationFrame(step);}
requestAnimationFrame(step);}
/* ---- state ---- */
var RANGE=0,V=D;
function applyRange(){if(!RANGE){V=D;return;}
var cut=ymd(new Date(Date.now()-RANGE*864e5));V=D.filter(function(d){return d.date>=cut;});
if(!V.length)V=D.slice(-1);}
/* =========================== RENDER =========================== */
function render(){
applyRange();
var dates=[].concat(Array.from(new Set(V.map(function(d){return d.date;})))).sort();
var DH={};dates.forEach(function(dt){var dd=V.filter(function(d){return d.date===dt;});var r=cdh(dd);
var fx=focusDay(dd);DH[dt]={a:r.a,o:r.o,n:dd.length,dy:dd[0].day,idle:fx.idle,
foc:fx.active>0?Math.round(fx.active/(fx.active+fx.idle)*100):100,
ivu:sumIvu(dd)};});
el('bDr').textContent=dates[0]+'  →  '+dates[dates.length-1]+'  ('+dates.length+' days)';
if(typeof TODAY_SHIFT!=='undefined'&&TODAY_SHIFT){el('bSh').style.display='';el('bShT').textContent=TODAY_SHIFT;}
var mods=['CR','CT','MR','US','PET'].filter(function(m){return V.some(function(d){return d.mod===m;});});
V.forEach(function(d){if(mods.indexOf(d.mod)<0&&d.mod)mods.push(d.mod);});
/* ---------- shift aggregates ---------- */
var BK={},SH={},shArr=[],modRows=[];
var hasShift=V.some(function(d){return d.shift;});
if(hasShift){
V.forEach(function(d){if(!d.shift)return;var k=d.dRaw+'|'+d.shift;
if(!BK[k]){var hrs=0,on=false;
if(HASSH&&SHIFTS[d.dRaw])dayPlan(SHIFTS[d.dRaw])[0].forEach(function(p){if(p.name===d.shift){if(p.w)hrs=p.e-p.s;on=p.on;}});
BK[k]={shift:d.shift,date:d.dRaw,ivu:0,n:0,sec:0,hrs:hrs,on:on,mods:new Set()};}
BK[k].ivu+=d.ivu;BK[k].n++;BK[k].sec+=d.sec;
if(d.extras)d.extras.split(' + ').forEach(function(m){BK[k].mods.add(m);});});
Object.values(BK).forEach(function(b){var s=b.shift;
if(!SH[s])SH[s]={blocks:0,n:0,ivu:0,sec:0,hrsSum:0,hrsCnt:0,on:b.on};
SH[s].blocks++;SH[s].n+=b.n;SH[s].ivu+=b.ivu;SH[s].sec+=b.sec;
if(b.hrs>0){SH[s].hrsSum+=b.hrs;SH[s].hrsCnt++;}if(b.on)SH[s].on=true;});
shArr=Object.keys(SH).map(function(k){var s=SH[k],hrs=s.hrsCnt?s.hrsSum/s.hrsCnt:0,ipb=s.ivu/s.blocks;
return{name:k,blocks:s.blocks,n:s.n,npb:Math.round(s.n/s.blocks*10)/10,ivu:Math.round(s.ivu*10)/10,
ipb:Math.round(ipb*10)/10,iph:hrs>0?Math.round(ipb/hrs*10)/10:0,hrs:Math.round(hrs*10)/10,on:s.on};})
.sort(function(a,b){return b.ipb-a.ipb;});
var modAgg={};
Object.values(BK).forEach(function(b){var bases=new Set(Array.from(b.mods).map(modBase));
var all=new Set(Object.values(BK).filter(function(x){return x.shift===b.shift;})
.flatMap(function(x){return Array.from(x.mods).map(modBase);}));
all.forEach(function(m){if(!modAgg[m])modAgg[m]={};
if(!modAgg[m][b.shift])modAgg[m][b.shift]={w:[0,0],o:[0,0]};
var t=bases.has(m)?modAgg[m][b.shift].w:modAgg[m][b.shift].o;t[0]++;t[1]+=b.ivu;});});
Object.keys(modAgg).forEach(function(m){var bw=0,iw=0,bo=0,io=0,wsum=0,dsum=0;
Object.values(modAgg[m]).forEach(function(sh){if(sh.w[0]>=1&&sh.o[0]>=1){
bw+=sh.w[0];iw+=sh.w[1];bo+=sh.o[0];io+=sh.o[1];
var wgt=Math.min(sh.w[0],sh.o[0]);wsum+=wgt;dsum+=wgt*((sh.w[1]/sh.w[0])/(sh.o[1]/sh.o[0])-1);}});
if(bw>=2&&bo>=2)modRows.push({m:m,bw:bw,iw:Math.round(iw/bw*10)/10,io:Math.round(io/bo*10)/10,d:Math.round(dsum/wsum*100)});});
modRows.sort(function(a,b){return Math.abs(b.d)-Math.abs(a.d);});}
renderToday(DH,shArr,BK,modRows);
renderFocus(dates,DH);
renderRhythm(dates);
renderBank(dates,DH);
renderShifts(dates,DH,hasShift,BK,SH,shArr,modRows,mods);
renderExams(mods);
renderLog(dates,DH,mods);}
/* ---------------- TODAY ---------------- */
function renderToday(DH,shArr,BK,modRows){
var tr=V.filter(function(d){return d.date===TODAY;});
var tN=tr.length,tSec=tr.reduce(function(a,d){return a+d.sec;},0),tAvg=tN?Math.round(tSec/tN):0;
var tI=sumIvu(tr);
var dh=DH[TODAY]||{a:0,o:0};var eff=dh.o>0?Math.round(dh.a/dh.o*100):0;
var paceH=dh.a>0?Math.round(tI/(dh.a/3600)*10)/10:0;
var fx=focusDay(tr),idleM=Math.round(fx.idle/60);
var foc=fx.active>0?Math.round(fx.active/(fx.active+fx.idle)*100):100;
var reclaim=fx.active>0?Math.round(fx.idle/fx.active*tI*10)/10:0;
var extraN=tAvg>0?Math.round(fx.idle/tAvg):0;
var typMap={};shArr.forEach(function(s){typMap[s.name]={ipb:s.ipb,d:s.blocks};});
var modD={};modRows.forEach(function(r){modD[r.m]=r.d/100;});
var proj=0,haveProj=false,blocks=[];
if(HASSH&&HASCLS&&SHIFTS[TRAW]){var pm=dayPlan(SHIFTS[TRAW]),P=pm[0],M=pm[1];
P.forEach(function(p){var st=typMap[p.name],eI=(st&&st.d>=2)?st.ipb:0;if(st&&st.d>=2)haveProj=true;
M.forEach(function(m){var mb=modBase(m.name),ov=!m.w||!p.w||(m.s<p.e&&p.s<m.e);
if(ov&&modD[mb]!==undefined)eI*=(1+modD[mb]);});
proj+=eI;blocks.push((p.on?'★ ':'')+p.name);});}
proj=Math.round(proj*10)/10;
var target=GOAL>0?GOAL:(haveProj?proj:0);
var pct=target>0?Math.round(tI/target*100):0;
var curName=(typeof TODAY_SHIFT!=='undefined')?TODAY_SHIFT:'';
/* hero */
var R=52,C=2*Math.PI*R,off=C*(1-Math.min(1,target>0?tI/target:0));
var ringCol=pct>=100?GOODC:pct>=60?'#3987e5':WARNC;
var h='<div class="hero"><div class="heroTop"><span class="t">Today</span><span class="s">'+esc(TODAY)+
(curName?' · '+esc(curName):'')+'</span></div><div class="heroMain">';
if(target>0){h+='<svg class="ring" width="124" height="124" viewBox="0 0 124 124" aria-hidden="true">'+
'<circle cx="62" cy="62" r="52" fill="none" stroke="#0c0c1e" stroke-width="10"/>'+
'<circle cx="62" cy="62" r="52" fill="none" stroke="'+ringCol+'" stroke-width="10" stroke-linecap="round" '+
'stroke-dasharray="'+C.toFixed(1)+'" stroke-dashoffset="'+off.toFixed(1)+'" transform="rotate(-90 62 62)" '+
'style="transition:stroke-dashoffset .9s cubic-bezier(.22,1,.36,1)"/></svg>';}
h+='<div><div class="heroNum" id="heroN">0</div><div class="heroUnit">IVU today</div></div>';
if(target>0){h+='<div class="heroSide"><div class="meter"><i style="width:'+Math.min(100,pct)+'%;background:'+ringCol+'"></i></div>'+
'<div class="mrow"><span>'+pct+'% of '+(GOAL>0?'goal':'projected')+'</span><span>'+
Math.max(0,Math.round((target-tI)*10)/10)+' to go</span></div></div>';}
h+='</div></div>';
var hw=el('heroWrap');
/* machine-readable hooks so the headless harness can assert the focus math */
hw.setAttribute('data-idle',Math.round(fx.idle));
hw.setAttribute('data-gaps',fx.gc);
hw.setAttribute('data-reclaim',reclaim);
hw.setAttribute('data-inidle',Math.round(fx.inIdle||0));
hw.setAttribute('data-inmeas',Math.round(fx.inMeas||0));
hw.innerHTML=h;
if(el('heroN'))countUp(el('heroN'),Math.round(tI*10)/10,1,'');
/* tiles */
var idleCol=fx.idle>=600?CRITC:fx.idle>=180?WARNC:GOODC;
var g='';
function tile(lb,val,col,sub){return '<div class="cd"><div class="lb">'+esc(lb)+'</div><div class="vl" style="color:'+col+
'">'+esc(val)+'</div><div class="sb">'+(sub||'')+'</div></div>';}
g+=tile('Studies',tN,'#fff',tN?('avg <b>'+ft(tAvg)+'</b> each'):'none yet');
g+=tile('Active time',fh(dh.a),'#c98500',eff?('eff <b>'+eff+'%</b> · clock '+fh(dh.o)):'');
g+=tile('Pace',(paceH||'--'),'#3987e5','IVU per active hour');
/* Credits, not raw IVU: credit accrues in whole rungs, so this is the number
   the day actually pays out on. */
if(LAD){var cNow=credits(tI),cNxt=nextRung(tI);
g+=tile('Credits',cNow,cNow>0?GOODC:MUT,r1(LAD.s)+' IVU = 1 credit = 1h'+
(cNxt>tI?' &middot; <b>'+r1(cNxt-tI)+'</b> to next':''));}
g+=tile('Idle time',idleM+'m',idleCol,fx.gc?('<b>'+fx.gc+'</b> gap'+(fx.gc==1?'':'s')+' · focus <b>'+foc+'%</b>'):'no gaps');
/* Where today's IVU came from. A number matched out of the report's prose is
   a guess; PowerScribe's own figure for the procedure code is not. The two
   used to be indistinguishable once written to the log, which is how the
   totals drifted from PowerScribe's without anyone being able to say where.
   Shown only once rows actually carry a source - it is silent on old data
   rather than reporting 0% and implying something is wrong. */
var srcKnown=tr.filter(function(d){return d.src;}).length;
if(srcKnown>0){var firmN=tr.filter(function(d){return d.firm;}).length,
firmPct=Math.round(firmN/srcKnown*100);
g+=tile('IVU from source',firmN+' of '+srcKnown,
firmPct>=80?GOODC:firmPct>=40?WARNC:CRITC,
'PowerScribe or an exact code · rest matched on text');}
/* Measured in-study inactivity - only shown once rows carry ActiveSec */
if(fx.inMeas>0){var im=Math.round(fx.inIdle/60);
var trueFoc=Math.round((fx.inMeas-fx.inIdle)/fx.inMeas*100);
g+=tile('Drifted off',im+'m',fx.inIdle>=600?CRITC:fx.inIdle>=180?WARNC:GOODC,
'inside studies · hands-on <b>'+trueFoc+'%</b>');}
/* Cost covers BOTH kinds of drift: gaps BETWEEN studies and dead time INSIDE
   them. Pricing only the between-study gaps hid the cost entirely on days
   where the drifting happened mid-study. */
var driftSec=fx.idle+(fx.inIdle||0);
if(RATE>0&&driftSec>0)
g+=tile('Cost of drifting',moneyFor(driftSec),CRITC,
Math.round(driftSec/60)+'m lost today, at your rate');
el('tGrid').innerHTML=g;
/* flow + alert */
if(fx.segs.length){el('bxTFlow').style.display='';el('tFlow').innerHTML=flowStrip(fx.segs);
el('tAlert').innerHTML=fx.idle>=180
?'<div class="alert">⚡ <b>'+idleM+'m</b> lost to '+fx.gc+' idle gap'+(fx.gc==1?'':'s')+' — about <b>'+
reclaim+' IVU</b>'+(extraN>0?' (≈'+extraN+' more '+(extraN==1?'study':'studies')+')':'')+
' left on the table'+(RATE>0?', <b>'+moneyFor(fx.idle)+'</b> of your time':'')+
'. Batch your reads to claw it back.</div>'
:(tN>=3?'<div class="good">✓ Tight focus — only '+idleM+'m idle today. Keep stacking reads back to back.</div>':'');}
else{el('bxTFlow').style.display='none';}
renderFiller(driftSec,tI);
/* notes */
var others=Object.keys(DH).filter(function(x){return x!==TODAY;}).map(function(x){return DH[x].ivu;}).filter(function(v){return v>0;});
var avgDay=others.length?others.reduce(function(a,b){return a+b;},0)/others.length:0;
var vsAvg=avgDay>0?Math.round((tI/avgDay-1)*100):0;
var notes=[];
if(curName){var bk=Object.values(BK).find(function(b){return b.date===TRAW&&b.shift===curName;});
var soFar=bk?Math.round(bk.ivu*10)/10:0,st=typMap[curName];
notes.push(st&&st.d>=2
?'<b>'+esc(curName)+'</b>: '+soFar+' IVU so far vs '+st.ipb+' typical ('+(st.ipb>0?Math.round(soFar/st.ipb*100):0)+'%)'
:'<b>'+esc(curName)+'</b>'+(soFar>0?': '+soFar+' IVU so far':''));}
if(avgDay>0&&tN)notes.push('Today’s '+Math.round(tI*10)/10+' IVU is <span class="'+(vsAvg>=0?'hi':'lo')+'">'+
(vsAvg>0?'+':'')+vsAvg+'%</span> vs your '+Math.round(avgDay*10)/10+' average day.');
if(blocks.length)notes.push('Scheduled: '+esc(blocks.join('  +  '))+(haveProj?(' · projected ~'+proj+' IVU'):''));
var mm={};tr.forEach(function(d){mm[d.mod]=(mm[d.mod]||0)+1;});
var chips=Object.keys(mm).map(function(m){return '<span class="mb '+esc(m)+'">'+esc(m)+' '+mm[m]+'</span>';}).join('');
el('tNotes').innerHTML=(notes.length||chips)
?'<div class="bx">'+(notes.length?'<ul class="ins">'+notes.map(function(n){return '<li>'+n+'</li>';}).join('')+'</ul>':'')+
(chips?'<div class="chips">'+chips+'</div>':'')+'</div>'
:(tN?'':'<div class="bx"><div class="empty">No studies signed yet today.</div></div>');}
/* ---- filler math ----
   Two questions, both answered in whole studies rather than in IVU:
     1. how many did the drifting cost me
     2. how many more to land on my number
   Deliberately counts studies and not minutes: the point is never to read a
   study faster, it is to not lose the hour between studies. */
function fq(cls,n,txt,sub){return '<div class="fq '+cls+'"><div class="qn">'+n+'</div><div><div class="qt">'+txt+
'</div><div class="qs">'+sub+'</div></div></div>';}
/* What landing on `target` is worth over where you stand now. A credit IS an
   hour, so pricing it keeps to the same rule as the rest of the app: dollars
   attach to time, never to a study. */
function credTail(target,now){
if(!LAD)return '';
var gain=credits(target)-credits(now);
if(gain<=0)return '';
return ' <span class="cred">+'+nCred(gain)+(RATE>0?', '+usd(gain*RATE):'')+'</span>';}
function renderFiller(driftSec,tI){
var box=el('bxFill');if(!box)return;
if(!FSTAT){box.style.display='none';return;}
box.style.display='';
var one=esc(FSTAT.name),many=one+'s';
el('fillH').textContent=FSTAT.name.charAt(0).toUpperCase()+FSTAT.name.slice(1)+'s, as a unit';
el('fillD').innerHTML=FSTAT.n>0
?'Calibrated from the <b>'+FSTAT.n+'</b> in your log: <b>'+FSTAT.ivu+' IVU</b> each'+
(FSTAT.sec>0?', <b>'+ft(Math.round(FSTAT.sec))+'</b> of engaged time each':'')+'.'
:'None in your log yet, so this uses the IVU table value of <b>'+FSTAT.ivu+'</b> each.';
var g='',lostN=0,need=0;
/* 1. what the drifting cost, in whole studies */
if(FSTAT.sec>0&&driftSec>0){
var lost=driftSec/FSTAT.sec;lostN=Math.floor(lost);
g+=fq(lostN>=1?'dn':'nu',lost>=10?Math.round(lost):(lost>=1?lostN:r1(lost)),
'<b>'+(lostN===1?one:many)+'</b> went into drifting instead',
Math.round(driftSec/60)+'m adrift today &divide; '+ft(Math.round(FSTAT.sec))+' each'+
(RATE>0?' &middot; '+moneyFor(driftSec):''));}
/* 2. what is left between here and the number still in play */
var short=GOAL>0?GOAL-tI:0,aim='',aimAt=0;
if(GOAL>0&&short>0){aim='your goal';aimAt=GOAL;need=Math.ceil(short/FSTAT.ivu);
g+=fq('nu',need,'more to hit <b>'+r1(GOAL)+'</b>'+credTail(GOAL,tI),
r1(short)+' IVU short &middot; '+FSTAT.ivu+' IVU each');}
else{
/* Past the goal (or never set one). The next rung is the whole answer to
   "I hit my number, why keep going" - without it the goal is just a ceiling. */
var rung=nextRung(GOAL>0?Math.max(GOAL,tI):tI);
if(GOAL>0)g+=fq('up','&#10003;','<b>'+r1(GOAL)+'</b> is done, '+r1(tI-GOAL)+' IVU past it',
'goal cleared'+(credits(tI)>0?' &middot; '+nCred(credits(tI))+' banked':''));
if(rung>tI){aim='the next rung';aimAt=rung;need=Math.ceil((rung-tI)/FSTAT.ivu);
g+=fq('nu',need,'more to reach <b>'+r1(rung)+'</b>'+credTail(rung,tI),
r1(rung-tI)+' IVU to go'+(GOAL>0?'':' &middot; no goal set today'));}}
el('fillGrid').innerHTML=g;
/* The sentence that ties the two together - drifting stops being abstract once
   it is measured against the gap you still have to close. */
var note='';
if(lostN>0&&need>0)note=lostN>=need
?'The drifting alone was worth more than the whole gap to '+aim+': <b>'+need+'</b> to go, '+
'and <b class="lo">'+lostN+'</b> already let go.'
:'You are <b>'+need+'</b> off '+aim+' at <b>'+r1(aimAt)+'</b>, and <b class="lo">'+lostN+
'</b> of that went to drifting.'+(lostN*3>=need?' Close the gaps and you are most of the way there.':'');
else if(lostN>0)note='Nothing left to chase today &mdash; but that is still <b class="lo">'+lostN+'</b> '+
(lostN===1?one:many)+' of reading that went nowhere.';
el('fillNote').innerHTML=note;}
/* ---------------- FOCUS ---------------- */
function renderFocus(dates,DH){
var wd=dates.filter(function(dt){return DH[dt].n>0;});
if(!wd.length)return;
var per=wd.map(function(dt){return{dt:dt,idle:DH[dt].idle,foc:DH[dt].foc,ivu:DH[dt].ivu,
fx:focusDay(V.filter(function(x){return x.date===dt;}))};});
var tIdle=per.reduce(function(a,d){return a+d.idle;},0);
var tAct=per.reduce(function(a,d){return a+d.fx.active;},0);
var tIvu=per.reduce(function(a,d){return a+d.ivu;},0);
var reclaimAll=tAct>0?tIdle/tAct*tIvu:0;
var weeks=Math.max(1,wd.length/5),wkReclaim=reclaimAll/weeks;
var avgFoc=Math.round(per.reduce(function(a,d){return a+d.foc;},0)/per.length);
/* streaks */
var best=per.filter(function(d){return d.fx.active>=1800;}).sort(function(a,b){return b.foc-a.foc;})[0];
var clean=per.filter(function(d){return d.idle<300;}).length;
var run=0,bestRun=0;per.forEach(function(d){if(d.foc>=avgFoc){run++;if(run>bestRun)bestRun=run;}else run=0;});
var s='';
function stk(e,n,l){return '<div class="stk"><div class="e">'+e+'</div><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>';}
s+=stk('🎯',avgFoc+'%','avg focus');
s+=stk('✨',clean,'clean days');
s+=stk('🔥',bestRun,'best streak');
if(best)s+=stk('🏆',best.foc+'%','best day '+best.dt.slice(5));
el('fStreaks').innerHTML=s;
/* ---- Par: only counts studies that actually carried a bet ---- */
var bets=V.filter(function(d){return d.par>0&&d.act>=0;});
if(bets.length){
el('bxPar').style.display='';
var wins=bets.filter(function(d){return d.act<=d.par;}).length;
var wr=Math.round(wins/bets.length*100);
var cur=0,bestRun=0;
bets.forEach(function(d){if(d.act<=d.par){cur++;if(cur>bestRun)bestRun=cur;}else cur=0;});
el('parSum').innerHTML='<b>'+wins+'</b> of <b>'+bets.length+'</b> studies came in under par '+
'(<span class="'+(wr>=50?'hi':'lo')+'">'+wr+'%</span>). Best run: <b class="hi">'+bestRun+
'</b> in a row &middot; current run: <b>'+cur+'</b>.';
var pm={};
bets.forEach(function(d){var k=d.exam||'(unknown)';
if(!pm[k])pm[k]={n:0,w:0,d:[]};
pm[k].n++;if(d.act<=d.par)pm[k].w++;pm[k].d.push(d.act-d.par);});
var prow=Object.keys(pm).map(function(k){var m=pm[k];
var sorted=m.d.slice().sort(function(a,b){return a-b;});
var mid=sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
return{name:k,n:m.n,w:m.w,wr:Math.round(m.w/m.n*100),med:Math.round(mid)};})
.filter(function(r){return r.n>=3;}).sort(function(a,b){return b.n-a.n;});
var pb='';
prow.forEach(function(r){
var cls=r.wr>=50?'up':'dn';
var sign=r.med<=0?'-':'+';
pb+='<tr><td>'+esc(r.name)+'</td><td>'+r.n+'</td><td>'+r.w+'</td><td class="'+cls+
'" style="font-weight:650">'+r.wr+'%</td><td class="'+(r.med<=0?'up':'dn')+'">'+sign+ft(Math.abs(r.med))+'</td></tr>';});
document.querySelector('#tPar tbody').innerHTML=pb||
'<tr><td colspan="5" class="nt" style="text-align:center;padding:18px">Need 3+ bets on an exam type</td></tr>';
}else{el('bxPar').style.display='none';}
var tInIdle=per.reduce(function(a,d){return a+(d.fx.inIdle||0);},0);
var tInMeas=per.reduce(function(a,d){return a+(d.fx.inMeas||0);},0);
var halfHrsWk=(tIdle/2)/Math.max(1,wd.length/5)/3600;
var head='Across <b>'+wd.length+'</b> worked days you lost <b class="lo">'+(Math.round(tIdle/360)/10)+
'h</b> to idle gaps — roughly <b class="tot">'+Math.round(reclaimAll)+' IVU</b> of reading at your own pace'+
(RATE>0?', or <b class="tot">'+moneyFor(tIdle)+'</b> of your time':'')+'.<br>'+
'Halving those gaps is about <b class="hi">+'+(Math.round(wkReclaim/2*10)/10)+' IVU per week</b>'+
(RATE>0?' — <b class="hi">'+(Math.round(halfHrsWk*10)/10)+'h</b> back, worth <b class="hi">'+usd(halfHrsWk*RATE)+'</b> a week':'')+'.';
if(tInMeas>0){var hands=Math.round((tInMeas-tInIdle)/tInMeas*100);
head+='<br><br>On top of that, <b class="lo">'+(Math.round(tInIdle/360)/10)+'h</b> passed <i>inside</i> studies with '+
'no keyboard or mouse at all — the clock was running but you weren’t'+
(RATE>0?' ('+moneyFor(tInIdle)+')':'')+'. Hands-on for <b>'+hands+'%</b> of measured study time.';}
if(FSTAT&&FSTAT.sec>0){var wkN=Math.round((tIdle+tInIdle)/Math.max(1,wd.length/5)/FSTAT.sec);
if(wkN>0)head+='<br><br>In your own currency, that is about <b class="lo">'+wkN+'</b> '+
esc(FSTAT.name)+(wkN===1?'':'s')+' a week you never got to read.';}
/* ---- Daily goal consistency ----
   Measures three things, because any two of them can lie on their own:
     1. did you clear the line
     2. how far past it did you go   (a goal quietly becomes a ceiling)
     3. HOW BIG WAS THE LINE
   A percentage with no magnitude behind it inverts the ranking: 90% of a 25
   IVU goal is 22.5 IVU, while 60% of a 100 IVU goal is 60. The first looks
   better and is less than half the work. So the chart plots absolute IVU
   against the goal marker on ONE axis, and the headline number is the
   volume-weighted aggregate, not the mean of the percentages. ---- */
(function(){
var gd=[];
Object.keys(GOALMAP).forEach(function(k){
var g=+GOALMAP[k];if(!(g>0))return;
var p=k.split('/');if(p.length<3)return;
var iso=p[2]+'-'+String(p[0]).padStart(2,'0')+'-'+String(p[1]).padStart(2,'0');
if(!DH[iso])return;                       /* no studies logged that day */
gd.push({iso:iso,goal:g,got:DH[iso].ivu,pct:Math.round(DH[iso].ivu/g*100)});});
gd.sort(function(a,b){return a.iso<b.iso?-1:1;});
if(!gd.length){el('bxGoal').style.display='none';return;}
el('bxGoal').style.display='';
var hit=gd.filter(function(d){return d.got>=d.goal;}).length;
var rate=Math.round(hit/gd.length*100);
var cur=0,best=0;
gd.forEach(function(d){if(d.got>=d.goal){cur++;if(cur>best)best=cur;}else cur=0;});
var avgPct=Math.round(gd.reduce(function(a,d){return a+d.pct;},0)/gd.length);
var coast=gd.filter(function(d){return d.pct>=100&&d.pct<=105;}).length;
/* Volume-weighted: total delivered over total committed. Immune to a small
   goal inflating the average, which the mean of percentages is not. */
var sumGot=gd.reduce(function(a,d){return a+d.got;},0);
var sumGoal=gd.reduce(function(a,d){return a+d.goal;},0);
var aggPct=sumGoal>0?Math.round(sumGot/sumGoal*100):0;
/* How ambitious the line itself is, against a normal worked day. A goal that
   sits below your median day is a soft goal however often you clear it. */
var allDay=Object.keys(DH).map(function(k){return DH[k].ivu;}).filter(function(v){return v>0;});
/* Needs a few days to mean anything - with two, "typical" is drawn from the
   same days being judged and the comparison is circular. */
var typDay=allDay.length>=5?med(allDay):0;
var medGoal=med(gd.map(function(d){return d.goal;}));
var amb=typDay>0?Math.round(medGoal/typDay*100):0;
var gs='';
gs+=stk('🎯',rate+'%','goals hit');
gs+=stk('⚖',aggPct+'%','delivered vs committed');
gs+=stk('📈',avgPct+'%','average finish');
gs+=stk('📏',(amb||'--')+'%','goal vs typical day');
gs+=stk('🏅',best,'best streak');
el('goalStk').innerHTML=gs;
/* The note has to be able to say "you cleared it often and it did not amount
   to much", which is exactly what a hit rate alone cannot say. */
var note='You set a goal on <b>'+gd.length+'</b> day'+(gd.length==1?'':'s')+', cleared it on <b class="hi">'+
hit+'</b>, and delivered <b>'+r1(sumGot)+'</b> IVU against <b>'+r1(sumGoal)+'</b> committed '+
'(<b'+(aggPct>=100?' class="hi"':'')+'>'+aggPct+'%</b>).';
if(aggPct>avgPct+5)note+=' Your big-goal days are carrying the weight: the volume-weighted number beats '+
'the plain average of <b>'+avgPct+'%</b>, which means you deliver more when the line is set higher.';
else if(avgPct>aggPct+5)note+=' Careful &mdash; the plain average (<b>'+avgPct+'%</b>) flatters you against '+
'the volume-weighted <b>'+aggPct+'%</b>: the small-goal days pull the percentage up while the big '+
'ones fall short. The bigger day is more work even when it scores worse.';
if(amb>0&&amb<95)note+=' Your median goal is <b class="lo">'+medGoal+'</b> IVU against a typical day of <b>'+
r1(typDay)+'</b> &mdash; the bar is set below a normal day, so clearing it is not the same as a good day.';
else if(amb>=110)note+=' Your median goal of <b class="hi">'+medGoal+'</b> IVU sits well above a typical '+
r1(typDay)+' day. These are real commitments.';
if(coast>0)note+=' On <b class="lo">'+coast+'</b> day'+(coast==1?'':'s')+' you stopped within 5% of the line '+
'&mdash; the goal became the ceiling.';
el('goalNote').innerHTML=note;
/* Bars are what you actually delivered, in IVU. The dash is that day's goal.
   One axis, both facts, and the percentage is readable as the gap between
   them - a tall bar that misses is visibly more work than a short one that
   clears. Outcome rides on the tick label, never the bar fill: green vs red
   is 4.1 deltaE apart under deuteranopia. */
mk('chGoal',{type:'bar',data:{
labels:gd.map(function(d){return (d.got>=d.goal?'✓ ':'✗ ')+d.iso.slice(5);}),
datasets:[
{label:'IVU finished',data:gd.map(function(d){return r1(d.got);}),
backgroundColor:SPAL[0],...BAR,order:2},
{label:'Goal',type:'line',data:gd.map(function(d){return r1(d.goal);}),
showLine:false,pointStyle:'line',pointRadius:12,pointHoverRadius:14,
pointBorderColor:MUT,pointBorderWidth:2,order:1}]},
options:{plugins:{legend:{position:'bottom',
labels:{padding:13,usePointStyle:true,boxWidth:14,font:{size:11}}},
tooltip:{callbacks:{label:function(c){
var d=gd[c.dataIndex];
return c.datasetIndex===0
?('finished '+r1(d.got)+' IVU  ('+d.pct+'% of goal)')
:('goal '+r1(d.goal)+' IVU');}}}},
scales:{y:ax('IVU'),
x:{grid:{display:false},border:{display:false},
ticks:{maxRotation:0,autoSkip:true,color:function(c){var d=gd[c.index];
return !d?MUT:(d.got>=d.goal?GOODC:CRITC);}}}}}});
el('tvGoal').innerHTML=tbl(['Date','Goal','Finished','% of goal','vs typical day'],
gd.map(function(d){return[d.iso,r1(d.goal),r1(d.got),d.pct+'%',
typDay>0?(Math.round(d.got/typDay*100)+'%'):'--'];}));
})();
el('fHead').innerHTML=head;
/* Lead the tab with the number, not a sentence containing the number. */
if(RATE>0&&tIdle>0){
var wkCost=(tIdle/Math.max(1,wd.length/5))/3600*RATE;
el('costBanner').style.display='';
el('costBanner').innerHTML=
'<div><div class="big">'+moneyFor(tIdle+tInIdle)+'</div><div class="cap">cost of drifting</div></div>'+
'<div class="side">Across <b>'+wd.length+'</b> worked days: <b>'+(Math.round(tIdle/360)/10)+'h</b> in gaps between studies'+
(tInMeas>0?' and <b>'+(Math.round(tInIdle/360)/10)+'h</b> parked inside them':'')+'.<br>'+
'That is <b>'+usd(wkCost)+'</b> a week &mdash; halve it and you keep <span class="win">'+usd(wkCost/2)+' a week</span>.</div>';
}else{el('costBanner').style.display='none';}
/* strips */
var recent=per.slice(-14),sh='';
recent.forEach(function(d){var im=Math.round(d.idle/60);
var col=d.idle>=1200?CRITC:d.idle>=300?WARNC:GOODC;
sh+='<div class="fRow"><div class="fDt">'+esc(d.dt.slice(5))+'</div><div class="fId" style="color:'+col+'">'+im+'m</div>'+
flowStrip(d.fx.segs)+'</div>';});
el('fStrips').innerHTML=sh;
var L=per.map(function(d){return d.dt.slice(5);});
mk('chIdle',{type:'bar',data:{labels:L,datasets:[{label:'Idle min',data:per.map(function(d){return Math.round(d.idle/60);}),
backgroundColor:CRITC,...BAR}]},options:{plugins:{legend:{display:false}},scales:{y:ax('minutes'),x:axX()}}});
el('tvIdle').innerHTML=tbl(['Date','Idle min','Gaps'],per.map(function(d){return[d.dt,Math.round(d.idle/60),d.fx.gc];}));
mk('chFoc',{type:'line',data:{labels:L,datasets:[{label:'Focus %',data:per.map(function(d){return d.foc;}),
borderColor:GOODC,backgroundColor:'rgba(12,163,12,.10)',fill:true,tension:.3,borderWidth:2,
pointRadius:0,pointHoverRadius:5,pointHitRadius:24}]},
options:{plugins:{legend:{display:false}},scales:{y:Object.assign(ax('%'),{max:100}),x:axX()},
interaction:{mode:'index',intersect:false}}});
el('tvFoc').innerHTML=tbl(['Date','Focus %'],per.map(function(d){return[d.dt,d.foc+'%'];}));
/* tax */
var flowS=[],gapS=[];
wd.forEach(function(dt){var r=V.filter(function(x){return x.date===dt;}).map(function(d){var e=new Date(d.ts).getTime();
return{st:e-d.sec*1000,en:e,sec:d.sec};}).filter(function(x){return x.en>0;}).sort(function(a,b){return a.st-b.st;});
for(var i=1;i<r.length;i++){var gap=(r[i].st-r[i-1].en)/1000;if(gap<0)gap=0;
if(gap<=FMICRO)flowS.push(r[i].sec);else if(gap>300&&gap<FBREAK)gapS.push(r[i].sec);}});
var fAvg=flowS.length?flowS.reduce(function(a,b){return a+b;},0)/flowS.length:0;
var gAvg=gapS.length?gapS.reduce(function(a,b){return a+b;},0)/gapS.length:0;
var tx='';
if(flowS.length>=10&&gapS.length>=10){var tp=Math.round((gAvg/fAvg-1)*100);
tx+=tp>=5?'<div>Studies picked up <b>right after a break</b> take <b class="lo">'+tp+'% longer</b> ('+
ft(Math.round(gAvg))+' vs '+ft(Math.round(fAvg))+' in flow). Every interruption charges you a restart fee.</div>'
:tp<=-5?'<div>Your post-break reads run <b class="hi">'+Math.abs(tp)+'% faster</b> — gaps aren’t costing restart time.</div>'
:'<div>Post-break reads take about the same as in-flow reads ('+ft(Math.round(gAvg))+' vs '+ft(Math.round(fAvg))+').</div>';}
if(best)tx+='<div style="margin-top:9px">Your most focused solid day was <b>'+esc(best.dt.slice(5))+
'</b> at <b class="hi">'+best.foc+'% focus</b>. That’s the bar to beat.</div>';
tx+='<div style="margin-top:9px">Typical day: <b>'+avgFoc+'% focus</b>, <b>'+Math.round(tIdle/wd.length/60)+
'm idle</b>. Shrink the red.</div>';
el('fTax').innerHTML=tx||'<div class="empty">Not enough paired reads yet to measure the tax.</div>';}
/* ---------------- RHYTHM ----------------
   The question this tab exists to answer: is the length of the day fixed (start
   earlier, finish earlier) or is the FINISH fixed (start earlier, read more)?
   The two imply opposite things about what an early start is worth, and only the
   data can say which one you are. Everything here is associational - the day's
   workload is not held constant - so the copy says "tracks", never "causes". */
var RIB_MAX=24;
function renderRhythm(dates){
var DS=dayShape(dates);
if(DS.length<5){el('rhEmpty').style.display='';el('rhBody').style.display='none';return;}
el('rhEmpty').style.display='none';el('rhBody').style.display='';
var starts=DS.map(function(d){return d.st;}),ends=DS.map(function(d){return d.en;});
var spans=DS.map(function(d){return d.span;});
var mS=med(starts),mE=med(ends),mSpan=med(spans);
var iqrE=quant(ends,0.75)-quant(ends,0.25);
/* ---- your clock ---- */
function stk2(e,n,l){return '<div class="stk"><div class="e">'+e+'</div><div class="n">'+esc(n)+
'</div><div class="l">'+esc(l)+'</div></div>';}
el('rhStk').innerHTML=stk2('🌅',hhmm(mS),'median start')+
stk2('🌆',hhmm(mE),'median finish')+
stk2('⏱',fh(mSpan*3600),'median day')+
stk2('🎯',Math.round(iqrE*60)+'m','finish spread');
/* ---- the fit ---- */
var fit=linfit(starts,ends),line=[];
if(fit){var x0=Math.min.apply(null,starts),x1=Math.max.apply(null,starts);
line=[{x:x0,y:fit.b+fit.m*x0},{x:x1,y:fit.b+fit.m*x1}];}
var hourAx=function(t){var o=ax(t);o.beginAtZero=false;
o.ticks={callback:function(v){return hhmm(v);}};return o;};
mk('chRhFit',{type:'scatter',data:{datasets:[
{label:'Worked day',data:DS.map(function(d){return{x:d.st,y:d.en};}),
backgroundColor:SPAL[0],borderColor:SF,borderWidth:2,pointRadius:6,pointHoverRadius:10,
pointHitRadius:14,order:1},
{label:'Fitted trend',type:'line',data:line,borderColor:MUT,borderWidth:2,borderDash:[5,4],
pointRadius:0,pointHitRadius:0,fill:false,showLine:true,pointStyle:'line',order:2}]},
/* LG forces a circle swatch on every entry; here the trend must read as a
   dashed LINE, so this legend leaves pointStyle to the datasets. */
options:{plugins:{legend:{position:'bottom',
labels:{padding:13,usePointStyle:true,boxWidth:14,font:{size:11}}},
tooltip:{callbacks:{label:function(c){
if(c.datasetIndex!==0)return 'fitted trend';
var d=DS[c.dataIndex];
return d.dt.slice(5)+'  '+hhmm(d.st)+' → '+hhmm(d.en)+'  ('+fh(d.span*3600)+', '+d.ivu+' IVU)';}}}},
scales:{x:hourAx('first study opens'),y:hourAx('last study signed')}}});
el('tvRhFit').innerHTML=tbl(['Date','Day','Start','Finish','Length','Studies','IVU'],
DS.slice().reverse().map(function(d){return [d.dt,d.dy,hhmm(d.st),hhmm(d.en),
fh(d.span*3600),d.n,d.ivu];}));
/* ---- the verdict ----
   Slope is hours of finish per hour of start. ~1 means the day has a fixed
   LENGTH; ~0 means it has a fixed END. Those two conclusions point opposite
   directions, which is the whole reason to measure it rather than assume. */
/* A slope near 0 is NOT "no result" - it is the fixed-end result, and reporting
   it as noise would bury the more interesting of the two findings. The only
   genuine no-result cases are too few days, or starts with no spread to fit
   against. Those are separated out first. */
var iqrS=quant(starts,0.75)-quant(starts,0.25);
var v='';
if(DS.length<8)
v='<b>Too few days to call it</b> — '+DS.length+' so far, and this wants 8 or more. '+
'For now: median start <b>'+hhmm(mS)+'</b>, median finish <b>'+hhmm(mE)+'</b>.';
else if(!fit||iqrS<0.5)
v='<b>Your starts barely vary.</b> The middle half of your days begin within <b>'+
Math.round(iqrS*60)+'m</b> of each other, so there is no spread to read a trend from. '+
'That is its own answer, though: your start time is already the consistent part.';
else{
var perHr=Math.round(fit.m*60),r2=Math.round(fit.r*fit.r*100);
if(fit.m>=0.7&&r2>=25)
v='<b>Your day has a fixed length, not a fixed end.</b> Each hour earlier you start, you finish about '+
'<b class="hi">'+perHr+'m earlier</b> — the start time carries almost straight through. '+
'Starting early buys you the evening.';
else if(Math.abs(fit.m)<=0.3)
v='<b>Your day has a fixed end, not a fixed length.</b> You finish near <b>'+hhmm(mE)+
'</b> — the middle half of your days land within <b>'+Math.round(iqrE*60)+'m</b> of each other — '+
'almost regardless of when you start; it moves only about '+Math.abs(perHr)+'m per hour. '+
'So starting an hour earlier does not get you out earlier, it buys you '+
'<b class="hi">an extra hour of reading</b>. Worth doing on purpose rather than by accident.';
else if(r2>=16)
v='<b>Partly both.</b> An hour earlier start moves your finish about <b>'+perHr+'m</b> earlier, '+
'so roughly '+Math.round((1-fit.m)*60)+'m of it turns into extra reading instead of an earlier evening.';
else
v='<b>Weak and in between.</b> The trend says '+perHr+'m of finish per hour of start, but it explains '+
'only '+r2+'% of the variation — your day length is being set by the workload, not the clock.';
v+=' <span class="nt">'+DS.length+' days, r² '+r2+'%.</span>';}
el('rhVerdict').innerHTML=v;
/* ---- the ribbon: where each day sat on the clock ---- */
var rib=DS.slice(-RIB_MAX).reverse();
el('rhRibD').innerHTML='First study open to last study signed, most recent day at the top.'+
(DS.length>RIB_MAX?' Showing the latest <b>'+RIB_MAX+'</b> of '+DS.length+' worked days.':'');
/* Goal outcome rides on the axis LABEL, not the bar fill. Colouring hit/miss
   green vs red would put the two states 4.1 deltaE apart under deuteranopia -
   indistinguishable - so the tick carries a check or a cross and the bars stay
   one validated hue. The glyph works in print and in the table view too. */
mk('chRhRib',{type:'bar',data:{labels:rib.map(function(d){
return (d.hit===null?'':(d.hit?'✓ ':'✗ '))+d.dt.slice(5);}),
datasets:[{label:'On the clock',data:rib.map(function(d){return [d.st,d.en];}),
backgroundColor:SPAL[0],borderColor:SF,borderWidth:2,borderRadius:4,maxBarThickness:15}]},
options:{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){
var d=rib[c.dataIndex];
return hhmm(d.st)+' → '+hhmm(d.en)+'  ('+fh(d.span*3600)+', '+d.n+' studies, '+d.ivu+' IVU'+
(d.hit===null?'':(d.hit?', goal hit':', goal missed'))+')';}}}},
scales:{x:hourAx(''),y:{grid:{display:false},border:{display:false},
ticks:{maxRotation:0,autoSkip:false,color:function(c){var d=rib[c.index];
return !d||d.hit===null?MUT:(d.hit?GOODC:CRITC);}}}}}});
el('tvRhRib').innerHTML=tbl(['Date','Day','Start','Finish','Length','IVU','Goal'],
rib.map(function(d){return [d.dt,d.dy,hhmm(d.st),hhmm(d.en),fh(d.span*3600),d.ivu,
d.hit===null?'--':(d.hit?'hit '+r1(d.goal):'missed '+r1(d.goal))];}));
/* ---- a typical day, by weekday ---- */
var DOWN=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
var bd=DOWN.map(function(nm){
var dd=DS.filter(function(d){return d.dy.slice(0,3)===nm;});
return dd.length?{nm:nm,c:dd.length,st:med(dd.map(function(d){return d.st;})),
en:med(dd.map(function(d){return d.en;})),ivu:med(dd.map(function(d){return d.ivu;}))}:null;})
.filter(Boolean);
mk('chRhDow',{type:'bar',data:{labels:bd.map(function(d){return d.nm;}),
datasets:[{label:'Median start to median finish',data:bd.map(function(d){return [d.st,d.en];}),
backgroundColor:SPAL[0],borderColor:SF,borderWidth:2,borderRadius:4,maxBarThickness:22}]},
options:{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){
var d=bd[c.dataIndex];
return hhmm(d.st)+' → '+hhmm(d.en)+'  (median of '+d.c+' day'+(d.c===1?'':'s')+', '+d.ivu+' IVU)';}}}},
scales:{x:hourAx(''),y:axX()}}});
el('tvRhDow').innerHTML=tbl(['Day','Days','Median start','Median finish','Median length','Median IVU'],
bd.map(function(d){return [d.nm,d.c,hhmm(d.st),hhmm(d.en),fh((d.en-d.st)*3600),d.ivu];}));
/* ---- what the start time is worth ---- */
var fSpan=linfit(starts,spans),fIvu=linfit(starts,DS.map(function(d){return d.ivu;}));
var fDrift=linfit(starts,DS.map(function(d){return d.drift/60;}));
var nn=[];
if(fSpan&&Math.abs(fSpan.r)>=0.3){var sm=Math.round(-fSpan.m*60);
nn.push(sm>0
?'Starting an hour <b>earlier</b> goes with a day about <b>'+sm+'m longer</b> — the early time is going into more work, not a shorter day.'
:'Starting an hour earlier goes with a day about <b>'+Math.abs(sm)+'m shorter</b>.');}
if(fIvu&&Math.abs(fIvu.r)>=0.3){var im=-fIvu.m;
if(im>0.05){var t='An hour earlier start goes with <b class="hi">+'+r1(im)+' IVU</b> on the day';
if(FSTAT&&FSTAT.ivu>0)t+=' — about <b>'+r1(im/FSTAT.ivu)+'</b> '+esc(FSTAT.name)+'s';
if(LAD)t+=', '+r1(im/LAD.s)+' of a credit';
nn.push(t+'.');}
else if(im<-0.05)nn.push('Oddly, later starts go with <b>+'+r1(-im)+' IVU</b> here — probably the shift mix, not the hour.');}
if(fDrift&&Math.abs(fDrift.r)>=0.3){var dm=Math.round(fDrift.m);
if(dm>0)nn.push('Every hour later you start, you drift about <b class="lo">'+dm+'m more</b>'+
(RATE>0?' ('+moneyFor(dm*60)+')':'')+'. Late starts and scattered days travel together.');
else if(dm<0)nn.push('Later starts actually drift <b>'+Math.abs(dm)+'m less</b> here.');}
/* Earliest vs latest third - a plain-language version of the same thing, which
   survives a weak correlation better than a slope does. */
var srt=DS.slice().sort(function(a,b){return a.st-b.st;}),k=Math.max(1,Math.floor(srt.length/3));
var early=srt.slice(0,k),late=srt.slice(-k);
var eI=med(early.map(function(d){return d.ivu;})),lI=med(late.map(function(d){return d.ivu;}));
var eE=med(early.map(function(d){return d.en;})),lE=med(late.map(function(d){return d.en;}));
nn.push('Your <b>'+k+' earliest</b> starts (median '+hhmm(med(early.map(function(d){return d.st;})))+
') finished at '+hhmm(eE)+' with <b>'+r1(eI)+' IVU</b>. Your <b>'+k+' latest</b> (median '+
hhmm(med(late.map(function(d){return d.st;})))+') finished at '+hhmm(lE)+' with <b>'+r1(lI)+' IVU</b>.');
el('rhNotes').innerHTML=nn.length
?'<ul class="ins">'+nn.map(function(x){return '<li>'+x+'</li>';}).join('')+'</ul>'
:'<div class="empty">Nothing tracks your start time strongly enough to report yet.</div>';}
/* ---------------- BANK ----------------
   Earnings are DERIVED here from the same CSV the app writes, using the same
   arithmetic RewardPoints() uses in the .ahk. Nothing about a reward is stored,
   so it can never drift from the work that produced it. The only persisted
   fact is a cash-out, because a withdrawal is the one thing the log cannot
   reconstruct. */
var RW=(typeof REWARD!=='undefined'&&REWARD)?REWARD:null;
var CASH=(typeof CASHOUTS!=='undefined'&&CASHOUTS)?CASHOUTS:[];
function usd2(n){return '$'+(Math.round(n*100)/100).toFixed(2);}
/* Mirrors RewardPoints() in RadTempo.ahk - keep the two in step. */
function rwPoints(wins,bets,best,rungs){
if(!RW)return 0;
var parPts=wins+(RW.every>0?RW.bonus*Math.floor(best/RW.every):0);
var goalPts=rungs>0?RW.rung*rungs*(rungs+1)/2:0;
var mul=0.75+0.5*(bets>0?wins/bets:0);
return{par:parPts,goal:goalPts,mul:mul,total:parPts+goalPts*mul};}
/* Per-day bets/wins/best-streak, in log order so a streak means what it says. */
function rwDays(dates){
var out=[];
/* The bank opens on REWARD.start. Without it the first run scores the whole
   back-catalogue and hands you a balance you never played for - a rebate, not
   a reward. */
var from=(RW&&RW.start)?RW.start:'';
dates.forEach(function(dt){
if(from&&dt<from)return;
var dd=V.filter(function(x){return x.date===dt;});
if(!dd.length)return;
var bets=0,wins=0,run=0,best=0;
dd.forEach(function(x){
if(!(x.par>0&&x.act>=0))return;      /* no bet, no point */
bets++;
if(x.act<=x.par){wins++;run++;if(run>best)best=run;}else run=0;});
var ivu=sumIvu(dd);
var rungs=credits(ivu);
var p=rwPoints(wins,bets,best,rungs);
out.push({dt:dt,dy:dd[0].day,bets:bets,wins:wins,best:best,ivu:r1(ivu),rungs:rungs,
par:p.par,goalP:p.goal*p.mul,mul:p.mul,pts:p.total,usd:p.total*RW.per});});
return out;}
/* ISO-week key, so the weekly cap lands in the same buckets the .ahk uses. */
function isoWeek(iso){var p=iso.split('-'),d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2]));
var dn=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-dn+3);
var t=new Date(Date.UTC(d.getUTCFullYear(),0,4));
var wk=1+Math.round(((d-t)/864e5-3+((t.getUTCDay()+6)%7))/7);
return d.getUTCFullYear()+'-W'+String(wk).padStart(2,'0');}
function renderBank(dates,DH){
var body=el('bkBody'),off=el('bkOff');
if(!body)return;
if(!RW||!RW.on||!RW.per){off.style.display='';body.style.display='none';return;}
off.style.display='none';body.style.display='';
var rows=rwDays(dates);
/* Apply the weekly cap exactly as the app does, and remember what it cost. */
var wk={},capped=0,earned=0;
rows.forEach(function(r){
var k=isoWeek(r.dt),prev=wk[k]||0,room=RW.cap-prev,amt=r.usd;
if(room<=0){capped+=amt;r.paid=0;return;}
if(amt>room){capped+=amt-room;amt=room;}
wk[k]=prev+amt;r.paid=amt;earned+=amt;});
var cashed=CASH.reduce(function(a,c){return a+(+c.a||0);},0);
var bal=Math.max(0,earned-cashed);
/* hero */
el('bkBal').textContent=usd2(bal);
el('bkSub').textContent=usd2(earned)+' earned  ·  '+usd2(cashed)+' taken out';
var thisWk=isoWeek(TODAY),wkNow=wk[thisWk]||0;
var side='Cash out from <b>Tray &rarr; Rewards &rarr; Cash Out</b>. It records the withdrawal '+
'and copies the amount &mdash; buying the card stays your move.';
if(RW.start)side+='<br><br>Counting from <b>'+esc(RW.start)+'</b>. Anything logged before that '+
'does not pay &mdash; reset the start date from <b>Rewards &rarr; Start the Bank Today</b>.';
side+='<br><br>This week: <b>'+usd2(wkNow)+'</b> of the '+usd2(RW.cap)+' cap.';
if(capped>0.005)side+=' Lifetime, <b>'+usd2(capped)+'</b> was trimmed by that cap.';
el('bkSide').innerHTML=side;
/* today */
var t=rows.filter(function(r){return r.dt===TODAY;})[0];
var g='';
function tile2(lb,val,col,sub){return '<div class="cd"><div class="lb">'+esc(lb)+'</div><div class="vl" style="color:'+col+
'">'+esc(val)+'</div><div class="sb">'+(sub||'')+'</div></div>';}
if(t){
g+=tile2('Earned today',usd2(t.paid===undefined?t.usd:t.paid),GOODC,Math.round(t.pts)+' points');
g+=tile2('Under par',t.wins+'/'+t.bets,t.bets&&t.wins/t.bets>=0.5?GOODC:WARNC,
t.bets?('best run <b>'+t.best+'</b> · '+Math.round(t.wins/t.bets*100)+'%'):'no bets yet');
g+=tile2('Rungs cleared',t.rungs,t.rungs>0?GOODC:MUT,t.ivu+' IVU'+
(nextRung(t.ivu)>t.ivu?(' · <b>'+r1(nextRung(t.ivu)-t.ivu)+'</b> to the next'):''));
/* What the next rung is worth, in money. This is the pull. */
var nr=credits(nextRung(t.ivu));
if(nr>t.rungs){var bump=rwPoints(t.wins,t.bets,t.best,nr).total-t.pts;
g+=tile2('Next rung pays',usd2(bump*RW.per),'#c98500','on top of today, at your focus rate');}
}else{g+=tile2('Earned today',usd2(0),MUT,'nothing signed yet');}
el('bkToday').innerHTML=g;
/* the formula, filled in with today (or the most recent day) */
var f=t||rows[rows.length-1];
var fh2='';
if(f){
function row(cls,l,v){return '<div class="fmRow '+cls+'"><div class="fmL">'+l+'</div><div class="fmV">'+v+'</div></div>';}
fh2+=row('','<b>Par</b> — 1 point per study under par, plus <b>'+RW.bonus+
'</b> every <b>'+RW.every+'</b> in a row. Flat per win, never scaled by how far under.',
Math.round(f.par)+' pts');
fh2+=row('','<b>Goal</b> — rung '+f.rungs+' of the ladder, '+RW.rung+
'&times;n(n+1)/2 so each rung pays more than the last.',
Math.round(f.rungs>0?RW.rung*f.rungs*(f.rungs+1)/2:0)+' pts');
fh2+=row('mul','<b>Focus multiplier</b> — your under-par rate, '+
(f.bets?Math.round(f.wins/f.bets*100):0)+'%. Scales the goal half only.',
'&times;'+(Math.round(f.mul*100)/100));
fh2+=row('tot','<b>'+esc(f.dt===TODAY?'Today':f.dt)+'</b> at '+usd2(RW.per)+' per point',
Math.round(f.pts)+' pts = '+usd2(f.paid===undefined?f.usd:f.paid));}
el('bkFormula').innerHTML=fh2;
el('bkNote').innerHTML='A par win pays the same whether you came in ten seconds under or six minutes '+
'under. Par is <b>engaged</b> time, so a flat token pays you for not drifting; a margin-scaled one '+
'would put a price on reading faster inside a study, which is the one incentive this app is built to '+
'avoid. Losing a bet costs nothing — it just ends the streak.';
/* chart: stacked par vs goal dollars per day */
var last=rows.slice(-30);
el('bkChartD').innerHTML='What each day paid, split into the par half and the goal half'+
(rows.length>30?'. Showing the latest <b>30</b> of '+rows.length+' days.':'');
mk('chBank',{type:'bar',data:{labels:last.map(function(r){return r.dt.slice(5);}),
datasets:[
{label:'Par',data:last.map(function(r){return Math.round(r.par*RW.per*100)/100;}),
backgroundColor:SPAL[2],...STACK},
{label:'Goal',data:last.map(function(r){return Math.round(r.goalP*RW.per*100)/100;}),
backgroundColor:SPAL[0],...STACK}]},
options:{plugins:{legend:LG,tooltip:{callbacks:{label:function(c){
return c.dataset.label+' '+usd2(c.raw);},
footer:function(items){var r=last[items[0].dataIndex];
return usd2(r.paid===undefined?r.usd:r.paid)+' total · '+r.wins+'/'+r.bets+' under par · rung '+r.rungs;}}}},
scales:{x:Object.assign(axX(),{stacked:true}),
y:Object.assign(ax('dollars'),{stacked:true,ticks:{callback:function(v){return '$'+v;}}})}}});
el('tvBank').innerHTML=tbl(['Date','Day','Under par','Best run','IVU','Rung','Mult','Points','Paid'],
rows.slice().reverse().map(function(r){return [r.dt,r.dy,r.wins+'/'+r.bets,r.best,r.ivu,r.rungs,
'x'+(Math.round(r.mul*100)/100),Math.round(r.pts),usd2(r.paid===undefined?r.usd:r.paid)];}));
/* cash-out ledger */
if(CASH.length){el('bxCash').style.display='';
el('bkCash').innerHTML=tbl(['When','Amount','Note'],
CASH.slice().reverse().map(function(c){return [c.d,usd2(+c.a||0),c.n||''];}));}
else{el('bxCash').style.display='none';}}
/* ---------------- SHIFTS ---------------- */
function renderShifts(dates,DH,hasShift,BK,SH,shArr,modRows,mods){
if(!hasShift||!shArr.length){el('shEmpty').style.display='';el('shBody').style.display='none';return;}
el('shEmpty').style.display='none';el('shBody').style.display='';
var lab=shArr.map(function(s){return (s.on?'★ ':'')+(s.name.length>24?s.name.slice(0,22)+'…':s.name);});
mk('chShift',{type:'bar',data:{labels:lab,datasets:[{label:'IVU per block',data:shArr.map(function(s){return s.ipb;}),
backgroundColor:SPAL[0],...BAR}]},
options:{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{afterBody:function(c){
var s=shArr[c[0].dataIndex];return 'Blocks: '+s.blocks+'\nStudies/block: '+s.npb+'\nIVU/scheduled hr: '+(s.iph||'--')+
(s.on?'\nON-SITE':'');}}}},scales:{x:ax('IVU per block'),y:{grid:{display:false},border:{display:false}}}}});
el('tvShift').innerHTML=tbl(['Block','IVU/blk','Blocks'],shArr.map(function(s){return[s.name,s.ipb,s.blocks];}));
var tb='';shArr.forEach(function(s){tb+='<tr><td>'+esc(s.name)+'</td><td>'+s.blocks+'</td><td>'+s.n+'</td><td>'+s.npb+
'</td><td>'+s.ivu+'</td><td class="tot">'+s.ipb+'</td><td>'+(s.iph||'--')+'</td><td>'+(s.hrs||'--')+'</td><td>'+
(s.on?'<span class="badge" style="padding:2px 8px;font-size:9px">on-site</span>':'')+'</td></tr>';});
document.querySelector('#tSh tbody').innerHTML=tb;
/* weekday */
var dwN=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],dwI={},dwD={};
dates.forEach(function(dt){var dy=DH[dt].dy;if(!dy)return;dwI[dy]=(dwI[dy]||0)+DH[dt].ivu;dwD[dy]=(dwD[dy]||0)+1;});
var dwV=dwN.map(function(d){return dwD[d]?Math.round(dwI[d]/dwD[d]*10)/10:0;});
mk('chDow',{type:'bar',data:{labels:dwN,datasets:[{label:'Avg IVU/day',data:dwV,backgroundColor:SPAL[0],...BAR}]},
options:{plugins:{legend:{display:false}},scales:{y:ax('IVU'),x:axX()}}});
el('tvDow').innerHTML=tbl(['Day','Avg IVU'],dwN.map(function(d,i){return[d,dwV[i]];}));
/* mix */
var topSh=shArr.slice().sort(function(a,b){return b.blocks-a.blocks;}).slice(0,5).map(function(s){return s.name;});
var MODL=['CR','CT','MR','US','PET'],mix={};
topSh.forEach(function(s){mix[s]={};MODL.forEach(function(m){mix[s][m]=0;});});
V.forEach(function(d){var s=d.shift;if(!s||!mix[s])return;if(mix[s][d.mod]!==undefined)mix[s][d.mod]++;});
mk('chMix',{type:'bar',data:{labels:topSh.map(function(s){return s.length>20?s.slice(0,18)+'…':s;}),
datasets:MODL.map(function(m){return{label:MN[m]||m,data:topSh.map(function(s){return Math.round(mix[s][m]/SH[s].blocks*10)/10;}),
backgroundColor:MC[m],...STACK};})},
options:{indexAxis:'y',plugins:{legend:LG},scales:{x:Object.assign(ax('studies per block'),{stacked:true}),
y:{stacked:true,grid:{display:false},border:{display:false}}}}});
/* cumulative */
var HRS=[];for(var h=6;h<=20;h++)HRS.push(h);
var cum={},top4=topSh.slice(0,4);
top4.forEach(function(s){cum[s]=HRS.map(function(){return 0;});});
top4.forEach(function(s){var bks=Array.from(new Set(V.filter(function(d){return d.shift===s;}).map(function(d){return d.dRaw;})));
bks.forEach(function(dr){var c=0;HRS.forEach(function(hh,i){
V.filter(function(d){return d.dRaw===dr&&d.shift===s&&d.hr===hh;}).forEach(function(d){c+=d.ivu;});cum[s][i]+=c;});});
var n=bks.length||1;cum[s]=cum[s].map(function(v){return Math.round(v/n*10)/10;});});
mk('chCum',{type:'line',data:{labels:HRS.map(function(hh){return (hh%12||12)+(hh<12?'a':'p');}),
datasets:top4.map(function(s,i){return{label:s.length>16?s.slice(0,14)+'…':s,data:cum[s],borderColor:SPAL[i],
backgroundColor:'transparent',tension:.3,borderWidth:2,pointRadius:0,pointHoverRadius:5,pointHitRadius:24};})},
options:{plugins:{legend:LG},scales:{y:ax('cumulative IVU'),x:axX()},interaction:{mode:'index',intersect:false}}});
/* fatigue - split into two single-axis charts */
var wdays=dates.filter(function(dt){return DH[dt].n>0;}).sort(),pos={},run=[];
wdays.forEach(function(dt,i){if(i>0&&(new Date(dt)-new Date(wdays[i-1]))===864e5)run.push(dt);else run=[dt];
pos[dt]=Math.min(run.length,4);});
var fb={1:{i:0,s:0,n:0,d:0},2:{i:0,s:0,n:0,d:0},3:{i:0,s:0,n:0,d:0},4:{i:0,s:0,n:0,d:0}};
wdays.forEach(function(dt){var p=pos[dt];fb[p].i+=DH[dt].ivu;fb[p].d++;
var rows=V.filter(function(d){return d.date===dt;});
fb[p].s+=rows.reduce(function(a,r){return a+r.sec;},0);fb[p].n+=rows.length;});
var fatL=['Day 1','Day 2','Day 3','Day 4+'];
mk('chFatI',{type:'bar',data:{labels:fatL,datasets:[{label:'IVU/day',
data:[1,2,3,4].map(function(p){return fb[p].d?Math.round(fb[p].i/fb[p].d*10)/10:null;}),backgroundColor:SPAL[0],...BAR}]},
options:{plugins:{legend:{display:false}},scales:{y:ax('IVU per day'),x:axX()}}});
mk('chFatS',{type:'bar',data:{labels:fatL,datasets:[{label:'sec/study',
data:[1,2,3,4].map(function(p){return fb[p].n?Math.round(fb[p].s/fb[p].n):null;}),backgroundColor:SPAL[3],...BAR}]},
options:{plugins:{legend:{display:false}},scales:{y:ax('seconds per study'),x:axX()}}});
/* trend */
var sel=el('shSel');sel.innerHTML='';
shArr.forEach(function(s){var o=document.createElement('option');o.value=s.name;
o.textContent=s.name+' ('+s.blocks+' blocks)';sel.appendChild(o);});
function shTrend(name){var bks=Object.values(BK).filter(function(b){return b.shift===name;})
.sort(function(a,x){return new Date(a.date)-new Date(x.date);});
var vals=bks.map(function(b){return Math.round(b.ivu*10)/10;}),ra=[],su=0;
vals.forEach(function(v,i){su+=v;ra.push(Math.round(su/(i+1)*10)/10);});
mk('chShTrend',{data:{labels:bks.map(function(b){var p=b.date.split('/');return p[0]+'/'+p[1];}),
datasets:[{type:'bar',label:'IVU',data:vals,backgroundColor:SPAL[0],...BAR,order:2},
{type:'line',label:'Running avg',data:ra,borderColor:SPAL[3],backgroundColor:'transparent',borderWidth:2,
pointRadius:0,pointHoverRadius:5,pointHitRadius:24,tension:.3,order:1}]},
options:{plugins:{legend:LG},scales:{y:ax('IVU'),x:axX()},interaction:{mode:'index',intersect:false}}});}
sel.onchange=function(e){shTrend(e.target.value);};
if(shArr.length)shTrend(shArr[0].name);
/* modifier */
if(modRows.length){el('bxMod').style.display='';var mb='';
modRows.forEach(function(r){mb+='<tr><td>'+esc(r.m)+'</td><td>'+r.bw+'</td><td>'+r.iw+'</td><td>'+r.io+
'</td><td class="'+(r.d>=0?'up':'dn')+'" style="font-weight:700">'+(r.d>0?'+':'')+r.d+'%</td></tr>';});
document.querySelector('#tMod tbody').innerHTML=mb;}else el('bxMod').style.display='none';
/* same exam different shift */
var xsMap={};
V.forEach(function(d){var s=d.shift;if(!s||!d.exam)return;var k=d.exam;
if(!xsMap[k])xsMap[k]={tot:0,sh:{}};xsMap[k].tot++;
if(!xsMap[k].sh[s])xsMap[k].sh[s]={sum:0,n:0};xsMap[k].sh[s].sum+=d.sec;xsMap[k].sh[s].n++;});
var xsEx=Object.keys(xsMap).map(function(k){return{name:k,tot:xsMap[k].tot,
ns:Object.values(xsMap[k].sh).filter(function(v){return v.n>=3;}).length};})
.filter(function(e){return e.ns>=2;}).sort(function(a,b){return b.tot-a.tot;}).slice(0,6);
if(xsEx.length){el('bxXS').style.display='';var xsSh=topSh.slice(0,4);
var xh='<tr><th>Exam</th>';xsSh.forEach(function(s){xh+='<th>'+esc(s.length>14?s.slice(0,12)+'…':s)+'</th>';});
document.querySelector('#tXS thead').innerHTML=xh+'</tr>';
var xb='';
xsEx.forEach(function(e){var cells=xsSh.map(function(s){var c=xsMap[e.name].sh[s];return c&&c.n>=3?Math.round(c.sum/c.n):null;});
var vv=cells.filter(function(v){return v!==null;}),mn=Math.min.apply(null,vv),mx=Math.max.apply(null,vv);
xb+='<tr><td>'+esc(e.name.length>40?e.name.slice(0,38)+'…':e.name)+'</td>';
cells.forEach(function(v){if(v===null){xb+='<td class="nt">--</td>';return;}
var cl=(v===mn&&vv.length>1)?'up':(v===mx&&vv.length>1?'dn':'');
xb+='<td class="'+cl+'" style="font-weight:650">'+ft(v)+'</td>';});xb+='</tr>';});
document.querySelector('#tXS tbody').innerHTML=xb;}else el('bxXS').style.display='none';
/* insights */
var INS=[],elig=shArr.filter(function(s){return s.blocks>=3;});
if(elig.length>=2){var hi=elig[0],lo=elig[elig.length-1];
INS.push('<b>'+esc(hi.name)+'</b> is your highest-yield block at <span class="hi">'+hi.ipb+' IVU/block</span> — '+
(lo.ipb>0?Math.round((hi.ipb/lo.ipb-1)*100):0)+'% above <b>'+esc(lo.name)+'</b> ('+lo.ipb+').');}
var effSh=elig.filter(function(s){return s.iph>0;}).sort(function(a,b){return b.iph-a.iph;});
if(effSh.length>=2)INS.push('Per <i>scheduled</i> hour, <b>'+esc(effSh[0].name)+'</b> leads at <span class="hi">'+
effSh[0].iph+' IVU/hr</span>; <b>'+esc(effSh[effSh.length-1].name)+'</b> trails at <span class="lo">'+effSh[effSh.length-1].iph+'</span>.');
var onB=shArr.filter(function(s){return s.on&&s.blocks>=2;}),offB=shArr.filter(function(s){return !s.on&&s.blocks>=2;});
if(onB.length&&offB.length){var oi=onB.reduce(function(a,s){return a+s.ivu;},0)/onB.reduce(function(a,s){return a+s.blocks;},0);
var ri=offB.reduce(function(a,s){return a+s.ivu;},0)/offB.reduce(function(a,s){return a+s.blocks;},0);
var dp=Math.round((oi/ri-1)*100);
INS.push('<b>On-site blocks</b> run <span class="'+(dp>=0?'hi':'lo')+'">'+(dp>0?'+':'')+dp+'%</span> IVU/block vs remote.');}
if(modRows.length)INS.push('Biggest modifier effect: <b>'+esc(modRows[0].m)+'</b> blocks run <span class="'+
(modRows[0].d>=0?'hi':'lo')+'">'+(modRows[0].d>0?'+':'')+modRows[0].d+'%</span> vs the same blocks without it.');
if(fb[1].d>=3&&fb[3].d+fb[4].d>=3){var d1=fb[1].i/fb[1].d,late=(fb[3].i+fb[4].i)/(fb[3].d+fb[4].d);
var fp=Math.round((late/d1-1)*100);
INS.push(fp<=-5?'Output drops <span class="lo">'+Math.abs(fp)+'%</span> by day 3+ of a stretch — front-load heavy lists early.'
:fp>=5?'You ramp up across a stretch: day 3+ runs <span class="hi">'+fp+'%</span> above day 1.'
:'Consistent across stretches: day 3+ is within '+Math.abs(fp)+'% of day 1.');}
if(INS.length){el('bxIns').style.display='';el('insList').innerHTML=INS.map(function(t){return '<li>'+t+'</li>';}).join('');}
else el('bxIns').style.display='none';
/* forecast */
if(HASSH&&HASCLS){var shipd={};shArr.forEach(function(s){shipd[s.name]={ipb:s.ipb,npb:s.npb,d:s.blocks};});
var modD={};modRows.forEach(function(r){modD[r.m]=r.d/100;});
var allBk=Object.keys(BK).length;
var allIpb=allBk?Object.values(BK).reduce(function(a,b){return a+b.ivu;},0)/allBk:0;
var allNpb=allBk?Object.values(BK).reduce(function(a,b){return a+b.n;},0)/allBk:0;
var rows=[],wk7=0,now=new Date();
for(var i=1;i<=14;i++){var dd=new Date(now.getTime()+i*864e5),key=mdyOf(dd),raw=SHIFTS[key];
if(!raw)continue;var pm=dayPlan(raw),P=pm[0],M=pm[1];if(!P.length)continue;
var dI=0,dN=0,parts=[],est=true;
P.forEach(function(p){var st=shipd[p.name],eI=st&&st.d>=2?st.ipb:allIpb,eN=st&&st.d>=2?st.npb:allNpb;
if(!(st&&st.d>=2))est=false;
M.forEach(function(m){var mb=modBase(m.name),ov=!m.w||!p.w||(m.s<p.e&&p.s<m.e);
if(ov&&modD[mb]!==undefined)eI*=(1+modD[mb]);});
dI+=eI;dN+=eN;parts.push((p.on?'★':'')+(p.name.length>18?p.name.slice(0,16)+'…':p.name));});
if(i<=7)wk7+=dI;
rows.push({key:key,dy:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dd.getDay()],parts:parts.join('  +  '),
eI:Math.round(dI*10)/10,eN:Math.round(dN*10)/10,est:est});}
if(rows.length){el('bxFc').style.display='';
el('fcSum').textContent='Projected next 7 days: ~'+(Math.round(wk7*10)/10)+' IVU';
var fb2='';rows.forEach(function(r){fb2+='<tr><td>'+esc(r.key)+'</td><td>'+esc(r.dy)+'</td><td>'+esc(r.parts)+
'</td><td>'+r.eN+'</td><td class="tot">'+r.eI+(r.est?'':' <span class="nt">(est)</span>')+'</td></tr>';});
document.querySelector('#tFc tbody').innerHTML=fb2;}else el('bxFc').style.display='none';}}
/* ---------------- EXAMS ---------------- */
function renderExams(mods){
var mc='';
mods.forEach(function(m){var md=V.filter(function(d){return d.mod===m;});if(!md.length)return;
var avg=Math.round(md.reduce(function(a,d){return a+d.sec;},0)/md.length);
var matched=md.filter(function(d){return d.ivu>0;});
var mIvu=matched.reduce(function(a,d){return a+d.ivu;},0);
var mAvgIvu=matched.length?Math.round(mIvu/matched.length*100)/100:0;
var mAvgSec=md.reduce(function(a,d){return a+d.sec;},0)/md.length;
var perMin=mAvgSec>0?Math.round(mAvgIvu/(mAvgSec/60)*100)/100:0;
var tr='<span class="nt">--</span>';
if(md.length>=10){var f5=md.slice(0,5).reduce(function(a,d){return a+d.sec;},0)/5;
var l5=md.slice(-5).reduce(function(a,d){return a+d.sec;},0)/5,df=Math.round(f5-l5);
tr=df>5?'<span class="up">'+ft(Math.abs(df))+' faster</span>':df<-5?'<span class="dn">'+ft(Math.abs(df))+' slower</span>':'<span class="nt">steady</span>';}
mc+='<div class="cd"><div class="lb"><span class="mb '+esc(m)+'" style="padding:1px 6px;font-size:9px">'+esc(m)+'</span> '+
esc(MN[m]||m)+'</div><div class="vl">'+ft(avg)+'</div><div class="sb">'+md.length+' studies · '+tr+
'</div><div class="sb">IVU <b>'+(Math.round(mIvu*10)/10)+'</b> · avg <b>'+mAvgIvu+'</b> · <b>'+perMin+'</b>/min</div></div>';});
el('mc').innerHTML=mc;
/* efficiency */
var eff=[];
mods.forEach(function(m){var md=V.filter(function(d){return d.mod===m;});if(!md.length)return;
var totalSec=md.reduce(function(a,d){return a+d.sec;},0);
var matched=md.filter(function(d){return d.ivu>0;});
var totalIvu=matched.reduce(function(a,d){return a+d.ivu;},0);
var avgSec=totalSec/md.length,avgIvu=matched.length?totalIvu/matched.length:0;
eff.push({mod:m,perMin:avgSec>0?Math.round(avgIvu/(avgSec/60)*1000)/1000:0,
avgIvu:Math.round(avgIvu*100)/100,avgSec:Math.round(avgSec),count:md.length,hrs:Math.round(totalSec/360)/10});});
eff.sort(function(a,b){return b.perMin-a.perMin;});
mk('chIVUEff',{type:'bar',data:{labels:eff.map(function(d){return MN[d.mod]||d.mod;}),
datasets:[{label:'IVU/min',data:eff.map(function(d){return d.perMin;}),
backgroundColor:eff.map(function(d){return MC[d.mod];}),...BAR}]},
options:{indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{afterBody:function(c){var d=eff[c[0].dataIndex];
return 'Avg IVU/study: '+d.avgIvu+'\nAvg time: '+ft(d.avgSec)+'\nStudies: '+d.count+'\nActive: '+d.hrs+'h';}}}},
scales:{x:ax('IVU per minute of reading'),y:{grid:{display:false},border:{display:false}}}}});
el('tvEff').innerHTML=tbl(['Modality','IVU/min','Avg IVU','Avg time','Studies'],
eff.map(function(d){return[MN[d.mod]||d.mod,d.perMin,d.avgIvu,ft(d.avgSec),d.count];}));
/* study types */
var stMap={};
V.forEach(function(d){if(!d.exam||d.exam.length<3)return;
if(!stMap[d.exam])stMap[d.exam]={mod:d.mod,times:[],ivus:[]};
stMap[d.exam].times.push(d.sec);if(d.ivu>0)stMap[d.exam].ivus.push(d.ivu);});
var full=Object.keys(stMap).map(function(k){var m=stMap[k];
var avgT=m.times.reduce(function(a,b){return a+b;},0)/m.times.length;
var avgI=m.ivus.length?m.ivus.reduce(function(a,b){return a+b;},0)/m.ivus.length:0;
return{name:k,mod:m.mod,count:m.times.length,avg:Math.round(avgT),avgIvu:Math.round(avgI*100)/100,
ivuMin:avgT>0?Math.round(avgI/(avgT/60)*1000)/1000:0};}).sort(function(a,b){return b.count-a.count;});
var arr=full.slice(),dir=1,filt='ALL';
function renderST(){var tb=document.querySelector('#tST tbody');
if(!arr.length){tb.innerHTML='<tr><td colspan="6" class="nt" style="text-align:center;padding:22px">No studies match</td></tr>';return;}
var mx=Math.max.apply(null,arr.map(function(s){return s.ivuMin;}));
var h='';arr.forEach(function(s){var p=mx>0?Math.round(s.ivuMin/mx*100):0;
var cl=p>=75?'up':p>=50?'':'nt';
h+='<tr data-n="'+esc(s.name)+'" style="cursor:pointer"><td>'+esc(s.name)+'</td><td><span class="mb '+esc(s.mod)+
'">'+esc(s.mod)+'</span></td><td>'+s.count+'</td><td style="color:#c98500;font-weight:650">'+ft(s.avg)+
'</td><td class="tot">'+s.avgIvu+'</td><td class="'+cl+'" style="font-weight:650">'+s.ivuMin.toFixed(3)+'</td></tr>';});
tb.innerHTML=h;
Array.prototype.forEach.call(tb.querySelectorAll('tr'),function(r){r.onclick=function(){
var n=r.getAttribute('data-n');if(n){el('stSel').value=n;trend(n);}};});}
el('stModFilter').onchange=function(e){filt=e.target.value;
arr=filt==='ALL'?full.slice():full.filter(function(s){return s.mod===filt;});renderST();};
Array.prototype.forEach.call(document.querySelectorAll('#tST thead th'),function(th){
th.style.cursor='pointer';th.onclick=function(){var k=['name','mod','count','avg','avgIvu','ivuMin'][+th.getAttribute('data-s')];
arr.sort(function(a,b){var x=a[k],y=b[k];return typeof x==='string'?dir*x.localeCompare(y):dir*(x-y);});dir*=-1;renderST();};});
renderST();
var ss=el('stSel');ss.innerHTML='';
full.forEach(function(s){var o=document.createElement('option');o.value=s.name;
o.textContent=s.name+' ('+s.count+')';ss.appendChild(o);});
function trend(name){var e=V.filter(function(d){return (d.exam||'').trim()===name;});if(!e.length)return;
var times=e.map(function(d){return d.sec;}),ra=[],su=0;
times.forEach(function(t,i){su+=t;ra.push(Math.round(su/(i+1)));});
var avg=Math.round(times.reduce(function(a,b){return a+b;},0)/times.length);
/* past ~20 reads a bar per study becomes a barcode - switch to a line */
var many=times.length>20;
var perStudy=many
?{type:'line',label:'Time',data:times,borderColor:SPAL[2],backgroundColor:'rgba(25,158,112,.10)',fill:true,
borderWidth:2,tension:.25,pointRadius:0,pointHoverRadius:5,pointHitRadius:24,order:3}
:{type:'bar',label:'Time',data:times,backgroundColor:SPAL[2],...BAR,order:3};
mk('chSTrend',{data:{labels:e.map(function(d,i){return many?d.date.slice(5):(d.date.slice(5)+' #'+(i+1));}),
datasets:[perStudy,
{type:'line',label:'Running avg',data:ra,borderColor:SPAL[3],backgroundColor:'transparent',borderWidth:2,
pointRadius:0,pointHoverRadius:5,pointHitRadius:24,tension:.3,order:1}]},
options:{plugins:{legend:LG,title:{display:true,text:name+' — '+e.length+' studies, avg '+ft(avg),
color:'#b8b8cf',font:{size:12}}},scales:{y:Object.assign(ax('seconds'),{ticks:{callback:function(v){return ft(v);}}}),
x:Object.assign(axX(),{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:6}})},
interaction:{mode:'index',intersect:false}}});}
ss.onchange=function(e){trend(e.target.value);};
if(full.length)trend(full[0].name);}
/* ---------------- LOG ---------------- */
function renderLog(dates,DH,mods){
var ivByDate={};dates.forEach(function(dt){ivByDate[dt]=DH[dt].ivu;});
var bIvD='',bIvV=0;Object.keys(ivByDate).forEach(function(k){if(ivByDate[k]>bIvV){bIvV=ivByDate[k];bIvD=k;}});
var bVoD='',bVoV=0,bAcD='',bAcV=0;
Object.keys(DH).forEach(function(k){if(DH[k].n>bVoV){bVoV=DH[k].n;bVoD=k;}if(DH[k].a>bAcV){bAcV=DH[k].a;bAcD=k;}});
var hC=new Array(24).fill(0);V.forEach(function(d){hC[d.hr]++;});
var pk=0;hC.forEach(function(v,i){if(v>hC[pk])pk=i;});
var rc='';
function rec(lb,val,sub){return '<div class="cd"><div class="lb">'+esc(lb)+'</div><div class="vl">'+esc(val)+
'</div><div class="sb">'+esc(sub)+'</div></div>';}
rc+=rec('Best IVU day',Math.round(bIvV*10)/10,bIvD);
rc+=rec('Most studies',bVoV,bVoD);
rc+=rec('Longest active day',fh(bAcV),bAcD);
rc+=rec('Peak hour',(pk%12||12)+(pk<12?' AM':' PM'),hC[pk]+' studies signed');
el('rc').innerHTML=rc;
var L=dates.map(function(d){return d.slice(5);});
var dBM={};mods.forEach(function(m){dBM[m]={};});
V.forEach(function(d){if(dBM[d.mod])dBM[d.mod][d.date]=(dBM[d.mod][d.date]||0)+1;});
mk('chVol',{type:'bar',data:{labels:L,datasets:mods.map(function(m){return{label:MN[m]||m,
data:dates.map(function(d){return dBM[m][d]||0;}),backgroundColor:MC[m]||'#888',...STACK};})},
options:{plugins:{legend:LG},scales:{x:Object.assign(axX(),{stacked:true}),y:Object.assign(ax('studies'),{stacked:true})}}});
var ivBM={};mods.forEach(function(m){ivBM[m]={};});
V.forEach(function(d){if(d.ivu>0&&ivBM[d.mod])ivBM[d.mod][d.date]=(ivBM[d.mod][d.date]||0)+d.ivu;});
mk('chIVU',{type:'bar',data:{labels:L,datasets:mods.map(function(m){return{label:MN[m]||m,
data:dates.map(function(d){return Math.round((ivBM[m][d]||0)*100)/100;}),backgroundColor:MC[m]||'#888',...STACK};})},
options:{plugins:{legend:LG},scales:{x:Object.assign(axX(),{stacked:true}),y:Object.assign(ax('IVU'),{stacked:true})}}});
var eD=[],eA=[],eO=[],eP=[];
dates.forEach(function(dt){var d=DH[dt];if(d.n<2)return;
eD.push(dt.slice(5));eA.push(fhr(d.a));eO.push(fhr(d.o));eP.push(d.o>0?Math.round(d.a/d.o*100):0);});
mk('chEff',{type:'bar',data:{labels:eD,datasets:[
{label:'On-clock',data:eO,backgroundColor:'#2b2b52',...BAR},
{label:'Active',data:eA,backgroundColor:SPAL[3],...BAR}]},
options:{plugins:{legend:LG,tooltip:{callbacks:{afterBody:function(c){return 'Efficiency: '+eP[c[0].dataIndex]+'%';}}}},
scales:{y:ax('hours'),x:axX()}}});
mk('chHr',{type:'bar',data:{labels:hC.map(function(_,i){return (i%12||12)+(i<12?'a':'p');}),
datasets:[{label:'Studies',data:hC,backgroundColor:hC.map(function(v,i){return i===pk?SPAL[3]:'#2b2b52';}),
borderRadius:3,maxBarThickness:16}]},
options:{plugins:{legend:{display:false}},scales:{y:ax('studies'),x:axX()}}});
var wks={};
V.forEach(function(d){var dt=new Date(d.date);
var wn=d.date.slice(0,4)+'-W'+String(Math.ceil(((dt-new Date(dt.getFullYear(),0,1))/864e5+1)/7)).padStart(2,'0');
if(!wks[wn])wks[wn]={n:0,sec:0};wks[wn].n++;wks[wn].sec+=d.sec;});
var wk=Object.keys(wks).sort();
mk('chWkN',{type:'bar',data:{labels:wk,datasets:[{label:'Studies',data:wk.map(function(w){return wks[w].n;}),
backgroundColor:SPAL[2],...BAR}]},options:{plugins:{legend:{display:false}},scales:{y:ax('studies'),x:axX()}}});
mk('chWkH',{type:'bar',data:{labels:wk,datasets:[{label:'Active hours',data:wk.map(function(w){return fhr(wks[w].sec);}),
backgroundColor:SPAL[0],...BAR}]},options:{plugins:{legend:{display:false}},scales:{y:ax('hours'),x:axX()}}});
var dh='';
dates.slice().reverse().forEach(function(dt){var d=DH[dt],ef=d.o>0?Math.round(d.a/d.o*100):0;
var ec=ef>=70?'up':ef>=50?'':'dn';
dh+='<tr><td>'+esc(dt)+'</td><td class="nt">'+esc(d.dy||'')+'</td><td style="color:#fff;font-weight:650">'+d.n+
'</td><td style="color:#c98500">'+fh(d.a)+'</td><td>'+fh(d.o)+'</td><td class="'+(d.idle>=600?'dn':'')+'">'+
Math.round(d.idle/60)+'m</td><td class="'+(d.idle>=600?'dn':'nt')+'">'+(RATE>0?moneyFor(d.idle):'--')+
'</td><td class="'+ec+'" style="font-weight:650">'+ef+'%</td><td class="tot">'+
(Math.round(d.ivu*100)/100)+'</td></tr>';});
document.querySelector('#tDH tbody').innerHTML=dh;
var mA={};mods.forEach(function(m){var md=V.filter(function(d){return d.mod===m;});
mA[m]=md.length?Math.round(md.reduce(function(a,d){return a+d.sec;},0)/md.length):0;});
var rh='';
V.slice(-40).reverse().forEach(function(d){var df=d.sec-(mA[d.mod]||0),vs;
if(Math.abs(df)<=5)vs='<span class="nt">avg</span>';
else if(df<0)vs='<span class="up">'+ft(Math.abs(df))+' faster</span>';
else vs='<span class="dn">'+ft(df)+' slower</span>';
rh+='<tr><td>'+esc(d.ts)+'</td><td><span class="mb '+esc(d.mod)+'">'+esc(d.mod)+'</span></td><td>'+
esc((d.exam||'').slice(0,38))+'</td><td style="color:#fff;font-weight:650">'+esc(d.fmt)+'</td><td>'+vs+'</td><td class="'+
(d.ivu>0?'tot':'nt')+'">'+(d.ivu>0?Math.round(d.ivu*100)/100:'--')+'</td></tr>';});
document.querySelector('#tR tbody').innerHTML=rh;}
/* ---------------- wiring ---------------- */
Array.prototype.forEach.call(document.querySelectorAll('#tabs button'),function(b){
b.onclick=function(){Array.prototype.forEach.call(document.querySelectorAll('#tabs button'),function(x){
x.setAttribute('aria-selected',x===b?'true':'false');});
Array.prototype.forEach.call(document.querySelectorAll('.pane'),function(p){
p.classList.toggle('on',p.id==='p-'+b.getAttribute('data-p'));});
window.scrollTo({top:0,behavior:'smooth'});};});
Array.prototype.forEach.call(document.querySelectorAll('#rng button'),function(b){
b.onclick=function(){RANGE=+b.getAttribute('data-d');
Array.prototype.forEach.call(document.querySelectorAll('#rng button'),function(x){
x.setAttribute('aria-pressed',x===b?'true':'false');});render();};});
document.addEventListener('click',function(e){var t=e.target;
if(t&&t.classList&&t.classList.contains('tgl')){var id=t.getAttribute('data-tv'),n=el(id);
if(n){n.classList.toggle('on');t.textContent=n.classList.contains('on')?'Hide table':'Table view';}}});
(function(){var all=document.querySelectorAll('#rng button');
Array.prototype.forEach.call(all,function(b){
b.setAttribute('aria-pressed',(+b.getAttribute('data-d'))===RANGE?'true':'false');});})();
render();
}catch(e){console.error('Dashboard error:',e);
document.body.insertAdjacentHTML('afterbegin','<div style="color:#d03b3b;padding:14px;background:#1c1c3a;margin:10px;border-radius:10px">Dashboard error: '+e.message+'</div>');}
