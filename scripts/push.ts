// 生成した問題（../xword-private/out/*.json）を Supabase の puzzles テーブルへ upsert する。
//   npm run push                      # 未来日の全ファイル
//   npm run push -- --date 2026-11-10 # 1 日分
//   npm run push -- --dry             # 実行せず一覧だけ
//   npm run push -- --force           # JST 今日以前も対象（solves がある日は拒否）
// .env の SUPABASE_SERVICE_ROLE_KEY を使う（RLS をバイパスする鍵。公開しない）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { jstDateKey } from "../src/lib/date";
import { DEFAULT_OUT_DIR } from "./gen/bankio";
import type { GeneratedPuzzle } from "./gen/generate";

const { values } = parseArgs({
  options: {
    date: { type: "string" },
    out: { type: "string", default: DEFAULT_OUT_DIR },
    dry: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を .env に設定してください");
const sb = createClient(url, key, { auth: { persistSession: false } });

const today = jstDateKey(Date.now());
const files = readdirSync(values.out)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .filter((f) => !values.date || f === `${values.date}.json`)
  .sort();
if (files.length === 0) throw new Error("対象ファイルがありません");

let pushed = 0;
for (const f of files) {
  const p = JSON.parse(readFileSync(join(values.out, f), "utf8")) as GeneratedPuzzle;
  if (p.date <= today && !values.force) {
    console.log(`${p.date}: 公開済み日付のためスキップ（--force で対象）`);
    continue;
  }
  const { data: existing, error: e1 } = await sb
    .from("puzzles")
    .select("puzzle_date, solution, version")
    .eq("puzzle_date", p.date)
    .maybeSingle();
  if (e1) throw new Error(`${p.date}: 取得失敗 ${e1.message}`);
  let version = 1;
  if (existing) {
    if (existing.solution === p.solution) {
      // 解答が同じなら spec（カギ修正）だけ更新できる
      version = existing.version;
    } else {
      const { count, error: e2 } = await sb
        .from("solves")
        .select("*", { count: "exact", head: true })
        .eq("puzzle_date", p.date);
      if (e2) throw new Error(`${p.date}: solves 取得失敗 ${e2.message}`);
      if ((count ?? 0) > 0) {
        console.log(`${p.date}: 既に ${count} 件の記録があるため解答の差し替えは拒否`);
        continue;
      }
      version = existing.version + 1;
    }
  }
  const words = Object.values(p.answers).join(" ");
  if (values.dry) {
    console.log(`${p.date}: ${existing ? `更新 (v${version})` : "新規"}  ${words}`);
    continue;
  }
  const { error } = await sb.from("puzzles").upsert(
    { puzzle_date: p.date, spec: p.spec, solution: p.solution, answers: p.answers, version },
    { onConflict: "puzzle_date" },
  );
  if (error) throw new Error(`${p.date}: upsert 失敗 ${error.message}`);
  pushed++;
  console.log(`${p.date}: ${existing ? `更新 (v${version})` : "登録"}  ${p.template}`);
}

const { data: stat } = await sb.from("puzzles").select("puzzle_date").order("puzzle_date", { ascending: false }).limit(1);
const { count } = await sb.from("puzzles").select("*", { count: "exact", head: true });
console.log(`完了: ${pushed} 件${values.dry ? "（dry）" : ""}。DB の問題数 ${count ?? "?"}、最終日 ${stat?.[0]?.puzzle_date ?? "-"}（今日 ${today}）`);
