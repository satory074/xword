// 1 日分の問題生成（純粋: ファイル I/O なし）。gen.ts / stress.ts / smoketest から使う。
import type { Bank, Level } from "../../src/lib/bank";
import { deriveSlots, solutionFromAnswers, type Slot, type Template } from "../../src/lib/grid";
import { cyrb53, shuffle } from "../../src/lib/rng";
import type { PublicPuzzle } from "../../src/lib/types";
import { fill } from "./fill";
import { schedule, type History } from "./history";
import { DEFAULT_PROFILE, type Profile } from "./level";
import { chooseClues, lintFill, lintLevels } from "./lint";

/**
 * 埋めアルゴリズム・lint を変えたら上げる（同じ日付でも別の問題になる）。
 * 2 = カギのレベル配分と難語の目標数 ／ 3 = 難語を新出（完全交差・lv1）と復習（間隔反復）に分けて毎日少数ずつ
 */
export const ALGO_VERSION = "3";
const SEEDS_PER_TEMPLATE = 3;
/** 新出・復習が目標に届かない候補しか無いとき、追加で試す（テンプレート, シード）の数 */
const EXTRA_TRIES = 9;

export interface GeneratedPuzzle {
  date: string;
  template: string;
  algo: string;
  seed: number;
  spec: PublicPuzzle;
  /** 49 文字 */
  solution: string;
  answers: Record<string, string>;
  clueIndex: Record<string, number>;
  /** slotId → 使ったカギのレベル */
  levels: Record<string, Level>;
  mix: Record<Level, number>;
  /** difficulty ≥ 2 の語のスロット id（= learn.new ∪ learn.review） */
  hard: string[];
  /** 新出語（履歴に無い難語）と復習語（間隔反復で戻ってきた難語）のスロット id */
  learn: { new: string[]; review: string[] };
  warnings: string[];
  nodes: number;
}

export interface GenerateOptions {
  cooldownDays?: number;
  maxNodes?: number;
  profile?: Profile;
}

export function dateSeed(date: string): number {
  return cyrb53(`${date}:${ALGO_VERSION}`) >>> 0;
}

export function generatePuzzle(
  date: string,
  bank: Bank,
  templates: Template[],
  history: History,
  opts: GenerateOptions = {},
): GeneratedPuzzle {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const seed = dateSeed(date);
  const sch = schedule(history, date, bank, opts.cooldownDays);
  const attempts: string[] = [];
  // 新出語が minNew に届かない、または復習候補がいるのに復習語が minReview に届かない候補は保留し、
  // 他のテンプレート／シードを少し試す。良い候補が無ければ保留のうち最良（新出 → 復習の順で満たすもの）を返す（失敗にはしない）
  let fallback: { puzzle: GeneratedPuzzle; score: number } | null = null;
  let extraTries = 0;
  for (const t of shuffle(templates, seed)) {
    const slots = deriveSlots(t.rows);
    for (let k = 0; k < SEEDS_PER_TEMPLATE; k++) {
      if (fallback && extraTries++ >= EXTRA_TRIES) return fallback.puzzle;
      const s = (seed + k * 7919) >>> 0;
      const res = fill(slots, bank, {
        seed: s,
        exclude: sch.exclude,
        recency: sch.recency,
        review: sch.review,
        maxNodes: opts.maxNodes,
        maxDiff3: profile.maxDiff3,
        targetNew: profile.targetNew,
        maxNew: profile.maxNew,
        targetReview: profile.targetReview,
        maxHard: profile.maxHard,
      });
      if (!res) {
        attempts.push(`${t.id}/${k}: 埋め失敗`);
        continue;
      }
      // 新出・復習の判定は schedule() を単一の情報源にする（fill の返す fresh/review と一致するはず）
      const isHard = (sid: string) => bank.words[bank.byKana.get(res.answers[sid]!)!]!.difficulty >= 2;
      const fresh = new Set(slots.map((x) => x.id).filter((sid) => isHard(sid) && !sch.recency.has(res.answers[sid]!)));
      const review = new Set(slots.map((x) => x.id).filter((sid) => sch.review.has(res.answers[sid]!)));
      const learn = { fresh, review };
      const solution = solutionFromAnswers(t.rows, slots, res.answers);
      const lint = lintFill(slots, bank, res.answers, solution, { maxDiff3: profile.maxDiff3, fresh, maxNew: profile.maxNew });
      if (lint.errors.length) {
        attempts.push(`${t.id}/${k}: ${lint.errors.join("; ")}`);
        continue;
      }
      const clues = chooseClues(slots, bank, res.answers, history.lastClue, s, profile, lint.ambiguous, learn);
      if (clues.errors.length) {
        attempts.push(`${t.id}/${k}: ${clues.errors.join("; ")}`);
        continue;
      }
      const levelErrors = lintLevels(slots, bank, res.answers, clues.levels, clues.clueIndex, profile, learn);
      if (levelErrors.length) {
        attempts.push(`${t.id}/${k}: ${levelErrors.join("; ")}`);
        continue;
      }
      const hard = slots.filter((x) => isHard(x.id)).map((x) => x.id);
      const warnings = [...lint.warnings, ...clues.warnings];
      if (fresh.size < profile.minNew) warnings.push(`新出語が ${fresh.size} 語（目標 ${profile.targetNew}）`);
      if (review.size < profile.minReview && sch.review.size > 0) warnings.push(`復習語が ${review.size} 語（目標 ${profile.targetReview}、候補 ${sch.review.size} 語）`);
      const puzzle: GeneratedPuzzle = {
        date,
        template: t.id,
        algo: ALGO_VERSION,
        seed: s,
        spec: buildSpec(date, t, slots, clues.clues),
        solution,
        answers: res.answers,
        clueIndex: clues.clueIndex,
        levels: clues.levels,
        mix: clues.mix,
        hard,
        learn: { new: slots.filter((x) => fresh.has(x.id)).map((x) => x.id), review: slots.filter((x) => review.has(x.id)).map((x) => x.id) },
        warnings,
        nodes: res.nodes,
      };
      const okNew = fresh.size >= profile.minNew;
      const okReview = review.size >= profile.minReview || sch.review.size === 0;
      if (okNew && okReview) return puzzle;
      const score = (okNew ? 2 : 0) + (okReview ? 1 : 0);
      if (!fallback || score > fallback.score) fallback = { puzzle, score };
      attempts.push(`${t.id}/${k}: 新出 ${fresh.size} 復習 ${review.size}（保留）`);
    }
  }
  if (fallback) return fallback.puzzle;
  throw new Error(`${date}: 生成できませんでした\n  ${attempts.join("\n  ")}`);
}

function buildSpec(date: string, t: Template, slots: Slot[], clues: Record<string, string>): PublicPuzzle {
  return {
    date,
    template: t.id,
    size: t.rows.length,
    grid: t.rows,
    slots: slots.map((s) => ({ id: s.id, dir: s.dir, num: s.num, r: s.r, c: s.c, len: s.len, clue: clues[s.id]! })),
  };
}
