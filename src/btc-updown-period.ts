export type Timeframe = '5m' | '15m' | '1h';

const TF_MS: Record<Timeframe, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
};

/**
 * Map a resolution timestamp (close/settlement) to the canonical **period start** (UTC ms)
 * for fixed grid candles. Resolutions on an exact period boundary are treated as belonging
 * to the interval that *ended* at that boundary (so we nudge by 1 ms before flooring).
 */
export function periodStartMsFromResolutionMs(
  resolutionMs: number,
  tf: Timeframe
): number {
  const p = TF_MS[tf];
  const adj = resolutionMs % p === 0 ? resolutionMs - 1 : resolutionMs;
  return Math.floor(adj / p) * p;
}

export function periodMs(tf: Timeframe): number {
  return TF_MS[tf];
}

/** Stable join key across venues for the same candle. */
export function alignKey(tf: Timeframe, periodStartMs: number): string {
  return `${tf}:${periodStartMs}`;
}

const MONTH_MAP: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/**
 * Convert a clock time in America/New_York on a calendar date to UTC epoch ms.
 * Used for Kalshi BTC event tickers (wall time is Eastern).
 */
export function easternWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const base = Date.UTC(year, month - 1, day, 0, 0);
  for (let t = base - 14 * 3600000; t < base + 36 * 3600000; t += 60000) {
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value])
    ) as Record<string, string>;
    const y = parseInt(parts.year, 10);
    const mo = parseInt(parts.month, 10);
    const d = parseInt(parts.day, 10);
    const h = parseInt(parts.hour, 10);
    const mi = parseInt(parts.minute, 10);
    if (
      y === year &&
      mo === month &&
      d === day &&
      h === hour &&
      mi === minute
    ) {
      return t;
    }
  }
  throw new Error(
    `easternWallTimeToUtcMs: no UTC instant for ${year}-${month}-${day} ${hour}:${minute} America/New_York`
  );
}

/**
 * Kalshi BTC up/down event ticker, e.g. `KXBTC15M-26APR201615` → period start UTC ms
 * (YY + MMM + DD + HHMM in Eastern, matching live API strings).
 */
export function periodStartMsFromKalshiEventTicker(
  eventTicker: string,
  tf: Timeframe
): number | null {
  const m = /^KXBTC(5M|15M|1H)-(\d{2})([A-Z]{3})(\d{2})(\d{4})$/i.exec(
    eventTicker.trim()
  );
  if (!m) return null;
  const series = m[1].toUpperCase();
  const expected =
    tf === '5m' ? '5M' : tf === '15m' ? '15M' : tf === '1h' ? '1H' : '';
  if (series !== expected) return null;
  const yy = parseInt(m[2], 10);
  const mon = MONTH_MAP[m[3].toUpperCase()];
  const day = parseInt(m[4], 10);
  const hhmm = parseInt(m[5], 10);
  if (mon == null || !Number.isFinite(day) || !Number.isFinite(hhmm)) return null;
  const hour = Math.floor(hhmm / 100);
  const minute = hhmm % 100;
  const year = 2000 + yy;
  try {
    return easternWallTimeToUtcMs(year, mon, day, hour, minute);
  } catch {
    return null;
  }
}

/**
 * Polymarket `btc-updown-{5m|15m|1h…}-{unixSec}` slug → same period start as fetchers used
 * (`unixSec * 1000 + periodMs(tf)`).
 */
export function periodStartMsFromPolyBtcUpDownSlug(
  slug: string,
  tf: Timeframe
): number | null {
  const m = /^btc-updown-(5m|15m|1hr?)-(\d+)$/i.exec(slug.trim());
  if (!m) return null;
  const rawTf = m[1].toLowerCase();
  const sec = parseInt(m[2], 10);
  if (!Number.isFinite(sec)) return null;
  let mapped: Timeframe | null = null;
  if (rawTf === '5m') mapped = '5m';
  else if (rawTf === '15m') mapped = '15m';
  else if (rawTf === '1h' || rawTf === '1hr') mapped = '1h';
  if (mapped !== tf) return null;
  return sec * 1000 + TF_MS[tf];
}

/** Signed (final − beat); Up outcomes are typically positive, Down negative. */
export function priceDiffUsd(
  finalPrice: number,
  beatPrice: number
): number {
  return finalPrice - beatPrice;
}
