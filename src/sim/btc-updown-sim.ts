#!/usr/bin/env node
/**
 * Simulate a simple BTC Up/Down follow strategy on saved JSON.
 *
 * - Candle 0 only seeds the pick (Yes=Up, No=Down); it is not scored.
 * - For each later candle: if your pick matches the resolution, success and
 *   keep the same pick; if not, failure and set the next pick to that candle's
 *   outcome (same side as the resolution that just occurred).
 *
 * Config via .env:
 *   BTC_UPDOWN_OUTPUT - JSON file path (default: poly-btc-updown.json)
 *
 * Run: npm run sim
 */
import 'dotenv/config';
import { readFileSync } from 'fs';

type Outcome = 'Yes' | 'No';

interface ResultItem {
  timeframe: string;
  result: Outcome;
}

function getInputPath(): string {
  return process.env.BTC_UPDOWN_OUTPUT?.trim() || 'poly-btc-updown.json';
}

function simulate(results: ResultItem[]): { successes: number; failures: number } {
  if (results.length < 2) {
    return { successes: 0, failures: 0 };
  }

  let pick: Outcome = results[0].result;
  let successes = 0;
  let failures = 0;

  for (let i = 1; i < results.length; i++) {
    const actual = results[i].result;
    if (pick === actual) {
      successes++;
    } else {
      failures++;
      pick = actual;
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
    console.error(`Cannot read ${inputPath}. Fetch or point BTC_UPDOWN_OUTPUT to a valid JSON file.`);
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

  console.log(`Strategy sim (${inputPath})`);
  console.log(`Candles: ${results.length} (seed: 1, scored: ${rounds})`);
  console.log(`Success: ${successes}`);
  console.log(`Fail:    ${failures}`);
  console.log(`Win rate (scored): ${rate}%`);
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
