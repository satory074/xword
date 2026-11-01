// 語彙バンクとテンプレートのファイル読み込み（Node 専用）。
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadBank, type Bank, type WordEntry } from "../../src/lib/bank";
import { validateTemplate, type Template } from "../../src/lib/grid";

export const PRIVATE_DIR = resolve(process.cwd(), "../xword-private");
export const DEFAULT_BANK_DIR = join(PRIVATE_DIR, "words");
export const DEFAULT_OUT_DIR = join(PRIVATE_DIR, "out");
export const TEMPLATES_PATH = resolve(process.cwd(), "data/templates/7x7.json");

export function readBankEntries(dir: string): WordEntry[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const entries: WordEntry[] = [];
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error(`${f}: 配列ではない`);
    for (const e of raw as Partial<WordEntry>[]) {
      entries.push({
        kana: String(e.kana ?? ""),
        surface: String(e.surface ?? ""),
        category: String(e.category ?? f.replace(/\.json$/, "")),
        difficulty: Number(e.difficulty ?? 1),
        clues: Array.isArray(e.clues) ? e.clues.map(String) : [],
      });
    }
  }
  return entries;
}

export function readBank(dir: string): { bank: Bank; errors: string[]; entryCount: number } {
  const entries = readBankEntries(dir);
  const { bank, errors } = loadBank(entries);
  return { bank, errors, entryCount: entries.length };
}

/**
 * テンプレート読込。各テンプレートを検証する。
 * 転置・反転の変種は、実語彙で埋まることを確認したものだけを 7x7.json に明示的に並べてある
 * （反転すると「語頭マス」の位置が変わり、埋まらなくなる変種があるため自動生成しない）。
 */
export function readTemplates(path = TEMPLATES_PATH): Template[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { id: string; rows: string[] }[];
  const out: Template[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const errs = validateTemplate(t.rows);
    if (errs.length) throw new Error(`テンプレート ${t.id} が不正:\n  ${errs.join("\n  ")}`);
    const key = t.rows.join("/");
    if (seen.has(key)) throw new Error(`テンプレート ${t.id} が重複`);
    seen.add(key);
    out.push({ id: t.id, rows: t.rows });
  }
  return out;
}
