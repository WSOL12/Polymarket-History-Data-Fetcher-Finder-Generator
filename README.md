# poly-copy

**Polymarket history data finder, checker & generator** — fetch resolved Polymarket Bitcoin Up/Down outcomes for **5m**, **15m**, and **1h** markets. Search, find, and generate historical prediction market data from Polymarket.

## What it returns

- Timeframe (`5m`, `15m`, `1h`)
- Closed time
- Result (`Yes` = Up, `No` = Down)
- Optional title (when `BTC_UPDOWN_VERBOSE=true`)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your preferences. See `.env.example` for all options.

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BTC_UPDOWN_DAYS_BACK` | Only markets closed in the last N days. Omit for no filter. | — |
| `BTC_UPDOWN_TIMEFRAMES` | Comma-separated: `5m`, `15m`, `1h` | all |
| `BTC_UPDOWN_OUTPUT` | JSON file path to save results. Omit to skip. | — |
| `BTC_UPDOWN_VERBOSE` | `true` to include title column in output | false |
| `BTC_UPDOWN_STREAK_MIN` | Streaks: only show runs >= N (see `npm run streaks`) | show all |

Example `.env`:

```env
BTC_UPDOWN_DAYS_BACK=2
BTC_UPDOWN_TIMEFRAMES=5m
BTC_UPDOWN_OUTPUT=btc-updown.json
BTC_UPDOWN_VERBOSE=false
BTC_UPDOWN_STREAK_MIN=6
```

## Run

```bash
npm run btc-updown
```

Or `npm run start` / `npm run dev` (same script).

### Streaks (consecutive Yes/No runs)

```bash
npm run streaks
```

Shows consecutive runs like `3: Yes`, `2: No`, `12: Yes`. Requires `btc-updown.json` (run `npm run btc-updown` first).

Set `BTC_UPDOWN_STREAK_MIN=6` in `.env` to only show runs of 6+.

## JSON output format

When `BTC_UPDOWN_OUTPUT` is set, the file contains:

```json
{
  "fetchedAt": "2026-03-23T10:35:00Z",
  "timeframes": ["5m"],
  "daysBack": 1,
  "total": 287,
  "yesCount": 145,
  "noCount": 142,
  "results": [
    { "timeframe": "5m", "result": "Yes" }
  ]
}
```

## Project structure

- `src/scripts/btc-updown-history.ts` — fetch history
- `src/scripts/btc-updown-streaks.ts` — consecutive Yes/No streaks
- `.env.example` — environment template (copy to `.env`)

---

**Keywords:** polymarket, polymarket history, polymarket data finder, polymarket checker, polymarket search, polymarket tool, polymarket history generator, prediction market, BTC up down, polymarket API, Gamma API
