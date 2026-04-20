#!/usr/bin/env node
/**
 * Simulate: scan consecutive identical outcomes (Yes/No). When a run has
 * length *more than 4* (i.e. 5+), use the first five candles of that run only,
 * then make exactly one prediction for the candle *after* those five (index
 * start+5). Default pick: opposite side (fade). Set
 *   BTC_UPDOWN_SIM_LONGRUN_PICK=same to bet the run continues on that step.
 *
 * Config via .env:
 *   BTC_UPDOWN_OUTPUT - JSON file path (default: poly-btc-updown.json)
 *   BTC_UPDOWN_SIM_LONGRUN_PICK - omit or `flip` (default) | `same`
 *
 * Run: npm run sim:longrun
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

function opposite(o: Outcome): Outcome {
  return o === 'Yes' ? 'No' : 'Yes';
}

function getPickMode(): 'same' | 'flip' {
  const m = process.env.BTC_UPDOWN_SIM_LONGRUN_PICK?.trim().toLowerCase();
  return m === 'same' ? 'same' : 'flip';
}

function simulate(
  results: ResultItem[],
  pickMode: 'same' | 'flip'
): { successes: number; failures: number } {
  if (results.length === 0) {
    return { successes: 0, failures: 0 };
  }

  let successes = 0;
  let failures = 0;
  let i = 0;

  while (i < results.length) {
    const val = results[i].result;
    let j = i + 1;
    while (j < results.length && results[j].result === val) {
      j++;
    }
    const len = j - i;

    if (len > 5) {
      const predictAt = i + 5;
      if (predictAt < results.length) {
        const pick = pickMode === 'same' ? val : opposite(val);
        const actual = results[predictAt].result;
        if (pick === actual) {
          successes++;
        } else {
          failures++;
        }
      }
    }
    i = j;
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

  const pickMode = getPickMode();
  const { successes, failures } = simulate(results, pickMode);
  const rounds = successes + failures;
  const rate = rounds > 0 ? ((successes / rounds) * 100).toFixed(2) : '0.00';

  console.log(
    `Strategy sim — long run (>4 same) then one pick [${pickMode}] (${inputPath})`
  );
  console.log(`Candles: ${results.length} | scored rounds: ${rounds}`);
  console.log(`Success: ${successes}`);
  console.log(`Fail:    ${failures}`);
  console.log(`Win rate (scored): ${rate}%`);
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
