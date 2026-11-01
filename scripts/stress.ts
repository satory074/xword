// 連続生成の負荷試験: 成功率・探索ノード数・語の再利用間隔・使用語数・カギのレベル配分を計測する（ファイルは書かない）。
//   npm run stress -- --days 60 [--date 2027-01-01] [--cooldown 10] [--mix 24/48/28] [--hard 3]
import { parseArgs } from "node:util";
import { addDays, diffDays } from "../src/lib/date";
import { DEFAULT_BANK_DIR, readBank, readTemplates } from "./gen/bankio";
import { generatePuzzle } from "./gen/generate";
import { addToHistory, emptyHistory } from "./gen/history";
import { parseProfileArgs } from "./gen/level";

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "60" },
    date: { type: "string", default: "2027-01-01" },
    cooldown: { type: "string" },
    bank: { type: "string", default: DEFAULT_BANK_DIR },
    mix: { type: "string" },
    hard: { type: "string" },
  },
});
const days = Number(values.days);
const profile = parseProfileArgs(values);
const { bank, errors } = readBank(values.bank);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const templates = readTemplates();
const history = emptyHistory();
const lastUsed = new Map<string, string>();
let ok = 0;
let nodesSum = 0;
let minGap = Number.POSITIVE_INFINITY;
const mixSum = { 1: 0, 2: 0, 3: 0 };
let slotSum = 0;
let hardSum = 0;
let lv3Short = 0;
const useCount = new Map<string, number>();
const tplCount = new Map<string, number>();
const t0 = Date.now();
for (let i = 0; i < days; i++) {
  const date = addDays(values.date, i);
  try {
    const p = generatePuzzle(date, bank, templates, history, {
      cooldownDays: values.cooldown ? Number(values.cooldown) : undefined,
      profile,
    });
    ok++;
    nodesSum += p.nodes;
    tplCount.set(p.template, (tplCount.get(p.template) ?? 0) + 1);
    for (const lv of [1, 2, 3] as const) mixSum[lv] += p.mix[lv];
    slotSum += p.spec.slots.length;
    hardSum += p.hard.length;
    if (p.mix[3] < profile.minLv3) lv3Short++;
    for (const kana of Object.values(p.answers)) {
      const prev = lastUsed.get(kana);
      if (prev) minGap = Math.min(minGap, diffDays(prev, date));
      lastUsed.set(kana, date);
      useCount.set(kana, (useCount.get(kana) ?? 0) + 1);
    }
    addToHistory(history, { date, answers: p.answers, clueIndex: p.clueIndex });
  } catch (e) {
    console.log(`${date}: 失敗 — ${(e as Error).message.split("\n")[0]}`);
  }
}
const ms = Date.now() - t0;
const top = [...useCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
const pct = (n: number) => (slotSum ? `${Math.round((n / slotSum) * 100)}%` : "-");
console.log(`成功 ${ok}/${days}、平均ノード ${ok ? Math.round(nodesSum / ok) : "-"}、所要 ${(ms / 1000).toFixed(1)}s`);
console.log(`カギ配分 ①${pct(mixSum[1])} ②${pct(mixSum[2])} ③${pct(mixSum[3])}、難語 平均 ${ok ? (hardSum / ok).toFixed(1) : "-"} 語、lv3 不足の日 ${lv3Short}`);
console.log(`使った語 ${useCount.size}/${bank.words.length}、最短再利用間隔 ${Number.isFinite(minGap) ? `${minGap} 日` : "再利用なし"}`);
console.log(`テンプレート: ${[...tplCount.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`頻出: ${top.map(([k, v]) => `${k}×${v}`).join(" ")}`);
