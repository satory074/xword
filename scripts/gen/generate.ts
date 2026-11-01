// 1 日分の問題生成（純粋: ファイル I/O なし）。gen.ts / stress.ts / smoketest から使う。
import type { Bank, Level } from "../../src/lib/bank";
import { deriveSlots, solutionFromAnswers, type Slot, type Template } from "../../src/lib/grid";
import { cyrb53, shuffle } from "../../src/lib/rng";
import type { PublicPuzzle } from "../../src/lib/types";
import { fill } from "./fill";
import { cooldown, type History } from "./history";
import { DEFAULT_PROFILE, type Profile } from "./level";
import { chooseClues, lintFill, lintLevels } from "./lint";

/** 埋めアルゴリズム・lint を変えたら上げる（同じ日付でも別の問題になる）。2 = カギのレベル配分と難語の目標数 */
export const ALGO_VERSION = "2";
const SEEDS_PER_TEMPLATE = 3;

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
  /** difficulty ≥ 2 の語のスロット id */
  hard: string[];
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
  const { exclude, recency } = cooldown(history, date, opts.cooldownDays);
  const attempts: string[] = [];
  for (const t of shuffle(templates, seed)) {
    const slots = deriveSlots(t.rows);
    for (let k = 0; k < SEEDS_PER_TEMPLATE; k++) {
      const s = (seed + k * 7919) >>> 0;
      const res = fill(slots, bank, { seed: s, exclude, recency, maxNodes: opts.maxNodes, maxDiff3: profile.maxDiff3, targetHard: profile.targetHard, maxHard: profile.maxHard });
      if (!res) {
        attempts.push(`${t.id}/${k}: 埋め失敗`);
        continue;
      }
      const solution = solutionFromAnswers(t.rows, slots, res.answers);
      const lint = lintFill(slots, bank, res.answers, solution, profile.maxDiff3);
      if (lint.errors.length) {
        attempts.push(`${t.id}/${k}: ${lint.errors.join("; ")}`);
        continue;
      }
      const clues = chooseClues(slots, bank, res.answers, history.lastClue, s, profile, lint.ambiguous);
      if (clues.errors.length) {
        attempts.push(`${t.id}/${k}: ${clues.errors.join("; ")}`);
        continue;
      }
      const levelErrors = lintLevels(slots, bank, res.answers, clues.levels, clues.clueIndex, profile);
      if (levelErrors.length) {
        attempts.push(`${t.id}/${k}: ${levelErrors.join("; ")}`);
        continue;
      }
      const hard = slots.filter((x) => bank.words[bank.byKana.get(res.answers[x.id]!)!]!.difficulty >= 2).map((x) => x.id);
      const warnings = [...lint.warnings, ...clues.warnings];
      if (hard.length < profile.minHard) warnings.push(`難語が ${hard.length} 語（目標 ${profile.targetHard}）`);
      return {
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
        warnings,
        nodes: res.nodes,
      };
    }
  }
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
