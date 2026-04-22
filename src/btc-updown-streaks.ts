#!/usr/bin/env node
/**
 * Show consecutive Yes/No streaks from poly-btc-updown.json.
 *
 * Config via .env:
 *   Poly_BTC_UPDOWN_OUTPUT - JSON file path (default: poly-btc-updown.json)
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

interface StreakSummary {
  total: number;
  yes: number;
  no: number;
}

function getConfig(): { inputPath: string; minStreak: number | null } {
  const inputPath =
    process.env.Poly_BTC_UPDOWN_OUTPUT?.trim() ||
    process.env.POLY_BTC_UPDOWN_OUTPUT?.trim() ||
    process.env.BTC_UPDOWN_OUTPUT?.trim() ||
    'poly-btc-updown.json';
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

function summarizeStreaks(streaks: Streak[]): Map<number, StreakSummary> {
  const summary = new Map<number, StreakSummary>();

  for (const streak of streaks) {
    const current = summary.get(streak.count) ?? { total: 0, yes: 0, no: 0 };
    current.total += 1;
    if (streak.result === 'Yes') {
      current.yes += 1;
    } else {
      current.no += 1;
    }
    summary.set(streak.count, current);
  }

  return new Map([...summary.entries()].sort((a, b) => a[0] - b[0]));
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
  const filteredStreaks =
    minStreak != null ? streaks.filter((s) => s.count >= minStreak) : streaks;
  const grouped = summarizeStreaks(filteredStreaks);
  const allStreaksTotal = streaks.length;
  const filteredStreaksTotal = filteredStreaks.length;
  const totalPredictions = results.length;
  const filteredPredictionsTotal = filteredStreaks.reduce(
    (sum, s) => sum + s.count,
    0
  );

  if (minStreak != null) {
    console.log(`Streaks >= ${minStreak} (from ${inputPath}):\n`);
    for (const [count, info] of grouped) {
      console.log(`${count}: ${info.total} (Yes: ${info.yes}, No: ${info.no})`);
    }
    if (filteredStreaksTotal === 0) {
      console.log(`No streaks of ${minStreak}+ found.`);
    }
    console.log(`\nTotal: ${filteredStreaksTotal} streaks (>= ${minStreak})`);
    console.log(`Grand total: ${filteredPredictionsTotal} predictions`);
    console.log(`All predictions total: ${totalPredictions}`);
  } else {
    console.log(`All streaks (from ${inputPath}):\n`);
    for (const [count, info] of grouped) {
      console.log(`${count}: ${info.total} (Yes: ${info.yes}, No: ${info.no})`);
    }
    console.log(`\nTotal: ${allStreaksTotal} streaks`);
    console.log(`Grand total: ${totalPredictions} predictions`);
  }
}

main().catch((err) => {
  console.error('Error:', (err as Error).message);
  process.exit(1);
});
