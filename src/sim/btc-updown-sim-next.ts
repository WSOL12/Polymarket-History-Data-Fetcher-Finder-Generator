#!/usr/bin/env node
/**
 * Simulate BTC Up/Down strategy: after a failed prediction, set the next pick
 * from the following candle's resolution (look-ahead one step), then continue.
 *
 * - Candle 0 only seeds the pick (Yes=Up, No=Down); it is not scored.
 * - Walk forward with index i. Compare pick to results[i].
 * - If match: success, keep pick, advance to next candle.
 * - If mismatch: failure; if a next candle exists, set pick to that candle's
 *   outcome and advance past it (that candle is only used to choose direction,
 *   not scored as a prediction). Otherwise stop.
 *
 * Config via .env:
 *   Poly_BTC_UPDOWN_OUTPUT - JSON file path (default: poly-btc-updown.json)
 *
 * Run: npm run sim:next
 */
import 'dotenv/config';
import { readFileSync } from 'fs';

type Outcome = 'Yes' | 'No';

interface ResultItem {
  timeframe: string;
  result: Outcome;
}

function getInputPath(): string {
  return (
    process.env.Poly_BTC_UPDOWN_OUTPUT?.trim() ||
    process.env.POLY_BTC_UPDOWN_OUTPUT?.trim() ||
    process.env.BTC_UPDOWN_OUTPUT?.trim() ||
    'poly-btc-updown.json'
  );
}

function simulate(results: ResultItem[]): { successes: number; failures: number } {
  if (results.length < 2) {
    return { successes: 0, failures: 0 };
  }

  let pick: Outcome = results[0].result;
  let successes = 0;
  let failures = 0;
  let i = 1;

  while (i < results.length) {
    const actual = results[i].result;
    if (pick === actual) {
      successes++;
      i++;
    } else {
      failures++;
      if (i + 1 < results.length) {
        pick = results[i + 1].result;
        i += 2;
      } else {
        i++;
      }
    }
  }

  return { successes, failures };
}

async function main() {
  const inputPath = getInputPath();

  let data: { results?: ResultItem[] };
  try {
    const raw = readFileSync(inputPath, 'utf-8');
    data = JSON.parse(raw) as { results?: ResultItem[] };
  } catch {
    console.error(
      `Cannot read ${inputPath}. Fetch or point Poly_BTC_UPDOWN_OUTPUT to a valid JSON file.`
    );
    process.exit(1);
  }

  const results = data.results ?? [];
  if (results.length === 0) {
    console.log('No results in JSON.');
    process.exit(0);
  }

  const { successes, failures } = simulate(results);
  const rounds = successes + failures;
  const rate = rounds > 0 ? ((successes / rounds) * 100).toFixed(2) : '0.00';

  console.log(`Strategy sim — next-candle reset (${inputPath})`);
  console.log(`Candles: ${results.length} (seed: 1, scored rounds: ${rounds})`);
  console.log(`Success: ${successes}`);
  console.log(`Fail:    ${failures}`);
  console.log(`Win rate (scored): ${rate}%`);
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
