// 連続生成の負荷試験: 成功率・探索ノード数・語の再利用間隔・使用語数を計測する（ファイルは書かない）。
//   npm run stress -- --days 60 [--date 2027-01-01] [--cooldown 10]
import { parseArgs } from "node:util";
import { addDays, diffDays } from "../src/lib/date";
import { DEFAULT_BANK_DIR, readBank, readTemplates } from "./gen/bankio";
import { generatePuzzle } from "./gen/generate";
import { addToHistory, emptyHistory } from "./gen/history";

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "60" },
    date: { type: "string", default: "2027-01-01" },
    cooldown: { type: "string" },
    bank: { type: "string", default: DEFAULT_BANK_DIR },
  },
});
const days = Number(values.days);
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
const useCount = new Map<string, number>();
const tplCount = new Map<string, number>();
const t0 = Date.now();
for (let i = 0; i < days; i++) {
  const date = addDays(values.date, i);
  try {
    const p = generatePuzzle(date, bank, templates, history, {
      cooldownDays: values.cooldown ? Number(values.cooldown) : undefined,
    });
    ok++;
    nodesSum += p.nodes;
    tplCount.set(p.template, (tplCount.get(p.template) ?? 0) + 1);
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
console.log(`成功 ${ok}/${days}、平均ノード ${ok ? Math.round(nodesSum / ok) : "-"}、所要 ${(ms / 1000).toFixed(1)}s`);
console.log(`使った語 ${useCount.size}/${bank.words.length}、最短再利用間隔 ${Number.isFinite(minGap) ? `${minGap} 日` : "再利用なし"}`);
console.log(`テンプレート: ${[...tplCount.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`頻出: ${top.map(([k, v]) => `${k}×${v}`).join(" ")}`);
