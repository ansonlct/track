#!/usr/bin/env python3
"""
Build a GitHub-Pages friendly daily JSON from raw ETA snapshots.

Important limitation:
The public KMB feed has no stable vehicle/trip identifier. This script therefore
INFERS arrival events and reconstructed trips. It is designed for trend and
segment-time comparison, not second-by-second operational auditing.

Inference:
- At each stop, nearby ETA predictions are clustered into one arrival event.
- Event time is the median of the last few predictions seen closest to arrival.
- Consecutive-stop events are paired in chronological order within a plausible
  time window; overtaking / short-working / missing ETA can reduce confidence.
"""

from __future__ import annotations
import argparse, collections, datetime as dt, json, math, sqlite3, statistics
from pathlib import Path

HK = dt.timezone(dt.timedelta(hours=8))
CLUSTER_TOLERANCE_MIN = 4.0
MAX_SEGMENT_MIN = 30.0

def parse(s):
    if not s: return None
    return dt.datetime.fromisoformat(s.replace("Z","+00:00"))

def median(vals):
    vals=sorted(vals)
    if not vals: return None
    return statistics.median(vals)

def q(vals,p):
    if not vals: return None
    a=sorted(vals); k=(len(a)-1)*p; lo=math.floor(k); hi=math.ceil(k)
    return a[lo] if lo==hi else a[lo]+(a[hi]-a[lo])*(k-lo)

def stats(vals):
    a=[x for x in vals if x is not None and 0 <= x <= MAX_SEGMENT_MIN]
    if not a:
        return dict(n=0,min=None,max=None,avg=None,median=None,p90=None,range=None)
    mn,mx=min(a),max(a)
    return dict(n=len(a),min=round(mn,2),max=round(mx,2),
                avg=round(sum(a)/len(a),2),median=round(statistics.median(a),2),
                p90=round(q(a,.9),2),range=round(mx-mn,2))

def cluster_events(rows):
    """
    rows: [(observed_at, eta), ...] for one stop, one route/dir/service.
    Cluster ETA timestamps that represent the same approaching bus.
    """
    pts=[]
    for observed,eta in rows:
        o,e=parse(observed),parse(eta)
        if not o or not e: continue
        # Ignore stale ETA more than 3m behind observation and far-future > 3h.
        delta=(e-o).total_seconds()/60
        if delta < -3 or delta > 180: continue
        pts.append((o,e))
    pts.sort(key=lambda x:(x[1],x[0]))
    clusters=[]
    for o,e in pts:
        best=None; best_d=999
        for c in clusters[-8:]:
            d=abs((e-c["center"]).total_seconds()/60)
            if d<=CLUSTER_TOLERANCE_MIN and d<best_d:
                best,best_d=c,d
        if best is None:
            best={"etas":[],"obs":[],"center":e}; clusters.append(best)
        best["etas"].append(e); best["obs"].append(o)
        best["center"]=dt.datetime.fromtimestamp(
            statistics.median([x.timestamp() for x in best["etas"]]), tz=e.tzinfo)
    events=[]
    for c in clusters:
        # Prefer ETA samples observed close to the predicted arrival.
        paired=list(zip(c["obs"],c["etas"]))
        near=[e for o,e in paired if -1 <= (e-o).total_seconds()/60 <= 6]
        use=near[-5:] if near else c["etas"][-5:]
        est=dt.datetime.fromtimestamp(statistics.median([x.timestamp() for x in use]),tz=use[0].tzinfo)
        proximity=min(abs((e-o).total_seconds()/60) for o,e in paired)
        confidence="較高" if proximity<=1.5 and len(paired)>=2 else ("中" if proximity<=4 else "較低")
        events.append({"time":est,"confidence":confidence,"samples":len(paired)})
    events.sort(key=lambda x:x["time"])
    return events

def pair_segment(a_events,b_events):
    """Monotonic one-to-one pairing for adjacent stops."""
    pairs=[]; j=0
    for a in a_events:
        while j < len(b_events) and b_events[j]["time"] <= a["time"]:
            j+=1
        k=j
        while k < len(b_events):
            d=(b_events[k]["time"]-a["time"]).total_seconds()/60
            if d>MAX_SEGMENT_MIN: break
            if d>=0.15:
                pairs.append((a,b_events[k],d)); j=k+1; break
            k+=1
    return pairs

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--db",default="kmb_eta.sqlite3")
    ap.add_argument("--date",help="YYYY-MM-DD (Hong Kong date), default yesterday")
    ap.add_argument("--out-dir",default="../data")
    args=ap.parse_args()

    day=dt.date.fromisoformat(args.date) if args.date else (dt.datetime.now(HK).date()-dt.timedelta(days=1))
    start=dt.datetime.combine(day,dt.time(0),HK)
    end=start+dt.timedelta(days=1)

    conn=sqlite3.connect(args.db)
    conn.row_factory=sqlite3.Row
    variants=conn.execute("""SELECT * FROM route_variants WHERE route IN ('272A','900')
                             ORDER BY route,bound,CAST(service_type AS INTEGER)""").fetchall()

    coverage_row=conn.execute("""SELECT MIN(observed_at), MAX(observed_at), COUNT(*)
      FROM eta_snapshots WHERE observed_at>=? AND observed_at<?""",
      (start.isoformat(),end.isoformat())).fetchone()
    result={
        "date":day.isoformat(),
        "generated_at":dt.datetime.now(HK).isoformat(timespec="seconds"),
        "source":"KMB / Transport Department Route ETA API",
        "data_type":"ETA-based inferred arrival",
        "coverage":{
            "first_observed_at": coverage_row[0] if coverage_row else None,
            "last_observed_at": coverage_row[1] if coverage_row else None,
            "snapshot_rows": int(coverage_row[2] or 0) if coverage_row else 0,
        },
        "routes":{}
    }

    for vr in variants:
        route,bound,st=vr["route"],vr["bound"],str(vr["service_type"])
        # Route ETA uses direction I/O.
        key=f"{bound}-{st}"
        stops=conn.execute("""SELECT rs.seq,rs.stop_id,s.name_tc
          FROM route_stops rs LEFT JOIN stops s ON s.stop_id=rs.stop_id
          WHERE rs.route=? AND rs.bound=? AND rs.service_type=?
          ORDER BY rs.seq""",(route,bound,st)).fetchall()
        if len(stops)<2: continue

        by_seq={}
        for s in stops:
            rows=conn.execute("""SELECT observed_at,eta FROM eta_snapshots
              WHERE route=? AND dir=? AND CAST(service_type AS TEXT)=? AND seq=?
                AND observed_at>=? AND observed_at<?
                AND eta IS NOT NULL
              ORDER BY observed_at""",(route,bound,st,s["seq"],start.isoformat(),end.isoformat())).fetchall()
            by_seq[s["seq"]]=cluster_events([(r["observed_at"],r["eta"]) for r in rows])

        # Adjacent segment pairings and stats.
        segs=[]
        pairmaps={}
        for a,b in zip(stops,stops[1:]):
            pairs=pair_segment(by_seq[a["seq"]],by_seq[b["seq"]])
            pairmaps[(a["seq"],b["seq"])]=pairs
            stt=stats([p[2] for p in pairs])
            segs.append({
                "from_seq":a["seq"],"to_seq":b["seq"],
                "from_name":a["name_tc"] or a["stop_id"],
                "to_name":b["name_tc"] or b["stop_id"],**stt
            })

        # Reconstruct pseudo-trips starting from events at the first stop.
        first_seq=stops[0]["seq"]
        trips=[]
        for idx,ev in enumerate(by_seq[first_seq],1):
            arrivals={str(first_seq):ev["time"].isoformat()}
            conf=[ev["confidence"]]
            cur=ev
            for a,b in zip(stops,stops[1:]):
                if str(a["seq"]) not in arrivals: break
                candidates=pairmaps.get((a["seq"],b["seq"]),[])
                hit=None
                for aa,bb,d in candidates:
                    if abs((aa["time"]-cur["time"]).total_seconds())<=90:
                        hit=bb; break
                if hit is None: break
                arrivals[str(b["seq"])]=hit["time"].isoformat()
                conf.append(hit["confidence"]); cur=hit
            last=stops[-1]["seq"]
            duration=None
            if str(last) in arrivals:
                duration=(parse(arrivals[str(last)])-parse(arrivals[str(first_seq)])).total_seconds()/60
                duration=round(duration,2)
            trips.append({
                "id":f"{route}-{bound}{st}-{day.strftime('%Y%m%d')}-{idx:03d}",
                "start_time":ev["time"].isoformat(),
                "duration_min":duration,
                "confidence":"較高" if conf and all(x=="較高" for x in conf) else ("中" if "較低" not in conf else "較低"),
                "arrivals":arrivals
            })

        route_obj=result["routes"].setdefault(route,{"variants":{}})
        label=f'{vr["orig_tc"] or bound} → {vr["dest_tc"] or ""} · {bound}/{st}'
        route_obj["variants"][key]={
            "label":label,
            "stops":[{"seq":s["seq"],"stop_id":s["stop_id"],"name":s["name_tc"] or s["stop_id"]} for s in stops],
            "segment_stats":segs,
            "trips":trips
        }

    out=Path(args.out_dir); out.mkdir(parents=True,exist_ok=True)
    dayfile=out/f"{day.isoformat()}.json"

    # Avoid pointless Git commits when a completed historical day has not changed.
    # generated_at is preserved unless actual route/coverage content changed.
    should_write=True
    if dayfile.exists():
        try:
            old=json.loads(dayfile.read_text(encoding="utf-8"))
            same_payload=(old.get("routes")==result.get("routes") and
                          old.get("coverage")==result.get("coverage") and
                          old.get("source")==result.get("source") and
                          old.get("data_type")==result.get("data_type"))
            if same_payload:
                should_write=False
        except Exception:
            pass
    if should_write:
        dayfile.write_text(json.dumps(result,ensure_ascii=False,separators=(",",":")),encoding="utf-8")

    idxfile=out/"index.json"
    if idxfile.exists():
        try: idx=json.loads(idxfile.read_text(encoding="utf-8"))
        except Exception: idx={}
    else: idx={}
    dates=set(idx.get("dates",[])); dates.add(day.isoformat())
    dates=sorted((d for d in dates if d!="demo"), reverse=True)
    idx={"dates":dates,"default_date":dates[0] if dates else "demo",
         "files":{d:f"{d}.json" for d in dates}}
    idxfile.write_text(json.dumps(idx,ensure_ascii=False,indent=2),encoding="utf-8")
    print(dayfile)

if __name__=="__main__":
    main()
