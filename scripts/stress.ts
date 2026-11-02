// 連続生成の負荷試験: 成功率・探索ノード数・語の再利用間隔・使用語数・カギのレベル配分・新出 / 復習の実績を計測する（ファイルは書かない）。
//   npm run stress -- --days 60 [--date 2027-01-01] [--cooldown 10] [--mix 24/48/28] [--new 2] [--review 2]
import { parseArgs } from "node:util";
import { addDays, diffDays } from "../src/lib/date";
import { DEFAULT_BANK_DIR, readBank, readTemplates } from "./gen/bankio";
import { generatePuzzle } from "./gen/generate";
import { addToHistory, emptyHistory, HARD_SCHEDULE, schedule } from "./gen/history";
import { parseProfileArgs } from "./gen/level";

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "60" },
    date: { type: "string", default: "2027-01-01" },
    cooldown: { type: "string" },
    bank: { type: "string", default: DEFAULT_BANK_DIR },
    mix: { type: "string" },
    new: { type: "string" },
    review: { type: "string" },
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
let newSum = 0;
let reviewSum = 0;
let windowReviewSum = 0;
let lv3Short = 0;
const useCount = new Map<string, number>();
/** 難語 → 使用日（昇順）。復習ウィンドウ命中率と在庫の計算用 */
const hardUses = new Map<string, string[]>();
const tplCount = new Map<string, number>();
const t0 = Date.now();
for (let i = 0; i < days; i++) {
  const date = addDays(values.date, i);
  try {
    const cooldownDays = values.cooldown ? Number(values.cooldown) : undefined;
    const sch = schedule(history, date, bank, cooldownDays);
    const p = generatePuzzle(date, bank, templates, history, { cooldownDays, profile });
    ok++;
    nodesSum += p.nodes;
    tplCount.set(p.template, (tplCount.get(p.template) ?? 0) + 1);
    for (const lv of [1, 2, 3] as const) mixSum[lv] += p.mix[lv];
    slotSum += p.spec.slots.length;
    hardSum += p.hard.length;
    newSum += p.learn.new.length;
    reviewSum += p.learn.review.length;
    windowReviewSum += p.learn.review.filter((sid) => sch.review.get(p.answers[sid]!) === "window").length;
    if (p.mix[3] < profile.minLv3) lv3Short++;
    for (const [sid, kana] of Object.entries(p.answers)) {
      const prev = lastUsed.get(kana);
      if (prev) minGap = Math.min(minGap, diffDays(prev, date));
      lastUsed.set(kana, date);
      useCount.set(kana, (useCount.get(kana) ?? 0) + 1);
      if (p.hard.includes(sid)) hardUses.set(kana, [...(hardUses.get(kana) ?? []), date]);
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
// 新出 / 復習: 初出から windowEnd 日以上経った難語のうち、2 回目が [blackout, windowEnd] に入った割合 = ウィンドウ命中率
const w1 = HARD_SCHEDULE[0]!;
const endDate = addDays(values.date, days - 1);
const matured = [...hardUses.entries()].filter(([, u]) => diffDays(u[0]!, endDate) >= w1.windowEnd);
const hit = matured.filter(([, u]) => u.length >= 2 && diffDays(u[0]!, u[1]!) >= w1.blackout && diffDays(u[0]!, u[1]!) <= w1.windowEnd).length;
const hardTotal = bank.words.filter((w) => w.difficulty >= 2).length;
const stock = bank.words.filter((w) => w.difficulty >= 2 && !useCount.has(w.kana)).length;
const perDay = ok ? newSum / ok : 0;
console.log(`新出 平均 ${ok ? perDay.toFixed(1) : "-"} 語、復習 平均 ${ok ? (reviewSum / ok).toFixed(1) : "-"} 語（うちウィンドウ内 ${ok ? (windowReviewSum / ok).toFixed(1) : "-"}）`);
console.log(`${w1.blackout}〜${w1.windowEnd} 日後の復習 命中率 ${matured.length ? `${Math.round((hit / matured.length) * 100)}%（${hit}/${matured.length} 語）` : "-（初出から日が浅い）"}、難語在庫 ${stock}/${hardTotal} 語${perDay ? ` ≈ ${Math.round(stock / perDay)} 日分` : ""}`);
console.log(`使った語 ${useCount.size}/${bank.words.length}、最短再利用間隔 ${Number.isFinite(minGap) ? `${minGap} 日` : "再利用なし"}`);
console.log(`テンプレート: ${[...tplCount.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`頻出: ${top.map(([k, v]) => `${k}×${v}`).join(" ")}`);
