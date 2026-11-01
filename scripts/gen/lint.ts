// 埋め結果の品質 lint とカギ選択（レベル配分）。
//   公平性: 難しいカギ（lv3）は完全交差のスロットだけ、lv2 は片方向マス ≤ lv2MaxUnchecked、
//   二重解の恐れがあるスロットは直球（lv1）のまま。実効難易度 3（lv3 カギ or difficulty 3 の語）同士は交差させない。
import { candidates, clueLeaks, type Bank, type BankWord, type Level } from "../../src/lib/bank";
import { BLACK, cellSlotMap, uncheckedCount, type Slot } from "../../src/lib/grid";
import { cyrb53 } from "../../src/lib/rng";
import { DEFAULT_PROFILE, maxClueLevel, type Profile } from "./level";

export const MAX_LETTER_SHARE = 0.25;
export const MAX_DIFF3 = DEFAULT_PROFILE.maxDiff3;

export interface LintReport {
  errors: string[];
  warnings: string[];
  /** 二重解注意を出したスロット id（カギは lv1 に留める） */
  ambiguous: Set<string>;
}

const wordOf = (bank: Bank, kana: string): BankWord => bank.words[bank.byKana.get(kana)!]!;
const crosses = (a: Slot, b: Slot): boolean => a.cells.some((c) => b.cells.includes(c));

/** 二重解・文字偏り・難語制約 */
export function lintFill(slots: Slot[], bank: Bank, answers: Record<string, string>, solution: string, maxDiff3 = MAX_DIFF3): LintReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ambiguous = new Set<string>();
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
    // 警告に留め、カギを lv1 に固定して preview.html で目視する。全マスが片方向のみの語だけは不採用。
    const msg = `${s.id} ${kana}: 交差 ${s.len - wildCount}/${s.len} マスで他に ${others.length} 語（${others.slice(0, 5).join("、")}）`;
    if (wildCount === s.len) errors.push(`交差のない語: ${msg}`);
    else {
      warnings.push(`二重解注意: ${msg}`);
      ambiguous.add(s.id);
    }
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
  const diff3 = slots.filter((s) => wordOf(bank, answers[s.id]!).difficulty === 3);
  if (diff3.length > maxDiff3) errors.push(`難語が ${diff3.length} 語（上限 ${maxDiff3}）`);
  for (const a of diff3) {
    if (uncheckedCount(a, cellMap) > 0) errors.push(`難語が片方向マスのスロットにある: ${a.id} ${answers[a.id]}`);
    for (const b of diff3) {
      if (a.id < b.id && crosses(a, b)) errors.push(`難語同士が交差: ${a.id} × ${b.id}`);
    }
  }
  return { errors, warnings, ambiguous };
}

export interface ClueChoice {
  clues: Record<string, string>;
  clueIndex: Record<string, number>;
  levels: Record<string, Level>;
  mix: Record<Level, number>;
  errors: string[];
  warnings: string[];
}

interface SlotInfo {
  s: Slot;
  kana: string;
  w: BankWord;
  unchecked: number;
  /** レベル → 使えるカギの添字（他の答えを漏らさないもの） */
  usable: Record<Level, number[]>;
  cap: Level;
  hash: number;
}

/**
 * マスを共有しない最大の部分集合を全探索で選ぶ（候補 ≤ 16）。
 * 個数 → 長さ合計 → ハッシュ の順で決める。候補が多ければ長い順の貪欲にフォールバック。
 */
function pickIndependent(cands: SlotInfo[], seed: number): SlotInfo[] {
  const n = cands.length;
  if (n === 0) return [];
  if (n > 16) {
    const sorted = [...cands].sort((a, b) => b.s.len - a.s.len || a.hash - b.hash);
    const out: SlotInfo[] = [];
    for (const c of sorted) if (!out.some((o) => crosses(o.s, c.s))) out.push(c);
    return out;
  }
  const conflict = cands.map((a, i) => {
    let m = 0;
    cands.forEach((b, j) => {
      if (i !== j && crosses(a.s, b.s)) m |= 1 << j;
    });
    return m;
  });
  let best = 0;
  let bestKey: [number, number, number] = [-1, -1, 0];
  for (let mask = 1; mask < 1 << n; mask++) {
    let ok = true;
    let count = 0;
    let lenSum = 0;
    for (let i = 0; i < n && ok; i++) {
      if (!(mask & (1 << i))) continue;
      if (mask & conflict[i]!) ok = false;
      count++;
      lenSum += cands[i]!.s.len;
    }
    if (!ok) continue;
    if (count < bestKey[0] || (count === bestKey[0] && lenSum < bestKey[1])) continue;
    const h = cyrb53(cands.filter((_, i) => mask & (1 << i)).map((c) => c.s.id).join(","), seed);
    if (count === bestKey[0] && lenSum === bestKey[1] && h >= bestKey[2]) continue;
    best = mask;
    bestKey = [count, lenSum, h];
  }
  return cands.filter((_, i) => best & (1 << i));
}

/**
 * カギ選択。手順:
 *   1. スロットごとに使えるカギ（他の答えを漏らさない）とレベル上限（片方向マス・2 文字・二重解・語の difficulty）
 *   2. lv3 を完全交差かつ互いに非交差のスロットへ（最大独立集合）、次に lv2、残りは lv1
 *   3. 割り当てたレベルにカギが無ければ 1 段ずつ下げる。同レベル内は前回使った番号の次（履歴なしはハッシュ）
 */
export function chooseClues(
  slots: Slot[],
  bank: Bank,
  answers: Record<string, string>,
  lastClue: ReadonlyMap<string, number>,
  seed: number,
  profile: Profile = DEFAULT_PROFILE,
  ambiguous: ReadonlySet<string> = new Set(),
): ClueChoice {
  const clues: Record<string, string> = {};
  const clueIndex: Record<string, number> = {};
  const levels: Record<string, Level> = {};
  const mix: Record<Level, number> = { 1: 0, 2: 0, 3: 0 };
  const errors: string[] = [];
  const warnings: string[] = [];
  const cellMap = cellSlotMap(slots);

  // この問題の全答え（表記も含む）。カギにこれらが入っていてはいけない
  const others = slots.map((s) => {
    const kana = answers[s.id]!;
    return { id: s.id, kana, surfaces: wordOf(bank, kana).surfaces };
  });
  const leaksAny = (clue: string, selfId: string): string | null => {
    for (const o of others) {
      const leak = clueLeaks(clue, o.kana, o.surfaces);
      if (leak) return o.id === selfId ? leak : `${leak}（同じ問題の ${o.id} の答え）`;
    }
    return null;
  };

  const info: SlotInfo[] = slots.map((s) => {
    const kana = answers[s.id]!;
    const w = wordOf(bank, kana);
    const usable: Record<Level, number[]> = { 1: [], 2: [], 3: [] };
    w.clues.forEach((c, idx) => {
      if (!leaksAny(c.text, s.id)) usable[c.level].push(idx);
    });
    const unchecked = uncheckedCount(s, cellMap);
    return { s, kana, w, unchecked, usable, cap: maxClueLevel(s.len, unchecked, w.difficulty, ambiguous.has(s.id), profile), hash: cyrb53(s.id + kana, seed) };
  });

  const n = slots.length;
  const want3 = Math.round(n * profile.mix[3]);
  const want2 = Math.round(n * profile.mix[2]);
  const target = new Map<string, Level>();

  // lv3: 完全交差・候補あり・difficulty 3 の語（実効 3）と交差しない
  const hard3 = info.filter((x) => x.w.difficulty >= 3);
  const elig3 = info.filter((x) => x.cap === 3 && x.usable[3].length > 0 && !hard3.some((h) => crosses(h.s, x.s)));
  let chosen3 = pickIndependent(elig3, seed);
  if (chosen3.length > want3) chosen3 = [...chosen3].sort((a, b) => b.s.len - a.s.len || a.hash - b.hash).slice(0, want3);
  for (const x of chosen3) target.set(x.s.id, 3);

  // lv2: 残りから片方向マスが少なく長いものを優先
  const elig2 = info
    .filter((x) => !target.has(x.s.id) && x.cap >= 2 && x.usable[2].length > 0)
    .sort((a, b) => a.unchecked - b.unchecked || b.s.len - a.s.len || a.hash - b.hash)
    .slice(0, want2);
  for (const x of elig2) target.set(x.s.id, 2);

  for (const x of info) {
    let lv = target.get(x.s.id) ?? 1;
    while (lv > 1 && x.usable[lv].length === 0) lv = (lv - 1) as Level;
    const idxs = x.usable[lv];
    if (idxs.length === 0) {
      const firstLeak = x.w.clues.map((c) => leaksAny(c.text, x.s.id)).find((l) => l) ?? "カギが無い";
      errors.push(`${x.s.id} ${x.kana}: 使えるカギがない — ${firstLeak}`);
      continue;
    }
    const last = lastClue.get(x.kana);
    const pos = last === undefined ? -1 : idxs.indexOf(last);
    const start = pos >= 0 ? (pos + 1) % idxs.length : cyrb53(x.kana, seed) % idxs.length;
    const chosen = idxs[start]!;
    clues[x.s.id] = x.w.clues[chosen]!.text;
    clueIndex[x.s.id] = chosen;
    levels[x.s.id] = lv;
    mix[lv]++;
  }
  if (mix[3] < profile.minLv3) warnings.push(`lv3 カギが ${mix[3]} 本（目標 ${want3}、置ける候補 ${elig3.length} スロット）`);
  if (mix[2] + mix[3] < want2 + want3 - 2) warnings.push(`lv2 以上のカギが ${mix[2] + mix[3]} 本（目標 ${want2 + want3}）`);
  return { clues, clueIndex, levels, mix, errors, warnings };
}

/** カギのレベル配置の公平性（chooseClues が守るはずの制約を最後の砦として再検査） */
export function lintLevels(
  slots: Slot[],
  bank: Bank,
  answers: Record<string, string>,
  levels: Record<string, Level>,
  clueIndex: Record<string, number>,
  profile: Profile = DEFAULT_PROFILE,
): string[] {
  const errors: string[] = [];
  const cellMap = cellSlotMap(slots);
  const eff = new Map<string, number>();
  for (const s of slots) {
    const w = wordOf(bank, answers[s.id]!);
    const lv = levels[s.id] ?? 1;
    const unchecked = uncheckedCount(s, cellMap);
    if (lv === 3 && unchecked > 0) errors.push(`lv3 カギが片方向マスのスロットに: ${s.id} ${answers[s.id]}`);
    if (lv === 2 && (s.len === 2 ? unchecked > 0 : unchecked > profile.lv2MaxUnchecked)) errors.push(`lv2 カギの片方向マスが多い: ${s.id} ${answers[s.id]}（${unchecked}）`);
    const clue = w.clues[clueIndex[s.id] ?? -1];
    eff.set(s.id, Math.max(lv, clue?.diff ?? w.difficulty, w.difficulty));
  }
  for (const a of slots) {
    if (eff.get(a.id)! < 3) continue;
    for (const b of slots) {
      if (a.id < b.id && eff.get(b.id)! >= 3 && crosses(a, b)) errors.push(`実効難易度 3 同士が交差: ${a.id} × ${b.id}`);
    }
  }
  return errors;
}
