#!/usr/bin/env python3
"""
KMB 272A / 900 ETA snapshot collector.

What it does:
1) Discovers route variants/service types from KMB's public route-list API.
2) Refreshes route-stop + stop-name metadata.
3) Polls Route ETA every POLL_SECONDS (default 60).
4) Stores RAW snapshots in SQLite. Raw data is deliberately kept so the
   arrival-inference algorithm can be improved later without losing history.

This does NOT receive official GPS "actual arrival" timestamps. KMB's public
API publishes ETA, so actual arrivals must be inferred in post-processing.
"""

from __future__ import annotations
import argparse, datetime as dt, json, sqlite3, time, urllib.request, urllib.error
from pathlib import Path

API = "https://data.etabus.gov.hk/v1/transport/kmb"
ROUTES = ("272A", "900")
HK = dt.timezone(dt.timedelta(hours=8))

def now_hk():
    return dt.datetime.now(HK)

def fetch_json(url: str, timeout=20):
    req = urllib.request.Request(url, headers={
        "User-Agent": "kmb-route-timing/1.0 (+personal analytics)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))

def init_db(conn):
    conn.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS route_variants(
      route TEXT NOT NULL, bound TEXT NOT NULL, service_type TEXT NOT NULL,
      orig_tc TEXT, dest_tc TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(route,bound,service_type)
    );
    CREATE TABLE IF NOT EXISTS stops(
      stop_id TEXT PRIMARY KEY, name_tc TEXT, name_en TEXT, lat REAL, long REAL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS route_stops(
      route TEXT NOT NULL, bound TEXT NOT NULL, service_type TEXT NOT NULL,
      seq INTEGER NOT NULL, stop_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(route,bound,service_type,seq)
    );
    CREATE TABLE IF NOT EXISTS eta_snapshots(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL, route TEXT NOT NULL, dir TEXT,
      service_type INTEGER, seq INTEGER, stop_id TEXT, eta_seq INTEGER,
      eta TEXT, dest_tc TEXT, rmk_tc TEXT, data_timestamp TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_eta_route_time
      ON eta_snapshots(route, observed_at);
    CREATE INDEX IF NOT EXISTS idx_eta_stop
      ON eta_snapshots(route,dir,service_type,seq,eta);
    """)
    conn.commit()

def discover_variants(conn):
    obj = fetch_json(f"{API}/route/")
    rows = obj.get("data", [])
    ts = now_hk().isoformat()
    chosen = []
    for r in rows:
        if r.get("route") not in ROUTES:
            continue
        route = r["route"]
        bound = r.get("bound") or r.get("dir")
        st = str(r.get("service_type", "1"))
        conn.execute("""INSERT OR REPLACE INTO route_variants
          (route,bound,service_type,orig_tc,dest_tc,updated_at)
          VALUES(?,?,?,?,?,?)""",
          (route,bound,st,r.get("orig_tc"),r.get("dest_tc"),ts))
        chosen.append((route,bound,st))
    conn.commit()
    return sorted(set(chosen))

def direction_path(bound):
    return "inbound" if bound == "I" else "outbound"

def refresh_stops(conn, variants):
    ts = now_hk().isoformat()
    stop_ids = set()
    for route,bound,st in variants:
        url=f"{API}/route-stop/{route}/{direction_path(bound)}/{st}"
        obj=fetch_json(url)
        for r in obj.get("data",[]):
            sid=r.get("stop")
            if not sid: continue
            seq=int(r.get("seq") or 0)
            conn.execute("""INSERT OR REPLACE INTO route_stops
              (route,bound,service_type,seq,stop_id,updated_at)
              VALUES(?,?,?,?,?,?)""",(route,bound,st,seq,sid,ts))
            stop_ids.add(sid)
    conn.commit()

    # Metadata is daily data; fetch each unique stop once on refresh.
    for i,sid in enumerate(sorted(stop_ids),1):
        try:
            s=fetch_json(f"{API}/stop/{sid}").get("data",{})
            conn.execute("""INSERT OR REPLACE INTO stops
              (stop_id,name_tc,name_en,lat,long,updated_at)
              VALUES(?,?,?,?,?,?)""",
              (sid,s.get("name_tc"),s.get("name_en"),
               float(s["lat"]) if s.get("lat") else None,
               float(s["long"]) if s.get("long") else None,ts))
            if i % 20 == 0: conn.commit()
        except Exception as e:
            print(f"[metadata] stop {sid}: {e}")
    conn.commit()

def poll_once(conn, variants):
    observed=now_hk().isoformat()
    count=0
    # One call per route/service type is enough; payload contains directions/stops.
    route_services=sorted(set((r,st) for r,_,st in variants))
    for route,st in route_services:
        try:
            obj=fetch_json(f"{API}/route-eta/{route}/{st}")
            for x in obj.get("data",[]):
                if x.get("route") != route: continue
                conn.execute("""INSERT INTO eta_snapshots
                  (observed_at,route,dir,service_type,seq,stop_id,eta_seq,eta,dest_tc,rmk_tc,data_timestamp)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?)""",(
                    observed, route, x.get("dir"),
                    int(x["service_type"]) if x.get("service_type") is not None else None,
                    int(x["seq"]) if x.get("seq") is not None else None,
                    x.get("stop"),
                    int(x["eta_seq"]) if x.get("eta_seq") is not None else None,
                    x.get("eta"),x.get("dest_tc"),x.get("rmk_tc"),x.get("data_timestamp")
                  ))
                count+=1
        except Exception as e:
            print(f"[poll] {route}/{st}: {e}")
    conn.commit()
    return count

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--db",default="kmb_eta.sqlite3")
    ap.add_argument("--poll-seconds",type=int,default=60)
    ap.add_argument("--once",action="store_true")
    args=ap.parse_args()
    conn=sqlite3.connect(args.db)
    init_db(conn)

    variants=discover_variants(conn)
    if not variants:
        raise SystemExit("No 272A/900 route variants discovered from KMB API.")
    print("variants:", variants)
    refresh_stops(conn,variants)

    last_meta_day=now_hk().date()
    while True:
        if now_hk().date()!=last_meta_day and now_hk().hour>=5:
            variants=discover_variants(conn)
            refresh_stops(conn,variants)
            last_meta_day=now_hk().date()
        n=poll_once(conn,variants)
        print(now_hk().isoformat(timespec="seconds"),"rows",n)
        if args.once: break
        time.sleep(max(15,args.poll_seconds))

if __name__=="__main__":
    main()
