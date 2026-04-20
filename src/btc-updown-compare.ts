#!/usr/bin/env node
/**
 * Fetch (optional) and compare Polymarket vs Kalshi BTC up/down candles aligned by period start (UTC).
 *
 * Alignment uses the same rule as the fetchers: `periodStartMsFromResolutionMs` on close/settlement time
 * so both venues map to one candle per `alignKey` (e.g. 15m:1745098800000).
 *
 * Config via .env (paths default to fetcher outputs):
 *   Poly_BTC_UPDOWN_OUTPUT, KALSHI_BTC_UPDOWN_OUTPUT
 *
 * Run:
 *   npm run compare:btc              — read JSON files only
 *   npm run compare:btc -- --fetch   — run both fetchers via npx tsx, then compare (Windows-safe)
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join } from 'path';
import {
  alignKey,
  periodStartMsFromResolutionMs,
  type Timeframe,
} from './btc-updown-period.js';

const VALID_TF: Timeframe[] = ['5m', '15m', '1h'];

interface LooseRow {
  timeframe: string;
  result: 'Yes' | 'No';
  periodStartMs?: number;
  alignKey?: string;
  slug?: string;
  closedTime?: string;
  endDate?: string;
  closeMs?: number;
  settlementTs?: string;
  settlementMs?: number;
  marketTicker?: string;
  eventTicker?: string;
}

interface FileShape {
  results?: LooseRow[];
  timeframes?: string[];
}

interface MismatchRow {
  key: string;
  timeframe: Timeframe;
  periodStartMs: number;
  poly?: LooseRow;
  kalshi?: LooseRow;
}

function isTimeframe(s: string): s is Timeframe {
  return VALID_TF.includes(s as Timeframe);
}

function normalizeRow(
  row: LooseRow,
  source: 'poly' | 'kalshi'
): { key: string; timeframe: Timeframe; periodStartMs: number } | null {
  if (!isTimeframe(row.timeframe)) return null;
  const tf = row.timeframe;
  let periodStartMs = row.periodStartMs;
  if (periodStartMs == null) {
    let ms: number | undefined;
    if (source === 'poly') {
      if (row.closeMs != null) ms = row.closeMs;
      else {
        const raw = row.closedTime ?? row.endDate;
        if (raw) ms = Date.parse(raw);
      }
    } else {
      if (row.settlementMs != null) ms = row.settlementMs;
      else if (row.settlementTs) ms = Date.parse(row.settlementTs);
    }
    if (ms == null || Number.isNaN(ms)) return null;
    periodStartMs = periodStartMsFromResolutionMs(ms, tf);
  }
  const key = row.alignKey ?? alignKey(tf, periodStartMs);
  return { key, timeframe: tf, periodStartMs };
}

function loadJson(path: string): FileShape {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as FileShape;
}

function indexByKey(
  rows: LooseRow[] | undefined,
  source: 'poly' | 'kalshi'
): Map<string, LooseRow> {
  const m = new Map<string, LooseRow>();
  if (!rows) return m;
  for (const row of rows) {
    const n = normalizeRow(row, source);
    if (!n) continue;
    if (m.has(n.key)) {
      console.warn(`Warning: duplicate ${source} key ${n.key} (keeping first)`);
      continue;
    }
    m.set(n.key, row);
  }
  return m;
}

interface JoinedRow {
  key: string;
  timeframe: Timeframe;
  periodStartMs: number;
  poly: LooseRow;
  kalshi: LooseRow;
  mismatch: boolean;
}

function colorRed(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}

function colorGreen(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}

function colorYellow(text: string): string {
  return `\x1b[33m${text}\x1b[0m`;
}

function colorResult(result: 'Yes' | 'No'): string {
  return result === 'Yes' ? colorGreen(result) : colorRed(result);
}

function formatJoinedRow(row: JoinedRow): string {
  const iso = new Date(row.periodStartMs).toISOString();
  const marker = row.mismatch ? 'DIFF' : 'same';
  const slug = row.poly.slug ?? '';
  const tick = row.kalshi.marketTicker ?? '';
  const polyResult = row.mismatch ? row.poly.result : colorResult(row.poly.result);
  const kalshiResult = row.mismatch
    ? row.kalshi.result
    : colorResult(row.kalshi.result);
  const base = `${iso}\t${row.timeframe}\t${polyResult}\t${kalshiResult}\t${marker}\t${slug}\t${tick}`;
  return row.mismatch ? colorYellow(base) : base;
}

function printMismatchContext(joinedRows: JoinedRow[], windowSize: number): void {
  const mismatchIdxs: number[] = [];
  for (let i = 0; i < joinedRows.length; i++) {
    if (joinedRows[i].mismatch) mismatchIdxs.push(i);
  }
  if (mismatchIdxs.length === 0) return;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of mismatchIdxs) {
    const start = Math.max(0, idx - windowSize);
    const end = Math.min(joinedRows.length - 1, idx + windowSize);
    const prev = ranges[ranges.length - 1];
    if (!prev || start > prev.end + 1) {
      ranges.push({ start, end });
    } else if (end > prev.end) {
      prev.end = end;
    }
  }

  console.log(
    colorYellow(
      `Mismatch context windows (each mismatch with ${windowSize} before and ${windowSize} after)`
    )
  );
  console.log(
    'periodStart (UTC)\tTF\tPolymarket\tKalshi\tFlag\tpoly slug\tkalshi ticker'
  );
  console.log('-'.repeat(120));

  for (let r = 0; r < ranges.length; r++) {
    const range = ranges[r];
    if (r > 0) console.log('-'.repeat(120));
    for (let i = range.start; i <= range.end; i++) {
      console.log(formatJoinedRow(joinedRows[i]));
    }
  }
  console.log('');
}

/** Run fetch scripts via `npx tsx` from project root. */
function runTsxScript(scriptFile: string, root: string): void {
  const rel = join('src', scriptFile);
  const r = spawnSync(`npx tsx "${rel}"`, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`tsx ${scriptFile} exited with code ${r.status}`);
  }
}

function resolveProjectPath(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p);
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(scriptDir, '..');
  const doFetch = process.argv.includes('--fetch');

  if (doFetch) {
    console.log('Fetching Polymarket (btc-updown-history)...\n');
    runTsxScript('btc-updown-history.ts', projectRoot);
    console.log('\nFetching Kalshi (kalshi-btc-updown-history)...\n');
    runTsxScript('kalshi-btc-updown-history.ts', projectRoot);
    console.log('');
  }

  const polyPath =
    process.env.Poly_BTC_UPDOWN_OUTPUT?.trim() ||
    process.env.POLY_BTC_UPDOWN_OUTPUT?.trim() ||
    process.env.BTC_UPDOWN_OUTPUT?.trim() ||
    'poly-btc-updown.json';
  const kalshiPath =
    process.env.KALSHI_BTC_UPDOWN_OUTPUT?.trim() ||
    'kalshi-btc-updown.json';

  const polyAbs = resolveProjectPath(projectRoot, polyPath);
  const kalshiAbs = resolveProjectPath(projectRoot, kalshiPath);

  console.log(`Polymarket file: ${polyPath}`);
  console.log(`Kalshi file:     ${kalshiPath}`);
  console.log('');

  const polyDoc = loadJson(polyAbs);
  const kalshiDoc = loadJson(kalshiAbs);

  const polyMap = indexByKey(polyDoc.results, 'poly');
  const kalshiMap = indexByKey(kalshiDoc.results, 'kalshi');

  if (polyMap.size === 0 && (polyDoc.results?.length ?? 0) > 0) {
    console.warn(
      'Polymarket rows had no usable timestamps. Re-fetch with the latest btc-updown-history (JSON must include closedTime / periodStartMs).'
    );
  }
  if (kalshiMap.size === 0 && (kalshiDoc.results?.length ?? 0) > 0) {
    console.warn(
      'Kalshi rows had no usable timestamps. Re-fetch with the latest kalshi-btc-updown-history.'
    );
  }

  const allKeys = new Set<string>([...polyMap.keys(), ...kalshiMap.keys()]);
  const sortedKeys = [...allKeys].sort((a, b) => {
    const ma = Number(a.split(':')[1] ?? 0);
    const mb = Number(b.split(':')[1] ?? 0);
    return mb - ma;
  });
  const joinedRows: JoinedRow[] = [];

  let matched = 0;
  let same = 0;
  let diff = 0;
  let polyOnly = 0;
  let kalshiOnly = 0;

  const diffs: MismatchRow[] = [];

  for (const key of sortedKeys) {
    const pr = polyMap.get(key);
    const kr = kalshiMap.get(key);
    if (pr && kr) {
      matched++;
      const n = normalizeRow(pr, 'poly');
      if (!n) continue;
      if (pr.result === kr.result) {
        same++;
        joinedRows.push({
          key,
          timeframe: n.timeframe,
          periodStartMs: n.periodStartMs,
          poly: pr,
          kalshi: kr,
          mismatch: false,
        });
      } else {
        diff++;
        diffs.push({
          key,
          timeframe: n.timeframe,
          periodStartMs: n.periodStartMs,
          poly: pr,
          kalshi: kr,
        });
        joinedRows.push({
          key,
          timeframe: n.timeframe,
          periodStartMs: n.periodStartMs,
          poly: pr,
          kalshi: kr,
          mismatch: true,
        });
      }
    } else if (pr && !kr) {
      polyOnly++;
    } else if (kr && !pr) {
      kalshiOnly++;
    }
  }

  console.log('Summary (aligned by period start UTC)');
  console.log('-'.repeat(60));
  console.log(`Candles in both:     ${matched}`);
  console.log(`Same outcome:        ${same}`);
  console.log(`Different outcome:   ${diff}`);
  console.log(`Polymarket only:     ${polyOnly}`);
  console.log(`Kalshi only:         ${kalshiOnly}`);
  console.log('');

  if (diffs.length > 0) {
    console.log('Mismatches (same candle, different Yes/No):');
    console.log(
      'periodStart (UTC)\tTF\tPolymarket\tKalshi\tpoly slug / kalshi ticker'
    );
    console.log('-'.repeat(100));
    for (const d of diffs) {
      const iso = new Date(d.periodStartMs).toISOString();
      const slug = d.poly?.slug ?? '';
      const tick = d.kalshi?.marketTicker ?? '';
      console.log(
        colorYellow(
          `${iso}\t${d.timeframe}\t${d.poly?.result}\t${d.kalshi?.result}\t${slug}\t${tick}`
        )
      );
    }
    console.log('');
    printMismatchContext(joinedRows, 7);
  }

  const polyOnlyKeys = sortedKeys.filter(
    (k) => polyMap.has(k) && !kalshiMap.has(k)
  );
  const kalOnlyKeys = sortedKeys.filter(
    (k) => kalshiMap.has(k) && !polyMap.has(k)
  );

  if (polyOnlyKeys.length > 0 && polyOnlyKeys.length <= 50) {
    console.log('Polymarket-only keys (no Kalshi row for same alignKey):');
    for (const k of polyOnlyKeys.slice(0, 50)) {
      const r = polyMap.get(k)!;
      const n = normalizeRow(r, 'poly');
      console.log(
        `  ${k}\t${n ? new Date(n.periodStartMs).toISOString() : ''}\t${r.slug ?? ''}`
      );
    }
    console.log('');
  } else if (polyOnlyKeys.length > 50) {
    console.log(
      `Polymarket-only: ${polyOnlyKeys.length} keys (omit listing; first key ${polyOnlyKeys[0]})`
    );
    console.log('');
  }

  if (kalOnlyKeys.length > 0 && kalOnlyKeys.length <= 50) {
    console.log('Kalshi-only keys (no Polymarket row for same alignKey):');
    for (const k of kalOnlyKeys.slice(0, 50)) {
      const r = kalshiMap.get(k)!;
      const n = normalizeRow(r, 'kalshi');
      console.log(
        `  ${k}\t${n ? new Date(n.periodStartMs).toISOString() : ''}\t${r.marketTicker ?? ''}`
      );
    }
    console.log('');
  } else if (kalOnlyKeys.length > 50) {
    console.log(
      `Kalshi-only: ${kalOnlyKeys.length} keys (omit listing; first key ${kalOnlyKeys[0]})`
    );
    console.log('');
  }

  if (diff > 0) {
    process.exitCode = 2;
  }
}

try {
  main();
} catch (e) {
  console.error('Error:', (e as Error).message);
  process.exit(1);
}
