// 生成履歴（../xword-private/out/*.json）から、語の最終使用日とカギ番号を集計する。
// クールダウン: 直近 COOLDOWN_DAYS 日の語は除外、それ以外は古い順を優先。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffDays, isDateKey } from "../../src/lib/date";

export const COOLDOWN_DAYS = 10;

export interface History {
  lastUsed: Map<string, string>;
  lastClue: Map<string, number>;
}

export interface HistoryEntry {
  date: string;
  answers: Record<string, string>;
  clueIndex?: Record<string, number>;
}

export function emptyHistory(): History {
  return { lastUsed: new Map(), lastClue: new Map() };
}

export function addToHistory(h: History, e: HistoryEntry): void {
  for (const [sid, kana] of Object.entries(e.answers)) {
    const prev = h.lastUsed.get(kana);
    if (prev === undefined || prev < e.date) {
      h.lastUsed.set(kana, e.date);
      const ci = e.clueIndex?.[sid];
      if (ci !== undefined) h.lastClue.set(kana, ci);
    }
  }
}

/**
 * out/ の履歴を読む。before を渡すとその日付より前のファイルだけ（再生成で、作り直す日以降の旧ファイルを
 * 履歴に数えないため。数えると直近 30 日分 ≈600 語がクールダウンで使えなくなる）。
 */
export function readHistoryDir(dir: string, opts: { before?: string } = {}): History {
  const h = emptyHistory();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return h;
  }
  for (const f of files.sort()) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<HistoryEntry>;
    if (!raw.date || !isDateKey(raw.date) || !raw.answers) continue;
    if (opts.before && raw.date >= opts.before) continue;
    addToHistory(h, { date: raw.date, answers: raw.answers, clueIndex: raw.clueIndex });
  }
  return h;
}

/** 生成日 date に対する除外集合と「最後に使ってからの日数」。date より後の履歴（未来日）は除外しない */
export function cooldown(h: History, date: string, days = COOLDOWN_DAYS): { exclude: Set<string>; recency: Map<string, number> } {
  const exclude = new Set<string>();
  const recency = new Map<string, number>();
  for (const [kana, last] of h.lastUsed) {
    const d = diffDays(last, date);
    recency.set(kana, d);
    if (d >= 0 && d < days) exclude.add(kana);
  }
  return { exclude, recency };
}
