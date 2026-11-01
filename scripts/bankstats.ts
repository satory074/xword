// 語彙バンクの統計: 長さ・難易度・カテゴリ別の語数と、薄い (長さ, 位置, 文字) バケツ。
import { parseArgs } from "node:util";
import { GRID_KANA } from "../src/lib/kana";
import { DEFAULT_BANK_DIR, readBank } from "./gen/bankio";

const { values } = parseArgs({ options: { bank: { type: "string", default: DEFAULT_BANK_DIR } } });
const { bank, errors, entryCount } = readBank(values.bank);
if (errors.length) console.log(`⚠ lint ${errors.length} 件:\n  ${errors.join("\n  ")}`);
console.log(`エントリ ${entryCount} → 語 ${bank.words.length}`);

const byLen = new Map<number, number>();
const byDiff = new Map<number, number>();
const byCat = new Map<string, number>();
for (const w of bank.words) {
  byLen.set(w.len, (byLen.get(w.len) ?? 0) + 1);
  byDiff.set(w.difficulty, (byDiff.get(w.difficulty) ?? 0) + 1);
  for (const c of w.categories) byCat.set(c, (byCat.get(c) ?? 0) + 1);
}
console.log("長さ:", [...byLen.entries()].sort().map(([k, v]) => `${k}:${v}`).join(" "));
console.log("難易度:", [...byDiff.entries()].sort().map(([k, v]) => `${k}:${v}`).join(" "));
console.log("カテゴリ:", [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" "));

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
