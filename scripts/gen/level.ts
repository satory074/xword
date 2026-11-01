// 1 問の難易度プロファイル（唯一の調整点）と、スロットに許すカギの最大レベル。
//   難易度のレバーは カギ ＞ 語 ＞ 盤面。公平性: 難しいカギは「交差のマスと合わせて解ける」位置にだけ置く。
import type { Level } from "../../src/lib/bank";

export interface Profile {
  /** カギのレベル配分（スロット数に掛けて丸める）。lv1 は残り */
  mix: { 2: number; 3: number };
  /** lv3 カギがこれより少なければ warning（網羅率が育つまでは起こり得る） */
  minLv3: number;
  /** difficulty ≥ 2 の語の目標数。埋めの候補順を偏らせるだけで、満たせなくても失敗にしない */
  targetHard: number;
  /** 難語がこれより少なければ warning */
  minHard: number;
  /** difficulty 3 の語の上限（互いに交差しない・完全交差のスロットのみ） */
  maxDiff3: number;
  /** 語の difficulty → カギの最大レベル。難語ほど直球のカギ（実効難易度 = max(語, カギ) を 3 で止める） */
  clueCap: Record<1 | 2 | 3, Level>;
  /** 3 文字以上の語に lv2 カギを許す片方向マスの最大数（lv3 は常に 0 = 完全交差のみ） */
  lv2MaxUnchecked: number;
}

/**
 * 既定（NYT の水〜木曜相当を狙う）。テンプレート実測で lv3 を置ける非交差スロットは 5〜6 / 20〜22 なので
 * mix[3] = 0.28 が実現可能な上限。到達見込み lv1 ≈ 24% / lv2 ≈ 48% / lv3 ≈ 28%。
 */
export const DEFAULT_PROFILE: Profile = {
  mix: { 2: 0.48, 3: 0.28 },
  minLv3: 4,
  targetHard: 3,
  minHard: 2,
  maxDiff3: 2,
  clueCap: { 1: 3, 2: 2, 3: 1 },
  lv2MaxUnchecked: 1,
};

/** 埋めで難語を先頭に昇格させる条件: forward checking の開放度が最大値の HARD_TIER 倍以上（かつ HARD_FC_FLOOR 以上） */
export const HARD_TIER = 0.5;
export const HARD_FC_FLOOR = 2;

/** CLI の --mix 24/48/28（lv1/lv2/lv3 の %）と --hard 3 をプロファイルに反映 */
export function parseProfileArgs(v: { mix?: string; hard?: string }, base: Profile = DEFAULT_PROFILE): Profile {
  const p: Profile = { ...base, mix: { ...base.mix }, clueCap: { ...base.clueCap } };
  if (v.mix) {
    const parts = v.mix.split("/").map(Number);
    if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x) || x < 0) || Math.abs(parts[0]! + parts[1]! + parts[2]! - 100) > 1) {
      throw new Error(`--mix は lv1/lv2/lv3 の % を合計 100 で: ${v.mix}`);
    }
    p.mix = { 2: parts[1]! / 100, 3: parts[2]! / 100 };
  }
  if (v.hard !== undefined) {
    const n = Number(v.hard);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--hard が不正: ${v.hard}`);
    p.targetHard = n;
    p.minHard = Math.min(p.minHard, n);
  }
  return p;
}

/**
 * スロットに許すカギの最大レベル。
 *   二重解の恐れがある（lintFill の warning）→ 1 ／ 2 文字語は両マス交差なら 2、さもなくば 1 ／
 *   片方向マスが lv2MaxUnchecked を超える → 1 ／ 片方向マスあり → 2 ／ 完全交差 → 3。最後に語の difficulty で頭打ち。
 */
export function maxClueLevel(len: number, unchecked: number, wordDiff: number, ambiguous: boolean, p: Profile): Level {
  let cap: Level;
  if (ambiguous) cap = 1;
  else if (len === 2) cap = unchecked > 0 ? 1 : 2;
  else if (unchecked > p.lv2MaxUnchecked) cap = 1;
  else if (unchecked > 0) cap = 2;
  else cap = 3;
  const d = (wordDiff <= 1 ? 1 : wordDiff >= 3 ? 3 : 2) as 1 | 2 | 3;
  const wc = p.clueCap[d];
  return (cap < wc ? cap : wc) as Level;
}
