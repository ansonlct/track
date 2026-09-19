const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const state = {
  index:null, day:null, route:null, variant:null, date:null,
  selectedTrip:0, selectedStop:null, toastTimer:null
};

function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function mins(v){ return v == null ? "—" : `${Number(v).toFixed(v < 10 ? 1 : 0)}m`; }
function hhmm(isoOrTime){
  if(!isoOrTime) return "—";
  if(/^\d\d:\d\d/.test(isoOrTime)) return isoOrTime.slice(0,5);
  const d = new Date(isoOrTime);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("zh-HK",{hour:"2-digit",minute:"2-digit",hour12:false});
}
function median(a){ const b=[...a].sort((x,y)=>x-y); if(!b.length)return null; const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; }
function percentile(a,p){ if(!a.length)return null; const b=[...a].sort((x,y)=>x-y),i=(b.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i); return lo===hi?b[lo]:b[lo]+(b[hi]-b[lo])*(i-lo); }
function calcStats(values){
  const a=values.filter(v=>Number.isFinite(v)&&v>=0);
  if(!a.length) return {n:0,min:null,max:null,avg:null,median:null,p90:null,range:null};
  const avg=a.reduce((x,y)=>x+y,0)/a.length,min=Math.min(...a),max=Math.max(...a);
  return {n:a.length,min,max,avg,median:median(a),p90:percentile(a,.9),range:max-min};
}
function currentVariant(){ return state.day?.routes?.[state.route]?.variants?.[state.variant] || null; }
function sortedTrips(v=currentVariant()){
  return [...(v?.trips||[])].sort((a,b)=>{
    const aa=a.start_time?new Date(a.start_time).getTime():Number.MAX_SAFE_INTEGER;
    const bb=b.start_time?new Date(b.start_time).getTime():Number.MAX_SAFE_INTEGER;
    return aa-bb;
  });
}
function toast(message){
  const el=$("#toast"); if(!el)return;
  el.textContent=message; el.classList.add("show");
  clearTimeout(state.toastTimer); state.toastTimer=setTimeout(()=>el.classList.remove("show"),1800);
}
function setLoading(on){
  $("#refreshBtn")?.classList.toggle("is-loading",on);
  $("#refreshBtn") && ($("#refreshBtn").disabled=on);
}

async function loadIndex(){
  try{
    const r=await fetch("./data/index.json",{cache:"no-store"});
    if(!r.ok) throw new Error("index missing");
    return await r.json();
  }catch(e){ return {dates:["demo"],default_date:"demo",files:{demo:"demo.json"}}; }
}
async function loadDay(date){
  const file=state.index.files?.[date] || `${date}.json`;
  const r=await fetch(`./data/${file}`,{cache:"no-store"});
  if(!r.ok) throw new Error(`讀取 ${file} 失敗`);
  return await r.json();
}
function fillDateSelect(){
  const s=$("#dateSelect"); s.innerHTML="";
  (state.index.dates||[]).forEach(d=>{ const o=document.createElement("option");o.value=d;o.textContent=d==="demo"?"示範數據":d;s.appendChild(o); });
  s.value=state.date;
}
function fillRouteSelect(){
  const s=$("#routeSelect"); s.innerHTML="";
  Object.keys(state.day?.routes||{}).forEach(r=>{const o=document.createElement("option");o.value=r;o.textContent=r;s.appendChild(o);});
  if(!state.route || !state.day.routes?.[state.route]) state.route=Object.keys(state.day?.routes||{})[0];
  s.value=state.route||"";
}
function fillVariantSelect(){
  const s=$("#variantSelect"); s.innerHTML="";
  const variants=state.day?.routes?.[state.route]?.variants||{};
  Object.entries(variants).forEach(([id,v])=>{const o=document.createElement("option");o.value=id;o.textContent=v.label||id;s.appendChild(o);});
  if(!state.variant || !variants[state.variant]) state.variant=Object.keys(variants)[0];
  s.value=state.variant||"";
}
function buildSegments(v){
  if(v.segment_stats?.length) return v.segment_stats.map(x=>({...x}));
  const stops=v.stops||[],trips=v.trips||[];
  return stops.slice(0,-1).map((s,i)=>{
    const n=stops[i+1],values=[];
    trips.forEach(t=>{const a=t.arrivals?.[String(s.seq)],b=t.arrivals?.[String(n.seq)];if(!a||!b)return;const diff=(new Date(b)-new Date(a))/60000;if(Number.isFinite(diff)&&diff>=0&&diff<60)values.push(diff);});
    return {from_seq:s.seq,to_seq:n.seq,from_name:s.name,to_name:n.name,...calcStats(values)};
  });
}

function renderKpis(v,segments){
  const trips=v.trips||[],complete=trips.filter(t=>t.duration_min!=null),ds=calcStats(complete.map(t=>t.duration_min));
  const slow=[...segments].filter(s=>s.n).sort((a,b)=>b.avg-a.avg)[0];
  $("#kpiGrid").innerHTML=[
    ["班次樣本",trips.length,`${segments.reduce((a,s)=>a+s.n,0)} 段車程樣本`],
    ["全程平均",mins(ds.avg),`${ds.n} 班有完整首尾站`],
    ["全程最快",mins(ds.min),ds.n?`最慢 ${mins(ds.max)}`:"暫無資料"],
    ["最慢路段",slow?mins(slow.avg):"—",slow?`${slow.from_name} → ${slow.to_name}`:"暫無資料"]
  ].map(([l,vv,sub])=>`<div class="kpi"><div class="kpi-label">${esc(l)}</div><div class="kpi-value">${esc(vv)}</div><div class="kpi-sub">${esc(sub)}</div></div>`).join("");
}
function renderRankList(el,segments,mode){
  let arr=segments.filter(x=>x.n).sort((a,b)=>mode==="avg"?b.avg-a.avg:b.range-a.range).slice(0,5);
  el.innerHTML=arr.length?arr.map((s,i)=>`<div class="rank-row"><div class="rank-num">${i+1}</div><div class="rank-main"><div class="rank-title">${esc(s.from_name)} → ${esc(s.to_name)}</div><div class="rank-meta">樣本 ${s.n} · 快 ${mins(s.min)} · 慢 ${mins(s.max)} · P90 ${mins(s.p90)}</div></div><div class="rank-value">${mode==="avg"?mins(s.avg):mins(s.range)}</div></div>`).join(""):`<div class="empty">暫時未有足夠樣本</div>`;
}
function renderSegments(v,segments){
  const sort=$("#segmentSort").value; let arr=[...segments];
  if(sort==="avgDesc")arr.sort((a,b)=>(b.avg??-1)-(a.avg??-1));
  if(sort==="maxDesc")arr.sort((a,b)=>(b.max??-1)-(a.max??-1));
  if(sort==="rangeDesc")arr.sort((a,b)=>(b.range??-1)-(a.range??-1));
  if(sort==="seq")arr.sort((a,b)=>Number(a.from_seq)-Number(b.from_seq));
  $("#segmentTable").innerHTML=`<div class="segment-row head"><div>路段</div><div class="metric">平均</div><div class="metric">最快</div><div class="metric">最慢</div><div class="metric">中位</div></div>${arr.map(s=>`<div class="segment-row"><div><div class="seg-name">${esc(s.from_name)}<br>→ ${esc(s.to_name)}</div><div class="seg-sub">#${esc(s.from_seq)}→#${esc(s.to_seq)} · n=${s.n||0}</div></div><div class="metric"><strong>${mins(s.avg)}</strong><span>P90 ${mins(s.p90)}</span></div><div class="metric"><strong>${mins(s.min)}</strong><span>min</span></div><div class="metric"><strong>${mins(s.max)}</strong><span>max</span></div><div class="metric"><strong>${mins(s.median)}</strong><span>median</span></div></div>`).join("")}`;
}
function gapBetween(prev,cur){ if(!prev||!cur)return null;const d=(new Date(cur)-new Date(prev))/60000;return Number.isFinite(d)&&d>=0&&d<60?d:null; }

function updateRangeVisual(){
  const range=$("#tripRange"); if(!range)return;
  const min=Number(range.min)||1,max=Number(range.max)||1,value=Number(range.value)||1;
  const pct=max===min?0:((value-min)/(max-min))*100;
  range.style.setProperty("--range-pct",`${pct}%`);
}
function updateNavigator(trips){
  const nav=$("#tripNavigator");
  if(!trips.length){nav.hidden=true;return;}
  nav.hidden=false;
  state.selectedTrip=Math.min(Math.max(state.selectedTrip,0),trips.length-1);
  const idx=state.selectedTrip,t=trips[idx];
  $("#selectedTripLabel").textContent=`第 ${idx+1} 班`;
  $("#selectedTripMeta").textContent=`${hhmm(t.start_time)}${t.duration_min!=null?` · 全程 ${mins(t.duration_min)}`:""}`;
  const range=$("#tripRange"); range.max=String(trips.length);range.value=String(idx+1);updateRangeVisual();
  $("#firstTripBtn").disabled=idx===0;$("#prevTripBtn").disabled=idx===0;$("#nextTripBtn").disabled=idx===trips.length-1;$("#lastTripBtn").disabled=idx===trips.length-1;
}
function applyTripFocus(idx,{scroll=false,pulse=false}={}){
  const grid=$(".trip-matrix-grid"); const trips=sortedTrips(); if(!grid||!trips.length)return;
  state.selectedTrip=Math.min(Math.max(Number(idx)||0,0),trips.length-1);
  $$(".trip-focus",grid).forEach(x=>x.classList.remove("trip-focus"));
  $$(`[data-trip="${state.selectedTrip}"]`,grid).forEach(x=>x.classList.add("trip-focus"));
  updateNavigator(trips);
  if(scroll){
    const head=$(`.matrix-trip-head[data-trip="${state.selectedTrip}"]`,grid);
    const scroller=$(".trip-matrix-scroll");
    if(head&&scroller){const stationWidth=parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--station-col"))||200;const left=Math.max(0,head.offsetLeft-stationWidth-10);scroller.scrollTo({left,behavior:"smooth"});}
  }
  if(pulse){const first=$(`.matrix-time-cell[data-trip="${state.selectedTrip}"]`,grid);if(first){first.classList.remove("cell-pulse");void first.offsetWidth;first.classList.add("cell-pulse");}}
}
function applyRowFocus(seq){
  const grid=$(".trip-matrix-grid"); if(!grid)return;
  const next=state.selectedStop===String(seq)?null:String(seq);state.selectedStop=next;
  $$(".row-focus",grid).forEach(x=>x.classList.remove("row-focus"));
  if(next)$$(`[data-stop="${CSS.escape(next)}"]`,grid).forEach(x=>x.classList.add("row-focus"));
}
function updateScrollEdges(){
  const scroller=$(".trip-matrix-scroll"); if(!scroller)return;
  const max=Math.max(0,scroller.scrollWidth-scroller.clientWidth);
  scroller.classList.toggle("has-right",scroller.scrollLeft<max-2);
  const hint=$(".matrix-scroll-hint");if(hint&&scroller.scrollLeft>12)hint.classList.add("fade");
}

function renderTrips(v){
  const stops=v.stops||[],trips=sortedTrips(v),tripList=$("#tripList");
  $("#tripCountPill").textContent=`${trips.length} 班`;
  if(!stops.length){$("#routeLegend").innerHTML="";$("#tripNavigator").hidden=true;tripList.innerHTML='<div class="empty">暫時未有車站資料</div>';return;}
  $("#routeLegend").innerHTML=`<div class="legend-start"><strong>${esc(stops[0].name)}</strong><span>起點</span></div><div class="legend-track" aria-hidden="true"></div><div class="legend-end"><strong>${esc(stops.at(-1).name)}</strong><span>${stops.length} 個站</span></div>`;
  if(!trips.length){$("#tripNavigator").hidden=true;tripList.innerHTML='<div class="empty">當日暫時未有足夠 ETA 數據重組班次</div>';return;}

  state.selectedTrip=Math.min(state.selectedTrip,trips.length-1); state.selectedStop=null;
  const first=trips.find(t=>t.start_time)?.start_time,last=[...trips].reverse().find(t=>t.start_time)?.start_time;
  const hint=`${first?hhmm(first):"—"}–${last?hhmm(last):"—"} · 左右滑動睇其他班次`;
  let cells=`<div class="matrix-corner matrix-header-cell"><div class="matrix-corner-title">車站</div><div class="matrix-corner-sub">${esc(hint)}</div></div>`;
  trips.forEach((t,idx)=>{cells+=`<button class="matrix-trip-head matrix-header-cell" type="button" data-trip="${idx}" aria-label="第 ${idx+1} 班，${hhmm(t.start_time)}"><strong>第${idx+1}班</strong><span>${hhmm(t.start_time)}</span><small>${t.duration_min!=null?mins(t.duration_min):""}</small></button>`;});
  stops.forEach((s,stopIdx)=>{
    const isFirst=stopIdx===0,isLast=stopIdx===stops.length-1;
    cells+=`<button class="matrix-station-cell ${isFirst?"first":""} ${isLast?"last":""}" type="button" data-stop="${esc(s.seq)}" aria-label="比較第 ${s.seq} 站 ${esc(s.name)}"><span class="matrix-line" aria-hidden="true"></span><span class="matrix-dot" aria-hidden="true"></span><span class="matrix-station-copy"><strong>${esc(`${s.seq}. ${s.name}`)}</strong><span>${isFirst?"起點":isLast?"終點":""}</span></span></button>`;
    trips.forEach((t,tripIdx)=>{
      const cur=t.arrivals?.[String(s.seq)],prev=stopIdx?t.arrivals?.[String(stops[stopIdx-1].seq)]:null,gap=gapBetween(prev,cur);
      const tooltip=cur?`${s.name} · 第${tripIdx+1}班 · ${hhmm(cur)}${gap!=null?` · 上一站 +${gap.toFixed(1)} 分鐘`:""}`:`${s.name} · 第${tripIdx+1}班 · 暫無時間`;
      cells+=`<button class="matrix-time-cell ${cur?"":"missing"}" type="button" data-trip="${tripIdx}" data-stop="${esc(s.seq)}" title="${esc(tooltip)}" aria-label="${esc(tooltip)}"><strong>${hhmm(cur)}</strong>${gap!=null?`<span>+${gap.toFixed(1)}m</span>`:"<span>&nbsp;</span>"}</button>`;
    });
  });
  tripList.innerHTML=`<div class="matrix-scroll-hint" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 7 3 12l5 5M16 7l5 5-5 5M4 12h16"/></svg> 左右滑動 · 點班次高亮整欄 · 點車站比較整行</div><div class="trip-matrix-scroll" tabindex="0" aria-label="所有班次逐站到站時間，可左右滑動"><div class="trip-matrix-grid" style="--trip-count:${trips.length}">${cells}</div></div>`;
  const grid=$(".trip-matrix-grid"),scroller=$(".trip-matrix-scroll");
  grid.style.animation="matrixIn .28s cubic-bezier(.2,.8,.2,1)";
  grid.addEventListener("click",e=>{
    const station=e.target.closest(".matrix-station-cell"); if(station){applyRowFocus(station.dataset.stop);return;}
    const trip=e.target.closest("[data-trip]"); if(trip){applyTripFocus(Number(trip.dataset.trip),{pulse:true});}
  });
  scroller.addEventListener("scroll",updateScrollEdges,{passive:true});
  requestAnimationFrame(()=>{applyTripFocus(state.selectedTrip);updateScrollEdges();});
}

function renderDataStatus(v){
  const demo=state.day?.date==="demo"||state.date==="demo",pill=$("#dataStatusPill");
  pill.className=`data-status ${demo?"":"live"}`;pill.innerHTML=`<i></i>${demo?"示範數據":"KMB 真 ETA"}`;
  const coverage=state.day?.coverage,coverageText=coverage?.last_observed_at?` · 收集至 ${hhmm(coverage.last_observed_at)}`:"";
  $("#statusText").textContent=`${state.route} · ${v.label} · ${demo?"示範數據":state.day.date}${coverageText}`;
  $("#generatedAt").textContent=state.day?.generated_at?`頁面更新 ${hhmm(state.day.generated_at)}`:"";
}
function render(){
  const v=currentVariant();if(!v){$("#statusText").textContent="沒有可顯示的方向/服務";return;}
  const segments=buildSegments(v);renderTrips(v);renderKpis(v,segments);renderRankList($("#slowestList"),segments,"avg");renderRankList($("#volatileList"),segments,"range");renderSegments(v,segments);renderDataStatus(v);
}
async function changeDate(date){
  try{setLoading(true);state.date=date;state.day=await loadDay(date);state.route=null;state.variant=null;state.selectedTrip=0;fillRouteSelect();fillVariantSelect();render();toast("已切換日期");}
  catch(e){showError(e);}finally{setLoading(false);}
}
function showError(e){
  const pill=$("#dataStatusPill");pill.className="data-status error";pill.innerHTML="<i></i>讀取失敗";$("#statusText").textContent=e?.message||"讀取失敗";toast("數據讀取失敗，請稍後再試");
}
async function refreshData(){
  try{setLoading(true);const oldDate=state.date;state.index=await loadIndex();if(!state.index.dates?.includes(oldDate))state.date=state.index.default_date||state.index.dates?.[0]||"demo";fillDateSelect();state.day=await loadDay(state.date);fillRouteSelect();fillVariantSelect();render();toast("已更新最新數據");}
  catch(e){showError(e);}finally{setLoading(false);}
}
async function boot(){
  try{state.index=await loadIndex();state.date=state.index.default_date||state.index.dates?.[0]||"demo";fillDateSelect();state.day=await loadDay(state.date);fillRouteSelect();fillVariantSelect();render();}
  catch(e){showError(e);}
}

$("#routeSelect").addEventListener("change",e=>{state.route=e.target.value;state.variant=null;state.selectedTrip=0;fillVariantSelect();render();});
$("#variantSelect").addEventListener("change",e=>{state.variant=e.target.value;state.selectedTrip=0;render();});
$("#dateSelect").addEventListener("change",e=>changeDate(e.target.value));
$("#segmentSort").addEventListener("change",()=>{const v=currentVariant();if(v)renderSegments(v,buildSegments(v));});
$("#refreshBtn").addEventListener("click",refreshData);
$("#firstTripBtn").addEventListener("click",()=>applyTripFocus(0,{scroll:true,pulse:true}));
$("#prevTripBtn").addEventListener("click",()=>applyTripFocus(state.selectedTrip-1,{scroll:true,pulse:true}));
$("#nextTripBtn").addEventListener("click",()=>applyTripFocus(state.selectedTrip+1,{scroll:true,pulse:true}));
$("#lastTripBtn").addEventListener("click",()=>applyTripFocus(sortedTrips().length-1,{scroll:true,pulse:true}));
$("#tripRange").addEventListener("input",e=>{updateRangeVisual();applyTripFocus(Number(e.target.value)-1,{scroll:true});});
$$('.tab').forEach(b=>b.addEventListener('click',()=>{$$('.tab').forEach(x=>x.classList.toggle('active',x===b));$$('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===b.dataset.tab));window.scrollTo({top:Math.min(window.scrollY,$('.tabs').offsetTop),behavior:'smooth'});}));
window.addEventListener("resize",()=>{updateScrollEdges();});
boot();
