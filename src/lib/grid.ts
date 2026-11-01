// 盤面の幾何: テンプレート検証・スロット抽出・番号付け・49 文字形式の採点。
// DOM / Supabase に依存しない。scoreCells は SQL の score_cells の鏡像。
import { GRID_KANA_SET } from "./kana";

export const SIZE = 7;
export const CELLS = SIZE * SIZE;
export const BLACK = "#";
export const WHITE = ".";
export const EMPTY = "_";

/** テンプレート制約（計画の lint 閾値） */
export const MAX_BLACKS = 12; // 49 × 25% = 12.25
export const MAX_SLOT_LEN = 5;
export const MAX_TWO_LETTER = 4;

export type Dir = "A" | "D";

export interface Slot {
  /** "A3" / "D7" */
  id: string;
  dir: Dir;
  num: number;
  r: number;
  c: number;
  len: number;
  /** 0..48 の行優先インデックス */
  cells: number[];
}

export interface Template {
  id: string;
  rows: string[];
}

export const cellIndex = (r: number, c: number): number => r * SIZE + c;

export function isBlackAt(rows: string[], r: number, c: number): boolean {
  return rows[r]![c] === BLACK;
}

/** 行優先でスロットを抽出し、ニコリ式に番号を振る（タテ・ヨコ同じ開始マスは同じ番号） */
export function deriveSlots(rows: string[]): Slot[] {
  const black = (r: number, c: number) => isBlackAt(rows, r, c);
  const slots: Slot[] = [];
  let num = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (black(r, c)) continue;
      const startsA = (c === 0 || black(r, c - 1)) && c + 1 < SIZE && !black(r, c + 1);
      const startsD = (r === 0 || black(r - 1, c)) && r + 1 < SIZE && !black(r + 1, c);
      if (!startsA && !startsD) continue;
      num++;
      if (startsA) {
        const cells: number[] = [];
        for (let cc = c; cc < SIZE && !black(r, cc); cc++) cells.push(cellIndex(r, cc));
        slots.push({ id: `A${num}`, dir: "A", num, r, c, len: cells.length, cells });
      }
      if (startsD) {
        const cells: number[] = [];
        for (let rr = r; rr < SIZE && !black(rr, c); rr++) cells.push(cellIndex(rr, c));
        slots.push({ id: `D${num}`, dir: "D", num, r, c, len: cells.length, cells });
      }
    }
  }
  return slots;
}

/** 各マスが属するスロット id の一覧（0 = 孤立、1 = 片方向のみ、2 = 交差） */
export function cellSlotMap(slots: Slot[]): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const s of slots) for (const cell of s.cells) m.set(cell, [...(m.get(cell) ?? []), s.id]);
  return m;
}

export function transpose(rows: string[]): string[] {
  const out: string[] = [];
  for (let c = 0; c < SIZE; c++) {
    let line = "";
    for (let r = 0; r < SIZE; r++) line += rows[r]![c];
    out.push(line);
  }
  return out;
}

/** 白マス数 */
export function whiteCount(rows: string[]): number {
  let n = 0;
  for (const row of rows) for (const ch of row) if (ch === WHITE) n++;
  return n;
}

/**
 * テンプレートの検証。空配列なら合法。
 * 日本語クロスワードのハード制約（連続黒なし・連結・孤立マスなし・四隅白・点対称）と
 * 計画の閾値（黒 ≤ 12・最長 5・2 文字語 ≤ 4）。
 */
export function validateTemplate(rows: string[]): string[] {
  const errors: string[] = [];
  if (rows.length !== SIZE) return [`行数が ${SIZE} ではない: ${rows.length}`];
  for (let r = 0; r < SIZE; r++) {
    if (rows[r]!.length !== SIZE) errors.push(`${r} 行目の長さが ${SIZE} ではない`);
    for (const ch of rows[r]!) if (ch !== BLACK && ch !== WHITE) errors.push(`不正な文字 '${ch}'`);
  }
  if (errors.length) return errors;

  const black = (r: number, c: number) => isBlackAt(rows, r, c);
  let blacks = 0;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!black(r, c)) continue;
      blacks++;
      if (c + 1 < SIZE && black(r, c + 1)) errors.push(`黒マスがヨコに連続 (${r},${c})`);
      if (r + 1 < SIZE && black(r + 1, c)) errors.push(`黒マスがタテに連続 (${r},${c})`);
      if (!black(SIZE - 1 - r, SIZE - 1 - c)) errors.push(`点対称でない (${r},${c})`);
    }
  }
  for (const [r, c] of [[0, 0], [0, SIZE - 1], [SIZE - 1, 0], [SIZE - 1, SIZE - 1]] as const) {
    if (black(r, c)) errors.push(`四隅が黒マス (${r},${c})`);
  }
  if (blacks > MAX_BLACKS) errors.push(`黒マスが多すぎる: ${blacks} > ${MAX_BLACKS}`);

  // 連結性
  const whites = whiteCount(rows);
  const seen = new Set<number>();
  let start = -1;
  for (let i = 0; i < CELLS && start < 0; i++) if (!black(Math.floor(i / SIZE), i % SIZE)) start = i;
  const stack = start >= 0 ? [start] : [];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && !black(rr, cc)) stack.push(cellIndex(rr, cc));
    }
  }
  if (seen.size !== whites) errors.push(`白マスが分断されている (${seen.size}/${whites})`);

  // スロット性質
  const slots = deriveSlots(rows);
  const covered = cellSlotMap(slots);
  for (let i = 0; i < CELLS; i++) {
    if (black(Math.floor(i / SIZE), i % SIZE)) continue;
    if (!covered.has(i)) errors.push(`どの単語にも属さない孤立マス (${Math.floor(i / SIZE)},${i % SIZE})`);
  }
  for (const s of slots) if (s.len > MAX_SLOT_LEN) errors.push(`スロット ${s.id} が長すぎる: ${s.len}`);
  const two = slots.filter((s) => s.len === 2).length;
  if (two > MAX_TWO_LETTER) errors.push(`2 文字語が多すぎる: ${two} > ${MAX_TWO_LETTER}`);
  return errors;
}

/** スロットごとの答えから 49 文字の解答文字列を組み立てる。交差で矛盾があれば例外 */
export function solutionFromAnswers(rows: string[], slots: Slot[], answers: Record<string, string>): string {
  const out: string[] = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) out.push(isBlackAt(rows, r, c) ? BLACK : EMPTY);
  for (const s of slots) {
    const w = answers[s.id];
    if (!w) throw new Error(`答えが無いスロット: ${s.id}`);
    const chars = Array.from(w);
    if (chars.length !== s.len) throw new Error(`長さ不一致 ${s.id}: ${w}`);
    s.cells.forEach((cell, i) => {
      const cur = out[cell]!;
      if (cur !== EMPTY && cur !== chars[i]) throw new Error(`交差が矛盾 ${s.id} @${cell}: ${cur} vs ${chars[i]}`);
      out[cell] = chars[i]!;
    });
  }
  const sol = out.join("");
  if (sol.includes(EMPTY)) throw new Error("埋まっていない白マスがある");
  return sol;
}

export interface Score {
  /** 49 文字: '1' 正解 / '0' 誤り / '_' 空欄 / '#' 黒 */
  mask: string;
  correct: number;
  total: number;
  solved: boolean;
}

/**
 * 49 文字形式の採点（SQL score_cells の鏡像）。
 * cells は正規化済み前提。長さ・黒マス位置・文字集合が合わなければ INVALID_CELLS。
 */
export function scoreCells(solution: string, cells: string): Score {
  const sol = Array.from(solution);
  const inp = Array.from(cells);
  if (sol.length !== CELLS || inp.length !== CELLS) throw new Error("INVALID_CELLS");
  let mask = "";
  let correct = 0;
  let total = 0;
  for (let i = 0; i < CELLS; i++) {
    const s = sol[i]!;
    const x = inp[i]!;
    if (s === BLACK) {
      if (x !== BLACK) throw new Error("INVALID_CELLS");
      mask += BLACK;
      continue;
    }
    total++;
    if (x === EMPTY) {
      mask += EMPTY;
    } else if (!GRID_KANA_SET.has(x)) {
      throw new Error("INVALID_CELLS");
    } else if (x === s) {
      mask += "1";
      correct++;
    } else {
      mask += "0";
    }
  }
  return { mask, correct, total, solved: correct === total };
}

/** 黒マスだけ '#'、他は '_' の空盤面文字列 */
export function emptyCells(rows: string[]): string {
  let s = "";
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) s += isBlackAt(rows, r, c) ? BLACK : EMPTY;
  return s;
}
