// 語彙バンクの統計: 長さ・難易度・カテゴリ別の語数、カギのレベル網羅率、薄い (長さ, 位置, 文字) バケツ、
//   難語の在庫（まだ出していない難語 = 新出に使える語）と crosswordese（直近 90 日に 4 回以上出た語）。
//   網羅率の目標: lv2 欠 = 0、lv3 欠（difficulty 1 かつ 3 文字以上）= 0。difficulty ≥ 2 の語には clues3 を書かない（カギは直球に留める）
import { parseArgs } from "node:util";
import { addDays } from "../src/lib/date";
import { GRID_KANA, kanaLength } from "../src/lib/kana";
import { DEFAULT_BANK_DIR, DEFAULT_OUT_DIR, readBank, readBankEntries } from "./gen/bankio";
import { readHistoryDir } from "./gen/history";
import { DEFAULT_PROFILE } from "./gen/level";

const { values } = parseArgs({ options: { bank: { type: "string", default: DEFAULT_BANK_DIR }, out: { type: "string", default: DEFAULT_OUT_DIR } } });
const { bank, errors, entryCount } = readBank(values.bank);
if (errors.length) console.log(`⚠ lint ${errors.length} 件:\n  ${errors.join("\n  ")}`);
console.log(`エントリ ${entryCount} → 語 ${bank.words.length}`);

const byLen = new Map<number, number>();
const byDiff = new Map<number, number>();
for (const w of bank.words) {
  byLen.set(w.len, (byLen.get(w.len) ?? 0) + 1);
  byDiff.set(w.difficulty, (byDiff.get(w.difficulty) ?? 0) + 1);
}
console.log("長さ:", [...byLen.entries()].sort().map(([k, v]) => `${k}:${v}`).join(" "));
console.log("難易度:", [...byDiff.entries()].sort().map(([k, v]) => `${k}:${v}`).join(" "));

// カギの網羅率（エントリ単位・カテゴリ別）
interface Cov { n: number; noLv2: number; noLv3: number; needLv3: number; hard: number; clues: number }
const cov = new Map<string, Cov>();
const total: Cov = { n: 0, noLv2: 0, noLv3: 0, needLv3: 0, hard: 0, clues: 0 };
const add = (c: Cov, e: { difficulty: number; kana: string; clues: string[]; clues2?: string[]; clues3?: string[] }) => {
  c.n++;
  c.clues += e.clues.length + (e.clues2?.length ?? 0) + (e.clues3?.length ?? 0);
  if (!e.clues2?.length) c.noLv2++;
  if (e.difficulty >= 2) c.hard++;
  else if (kanaLength(e.kana) >= 3) {
    c.needLv3++;
    if (!e.clues3?.length) c.noLv3++;
  }
};
const entries = readBankEntries(values.bank);
for (const e of entries) {
  const c = cov.get(e.category) ?? { n: 0, noLv2: 0, noLv3: 0, needLv3: 0, hard: 0, clues: 0 };
  add(c, e);
  cov.set(e.category, c);
  add(total, e);
}
const fmt = (k: string, c: Cov) => `${k.padEnd(9)} ${String(c.n).padStart(4)} 語  lv2欠 ${String(c.noLv2).padStart(4)}  lv3欠 ${String(c.noLv3).padStart(4)}/${String(c.needLv3).padStart(4)}  難語 ${String(c.hard).padStart(3)}  カギ ${c.clues}`;
console.log("網羅率（lv3 欠は difficulty 1 かつ 3 文字以上のうち）:");
for (const [k, c] of [...cov.entries()].sort((a, b) => b[1].n - a[1].n)) console.log("  " + fmt(k, c));
console.log("  " + fmt("合計", total));

// 同音統合で difficulty が食い違う語（統合後は min になる。カギの実効難易度は出自エントリの difficulty）
const diffByKana = new Map<string, Set<number>>();
for (const e of entries) diffByKana.set(e.kana, (diffByKana.get(e.kana) ?? new Set()).add(e.difficulty));
const mixed = [...diffByKana.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => `${k}(${[...s].sort().join("/")})`);
if (mixed.length) console.log(`同音統合で difficulty が異なる語: ${mixed.join(" ")}`);

// 難語の在庫: out/ の履歴に一度も出ていない難語（新出語として出せる語）。1 日 targetNew 語で何日分か
const history = readHistoryDir(values.out);
const hardWords = bank.words.filter((w) => w.difficulty >= 2);
const unseen = hardWords.filter((w) => !history.uses.has(w.kana));
const perDay = DEFAULT_PROFILE.targetNew;
console.log(`難語在庫: ${unseen.length}/${hardWords.length} 語が未出題（1 日 ${perDay} 語なら約 ${perDay ? Math.floor(unseen.length / perDay) : "-"} 日分。bank に難語を足すと増える）`);

// crosswordese: 履歴の最終日から 90 日の窓で 4 回以上出た語（文字パターンの都合で繰り返し出る穴埋め語）
{
  const WINDOW = 90;
  const MIN_USES = 4;
  let latest = "";
  for (const u of history.uses.values()) for (const d of u) if (d > latest) latest = d;
  if (latest) {
    const from = addDays(latest, -(WINDOW - 1));
    const frequent = [...history.uses.entries()]
      .map(([kana, u]) => [kana, u.filter((d) => d >= from).length] as const)
      .filter(([, n]) => n >= MIN_USES)
      .sort((a, b) => b[1] - a[1]);
    console.log(`頻出語（${from}〜${latest} に ${MIN_USES} 回以上）: ${frequent.length ? frequent.map(([k, n]) => `${k}×${n}`).join(" ") : "なし"}`);
  }
}

// 文字別の出現（薄い文字を知る）
const charCount = new Map<string, number>();
for (const w of bank.words) for (const ch of w.kana) charCount.set(ch, (charCount.get(ch) ?? 0) + 1);
const rare = [...GRID_KANA].map((ch) => [ch, charCount.get(ch) ?? 0] as const).filter(([, n]) => n < 8);
console.log("出現 8 回未満の文字:", rare.map(([ch, n]) => `${ch}${n}`).join(" ") || "なし");

// 長さ 3〜5 で (位置, 文字) の候補が 2 語未満のバケツ数
for (const len of [3, 4, 5]) {
  let thin = 0;
  let total = 0;
  for (let pos = 0; pos < len; pos++) {
    for (const ch of GRID_KANA) {
      total++;
      if ((bank.index.get(`${len}:${pos}:${ch}`)?.length ?? 0) < 2) thin++;
    }
  }
  console.log(`長さ ${len}: 候補 2 語未満のバケツ ${thin}/${total}`);
}
