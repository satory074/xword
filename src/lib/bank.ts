// 語彙バンク: エントリの lint・同音統合・(長さ, 位置, 文字) 索引・パターン検索。
// 純 TS（ファイル I/O は scripts/gen/bankio.ts）。
import { MAX_SLOT_LEN } from "./grid";
import { isGridWord, kanaLength, normalizeKana, toHiragana } from "./kana";

export const MIN_WORD_LEN = 2;
export const MAX_CLUE_LEN = 60;

/** カギのレベル: 1 直接 / 2 ひとひねり / 3 ひねり（交差のマスと合わせて解く前提） */
export type Level = 1 | 2 | 3;
export const LEVELS: readonly Level[] = [1, 2, 3];

/** words/*.json の 1 エントリ。clues が lv1、clues2 / clues3 は任意（別配列にして差分を純追加に保つ） */
export interface WordEntry {
  kana: string;
  surface: string;
  category: string;
  difficulty: number;
  clues: string[];
  clues2?: string[];
  clues3?: string[];
}

/**
 * 正規化したカギ。diff は出自エントリの difficulty。
 * 同音統合で語の difficulty は min になるが、希な語義（雁）向けのカギの実効難易度はこれで保つ。
 */
export interface Clue {
  text: string;
  level: Level;
  diff: number;
}

/** 同音異義語を統合した 1 語 */
export interface BankWord {
  kana: string;
  len: number;
  /** 統合時は最小値 */
  difficulty: number;
  surfaces: string[];
  categories: string[];
  /** エントリ順 × (lv1 → lv2 → lv3)。clueIndex はこの配列の添字 */
  clues: Clue[];
}

export interface Bank {
  words: BankWord[];
  byLen: Map<number, number[]>;
  /** `${len}:${pos}:${ch}` → 語 id（昇順） */
  index: Map<string, number[]>;
  byKana: Map<string, number>;
}

/** カギに答えが漏れていないか（表記・カナ・ひらがな） */
export function clueLeaks(clue: string, kana: string, surfaces: string[]): string | null {
  if (clue.includes(kana)) return `カギに答えのカナ「${kana}」が含まれる`;
  // ひらがな読みは 3 文字以上だけ検査する（2 文字は「めでたい」の「たい」のような偽陽性が多い）
  const hira = toHiragana(kana);
  if (kanaLength(kana) >= 3 && clue.includes(hira)) return `カギに答えの読み「${hira}」が含まれる`;
  for (const s of surfaces) {
    if (s && s !== kana && kanaLength(s) >= 2 && clue.includes(s)) return `カギに答えの表記「${s}」が含まれる`;
  }
  return null;
}

/** エントリの 3 配列を正規化（lv1 → lv2 → lv3 の順） */
export function entryClues(e: WordEntry): Clue[] {
  const out: Clue[] = [];
  const lists: [Level, string[] | undefined][] = [[1, e.clues], [2, e.clues2], [3, e.clues3]];
  for (const [level, list] of lists) for (const text of list ?? []) out.push({ text, level, diff: e.difficulty });
  return out;
}

/** 指定レベルのカギの添字（昇順） */
export function cluesAt(w: BankWord, level: Level): number[] {
  const idx: number[] = [];
  w.clues.forEach((c, i) => {
    if (c.level === level) idx.push(i);
  });
  return idx;
}

export function lintEntry(e: WordEntry): string[] {
  const errs: string[] = [];
  const tag = `[${e.surface || "?"} / ${e.kana || "?"}]`;
  if (typeof e.kana !== "string" || e.kana === "") return [`${tag} kana が空`];
  if (normalizeKana(e.kana) !== e.kana) errs.push(`${tag} kana が正規化されていない（${normalizeKana(e.kana)} であるべき）`);
  if (!isGridWord(e.kana)) errs.push(`${tag} 盤面に使えない文字を含む`);
  const len = kanaLength(e.kana);
  if (len < MIN_WORD_LEN || len > MAX_SLOT_LEN) errs.push(`${tag} 長さ ${len} は ${MIN_WORD_LEN}〜${MAX_SLOT_LEN} の範囲外`);
  const first = Array.from(e.kana)[0];
  if (first === "ン" || first === "ー") errs.push(`${tag} ン・ー で始まる語`);
  if (typeof e.surface !== "string" || e.surface === "") errs.push(`${tag} surface が空`);
  if (typeof e.category !== "string" || e.category === "") errs.push(`${tag} category が空`);
  if (![1, 2, 3].includes(e.difficulty)) errs.push(`${tag} difficulty は 1〜3`);
  if (!Array.isArray(e.clues) || e.clues.length === 0) errs.push(`${tag} clues が空`);
  const lists: [string, Level, unknown][] = [["clues", 1, e.clues], ["clues2", 2, e.clues2], ["clues3", 3, e.clues3]];
  for (const [key, level, list] of lists) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errs.push(`${tag} ${key} が配列でない`);
      continue;
    }
    // lv3 は「交差のマスと合わせて解く」前提。2 文字語は候補が多く交差でも決まらないので付けない
    if (level === 3 && list.length > 0 && len === 2) errs.push(`${tag} 2 文字語に clues3 は付けない`);
    for (const c of list) {
      if (typeof c !== "string" || c.trim() === "") {
        errs.push(`${tag} ${key} に空のカギ`);
        continue;
      }
      if (kanaLength(c) > MAX_CLUE_LEN) errs.push(`${tag} カギが長すぎる（${kanaLength(c)} > ${MAX_CLUE_LEN}）: ${c}`);
      const leak = clueLeaks(c, e.kana, [e.surface]);
      if (leak) errs.push(`${tag} ${leak}: ${c}`);
    }
  }
  return errs;
}

/** エントリ配列 → バンク。エラーがあっても使える部分で構築する（呼び出し側で errors を判断） */
export function loadBank(entries: WordEntry[]): { bank: Bank; errors: string[] } {
  const errors: string[] = [];
  const merged = new Map<string, BankWord>();
  for (const e of entries) {
    const errs = lintEntry(e);
    if (errs.length) {
      errors.push(...errs);
      continue;
    }
    const cur = merged.get(e.kana);
    if (cur) {
      cur.difficulty = Math.min(cur.difficulty, e.difficulty);
      if (!cur.surfaces.includes(e.surface)) cur.surfaces.push(e.surface);
      if (!cur.categories.includes(e.category)) cur.categories.push(e.category);
      for (const c of entryClues(e)) if (!cur.clues.some((x) => x.text === c.text)) cur.clues.push(c);
    } else {
      merged.set(e.kana, {
        kana: e.kana,
        len: kanaLength(e.kana),
        difficulty: e.difficulty,
        surfaces: [e.surface],
        categories: [e.category],
        clues: entryClues(e),
      });
    }
  }
  // 統合後に、他の表記が別エントリのカギへ漏れていないか再検査
  for (const w of merged.values()) {
    for (const c of w.clues) {
      const leak = clueLeaks(c.text, w.kana, w.surfaces);
      if (leak) errors.push(`[${w.surfaces.join("/")} / ${w.kana}] ${leak}: ${c.text}`);
    }
  }

  const words = [...merged.values()].sort((a, b) => (a.kana < b.kana ? -1 : a.kana > b.kana ? 1 : 0));
  const byLen = new Map<number, number[]>();
  const index = new Map<string, number[]>();
  const byKana = new Map<string, number>();
  words.forEach((w, id) => {
    byKana.set(w.kana, id);
    byLen.set(w.len, [...(byLen.get(w.len) ?? []), id]);
    Array.from(w.kana).forEach((ch, pos) => {
      const key = `${w.len}:${pos}:${ch}`;
      index.set(key, [...(index.get(key) ?? []), id]);
    });
  });
  return { bank: { words, byLen, index, byKana }, errors };
}

/**
 * パターン検索。pattern の null はワイルドカード。語 id を昇順で返す。
 * 固定文字の中で最も短い索引リストを走査し、残りの固定文字で絞る。
 */
export function candidates(bank: Bank, len: number, pattern: readonly (string | null)[]): number[] {
  const fixed: [number, string][] = [];
  pattern.forEach((ch, pos) => {
    if (ch !== null) fixed.push([pos, ch]);
  });
  if (fixed.length === 0) return bank.byLen.get(len) ?? [];
  let best: number[] | null = null;
  for (const [pos, ch] of fixed) {
    const list = bank.index.get(`${len}:${pos}:${ch}`) ?? [];
    if (best === null || list.length < best.length) best = list;
    if (list.length === 0) return [];
  }
  const rest = fixed;
  return best!.filter((id) => {
    const k = bank.words[id]!.kana;
    for (const [pos, ch] of rest) if (k[pos] !== ch) return false;
    return true;
  });
}
