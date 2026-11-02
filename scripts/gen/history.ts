// 生成履歴（../xword-private/out/*.json）から、語の使用日とカギ番号を集計する。
// クールダウンは difficulty 別:
//   difficulty 1 … 直近 COOLDOWN_DAYS 日は除外、それ以外は古い順を優先（従来どおり）
//   difficulty ≥ 2（難語）… 間隔反復。使用回数 n に応じて blackout 日は除外し、復習ウィンドウ内なら埋めで昇格（schedule()）
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bank } from "../../src/lib/bank";
import { diffDays, isDateKey } from "../../src/lib/date";

export const COOLDOWN_DAYS = 10;

/**
 * 難語の間隔反復（n 回目の使用後）。blackout 日未満は除外、[blackout, windowEnd] は復習ウィンドウ（埋めで優先）、
 * 過ぎたら due（使える・復習扱い）。Leitner / SM-2 の 3 日 → 2 週 → 1 ヶ月半を日次パズルに合わせたもの
 */
export const HARD_SCHEDULE: readonly { blackout: number; windowEnd: number }[] = [
  { blackout: 3, windowEnd: 7 }, // n = 1: 初出から 3〜7 日で 1 回目の復習
  { blackout: 14, windowEnd: 30 }, // n = 2: 14〜30 日で 2 回目
  { blackout: 45, windowEnd: Number.POSITIVE_INFINITY }, // n ≥ 3: 既知扱い。45 日空ける
];

export interface History {
  lastUsed: Map<string, string>;
  lastClue: Map<string, number>;
  /** kana → 使用日（昇順・重複なし）。難語の間隔反復に使う */
  uses: Map<string, string[]>;
}

export interface HistoryEntry {
  date: string;
  answers: Record<string, string>;
  clueIndex?: Record<string, number>;
}

export function emptyHistory(): History {
  return { lastUsed: new Map(), lastClue: new Map(), uses: new Map() };
}

export function addToHistory(h: History, e: HistoryEntry): void {
  for (const [sid, kana] of Object.entries(e.answers)) {
    const prev = h.lastUsed.get(kana);
    if (prev === undefined || prev < e.date) {
      h.lastUsed.set(kana, e.date);
      const ci = e.clueIndex?.[sid];
      if (ci !== undefined) h.lastClue.set(kana, ci);
    }
    const list = h.uses.get(kana) ?? [];
    if (!list.includes(e.date)) {
      list.push(e.date);
      list.sort();
      h.uses.set(kana, list);
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

/** window = 復習ウィンドウ内（埋めで最優先）／ due = ウィンドウを過ぎた（使える・復習扱い） */
export type ReviewState = "window" | "due";

export interface Schedule {
  /** difficulty 1: クールダウン中 ／ 難語: blackout 中 */
  exclude: Set<string>;
  /** 語 → 最後に使ってからの日数（date 以前の使用のみ。未登録 = 未使用） */
  recency: Map<string, number>;
  /** 使用済みで使える難語 → 状態。新出 = difficulty ≥ 2 かつ recency 未登録、復習 = ここに載っている語 */
  review: Map<string, ReviewState>;
}

/**
 * 生成日 date に対するスケジュール。difficulty 1 は cooldown() と同じ。難語は HARD_SCHEDULE で間隔反復。
 * date より後の使用（再生成で残る未来日）は数えない。バンクから消えた語は difficulty 1 として扱う。
 */
export function schedule(h: History, date: string, bank: Bank, cooldownDays = COOLDOWN_DAYS): Schedule {
  const exclude = new Set<string>();
  const recency = new Map<string, number>();
  const review = new Map<string, ReviewState>();
  for (const [kana, uses] of h.uses) {
    const past = uses.filter((u) => u <= date);
    if (past.length === 0) continue;
    const n = past.length;
    const d = diffDays(past[n - 1]!, date);
    recency.set(kana, d);
    const id = bank.byKana.get(kana);
    const difficulty = id === undefined ? 1 : bank.words[id]!.difficulty;
    if (difficulty < 2) {
      if (d < cooldownDays) exclude.add(kana);
      continue;
    }
    const rule = HARD_SCHEDULE[Math.min(n, HARD_SCHEDULE.length) - 1]!;
    if (d < rule.blackout) exclude.add(kana);
    else review.set(kana, d <= rule.windowEnd ? "window" : "due");
  }
  return { exclude, recency, review };
}
