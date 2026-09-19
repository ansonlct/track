#!/usr/bin/env python3
"""
KMB 272A / 900 ETA snapshot collector.

Designed for both an always-on computer and GitHub Actions.
The public feed contains ETA predictions, not official actual-arrival timestamps,
so raw snapshots are retained temporarily and arrivals are inferred later.
"""

from __future__ import annotations
import argparse
import datetime as dt
import json
import sqlite3
import time
import urllib.error
import urllib.request

API = "https://data.etabus.gov.hk/v1/transport/kmb"
ROUTES = ("272A", "900")
HK = dt.timezone(dt.timedelta(hours=8))


def now_hk():
    return dt.datetime.now(HK)


def fetch_json(url: str, timeout=25, attempts=4):
    last = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "kmb-route-timing/2.0 (+personal analytics)",
                "Accept": "application/json",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            if attempt < attempts:
                time.sleep(min(2 ** attempt, 10))
    raise last


def init_db(conn):
    conn.executescript("""
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
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


def existing_variants(conn):
    rows = conn.execute("""SELECT route,bound,service_type FROM route_variants
                           WHERE route IN ('272A','900')""").fetchall()
    return sorted({(r[0], r[1], str(r[2])) for r in rows})


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
        if not bound:
            continue
        conn.execute("""INSERT OR REPLACE INTO route_variants
          (route,bound,service_type,orig_tc,dest_tc,updated_at)
          VALUES(?,?,?,?,?,?)""",
          (route,bound,st,r.get("orig_tc"),r.get("dest_tc"),ts))
        chosen.append((route,bound,st))
    conn.commit()
    return sorted(set(chosen))


def direction_path(bound):
    return "inbound" if bound == "I" else "outbound"


def metadata_needs_refresh(conn):
    row = conn.execute("SELECT MAX(updated_at), COUNT(*) FROM route_stops").fetchone()
    if not row or not row[1] or not row[0]:
        return True
    try:
        updated = dt.datetime.fromisoformat(row[0]).astimezone(HK)
        return updated.date() < now_hk().date() and now_hk().hour >= 5
    except Exception:
        return True


def refresh_stops(conn, variants):
    ts = now_hk().isoformat()
    stop_ids = set()
    for route,bound,st in variants:
        url=f"{API}/route-stop/{route}/{direction_path(bound)}/{st}"
        obj=fetch_json(url)
        conn.execute("DELETE FROM route_stops WHERE route=? AND bound=? AND service_type=?",
                     (route,bound,st))
        for r in obj.get("data",[]):
            sid=r.get("stop")
            if not sid:
                continue
            seq=int(r.get("seq") or 0)
            conn.execute("""INSERT OR REPLACE INTO route_stops
              (route,bound,service_type,seq,stop_id,updated_at)
              VALUES(?,?,?,?,?,?)""",(route,bound,st,seq,sid,ts))
            stop_ids.add(sid)
    conn.commit()

    # Route/stop metadata is daily data, so fetch each unique stop only on refresh.
    for i,sid in enumerate(sorted(stop_ids),1):
        try:
            s=fetch_json(f"{API}/stop/{sid}").get("data",{})
            conn.execute("""INSERT OR REPLACE INTO stops
              (stop_id,name_tc,name_en,lat,long,updated_at)
              VALUES(?,?,?,?,?,?)""",
              (sid,s.get("name_tc"),s.get("name_en"),
               float(s["lat"]) if s.get("lat") else None,
               float(s["long"]) if s.get("long") else None,ts))
            if i % 20 == 0:
                conn.commit()
        except Exception as e:
            print(f"[metadata] stop {sid}: {e}", flush=True)
    conn.commit()


def poll_once(conn, variants):
    observed=now_hk().isoformat()
    count=0
    # One call per route/service type is enough; payload includes stops/directions.
    route_services=sorted(set((r,st) for r,_,st in variants))
    for route,st in route_services:
        try:
            obj=fetch_json(f"{API}/route-eta/{route}/{st}")
            for x in obj.get("data",[]):
                if x.get("route") != route:
                    continue
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
            print(f"[poll] {route}/{st}: {e}", flush=True)
    conn.commit()
    return count


def prune_snapshots(conn, retention_days):
    if retention_days <= 0:
        return
    cutoff = now_hk() - dt.timedelta(days=retention_days)
    cur = conn.execute("DELETE FROM eta_snapshots WHERE observed_at < ?", (cutoff.isoformat(),))
    conn.commit()
    print(f"[prune] removed {cur.rowcount} snapshot rows older than {retention_days} days", flush=True)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--db",default="kmb_eta.sqlite3")
    ap.add_argument("--poll-seconds",type=int,default=60)
    ap.add_argument("--once",action="store_true")
    ap.add_argument("--max-polls",type=int,default=0,
                    help="Stop after N polls. 0 means keep running.")
    ap.add_argument("--retention-days",type=int,default=3,
                    help="Keep raw snapshots for this many days in the rolling DB.")
    args=ap.parse_args()

    conn=sqlite3.connect(args.db, timeout=30)
    init_db(conn)

    try:
        variants=discover_variants(conn)
    except Exception as e:
        print(f"[metadata] route discovery failed: {e}", flush=True)
        variants=existing_variants(conn)
    if not variants:
        raise SystemExit("No 272A/900 route variants available. Try the workflow again later.")

    if metadata_needs_refresh(conn):
        print("[metadata] refreshing route stops / stop names", flush=True)
        refresh_stops(conn,variants)
    else:
        print("[metadata] using cached daily route/stop metadata", flush=True)

    print("variants:", variants, flush=True)
    polls = 0
    last_meta_day=now_hk().date()

    try:
        while True:
            # Refresh daily metadata after 05:00 HKT, matching the provider cadence.
            if now_hk().date()!=last_meta_day and now_hk().hour>=5:
                try:
                    fresh=discover_variants(conn)
                    if fresh:
                        variants=fresh
                    refresh_stops(conn,variants)
                    last_meta_day=now_hk().date()
                except Exception as e:
                    print(f"[metadata] daily refresh failed: {e}", flush=True)

            n=poll_once(conn,variants)
            polls += 1
            print(now_hk().isoformat(timespec="seconds"), "rows", n, f"poll={polls}", flush=True)

            if args.once or (args.max_polls and polls >= args.max_polls):
                break
            time.sleep(max(15,args.poll_seconds))
    finally:
        prune_snapshots(conn,args.retention_days)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:
            pass
        conn.commit()
        conn.close()


if __name__=="__main__":
    main()
