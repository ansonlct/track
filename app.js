const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = { index:null, day:null, route:null, variant:null, date:null };

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
function median(a){
  const b=[...a].sort((x,y)=>x-y); if(!b.length) return null;
  const m=Math.floor(b.length/2); return b.length%2 ? b[m] : (b[m-1]+b[m])/2;
}
function percentile(a,p){
  if(!a.length) return null; const b=[...a].sort((x,y)=>x-y);
  const i=(b.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i);
  return lo===hi?b[lo]:b[lo]+(b[hi]-b[lo])*(i-lo);
}
function calcStats(values){
  const a=values.filter(v=>Number.isFinite(v)&&v>=0);
  if(!a.length) return {n:0,min:null,max:null,avg:null,median:null,p90:null,range:null};
  const avg=a.reduce((x,y)=>x+y,0)/a.length;
  const min=Math.min(...a), max=Math.max(...a);
  return {n:a.length,min,max,avg,median:median(a),p90:percentile(a,.9),range:max-min};
}
function currentVariant(){
  return state.day?.routes?.[state.route]?.variants?.[state.variant] || null;
}
async function loadIndex(){
  try{
    const r=await fetch("./data/index.json",{cache:"no-store"});
    if(!r.ok) throw new Error("index missing");
    return await r.json();
  }catch(e){
    return {dates:["demo"], default_date:"demo", files:{demo:"demo.json"}};
  }
}
async function loadDay(date){
  const file=state.index.files?.[date] || `${date}.json`;
  const r=await fetch(`./data/${file}`,{cache:"no-store"});
  if(!r.ok) throw new Error(`讀取 ${file} 失敗`);
  return await r.json();
}
function fillDateSelect(){
  const s=$("#dateSelect"); s.innerHTML="";
  state.index.dates.forEach(d=>{
    const o=document.createElement("option"); o.value=d; o.textContent=d==="demo"?"示範數據":d; s.appendChild(o);
  });
  s.value=state.date;
}
function fillRouteSelect(){
  const s=$("#routeSelect"); s.innerHTML="";
  Object.keys(state.day.routes||{}).forEach(r=>{
    const o=document.createElement("option"); o.value=r; o.textContent=r; s.appendChild(o);
  });
  if(!state.route || !state.day.routes[state.route]) state.route=Object.keys(state.day.routes||{})[0];
  s.value=state.route;
}
function fillVariantSelect(){
  const s=$("#variantSelect"); s.innerHTML="";
  const variants=state.day.routes?.[state.route]?.variants||{};
  Object.entries(variants).forEach(([id,v])=>{
    const o=document.createElement("option"); o.value=id; o.textContent=v.label||id; s.appendChild(o);
  });
  if(!state.variant || !variants[state.variant]) state.variant=Object.keys(variants)[0];
  s.value=state.variant;
}
function buildSegments(v){
  if(v.segment_stats?.length) return v.segment_stats.map(x=>({...x}));
  const stops=v.stops||[], trips=v.trips||[];
  return stops.slice(0,-1).map((s,i)=>{
    const n=stops[i+1], values=[];
    trips.forEach(t=>{
      const a=t.arrivals?.[String(s.seq)], b=t.arrivals?.[String(n.seq)];
      if(!a||!b) return;
      const da=new Date(a), db=new Date(b);
      const diff=(db-da)/60000;
      if(Number.isFinite(diff)&&diff>=0&&diff<60) values.push(diff);
    });
    return {from_seq:s.seq,to_seq:n.seq,from_name:s.name,to_name:n.name,...calcStats(values)};
  });
}
function renderKpis(v,segments){
  const trips=v.trips||[];
  const complete=trips.filter(t=>t.duration_min!=null);
  const durations=complete.map(t=>t.duration_min);
  const ds=calcStats(durations);
  const slow=[...segments].filter(s=>s.n).sort((a,b)=>b.avg-a.avg)[0];
  const html=[
    ["班次樣本", trips.length, `${segments.reduce((a,s)=>a+s.n,0)} 段車程樣本`],
    ["全程平均", mins(ds.avg), `${ds.n} 班有完整首尾站`],
    ["全程最快", mins(ds.min), ds.n?`最慢 ${mins(ds.max)}`:"暫無資料"],
    ["最慢路段", slow?mins(slow.avg):"—", slow?`${slow.from_name} → ${slow.to_name}`:"暫無資料"],
  ].map(([l,vv,sub])=>`<div class="kpi"><div class="kpi-label">${esc(l)}</div><div class="kpi-value">${esc(vv)}</div><div class="kpi-sub">${esc(sub)}</div></div>`).join("");
  $("#kpiGrid").innerHTML=html;
}
function renderRankList(el,segments,mode){
  let arr=segments.filter(x=>x.n);
  arr.sort((a,b)=> mode==="avg" ? b.avg-a.avg : b.range-a.range);
  arr=arr.slice(0,5);
  el.innerHTML=arr.length?arr.map((s,i)=>`
    <div class="rank-row">
      <div class="rank-num">${i+1}</div>
      <div class="rank-main">
        <div class="rank-title">${esc(s.from_name)} → ${esc(s.to_name)}</div>
        <div class="rank-meta">樣本 ${s.n} · 快 ${mins(s.min)} · 慢 ${mins(s.max)} · P90 ${mins(s.p90)}</div>
      </div>
      <div class="rank-value">${mode==="avg"?mins(s.avg):mins(s.range)}</div>
    </div>`).join(""):`<div class="empty">暫時未有足夠樣本</div>`;
}
function renderSegments(v,segments){
  const sort=$("#segmentSort").value;
  let arr=[...segments];
  if(sort==="avgDesc") arr.sort((a,b)=>(b.avg??-1)-(a.avg??-1));
  if(sort==="maxDesc") arr.sort((a,b)=>(b.max??-1)-(a.max??-1));
  if(sort==="rangeDesc") arr.sort((a,b)=>(b.range??-1)-(a.range??-1));
  if(sort==="seq") arr.sort((a,b)=>Number(a.from_seq)-Number(b.from_seq));
  $("#segmentTable").innerHTML=`
    <div class="segment-row head">
      <div>路段</div><div class="metric">平均</div><div class="metric">最快</div><div class="metric">最慢</div><div class="metric">中位</div>
    </div>
    ${arr.map(s=>`
      <div class="segment-row">
        <div><div class="seg-name">${esc(s.from_name)}<br>→ ${esc(s.to_name)}</div><div class="seg-sub">#${esc(s.from_seq)}→#${esc(s.to_seq)} · n=${s.n||0}</div></div>
        <div class="metric"><strong>${mins(s.avg)}</strong><span>P90 ${mins(s.p90)}</span></div>
        <div class="metric"><strong>${mins(s.min)}</strong><span>min</span></div>
        <div class="metric"><strong>${mins(s.max)}</strong><span>max</span></div>
        <div class="metric"><strong>${mins(s.median)}</strong><span>median</span></div>
      </div>`).join("")}`;
}
function gapBetween(prev,cur){
  if(!prev || !cur) return null;
  const d=(new Date(cur)-new Date(prev))/60000;
  return Number.isFinite(d)&&d>=0&&d<60 ? d : null;
}
function renderTrips(v){
  const stops=v.stops||[];
  const trips=[...(v.trips||[])].sort((a,b)=>{
    const aa=a.start_time?new Date(a.start_time).getTime():Number.MAX_SAFE_INTEGER;
    const bb=b.start_time?new Date(b.start_time).getTime():Number.MAX_SAFE_INTEGER;
    return aa-bb;
  });
  const tripList=$("#tripList");
  $("#tripCountPill").textContent=`${trips.length} 班`;

  if(!stops.length){
    $("#routeLegend").innerHTML="";
    tripList.innerHTML='<div class="empty">暫時未有車站資料</div>';
    return;
  }

  $("#routeLegend").innerHTML=`
    <div class="legend-start"><strong>${esc(stops[0].name)}</strong><span>起點</span></div>
    <div class="legend-arrow">→</div>
    <div class="legend-end"><strong>${esc(stops[stops.length-1].name)}</strong><span>${stops.length} 個站</span></div>
  `;

  if(!trips.length){
    tripList.innerHTML='<div class="empty">當日暫時未有足夠 ETA 數據重組班次</div>';
    return;
  }

  const firstTrip=trips.find(t=>t.start_time)?.start_time;
  const lastTrip=[...trips].reverse().find(t=>t.start_time)?.start_time;
  const hint=`${firstTrip?hhmm(firstTrip):"—"}–${lastTrip?hhmm(lastTrip):"—"} · 左右滑動查看更多班次`;

  let cells=`
    <div class="matrix-corner matrix-header-cell">
      <div class="matrix-corner-title">車站</div>
      <div class="matrix-corner-sub">${esc(hint)}</div>
    </div>`;

  trips.forEach((t,idx)=>{
    const complete=t.duration_min!=null;
    cells+=`<div class="matrix-trip-head matrix-header-cell" data-trip="${idx}">
      <strong>第${idx+1}班</strong>
      <span>${t.start_time?hhmm(t.start_time):"—"}</span>
      <small>${complete?mins(t.duration_min):""}</small>
    </div>`;
  });

  stops.forEach((s,stopIdx)=>{
    const isFirst=stopIdx===0, isLast=stopIdx===stops.length-1;
    cells+=`<div class="matrix-station-cell ${isFirst?'first':''} ${isLast?'last':''}">
      <span class="matrix-line" aria-hidden="true"></span>
      <span class="matrix-dot" aria-hidden="true"></span>
      <div class="matrix-station-copy">
        <strong>${esc(`${s.seq}. ${s.name}`)}</strong>
        <span>${isFirst?'起點':isLast?'終點':''}</span>
      </div>
    </div>`;

    trips.forEach((t,tripIdx)=>{
      const cur=t.arrivals?.[String(s.seq)];
      const prev=stopIdx? t.arrivals?.[String(stops[stopIdx-1].seq)] : null;
      const gap=gapBetween(prev,cur);
      const tooltip=cur
        ? `${s.name} · 第${tripIdx+1}班 · ${hhmm(cur)}${gap!=null?` · 較上一站 +${gap.toFixed(1)} 分鐘`:''}`
        : `${s.name} · 第${tripIdx+1}班 · 暫無時間`;
      cells+=`<div class="matrix-time-cell ${cur?'':'missing'}" data-trip="${tripIdx}" title="${esc(tooltip)}">
        <strong>${hhmm(cur)}</strong>
        ${gap!=null?`<span>+${gap.toFixed(1)}m</span>`:'<span>&nbsp;</span>'}
      </div>`;
    });
  });

  tripList.innerHTML=`
    <div class="matrix-scroll-hint" aria-hidden="true"><span>←</span> 左右滑動睇其他班次 <span>→</span></div>
    <div class="trip-matrix-scroll" tabindex="0" aria-label="所有班次逐站到站時間，可左右滑動">
      <div class="trip-matrix-grid" style="--trip-count:${trips.length}">${cells}</div>
    </div>`;

  const scroller=tripList.querySelector('.trip-matrix-scroll');
  const grid=tripList.querySelector('.trip-matrix-grid');
  grid?.addEventListener('click',e=>{
    const target=e.target.closest('[data-trip]');
    if(!target) return;
    const n=target.dataset.trip;
    grid.querySelectorAll('.trip-focus').forEach(x=>x.classList.remove('trip-focus'));
    grid.querySelectorAll(`[data-trip="${n}"]`).forEach(x=>x.classList.add('trip-focus'));
  });
  scroller?.addEventListener('scroll',()=>{
    const hintEl=tripList.querySelector('.matrix-scroll-hint');
    if(hintEl && scroller.scrollLeft>18) hintEl.classList.add('fade');
  },{passive:true});
}

function renderDataStatus(v){
  const demo=state.day.date==="demo" || state.date==="demo";
  const pill=$("#dataStatusPill");
  pill.textContent=demo?"示範數據":"KMB 真 ETA";
  pill.classList.toggle("live",!demo);
  const coverage=state.day.coverage;
  const coverageText=coverage?.last_observed_at?` · 收集至 ${hhmm(coverage.last_observed_at)}`:"";
  $("#statusText").textContent=`${state.route} · ${v.label} · ${demo?"示範數據":state.day.date}${coverageText}`;
  $("#generatedAt").textContent=state.day.generated_at?`頁面更新 ${hhmm(state.day.generated_at)}`:"";
}
function render(){
  const v=currentVariant();
  if(!v){ $("#statusText").textContent="沒有可顯示的方向/服務"; return; }
  const segments=buildSegments(v);
  renderTrips(v);
  renderKpis(v,segments);
  renderRankList($("#slowestList"),segments,"avg");
  renderRankList($("#volatileList"),segments,"range");
  renderSegments(v,segments);
  renderDataStatus(v);
}
async function changeDate(date){
  state.date=date; state.day=await loadDay(date); state.route=null; state.variant=null;
  fillRouteSelect(); fillVariantSelect(); render();
}
async function boot(){
  try{
    state.index=await loadIndex();
    state.date=state.index.default_date||state.index.dates?.[0]||"demo";
    fillDateSelect();
    state.day=await loadDay(state.date);
    fillRouteSelect(); fillVariantSelect(); render();
  }catch(e){
    $("#statusText").textContent=`讀取失敗：${e.message}`;
    $("#dataStatusPill").textContent="錯誤";
  }
}
$("#routeSelect").addEventListener("change",e=>{state.route=e.target.value; state.variant=null; fillVariantSelect(); render();});
$("#variantSelect").addEventListener("change",e=>{state.variant=e.target.value; render();});
$("#dateSelect").addEventListener("change",e=>changeDate(e.target.value));
$("#segmentSort").addEventListener("change",render);
$("#refreshBtn").addEventListener("click",()=>location.reload());
$$(".tab").forEach(b=>b.addEventListener("click",()=>{
  $$(".tab").forEach(x=>x.classList.toggle("active",x===b));
  $$(".tab-panel").forEach(p=>p.classList.toggle("active",p.id===b.dataset.tab));
}));
boot();
