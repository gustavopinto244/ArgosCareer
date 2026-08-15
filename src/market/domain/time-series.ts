import { CorpusEntry, TimeSeriesPoint } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The Monday (UTC) of the week containing `date` — a stable, timezone-
 * independent bucket key. `getUTCDay()` is 0 (Sunday) through 6 (Saturday);
 * shifting so Monday is the anchor matches how a week is normally read.
 */
function weekStartOf(date: Date): string {
  const day = date.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  const monday = new Date(date.getTime() - offset * MS_PER_DAY);
  return monday.toISOString().slice(0, 10);
}

/**
 * Postings collected per week, by `firstSeenAt` — "how the market moved"
 * (docs/10-milestones.md). Week granularity, not daily: this corpus is
 * hundreds of rows across a few weeks so far, and a daily bucket would be
 * mostly noise. Pure, no I/O, same discipline as `aggregateCorpus`.
 */
export function timeSeries(entries: readonly CorpusEntry[]): TimeSeriesPoint[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = weekStartOf(entry.posting.firstSeenAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([weekStart, count]) => ({ weekStart, count }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}
