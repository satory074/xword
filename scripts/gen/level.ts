// 1 問の難易度プロファイル（唯一の調整点）と、スロットに許すカギの最大レベル。
//   難易度のレバーは カギ ＞ 語 ＞ 盤面。公平性: 難しいカギは「交差のマスと合わせて解ける」位置にだけ置く。
//   語彙が増える出題: 難語（difficulty ≥ 2）は「新出」（履歴に無い語。完全交差の位置・新出同士は非交差・カギは lv1）と
//   「復習」（間隔反復で戻ってきた語。カギは次の番号、lv2 まで）に分け、毎日少数ずつ入れる。
import type { Level } from "../../src/lib/bank";

export interface Profile {
  /** カギのレベル配分（スロット数に掛けて丸める）。lv1 は残り */
  mix: { 2: number; 3: number };
  /** lv3 カギがこれより少なければ warning（網羅率が育つまでは起こり得る） */
  minLv3: number;
  /** 新出語（履歴に無い難語）の目標数。埋めの候補順を偏らせるだけで、満たせなくても失敗にしない */
  targetNew: number;
  /** 新出語がこれより少なければ warning（在庫切れか埋めの都合） */
  minNew: number;
  /** 新出語の上限（ハード制約）。新出は完全交差スロットにしか置けず、lv3 カギの置き場を奪うため */
  maxNew: number;
  /** 復習語（過去に出た難語）の目標数。ウィンドウ内の語を優先。候補が無い日は 0 でよい */
  targetReview: number;
  /** 復習候補がいるのにこれより少なければ warning */
  minReview: number;
  /** difficulty ≥ 2 の語（新出 + 復習）の上限（ハード制約）。難語ばかりになると lv3 カギを置ける語が無くなるため */
  maxHard: number;
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
 * 新出 1〜2 語: 未知語は全体の 2〜5%（Nation）／誤り率 15%（85% ルール）が学習に最適。20 語の盤面なら 1〜2 語。
 * 復習 1〜2 語: 3〜7 日後・14〜30 日後に別のカギで再会させる（history.ts の HARD_SCHEDULE）。
 */
export const DEFAULT_PROFILE: Profile = {
  mix: { 2: 0.48, 3: 0.28 },
  minLv3: 4,
  targetNew: 2,
  minNew: 1,
  maxNew: 2,
  targetReview: 2,
  minReview: 1,
  maxHard: 5,
  maxDiff3: 2,
  clueCap: { 1: 3, 2: 2, 3: 1 },
  lv2MaxUnchecked: 1,
};

/** 埋めで種（新出 / 復習）を先頭に昇格させる条件: forward checking の開放度（交差スロットの残り候補の最小）が HARD_FC_FLOOR 以上 */
export const HARD_FC_FLOOR = 2;
/** 1 スロットの候補順で先頭に昇格させる種の最大数（全部が行き止まりでも探索が発散しないように） */
export const SEED_PROMOTE_MAX = 6;

/** CLI の --mix 24/48/28（lv1/lv2/lv3 の %）、--new 2（新出語の目標）、--review 2（復習語の目標）をプロファイルに反映 */
export function parseProfileArgs(v: { mix?: string; new?: string; review?: string }, base: Profile = DEFAULT_PROFILE): Profile {
  const p: Profile = { ...base, mix: { ...base.mix }, clueCap: { ...base.clueCap } };
  if (v.mix) {
    const parts = v.mix.split("/").map(Number);
    if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x) || x < 0) || Math.abs(parts[0]! + parts[1]! + parts[2]! - 100) > 1) {
      throw new Error(`--mix は lv1/lv2/lv3 の % を合計 100 で: ${v.mix}`);
    }
    p.mix = { 2: parts[1]! / 100, 3: parts[2]! / 100 };
  }
  const count = (name: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} が不正: ${raw}`);
    return n;
  };
  if (v.new !== undefined) {
    const n = count("new", v.new);
    p.targetNew = n;
    p.minNew = Math.min(p.minNew, n);
    p.maxNew = Math.max(p.maxNew, n);
    p.maxHard = Math.max(p.maxHard, n);
  }
  if (v.review !== undefined) {
    const n = count("review", v.review);
    p.targetReview = n;
    p.minReview = Math.min(p.minReview, n);
  }
  return p;
}

/**
 * スロットに許すカギの最大レベル。
 *   新出語（fresh）→ 1（初めて会う語は意味の分かる直接カギで。noticing）／
 *   二重解の恐れがある（lintFill の warning）→ 1 ／ 2 文字語は両マス交差なら 2、さもなくば 1 ／
 *   片方向マスが lv2MaxUnchecked を超える → 1 ／ 片方向マスあり → 2 ／ 完全交差 → 3。最後に語の difficulty で頭打ち。
 */
export function maxClueLevel(len: number, unchecked: number, wordDiff: number, ambiguous: boolean, p: Profile, fresh = false): Level {
  let cap: Level;
  if (ambiguous || fresh) cap = 1;
  else if (len === 2) cap = unchecked > 0 ? 1 : 2;
  else if (unchecked > p.lv2MaxUnchecked) cap = 1;
  else if (unchecked > 0) cap = 2;
  else cap = 3;
  const d = (wordDiff <= 1 ? 1 : wordDiff >= 3 ? 3 : 2) as 1 | 2 | 3;
  const wc = p.clueCap[d];
  return (cap < wc ? cap : wc) as Level;
}
