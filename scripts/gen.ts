// 問題生成 CLI。
//   npm run gen -- --date 2026-11-10 --days 30 [--dry] [--force] [--mix 24/48/28] [--hard 3] [--bank DIR] [--out DIR]
// 出力: <out>/<date>.json（解答入り。公開リポに入れない）と <out>/preview.html
// --force で作り直すとき、開始日以降の旧ファイルは履歴に数えない（数えると直近の語がクールダウンで使えなくなる）
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addDays, isDateKey, jstDateKey } from "../src/lib/date";
import { DEFAULT_BANK_DIR, DEFAULT_OUT_DIR, readBank, readTemplates } from "./gen/bankio";
import { generatePuzzle, type GeneratedPuzzle } from "./gen/generate";
import { addToHistory, readHistoryDir } from "./gen/history";
import { parseProfileArgs } from "./gen/level";
import { renderPreview } from "./gen/preview";

const { values } = parseArgs({
  options: {
    date: { type: "string" },
    days: { type: "string", default: "1" },
    dry: { type: "boolean", default: false },
    bank: { type: "string", default: DEFAULT_BANK_DIR },
    out: { type: "string", default: DEFAULT_OUT_DIR },
    force: { type: "boolean", default: false },
    mix: { type: "string" },
    hard: { type: "string" },
  },
});

const start = values.date ?? addDays(jstDateKey(Date.now()), 1);
if (!isDateKey(start)) throw new Error(`--date が不正: ${start}`);
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1) throw new Error(`--days が不正: ${values.days}`);
const profile = parseProfileArgs(values);

const { bank, errors, entryCount } = readBank(values.bank);
if (errors.length) {
  console.error(`語彙バンクに ${errors.length} 件の問題:\n  ${errors.slice(0, 30).join("\n  ")}`);
  process.exit(1);
}
console.log(`語彙: ${entryCount} エントリ → ${bank.words.length} 語`);
const templates = readTemplates();
const history = readHistoryDir(values.out, { before: start });
if (!values.dry) mkdirSync(values.out, { recursive: true });

const generated: GeneratedPuzzle[] = [];
for (let i = 0; i < days; i++) {
  const date = addDays(start, i);
  const path = join(values.out, `${date}.json`);
  if (!values.dry && existsSync(path) && !values.force) {
    console.log(`${date}: 既に存在（--force で上書き）`);
    const prev = JSON.parse(readFileSync(path, "utf8")) as GeneratedPuzzle;
    addToHistory(history, prev);
    continue;
  }
  const p = generatePuzzle(date, bank, templates, history, { profile });
  addToHistory(history, { date, answers: p.answers, clueIndex: p.clueIndex });
  generated.push(p);
  const words = Object.values(p.answers).join(" ");
  const mix = `lv ${p.mix[1]}/${p.mix[2]}/${p.mix[3]} 難語 ${p.hard.length}`;
  console.log(`${date}: ${p.template} nodes=${p.nodes} ${mix}${p.warnings.length ? ` warn=${p.warnings.length}` : ""}  ${words}`);
  if (!values.dry) writeFileSync(path, JSON.stringify({ ...p, generatedAt: new Date().toISOString() }, null, 2) + "\n");
}

if (!values.dry) {
  const all = readdirSync(values.out)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse()
    .map((f) => JSON.parse(readFileSync(join(values.out, f), "utf8")) as GeneratedPuzzle);
  writeFileSync(join(values.out, "preview.html"), renderPreview(all));
  console.log(`preview: ${join(values.out, "preview.html")}（${all.length} 問）`);
}
