#!/usr/bin/env node
/**
 * Show consecutive Yes/No streaks from poly-btc-updown.json.
 *
 * Config via .env:
 *   BTC_UPDOWN_OUTPUT   - JSON file path (default: poly-btc-updown.json)
 *   BTC_UPDOWN_STREAK_MIN - only show streaks >= N (omit to show all)
 *
 * Run: npm run streaks
 */
import 'dotenv/config';
import { readFileSync } from 'fs';

interface ResultItem {
  timeframe: string;
  result: 'Yes' | 'No';
}

interface Streak {
  count: number;
  result: 'Yes' | 'No';
  values: ResultItem[];
}

function getConfig(): { inputPath: string; minStreak: number | null } {
  const inputPath =
    process.env.BTC_UPDOWN_OUTPUT?.trim() || 'poly-btc-updown.json';
  const minStr = process.env.BTC_UPDOWN_STREAK_MIN?.trim();
  const minStreak =
    minStr != null && minStr !== ''
      ? Math.max(1, parseInt(minStr, 10) || 1)
      : null;
  return { inputPath, minStreak };
}

function computeStreaks(results: ResultItem[]): Streak[] {
  if (results.length === 0) return [];

  const streaks: Streak[] = [];
  let current: ResultItem['result'] = results[0].result;
  let count = 0;
  let values: ResultItem[] = [];

  for (const r of results) {
    if (r.result === current) {
      count++;
      values.push(r);
    } else {
      streaks.push({ count, result: current, values });
      current = r.result;
      count = 1;
      values = [r];
    }
  }
  if (count > 0) {
    streaks.push({ count, result: current, values });
  }
  return streaks;
}

async function main() {
  const { inputPath, minStreak } = getConfig();

  let data: { results?: ResultItem[] };
  try {
    const raw = readFileSync(inputPath, 'utf-8');
    data = JSON.parse(raw) as { results?: ResultItem[] };
  } catch (err) {
    console.error(`Cannot read ${inputPath}. Run 'npm run btc-updown' first.`);
    process.exit(1);
  }

  const results = data.results ?? [];
  if (results.length === 0) {
    console.log('No results in JSON.');
    process.exit(0);
  }

  const streaks = computeStreaks(results);

  if (minStreak != null) {
    const filtered = streaks.filter((s) => s.count >= minStreak);
    console.log(`Streaks >= ${minStreak} (from ${inputPath}):\n`);
    for (const s of filtered) {
      console.log(`${s.count}: ${s.result}`);
    }
    if (filtered.length === 0) {
      console.log(`No streaks of ${minStreak}+ found.`);
    }
    console.log(`\nTotal: ${filtered.length} streaks (>= ${minStreak})`);
  } else {
    console.log(`All streaks (from ${inputPath}):\n`);
    for (const s of streaks) {
      console.log(`${s.count}: ${s.result}`);
    }
    console.log(`\nTotal: ${streaks.length} streaks`);
  }
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
