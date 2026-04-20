#!/usr/bin/env node
/**
 * Fetch BTC Up/Down historical results (5m, 15m, 1h) from Polymarket.
 * Outputs only the resolution: Yes (Up) or No (Down).
 *
 * Config via .env:
 *   BTC_UPDOWN_DAYS_BACK  - only markets resolved in last N days (omit for no period filter)
 *   BTC_UPDOWN_TIMEFRAMES - comma-separated: 5m, 15m, 1h (default: all)
 *   Poly_BTC_UPDOWN_OUTPUT - JSON file path to save results (omit to skip)
 *   BTC_UPDOWN_VERBOSE    - true to include title column
 *
 * Run: npm run btc-updown
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import {
  alignKey,
  periodStartMsFromResolutionMs,
} from './btc-updown-period.js';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

type Timeframe = '5m' | '15m' | '1h';

interface BtcUpDownResult {
  timeframe: Timeframe;
  slug: string;
  title: string;
  endDate: string;
  result: 'Yes' | 'No';
  closedTime?: string;
}

const SLUG_PATTERNS: Record<Timeframe, RegExp> = {
  '5m': /^btc-updown-5m-\d+$/i,
  '15m': /^btc-updown-15m-\d+$/i,
  // 1h: btc-updown-1h-* or bitcoin-up-or-down-*-et (hourly series)
  '1h': /^(?:btc-updown-1h(?:r)?-\d+|bitcoin-up-or-down-[a-z0-9-]+-et)$/i,
};

function parseClosedTime(closedTime?: string): number | null {
  if (!closedTime) return null;
  const ms = new Date(closedTime).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function getTimeframeFromSlug(slug: string): Timeframe | null {
  if (SLUG_PATTERNS['5m'].test(slug)) return '5m';
  if (SLUG_PATTERNS['15m'].test(slug)) return '15m';
  if (SLUG_PATTERNS['1h'].test(slug)) return '1h';
  return null;
}

function parseResolution(
  outcomesStr: string,
  outcomePricesStr: string
): 'Yes' | 'No' | null {
  let outcomes: string[];
  let prices: string[];
  try {
    outcomes = JSON.parse(outcomesStr) as string[];
    prices = JSON.parse(outcomePricesStr) as string[];
  } catch {
    return null;
  }
  if (!Array.isArray(outcomes) || !Array.isArray(prices) || outcomes.length < 2)
    return null;

  // "Up" is typically first, "Down" second
  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up');
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === 'down');
  if (upIdx === -1 || downIdx === -1) return null;

  const upPrice = parseFloat(String(prices[upIdx] ?? 0));
  const downPrice = parseFloat(String(prices[downIdx] ?? 0));

  if (upPrice >= 0.99) return 'Yes';
  if (downPrice >= 0.99) return 'No';
  return null;
}

/** Tag 102892 = 5M, 102467 = 15M, 102175 = 1H. Fallback 102127 = Up or Down */
const TAG_BY_TIMEFRAME: Partial<Record<Timeframe, string>> = {
  '5m': '102892',
  '15m': '102467',
  '1h': '102175',
};
const FALLBACK_TAG = '102127';

async function fetchEvents(
  limit: number,
  offset: number,
  tagId?: string
): Promise<{ events: unknown[]; hasMore: boolean }> {
  const url = new URL('/events', GAMMA_BASE);
  url.searchParams.set('closed', 'true');
  // Ensure newest markets first so period pagination can stop correctly.
  url.searchParams.set('order', 'closedTime');
  url.searchParams.set('ascending', 'false');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (tagId) url.searchParams.set('tag_id', tagId);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);
  const data = (await res.json()) as unknown[];
  if (!Array.isArray(data)) return { events: [], hasMore: false };
  return { events: data, hasMore: data.length >= limit };
}

function extractResults(events: unknown[]): BtcUpDownResult[] {
  const results: BtcUpDownResult[] = [];

  for (const ev of events) {
    const e = ev as {
      slug?: string;
      title?: string;
      endDate?: string;
      closedTime?: string;
      markets?: Array<{
        slug?: string;
        outcomes?: string;
        outcomePrices?: string;
        endDate?: string;
        closedTime?: string;
        umaResolutionStatus?: string;
      }>;
    };

    const slug = e.slug ?? e.markets?.[0]?.slug ?? '';
    const timeframe = getTimeframeFromSlug(slug);
    if (!timeframe) continue;

    const market = e.markets?.[0];
    if (!market) continue;

    const status = market.umaResolutionStatus;
    if (status !== 'resolved') continue;

    const result = parseResolution(
      market.outcomes ?? '[]',
      market.outcomePrices ?? '[]'
    );
    if (!result) continue;

    results.push({
      timeframe,
      slug,
      title: e.title ?? market.slug ?? slug,
      endDate: market.endDate ?? e.endDate ?? '',
      result,
      closedTime: market.closedTime ?? e.closedTime,
    });
  }

  return results;
}

function inPeriod(
  r: BtcUpDownResult,
  start: number | null,
  end: number | null
): boolean {
  const ms = parseClosedTime(r.closedTime ?? r.endDate);
  if (ms == null) return false;
  if (start != null && ms < start) return false;
  if (end != null && ms >= end) return false;
  return true;
}

function filterByPeriodRange(
  results: BtcUpDownResult[],
  start: number | null,
  end: number | null
): BtcUpDownResult[] {
  if (start == null && end == null) return results;
  return results.filter((r) => inPeriod(r, start, end));
}

async function fetchBtcUpDownHistory(
  timeframes: Timeframe[],
  periodStartMs: number | null
): Promise<BtcUpDownResult[]> {
  const allResults: BtcUpDownResult[] = [];
  const seen = new Set<string>();

  const hasPeriod = periodStartMs != null;
  const maxPages = hasPeriod ? 800 : 50;

  for (const tf of timeframes) {
    const tagId = TAG_BY_TIMEFRAME[tf] ?? FALLBACK_TAG;
    const tagsToTry = [tagId];
    if (tagId !== FALLBACK_TAG && tf === '15m') tagsToTry.push(FALLBACK_TAG);

    for (const tryTag of tagsToTry) {
      let offset = 0;
      for (let page = 0; page < maxPages; page++) {
        const { events, hasMore } = await fetchEvents(100, offset, tryTag);
        const results = extractResults(events);
        for (const r of results) {
          if (!timeframes.includes(r.timeframe)) continue;
          if (seen.has(r.slug)) continue;
          seen.add(r.slug);
          allResults.push(r);
        }

        // With newest-first ordering, stop once this page is older than period start.
        if (periodStartMs != null && results.length > 0) {
          let oldestMs: number | null = null;
          for (const r of results) {
            const ms = parseClosedTime(r.closedTime ?? r.endDate);
            if (ms == null) continue;
            if (oldestMs == null || ms < oldestMs) oldestMs = ms;
          }
          if (oldestMs != null && oldestMs < periodStartMs) break;
        }

        offset += 100;
        if (!hasMore || events.length === 0) break;
      }
      // For each timeframe, first tag is enough in most cases.
      if (tryTag === tagId) break;
    }
  }

  const filtered = filterByPeriodRange(allResults, periodStartMs, null);
  return sortAndTrimResults(filtered, timeframes, Number.MAX_SAFE_INTEGER);
}

function sortAndTrimResults(
  results: BtcUpDownResult[],
  timeframes: Timeframe[],
  limitPerTimeframe: number
): BtcUpDownResult[] {
  const byTf = new Map<Timeframe, BtcUpDownResult[]>();
  for (const r of results) {
    const arr = byTf.get(r.timeframe) ?? [];
    arr.push(r);
    byTf.set(r.timeframe, arr);
  }

  const out: BtcUpDownResult[] = [];
  for (const tf of timeframes) {
    const arr = (byTf.get(tf) ?? []).sort(
      (a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime()
    );
    out.push(...arr.slice(0, limitPerTimeframe));
  }
  return out.sort(
    (a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime()
  );
}

function formatResult(r: BtcUpDownResult, verbose: boolean): string {
  const time = r.closedTime ?? r.endDate;
  if (verbose) {
    return `${r.timeframe}\t${time}\t${r.result}\t${r.title}`;
  }
  return `${r.timeframe}\t${time}\t${r.result}`;
}

const VALID_TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h'];

function pickFirstEnv(...candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    const v = c?.trim();
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function getConfig(): {
  timeframes: Timeframe[];
  daysBack: number | null;
  verbose: boolean;
  outputPath: string | null;
} {
  const daysBackEnv = process.env.BTC_UPDOWN_DAYS_BACK;
  const raw =
    daysBackEnv != null && daysBackEnv !== '' ? parseInt(daysBackEnv.trim(), 10) : NaN;
  const daysBack = Number.isNaN(raw) || raw <= 0 ? null : raw;

  const tfEnv = process.env.BTC_UPDOWN_TIMEFRAMES?.trim();
  let timeframes: Timeframe[] = VALID_TIMEFRAMES;
  if (tfEnv) {
    const parsed = tfEnv
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is Timeframe => VALID_TIMEFRAMES.includes(s as Timeframe));
    if (parsed.length > 0) timeframes = [...new Set(parsed)];
  }

  const verboseEnv = process.env.BTC_UPDOWN_VERBOSE?.trim().toLowerCase();
  const verbose =
    verboseEnv === 'true' || verboseEnv === '1' || verboseEnv === 'yes';

  const outputPath =
    pickFirstEnv(
      process.env.Poly_BTC_UPDOWN_OUTPUT,
      process.env.POLY_BTC_UPDOWN_OUTPUT,
      process.env.BTC_UPDOWN_OUTPUT
    ) ?? null;

  return {
    timeframes,
    daysBack,
    verbose,
    outputPath,
  };
}

async function main() {
  const { timeframes, daysBack, verbose, outputPath } = getConfig();
  const periodStartMs =
    daysBack != null && daysBack > 0
      ? Date.now() - daysBack * 24 * 60 * 60 * 1000
      : null;

  console.log('Fetching BTC Up/Down history from Polymarket...');
  const parts = [`Timeframes: ${timeframes.join(', ')}`];
  if (periodStartMs != null) {
    parts.push(`Period: last ${daysBack} days`);
  }
  console.log(parts.join(' | '));
  console.log();

  const results = await fetchBtcUpDownHistory(timeframes, periodStartMs);

  if (results.length === 0) {
    console.log('No resolved BTC Up/Down markets found.');
    if (periodStartMs != null) {
      console.log('Tip: Widen BTC_UPDOWN_DAYS_BACK.');
    }
    process.exit(0);
  }

  if (outputPath) {
    const yesCount = results.filter((r) => r.result === 'Yes').length;
    const noCount = results.filter((r) => r.result === 'No').length;
    const json = {
      fetchedAt: new Date().toISOString(),
      timeframes,
      daysBack: daysBack ?? null,
      total: results.length,
      yesCount,
      noCount,
      results: results.map((r) => {
        const closeMs = parseClosedTime(r.closedTime ?? r.endDate);
        const periodStartMs =
          closeMs != null
            ? periodStartMsFromResolutionMs(closeMs, r.timeframe)
            : undefined;
        return {
          timeframe: r.timeframe,
          result: r.result,
          slug: r.slug,
          closedTime: r.closedTime,
          endDate: r.endDate,
          ...(closeMs != null ? { closeMs } : {}),
          ...(periodStartMs != null
            ? {
                periodStartMs,
                alignKey: alignKey(r.timeframe, periodStartMs),
              }
            : {}),
        };
      }),
    };
    writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf-8');
    console.log(`Saved ${results.length} results to ${outputPath}`);
  }

  console.log(
    verbose ? 'Timeframe\tClosedTime\tResult\tTitle' : 'Timeframe\tClosedTime\tResult'
  );
  console.log('-'.repeat(60));
  for (const r of results) {
    console.log(formatResult(r, verbose));
  }
  console.log(`\nTotal: ${results.length} results (Yes=Up, No=Down)`);
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
