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
