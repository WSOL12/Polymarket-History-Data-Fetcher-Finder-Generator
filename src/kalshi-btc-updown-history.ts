#!/usr/bin/env node
/**
 * Fetch settled BTC Up/Down style markets from Kalshi (binary YES = up, NO = down).
 * Merges live + historical market endpoints so coverage matches Kalshi's rolling cutoff.
 *
 * Config via .env (Kalshi-specific vars override shared BTC_UPDOWN_* when set):
 *   KALSHI_BASE_URL           - API base (default: https://api.elections.kalshi.com/trade-api/v2)
 *   KALSHI_BTC_UPDOWN_SERIES_MAP - optional explicit SERIES:timeframe list (overrides timeframe list)
 *   BTC_UPDOWN_DAYS_BACK / KALSHI_BTC_UPDOWN_DAYS_BACK - settled within last N days (omit = all pages)
 *   BTC_UPDOWN_TIMEFRAMES / KALSHI_BTC_UPDOWN_TIMEFRAMES - e.g. 5m, 15m, 1h (default: all three)
 *   BTC_UPDOWN_VERBOSE / KALSHI_BTC_UPDOWN_VERBOSE - true = print per-market lines at end
 *   KALSHI_BTC_UPDOWN_OUTPUT    - JSON path (default: kalshi-btc-updown.json)
 *   KALSHI_BTC_UPDOWN_INCLUDE_DETAILS - true to add per-market tickers and settlementTs in JSON
 *
 * Each result may include `finalPrice` (Kalshi `expiration_value`) and `beatPrice` (`floor_strike` or `cap_strike`)
 * when the API returns them for settled markets.
 *
 * Run: npm run kalshi:btc-updown
 * Preflight only: npm run kalshi:ping
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { priceDiffUsd } from './btc-updown-period.js';

const DEFAULT_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

type Timeframe = '5m' | '15m' | '1h';

const VALID_TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h'];

/** Kalshi series tickers for each BTC up/down timeframe (when not using KALSHI_BTC_UPDOWN_SERIES_MAP). */
const SERIES_FOR_TIMEFRAME: Record<Timeframe, string> = {
  '5m': 'KXBTC5M',
  '15m': 'KXBTC15M',
  '1h': 'KXBTC1H',
};

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  status: string;
  result: 'yes' | 'no' | 'scalar' | '';
  settlement_ts?: string | null;
  close_time?: string;
  /** Observed value used at settlement (often the index level at period end). */
  expiration_value?: string | null;
  /** Strike / reference threshold from contract terms (see Kalshi `floor_strike` docs). */
  floor_strike?: number | null;
  cap_strike?: number | null;
}

interface BtcUpDownResult {
  timeframe: Timeframe;
  marketTicker: string;
  eventTicker: string;
  settlementTs: string;
  result: 'Yes' | 'No';
  finalPrice?: number;
  beatPrice?: number;
}

function getBaseUrl(): string {
  return process.env.KALSHI_BASE_URL?.trim() || DEFAULT_BASE;
}

/** First non-empty trimmed string wins (Kalshi-specific env overrides shared BTC_UPDOWN_*). */
function pickFirstEnv(...candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    const v = c?.trim();
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function parseSeriesMap(raw: string): Map<string, Timeframe> {
  const m = new Map<string, Timeframe>();
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const idx = seg.lastIndexOf(':');
    if (idx <= 0) continue;
    const series = seg.slice(0, idx).trim().toUpperCase();
    const tf = seg.slice(idx + 1).trim().toLowerCase() as Timeframe;
    if (!series || !VALID_TIMEFRAMES.includes(tf)) continue;
    m.set(series, tf);
  }
  if (m.size === 0) {
    throw new Error(
      `Invalid KALSHI_BTC_UPDOWN_SERIES_MAP (use e.g. KXBTC5M:5m,KXBTC15M:15m,KXBTC1H:1h)`
    );
  }
  return m;
}

function parseTimeframesFromEnv(raw: string | undefined): Timeframe[] | null {
  if (!raw?.trim()) return null;
  const list = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Timeframe =>
      VALID_TIMEFRAMES.includes(s as Timeframe)
    );
  return list.length ? [...new Set(list)] : null;
}

/** Explicit SERIES_MAP, or series derived from BTC_UPDOWN_TIMEFRAMES / KALSHI_BTC_UPDOWN_TIMEFRAMES. */
function resolveSeriesMap(): Map<string, Timeframe> {
  const explicit = pickFirstEnv(process.env.KALSHI_BTC_UPDOWN_SERIES_MAP);
  if (explicit) {
    return parseSeriesMap(explicit);
  }
  const tfRaw = pickFirstEnv(
    process.env.KALSHI_BTC_UPDOWN_TIMEFRAMES,
    process.env.BTC_UPDOWN_TIMEFRAMES
  );
  const wanted =
    parseTimeframesFromEnv(tfRaw) ?? (['5m', '15m', '1h'] as Timeframe[]);
  const m = new Map<string, Timeframe>();
  for (const tf of wanted) {
    const series = SERIES_FOR_TIMEFRAME[tf];
    if (series) m.set(series, tf);
  }
  if (m.size === 0) {
    throw new Error(
      'No timeframes selected. Set BTC_UPDOWN_TIMEFRAMES (e.g. 5m,15m) or KALSHI_BTC_UPDOWN_SERIES_MAP.'
    );
  }
  return m;
}

function getDaysBack(): number | null {
  const v = pickFirstEnv(
    process.env.KALSHI_BTC_UPDOWN_DAYS_BACK,
    process.env.BTC_UPDOWN_DAYS_BACK
  );
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

function getOutputPath(): string {
  return process.env.KALSHI_BTC_UPDOWN_OUTPUT?.trim() || 'kalshi-btc-updown.json';
}

function getVerbose(): boolean {
  const v = pickFirstEnv(
    process.env.KALSHI_BTC_UPDOWN_VERBOSE,
    process.env.BTC_UPDOWN_VERBOSE
  )?.toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function getIncludeDetails(): boolean {
  const v = process.env.KALSHI_BTC_UPDOWN_INCLUDE_DETAILS?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function kalshiResultToUpDown(
  r: KalshiMarket['result']
): 'Yes' | 'No' | null {
  if (r === 'yes') return 'Yes';
  if (r === 'no') return 'No';
  return null;
}

/** Parse Kalshi `expiration_value` into a number when it is a plain numeric string. */
function parseExpirationNumeric(raw?: string | null): number | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

function strikeAsBeatPrice(m: KalshiMarket): number | undefined {
  if (typeof m.floor_strike === 'number' && Number.isFinite(m.floor_strike)) {
    return m.floor_strike;
  }
  if (typeof m.cap_strike === 'number' && Number.isFinite(m.cap_strike)) {
    return m.cap_strike;
  }
  return undefined;
}

/** Thrown when the API is unreachable or blocked (e.g. CloudFront 403 geo-restriction). */
class KalshiAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KalshiAccessError';
  }
}

function looksLikeCloudFrontBlock(status: number, body: string): boolean {
  if (status === 403 || status === 451) return true;
  return (
    /cloudfront|could not be satisfied|Request blocked/i.test(body) &&
    body.includes('<')
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    if (looksLikeCloudFrontBlock(res.status, text)) {
      throw new KalshiAccessError(
        'Kalshi API blocked this request (HTTP ' +
          res.status +
          '). The trade API is often limited by region (CloudFront). Use a VPN or host in a supported jurisdiction, or set KALSHI_BASE_URL if Kalshi documents a different endpoint.'
      );
    }
    const snippet = text.trimStart().startsWith('<')
      ? '(HTML error page — not shown)'
      : text.slice(0, 180);
    throw new Error(`HTTP ${res.status} ${url}: ${snippet}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${url}, got: ${text.slice(0, 120)}`
    );
  }
}

/** Lightweight public endpoint; fails fast with KalshiAccessError if blocked. */
async function ensureKalshiApiReachable(base: string): Promise<void> {
  await fetchJson<unknown>(`${base}/historical/cutoff`);
}

/** Seconds since epoch for Kalshi live vs historical market boundary; null if unavailable. */
async function getMarketSettledCutoffSec(base: string): Promise<number | null> {
  try {
    const data = await fetchJson<{ market_settled_ts?: string }>(
      `${base}/historical/cutoff`
    );
    const raw = data.market_settled_ts?.trim();
    if (!raw) return null;
    const sec = new Date(raw).getTime() / 1000;
    return Number.isNaN(sec) ? null : sec;
  } catch (e) {
    if (e instanceof KalshiAccessError) throw e;
    return null;
  }
}

interface GetMarketsPage {
  markets: KalshiMarket[];
  cursor: string;
}

async function fetchAllSettledForSeries(
  base: string,
  path: '/markets' | '/historical/markets',
  seriesTicker: string,
  minSettledSec: number | null
): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  let cursor = '';
  const limit = 1000;
  const isHistorical = path === '/historical/markets';

  for (let page = 0; page < 500; page++) {
    const url = new URL(`${base}${path}`);
    if (!isHistorical) {
      url.searchParams.set('status', 'settled');
    }
    url.searchParams.set('series_ticker', seriesTicker);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    if (minSettledSec != null && !isHistorical) {
      url.searchParams.set('min_settled_ts', String(minSettledSec));
    }

    const data = await fetchJson<GetMarketsPage>(url.toString());
    const batch = data.markets ?? [];
    out.push(...batch);

    const next = data.cursor?.trim();
    if (!next || batch.length === 0) break;
    cursor = next;
  }

  return out;
}

function mergeByTicker(live: KalshiMarket[], historical: KalshiMarket[]): KalshiMarket[] {
  const map = new Map<string, KalshiMarket>();
  const pickExpiration = (
    a?: string | null,
    b?: string | null
  ): string | null | undefined => {
    const x = a?.trim();
    if (x) return x;
    const y = b?.trim();
    return y || (a ?? b);
  };
  const combine = (a: KalshiMarket, b: KalshiMarket): KalshiMarket => ({
    ...a,
    ...b,
    expiration_value: pickExpiration(a.expiration_value, b.expiration_value),
    floor_strike: b.floor_strike ?? a.floor_strike,
    cap_strike: b.cap_strike ?? a.cap_strike,
  });
  for (const m of historical) map.set(m.ticker, m);
  for (const m of live) {
    const existing = map.get(m.ticker);
    map.set(m.ticker, existing ? combine(existing, m) : m);
  }
  return [...map.values()];
}

function filterByMinSettled(
  markets: KalshiMarket[],
  minSettledSec: number | null
): KalshiMarket[] {
  if (minSettledSec == null) return markets;
  return markets.filter((m) => {
    const raw = m.settlement_ts?.trim() || m.close_time;
    if (!raw) return false;
    const sec = new Date(raw).getTime() / 1000;
    return !Number.isNaN(sec) && sec >= minSettledSec;
  });
}

function toResults(
  markets: KalshiMarket[],
  timeframe: Timeframe
): BtcUpDownResult[] {
  const rows: BtcUpDownResult[] = [];
  for (const m of markets) {
    const side = kalshiResultToUpDown(m.result);
    if (side == null) continue;
    const ts = m.settlement_ts?.trim() || m.close_time || '';
    if (!ts) continue;
    const finalPrice = parseExpirationNumeric(m.expiration_value);
    const beatPrice = strikeAsBeatPrice(m);
    rows.push({
      timeframe,
      marketTicker: m.ticker,
      eventTicker: m.event_ticker,
      settlementTs: ts,
      result: side,
      ...(finalPrice != null ? { finalPrice } : {}),
      ...(beatPrice != null ? { beatPrice } : {}),
    });
  }
  return rows;
}

async function fetchSeriesHistory(
  base: string,
  seriesTicker: string,
  timeframe: Timeframe,
  minSettledSec: number | null,
  marketCutoffSec: number | null
): Promise<BtcUpDownResult[]> {
  const needHistorical =
    marketCutoffSec == null ||
    minSettledSec == null ||
    minSettledSec < marketCutoffSec;

  const live = await fetchAllSettledForSeries(
    base,
    '/markets',
    seriesTicker,
    minSettledSec
  );
  const hist = needHistorical
    ? await fetchAllSettledForSeries(
        base,
        '/historical/markets',
        seriesTicker,
        null
      )
    : [];
  const merged = mergeByTicker(live, hist);
  const settledWindow = filterByMinSettled(merged, minSettledSec);
  const results = toResults(settledWindow, timeframe);
  results.sort(
    (a, b) =>
      new Date(b.settlementTs).getTime() - new Date(a.settlementTs).getTime()
  );
  return results;
}

async function main() {
  if (process.argv.includes('--ping')) {
    const base = getBaseUrl().replace(/\/$/, '');
    console.log(`Kalshi API ping: ${base}/historical/cutoff`);
    await ensureKalshiApiReachable(base);
    console.log('OK — API reachable (JSON response).');
    return;
  }

  const base = getBaseUrl().replace(/\/$/, '');
  await ensureKalshiApiReachable(base);

  const seriesMap = resolveSeriesMap();
  const daysBack = getDaysBack();
  const minSettledSec =
    daysBack != null ? Math.floor(Date.now() / 1000) - daysBack * 86400 : null;
  const outputPath = getOutputPath();
  const verbose = getVerbose();
  const includeDetails = getIncludeDetails();

  console.log('Fetching Kalshi BTC Up/Down history...');
  console.log(`Base: ${base}`);
  console.log(
    `Series: ${[...seriesMap.entries()].map(([s, t]) => `${s}->${t}`).join(', ')}`
  );
  if (minSettledSec != null) {
    console.log(`Settled after: ${new Date(minSettledSec * 1000).toISOString()} (${daysBack}d window)`);
  }
  console.log();

  const marketCutoffSec = await getMarketSettledCutoffSec(base);
  if (marketCutoffSec != null) {
    console.log(
      `Live/historical market cutoff (settlement): ${new Date(marketCutoffSec * 1000).toISOString()}`
    );
    console.log();
  }

  const all: BtcUpDownResult[] = [];
  for (const [seriesTicker, tf] of seriesMap) {
    process.stdout.write(`  ${seriesTicker} (${tf})... `);
    const chunk = await fetchSeriesHistory(
      base,
      seriesTicker,
      tf,
      minSettledSec,
      marketCutoffSec
    );
    console.log(`${chunk.length} markets`);
    all.push(...chunk);
  }

  all.sort(
    (a, b) =>
      new Date(b.settlementTs).getTime() - new Date(a.settlementTs).getTime()
  );

  if (all.length === 0) {
    console.log('\nNo settled binary results found. Check series tickers / region / API access.');
    process.exit(0);
  }

  const timeframesUsed = [...new Set(seriesMap.values())];
  const yesCount = all.filter((r) => r.result === 'Yes').length;
  const noCount = all.filter((r) => r.result === 'No').length;

  const json: Record<string, unknown> = {
    fetchedAt: new Date().toISOString(),
    source: 'kalshi' as const,
    baseUrl: base,
    timeframes: timeframesUsed,
    seriesMap: Object.fromEntries(seriesMap),
    daysBack: daysBack ?? null,
    total: all.length,
    yesCount,
    noCount,
    results: all.map((r) => {
      const hasBoth =
        r.finalPrice != null &&
        r.beatPrice != null &&
        Number.isFinite(r.finalPrice) &&
        Number.isFinite(r.beatPrice);
      return {
        timeframe: r.timeframe,
        result: r.result,
        marketTicker: r.marketTicker,
        eventTicker: r.eventTicker,
        ...(r.finalPrice != null ? { finalPrice: r.finalPrice } : {}),
        ...(r.beatPrice != null ? { beatPrice: r.beatPrice } : {}),
        ...(hasBoth
          ? { priceDiff: priceDiffUsd(r.finalPrice!, r.beatPrice!) }
          : {}),
      };
    }),
  };
  if (includeDetails) {
    json.details = all.map((r) => ({
      timeframe: r.timeframe,
      result: r.result,
      marketTicker: r.marketTicker,
      eventTicker: r.eventTicker,
      settlementTs: r.settlementTs,
    }));
  }

  writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf-8');
  console.log(`\nSaved ${all.length} results to ${outputPath}`);
  console.log(`Yes (up): ${yesCount} | No (down): ${noCount}`);

  if (verbose) {
    console.log('\nTimeframe\tSettlement (UTC)\tResult\tMarket');
    console.log('-'.repeat(80));
    for (const r of all) {
      console.log(
        `${r.timeframe}\t${r.settlementTs}\t${r.result}\t${r.marketTicker}`
      );
    }
  }
}

main().catch((err) => {
  if (err instanceof KalshiAccessError) {
    console.error(err.message);
  } else {
    console.error('Error:', (err as Error).message);
  }
  process.exit(1);
});
