// 埋め結果の品質 lint とカギ選択。
import { candidates, clueLeaks, type Bank } from "../../src/lib/bank";
import { BLACK, cellSlotMap, type Slot } from "../../src/lib/grid";
import { cyrb53 } from "../../src/lib/rng";

export const MAX_LETTER_SHARE = 0.25;
export const MAX_DIFF3 = 2;

export interface LintReport {
  errors: string[];
  warnings: string[];
}

/** 二重解・文字偏り・難語制約 */
export function lintFill(slots: Slot[], bank: Bank, answers: Record<string, string>, solution: string): LintReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cellMap = cellSlotMap(slots);

  // 二重解: 片方向にしか属さないマスをワイルドカードにして、他の語が一致するか
  for (const s of slots) {
    const kana = answers[s.id]!;
    const chars = Array.from(kana);
    const wild = s.cells.map((cell) => (cellMap.get(cell)?.length ?? 0) === 1);
    const wildCount = wild.filter(Boolean).length;
    if (wildCount === 0) continue;
    const pattern = chars.map((ch, i) => (wild[i] ? null : ch));
    const others = candidates(bank, s.len, pattern)
      .map((id) => bank.words[id]!.kana)
      .filter((k) => k !== kana);
    if (others.length === 0) continue;
    // 構造だけでは「カギが一義的か」は判定できない（1 文字固定の 3 文字語は必ず多数一致する）ので
    // 警告に留め、preview.html で目視する。全マスが片方向のみの語だけは不採用。
    const msg = `${s.id} ${kana}: 交差 ${s.len - wildCount}/${s.len} マスで他に ${others.length} 語（${others.slice(0, 5).join("、")}）`;
    if (wildCount === s.len) errors.push(`交差のない語: ${msg}`);
    else warnings.push(`二重解注意: ${msg}`);
  }

  // 文字の偏り
  const counts = new Map<string, number>();
  let whites = 0;
  for (const ch of solution) {
    if (ch === BLACK) continue;
    whites++;
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  for (const [ch, n] of counts) {
    if (n / whites > MAX_LETTER_SHARE) errors.push(`文字「${ch}」が白マスの ${Math.round((n / whites) * 100)}% を占める`);
  }

  // 難語（探索中に強制しているが、最後の砦として再検査）
  const diff3 = slots.filter((s) => (bank.words[bank.byKana.get(answers[s.id]!)!]?.difficulty ?? 1) === 3);
  if (diff3.length > MAX_DIFF3) errors.push(`難語が ${diff3.length} 語（上限 ${MAX_DIFF3}）`);
  for (const a of diff3) {
    for (const b of diff3) {
      if (a.id < b.id && a.cells.some((c) => b.cells.includes(c))) errors.push(`難語同士が交差: ${a.id} × ${b.id}`);
    }
  }
  return { errors, warnings };
}

/**
 * カギ選択: 前回使った番号の次（履歴なしはハッシュで決める）。
 * 同じ問題内の他の答え（カナ・読み・表記）をカギに含むものは避け、避けられなければエラー。
 * 戻り値は slotId → カギ本文と、slotId → 使った番号（履歴用）。
 */
export function chooseClues(
  slots: Slot[],
  bank: Bank,
  answers: Record<string, string>,
  lastClue: ReadonlyMap<string, number>,
  seed: number,
): { clues: Record<string, string>; clueIndex: Record<string, number>; errors: string[] } {
  const clues: Record<string, string> = {};
  const clueIndex: Record<string, number> = {};
  const errors: string[] = [];
  // この問題の全答え（表記も含む）。カギにこれらが入っていてはいけない
  const others = slots.map((s) => {
    const kana = answers[s.id]!;
    return { id: s.id, kana, surfaces: bank.words[bank.byKana.get(kana)!]!.surfaces };
  });
  const leaksAny = (clue: string, selfId: string): string | null => {
    for (const o of others) {
      const leak = clueLeaks(clue, o.kana, o.surfaces);
      if (leak) return o.id === selfId ? leak : `${leak}（同じ問題の ${o.id} の答え）`;
    }
    return null;
  };
  for (const s of slots) {
    const kana = answers[s.id]!;
    const w = bank.words[bank.byKana.get(kana)!]!;
    const n = w.clues.length;
    const last = lastClue.get(kana);
    const start = last === undefined ? cyrb53(kana, seed) % n : (last + 1) % n;
    let chosen = -1;
    let firstLeak: string | null = null;
    for (let k = 0; k < n; k++) {
      const idx = (start + k) % n;
      const leak = leaksAny(w.clues[idx]!, s.id);
      if (!leak) {
        chosen = idx;
        break;
      }
      firstLeak ??= leak;
    }
    if (chosen < 0) {
      errors.push(`${s.id} ${kana}: 使えるカギがない — ${firstLeak}`);
      continue;
    }
    clues[s.id] = w.clues[chosen]!;
    clueIndex[s.id] = chosen;
  }
  return { clues, clueIndex, errors };
}
