// 自分の記録から統計を計算する（純関数）。連続日数は JST 日付キーで数える。
import { addDays } from "./date";

export interface DayRecord {
  date: string;
  solved: boolean;
  reveals: number;
}

export interface Stats {
  /** 答え合わせをした日数 */
  played: number;
  /** 完答した日数 */
  solved: number;
  /** ヒントなしで完答した日数 */
  clean: number;
  /** 今日（未完答なら昨日）まで続く連続完答日数 */
  currentStreak: number;
  maxStreak: number;
}

export function computeStats(records: DayRecord[], todayKey: string): Stats {
  const solvedDays = new Set(records.filter((r) => r.solved).map((r) => r.date));
  const stats: Stats = {
    played: records.length,
    solved: solvedDays.size,
    clean: records.filter((r) => r.solved && r.reveals === 0).length,
    currentStreak: 0,
    maxStreak: 0,
  };

  // 現在の連続: 今日が未完答なら昨日を起点にする
  let cursor = solvedDays.has(todayKey) ? todayKey : addDays(todayKey, -1);
  while (solvedDays.has(cursor)) {
    stats.currentStreak++;
    cursor = addDays(cursor, -1);
  }

  // 最長連続
  const sorted = [...solvedDays].sort();
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > stats.maxStreak) stats.maxStreak = run;
    prev = d;
  }
  return stats;
}
