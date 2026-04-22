#!/usr/bin/env node
/**
 * Backtest nested BTC Up/Down rules using only *early* sub-candles (no lookahead on the last sub-interval).
 *
 * Rules (defaults tunable via env):
 *   15m → 1h: First three 15m candles of each 1h (exclude last 15m). NESTED_MIN_SAME_15_TO_1H = minimum votes on the
 *             **winning** side (**≥**). With 3 sub-candles: 2 = majority (2–1 or 3–0), 3 = unanimous only.
 *   5m → 15m: First N×5m per 15m window (default N=2). NESTED_MIN_SAME_5_TO_15 = minimum votes on the winner (**≥**).
 *             One row per **15m** period in the data (not one per 5m row).
 *
 * Optional: require |sum(priceDiff)| of sub-candles that match the predicted direction ≥ min (USD).
 *
 * Input: one or more JSON files (Polymarket/Kalshi fetcher output). Merge `results` from all files.
 * You need 5m, 15m, and 1h rows in the merged set — fetch with e.g.
 *   BTC_UPDOWN_TIMEFRAMES=5m,15m,1h npm run poly:btc-updown
 *
 * Env:
 *   BTC_STRATEGY_INPUT       - single JSON path (default: poly-btc-updown.json)
 *   BTC_STRATEGY_INPUTS      - comma-separated extra paths to merge
 *   NESTED_MIN_SAME_15_TO_1H - min votes on winner (≥) among 3 fifteens (default 2 = majority; 3 = all 3)
 *   NESTED_5_TO_15_SLOTS     - 2 or 3 (default 2 = first two 5m only, excludes last 5m)
 *   NESTED_MIN_SAME_5_TO_15  - min votes on winner (≥) (default 2 with 2 slots = both 5m agree; 1 = looser)
 *   NESTED_MIN_ABS_PRICE_SUM_15_TO_1H / _5_TO_15 — optional USD floor on |sum(priceDiff)|
 *                              for sub-rows matching the predicted side (0 = off)
 *
 * Run:
 *   npm run nested
 *   npx tsx src/btc-updown-nested-strategy.ts other.json
 */
import 'dotenv/config';
import { readFileSync } from 'fs';

import {
  alignKey,
  periodMs,
  periodStartMsFromKalshiEventTicker,
  periodStartMsFromPolyBitcoinHourlySlug,
  periodStartMsFromPolyBtcUpDownSlug,
  periodStartMsFromResolutionMs,
  type Timeframe,
} from './btc-updown-period.js';

const TF: Timeframe[] = ['5m', '15m', '1h'];

interface LooseRow {
  timeframe: string;
  result: 'Yes' | 'No';
  slug?: string;
  eventTicker?: string;
  closedTime?: string;
  endDate?: string;
  settlementTs?: string;
  priceDiff?: number;
}

interface FileShape {
  results?: LooseRow[];
}

type Direction = 'up' | 'down';

function isTf(s: string): s is Timeframe {
  return (TF as string[]).includes(s);
}

function resultToDir(r: 'Yes' | 'No'): Direction {
  return r === 'Yes' ? 'up' : 'down';
}

function periodStartForRow(row: LooseRow, tf: Timeframe): number | null {
  if (row.slug) {
    const fromBtc = periodStartMsFromPolyBtcUpDownSlug(row.slug, tf);
    if (fromBtc != null) return fromBtc;
    if (tf === '1h') {
      const fromHourly = periodStartMsFromPolyBitcoinHourlySlug(row.slug);
      if (fromHourly != null) return fromHourly;
    }
  }
  if (row.eventTicker) {
    const p = periodStartMsFromKalshiEventTicker(row.eventTicker, tf);
    if (p != null) return p;
  }
  const raw = row.closedTime ?? row.endDate ?? row.settlementTs;
  if (raw) {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return periodStartMsFromResolutionMs(ms, tf);
  }
  return null;
}

function indexByTimeframe(
  rows: LooseRow[]
): Map<Timeframe, Map<string, LooseRow>> {
  const out = new Map<Timeframe, Map<string, LooseRow>>();
  for (const tf of TF) out.set(tf, new Map());

  for (const row of rows) {
    if (!isTf(row.timeframe)) continue;
    const tf = row.timeframe;
    const ps = periodStartForRow(row, tf);
    if (ps == null) continue;
    const key = alignKey(tf, ps);
    const m = out.get(tf)!;
    if (!m.has(key)) m.set(key, row);
  }
  return out;
}

function sumPriceDiffForDirection(
  rows: LooseRow[],
  predictYes: boolean
): number {
  let s = 0;
  for (const r of rows) {
    if (r.priceDiff == null || !Number.isFinite(r.priceDiff)) continue;
    if (predictYes && r.result === 'Yes') s += r.priceDiff;
    if (!predictYes && r.result === 'No') s += r.priceDiff;
  }
  return s;
}

/**
 * Winner must have **at least** `minOnWinner` votes and strictly outnumber the other side.
 * 3 slots: minOnWinner=2 → majority; 3 → unanimous. 2 slots: minOnWinner=2 → both bars agree.
 */
function predictFromCounts(
  dirs: Direction[],
  minOnWinner: number
): 'Yes' | 'No' | null {
  let yes = 0;
  let no = 0;
  for (const d of dirs) {
    if (d === 'up') yes++;
    else no++;
  }
  if (yes >= minOnWinner && yes > no) return 'Yes';
  if (no >= minOnWinner && no > yes) return 'No';
  return null;
}

interface StratResult {
  name: string;
  signal: number;
  success: number;
  fail: number;
  skip: number;
  skipMissing: number;
  skipNoVote: number;
  skipPrice: number;
}

function run15mTo1h(
  byTf: Map<Timeframe, Map<string, LooseRow>>,
  minOnWinner: number,
  minAbsPriceSum: number
): StratResult {
  const hMap = byTf.get('1h')!;
  const m15 = byTf.get('15m')!;
  const p15 = periodMs('15m');

  let signal = 0;
  let success = 0;
  let fail = 0;
  let skipMissing = 0;
  let skipNoVote = 0;
  let skipPrice = 0;

  for (const [, row1h] of hMap) {
    const hStart = periodStartForRow(row1h, '1h');
    if (hStart == null) {
      skipMissing++;
      continue;
    }

    const subs: LooseRow[] = [];
    for (let k = 0; k < 3; k++) {
      const start = hStart + k * p15;
      const k15 = alignKey('15m', start);
      const sub = m15.get(k15);
      if (!sub) {
        subs.length = 0;
        break;
      }
      subs.push(sub);
    }
    if (subs.length !== 3) {
      skipMissing++;
      continue;
    }

    const dirs = subs.map((r) => resultToDir(r.result));
    const pred = predictFromCounts(dirs, minOnWinner);
    if (pred == null) {
      skipNoVote++;
      continue;
    }

    if (minAbsPriceSum > 0) {
      const sum = sumPriceDiffForDirection(subs, pred === 'Yes');
      if (Math.abs(sum) < minAbsPriceSum) {
        skipPrice++;
        continue;
      }
    }

    signal++;
    if (pred === row1h.result) success++;
    else fail++;
  }

  const skip = skipMissing + skipNoVote + skipPrice;
  return {
    name: '15m → 1h (first 3×15m vs 1h)',
    signal,
    success,
    fail,
    skip,
    skipMissing,
    skipNoVote,
    skipPrice,
  };
}

function run5mTo15m(
  byTf: Map<Timeframe, Map<string, LooseRow>>,
  slots: 2 | 3,
  minOnWinner: number,
  minAbsPriceSum: number
): StratResult {
  const m5 = byTf.get('5m')!;
  const m15 = byTf.get('15m')!;
  const p5 = periodMs('5m');

  let signal = 0;
  let success = 0;
  let fail = 0;
  let skipMissing = 0;
  let skipNoVote = 0;
  let skipPrice = 0;

  const slotCount = slots === 2 ? 2 : 3;

  for (const [, row15] of m15) {
    const pStart = periodStartForRow(row15, '15m');
    if (pStart == null) {
      skipMissing++;
      continue;
    }

    const subs: LooseRow[] = [];
    for (let k = 0; k < slotCount; k++) {
      const start = pStart + k * p5;
      const sub = m5.get(alignKey('5m', start));
      if (!sub) {
        subs.length = 0;
        break;
      }
      subs.push(sub);
    }
    if (subs.length !== slotCount) {
      skipMissing++;
      continue;
    }

    const dirs = subs.map((r) => resultToDir(r.result));
    const pred = predictFromCounts(dirs, minOnWinner);
    if (pred == null) {
      skipNoVote++;
      continue;
    }

    if (minAbsPriceSum > 0) {
      const sum = sumPriceDiffForDirection(subs, pred === 'Yes');
      if (Math.abs(sum) < minAbsPriceSum) {
        skipPrice++;
        continue;
      }
    }

    signal++;
    if (pred === row15.result) success++;
    else fail++;
  }

  const skip = skipMissing + skipNoVote + skipPrice;
  return {
    name: `5m → 15m (first ${slotCount}×5m vs 15m)`,
    signal,
    success,
    fail,
    skip,
    skipMissing,
    skipNoVote,
    skipPrice,
  };
}

function parseEnvInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseEnvFloat(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadMergedResults(paths: string[]): LooseRow[] {
  const merged: LooseRow[] = [];
  for (const p of paths) {
    const raw = readFileSync(p, 'utf-8');
    const data = JSON.parse(raw) as FileShape;
    const rows = data.results ?? [];
    merged.push(...rows);
  }
  return merged;
}

function getInputPaths(cliPaths: string[]): string[] {
  if (cliPaths.length > 0) return cliPaths;

  const single =
    process.env.BTC_STRATEGY_INPUT?.trim() ||
    process.env.Poly_BTC_UPDOWN_OUTPUT?.trim() ||
    process.env.POLY_BTC_UPDOWN_OUTPUT?.trim() ||
    process.env.BTC_UPDOWN_OUTPUT?.trim() ||
    'poly-btc-updown.json';

  const extra = process.env.BTC_STRATEGY_INPUTS?.trim();
  const parts = [single];
  if (extra) {
    for (const p of extra.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
      parts.push(p);
    }
  }
  return parts;
}

function main() {
  const cliPaths = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const paths = getInputPaths(cliPaths);

  const min15To1h = Math.max(
    1,
    parseEnvInt('NESTED_MIN_SAME_15_TO_1H', 2)
  );
  const slotsRaw = parseEnvInt('NESTED_5_TO_15_SLOTS', 2);
  const slots: 2 | 3 = slotsRaw >= 3 ? 3 : 2;
  const defaultMin5To15 = 2;
  const min5To15 = Math.max(
    1,
    parseEnvInt('NESTED_MIN_SAME_5_TO_15', defaultMin5To15)
  );

  const price15 = parseEnvFloat('NESTED_MIN_ABS_PRICE_SUM_15_TO_1H', 0);
  const price515 = parseEnvFloat('NESTED_MIN_ABS_PRICE_SUM_5_TO_15', 0);

  let rows: LooseRow[];
  try {
    rows = loadMergedResults(paths);
  } catch (e) {
    console.error(`Cannot read input: ${(e as Error).message}`);
    process.exit(1);
  }

  const byTf = indexByTimeframe(rows);

  const counts = TF.map((tf) => byTf.get(tf)!.size);
  console.log('Nested BTC Up/Down backtest');
  console.log(`Input: ${paths.join(', ')}`);
  console.log(
    `Rows indexed: 5m=${counts[0]}, 15m=${counts[1]}, 1h=${counts[2]}`
  );
  console.log(
    `Scope: 15m→1h tests each **1h** row (≤${counts[2]} signals if data complete). ` +
      `5m→15m tests each **15m** row (≤${counts[1]}), not each 5m row.`
  );
  console.log();
  console.log('Parameters (min votes on **winning** side, **≥**):');
  console.log(`  NESTED_MIN_SAME_15_TO_1H=${min15To1h}`);
  console.log(`  NESTED_5_TO_15_SLOTS=${slots}  NESTED_MIN_SAME_5_TO_15=${min5To15}`);
  console.log(
    `  price floors (USD, 0=off): 15→1h=${price15}, 5→15=${price515}`
  );
  console.log();

  const strats: StratResult[] = [
    run15mTo1h(byTf, min15To1h, price15),
    run5mTo15m(byTf, slots, min5To15, price515),
  ];

  for (const s of strats) {
    const rate =
      s.signal > 0 ? ((100 * s.success) / s.signal).toFixed(1) : 'n/a';
    console.log(`${s.name}`);
    console.log(
      `  signals=${s.signal}  success=${s.success}  fail=${s.fail}  skip=${s.skip}  hit-rate=${rate}%`
    );
    console.log(
      `  skip detail: missing=${s.skipMissing}  no-vote=${s.skipNoVote}  price=${s.skipPrice}`
    );
  }

  if (counts[0] === 0 || counts[1] === 0 || counts[2] === 0) {
    console.log();
    console.log(
      'Tip: index counts show missing timeframes. Fetch all with BTC_UPDOWN_TIMEFRAMES=5m,15m,1h'
    );
  }
}

main();
