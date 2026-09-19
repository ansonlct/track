# KMB 272A / 900 Route Timing — GitHub-only Real Data

手機優先的九巴 272A / 900 行車時間記錄頁。新版不需要 Mac Studio、NAS 或其他長開電腦：GitHub Actions 會自動輪流收集 KMB / 運輸署公開 Route ETA，整理成每日 JSON，再由 GitHub Pages 顯示。

## 你會見到甚麼

- 「逐班車」預設為首頁。
- 每個方向以地鐵線式時間軸顯示：左邊站名、中間直線及站點、右邊推算到站時間。
- 顯示每一站與上一站相差幾多分鐘。
- 站間分析：平均、最快、最慢、中位數、P90、波幅。
- 總覽：完整班次平均 / 最快、最慢路段等。
- 日期、272A / 900、方向 / service type 可切換。

## 真數據的意思

來源是：

`https://data.etabus.gov.hk/v1/transport/kmb/route-eta/{route}/{service_type}`

公開 API 提供 ETA，不提供每架車的官方 GPS actual-arrival timestamp。因此本系統每分鐘保存 ETA snapshot，再推算每站到達事件和班次。頁面上的時間應理解為 **ETA-based inferred arrival**。

## GitHub 自動收集架構

```text
KMB / Transport Department Route ETA
                │
                ▼
        GitHub Actions runner
       約每 60 秒 poll 一次
                │
                ▼
   rolling SQLite (Actions artifact)
      只保留最近約 3 日 raw data
                │
                ▼
       collector/build_daily.py
                │
                ▼
       data/YYYY-MM-DD.json
                │
                ▼
          GitHub Pages
```

`.github/workflows/build.yml` 會每小時啟動一個 runner，每個 runner 內連續收集約 57 分鐘、約每 60 秒 poll 一次。`concurrency` 會避免兩個 collector 同時改同一份 state；上一個 job 如果仲收尾，下一個會等佢完成。網站每日 JSON 因此大約每小時更新一次。

Rolling SQLite 不會 commit 入 Git history；每個 collector 完成後會上載成短期 Actions artifact，下一個 collector 自動下載最新 state 繼續。Workflow 只保留最新兩份 state artifact，避免 artifact storage 無限增長。

## 第一次設定

### 1. Upload / push 整個 project 到 GitHub

保留以下結構：

```text
.github/workflows/build.yml
collector/collector.py
collector/build_daily.py
data/
index.html
app.js
styles.css
```

### 2. 開 GitHub Actions

Repository → **Actions**。

第一次可以手動選擇 **Collect KMB real ETA** → **Run workflow**，不用等 cron。

### 3. 允許 workflow 寫回每日 JSON

如果 workflow 在 `git push` 顯示 permission denied：

Repository → **Settings** → **Actions** → **General** → **Workflow permissions** → 選 **Read and write permissions**。

如果 default branch 有 branch protection / ruleset 阻止 `github-actions[bot]` push，也要容許這個 workflow 更新 `data/*.json`，或者改用獨立 data branch。

### 4. GitHub Pages

Repository → **Settings** → **Pages**：

- Deploy from a branch
- Branch: 你的 default branch（通常 `main`）
- Folder: `/ (root)`

然後等 Pages deployment 完成。

## 第一次真數據幾時出現？

Workflow 一開始就會收 ETA，但「逐班車」要有一段連續 snapshot 才能重組到站事件。第一次手動 Run workflow 後，網站未必即時出現完整班次；大約完成第一個一小時收集段後會 build 當日 JSON 並 push 到 repo。之後一般約每小時更新一次。

`data/index.json` 一旦有真日期，例如：

```json
{
  "dates": ["2026-09-20"],
  "default_date": "2026-09-20",
  "files": {
    "2026-09-20": "2026-09-20.json"
  }
}
```

網站就會預設讀真數據，而不是 `demo.json`。

## 如何確認 collector 正常

到 GitHub → **Actions** → **Collect KMB real ETA** → 最新 run。

在 `Poll official KMB Route ETA roughly every minute` 應會見到類似：

```text
variants: [('272A', 'I', '1'), ...]
2026-09-20T...+08:00 rows 123 poll=1
2026-09-20T...+08:00 rows 121 poll=2
```

之後 `Build current day and previous day JSON` 會建立 / 更新 `data/YYYY-MM-DD.json`。

## 重要限制

1. GitHub scheduled workflows 不是硬即時系統，開始時間可能延遲；所以不能保證 24/7 每一分鐘零缺口。
2. KMB 公開數據是 ETA，不是官方 actual-arrival log。
3. 沒有穩定 vehicle / trip ID，班次是按相鄰站事件及時間順序推算。
4. 缺 ETA、特別班次、短途、越站或兩架車非常接近時，可能出現低可信度 / 未完整班次。
5. 這個 project 適合比較日常站間時間與長期趨勢，不應當成營運商秒級 audit system。

## 本地測試（可選）

完全不是正式運行所必須，只供開發測試：

```bash
python3 collector/collector.py --db kmb_eta.sqlite3 --once
python3 collector/build_daily.py --db kmb_eta.sqlite3 --date 2026-09-20 --out-dir data
python3 -m http.server 8000
```

瀏覽 `http://localhost:8000/`。

> 成本提示：如果 repository 是 **public**，GitHub-hosted standard runners 一般不計 billable Actions minutes；如果是 private repo，長時間 collector 可能消耗你方案內的 Actions minutes。
