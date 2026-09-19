# KMB Route Timing — 272A / 900

手機優先的九巴行車時間紀錄及分析頁面，可部署到 GitHub Pages。

## 功能

- 路線：272A、900
- 自動讀取九巴 route variant / service type
- 每分鐘保存 Route ETA 原始 snapshot 到 SQLite
- 每日輸出：
  - 每班推算到站時間
  - 相鄰站最快 / 最慢 / 平均 / 中位數 / P90
  - 全程時間
  - 最慢路段、波幅最大路段
- 手機版介面
- 歷史日期切換

## 重要限制

九巴 / 運輸署公開 API 是 **ETA**，不是官方「actual arrival GPS timestamp」，亦沒有穩定的 vehicle/trip ID。
因此本專案顯示的是 **ETA-based inferred arrival**。

如果你要「真正每架巴士的實際 GPS 到站秒數」，單靠現有公開 API 做不到；
但用 60 秒 ETA snapshot 做日常站間車程比較，仍然有實用價值。

## 1. 先試 UI

直接用簡單 HTTP server：

```bash
python3 -m http.server 8080
```

打開：

```text
http://localhost:8080
```

未有真實資料時會顯示 `data/demo.json`。

## 2. 收集資料

建議在一部 24/7 長開的 Mac / Linux / VPS 執行，而不是靠 GitHub Actions。
GitHub Actions 的 cron 並不適合一分鐘級、全日持續的 ETA polling。

```bash
cd collector
python3 collector.py --db ../kmb_eta.sqlite3 --poll-seconds 60
```

測試一次：

```bash
python3 collector.py --db ../kmb_eta.sqlite3 --once
```

## 3. 生成每日 JSON

例如生成 2026-09-20：

```bash
cd collector
python3 build_daily.py \
  --db ../kmb_eta.sqlite3 \
  --date 2026-09-20 \
  --out-dir ../data
```

然後 commit：

```bash
git add data/
git commit -m "data: 2026-09-20"
git push
```

## 4. GitHub Pages

Repo → **Settings** → **Pages** → Deploy from branch → `main` / root。

`index.html` 已經可以直接做 Pages 首頁。

## 5. 建議的正式部署方式

最穩陣：

```text
KMB Open Data
      ↓ 每 60 秒
24/7 collector (Mac/Linux/VPS)
      ↓
SQLite raw snapshots
      ↓ 每日凌晨
build_daily.py
      ↓
data/YYYY-MM-DD.json
      ↓
Git push
      ↓
GitHub Pages 手機 dashboard
```

### 點解保留 raw SQLite？

因為公開 API 沒有 vehicle ID，所以「同一班車」需要推算。
先保留 raw snapshot，日後改善 matching / clustering 演算法時可以重算歷史，不會丟失原始資料。

## API

使用 DATA.GOV.HK / KMB 公開 API：

- Route list: `https://data.etabus.gov.hk/v1/transport/kmb/route/`
- Route-stop: `https://data.etabus.gov.hk/v1/transport/kmb/route-stop/{route}/{direction}/{service_type}`
- Stop: `https://data.etabus.gov.hk/v1/transport/kmb/stop/{stop_id}`
- Route ETA: `https://data.etabus.gov.hk/v1/transport/kmb/route-eta/{route}/{service_type}`
