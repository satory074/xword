// 語彙バンクの surface を ja.wikipedia で引き、要約と直近 12 か月の閲覧数を ../xword-private/wiki/<file>.json にキャッシュする。
//   npm run wiki -- --file animals [--force]     # 1 ファイル分（未取得分だけ取る。--force で全部取り直す）
//   npm run wiki -- --all
// 用途: カギ執筆時の事実の裏取り、異称・由来など「斜めからの事実」の採掘、difficulty 採点の見直し候補の抽出（閲覧数）。
// 本文をカギにそのまま使わない（CC BY-SA の帰属と、辞書コピーのアンチパターン）。曖昧さ回避ページは手で見る。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bankFiles, DEFAULT_BANK_DIR, DEFAULT_WIKI_DIR, readBankFile } from "./gen/bankio";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    all: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    bank: { type: "string", default: DEFAULT_BANK_DIR },
    out: { type: "string", default: DEFAULT_WIKI_DIR },
  },
});

interface WikiInfo {
  status: "ok" | "disambiguation" | "notfound" | "error";
  title?: string;
  description?: string;
  extract?: string;
  /** 直近 12 か月の閲覧数合計（user）。取れなければ null */
  views12m?: number | null;
  fetchedAt: string;
}
type Cache = Record<string, WikiInfo>;

const UA = "xword-wiki/1.0 (https://github.com/satory074/xword; vocabulary research)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const body = res.status === 200 ? ((await res.json()) as unknown) : null;
  return { status: res.status, body };
}

function monthRange(): { from: string; to: string } {
  // 直近 12 か月の月初（当月は未完なので除く）
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 12, 1));
  const f = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}0100`;
  return { from: f(start), to: f(new Date(end.getTime() - 86_400_000)) };
}

async function lookup(surface: string): Promise<WikiInfo> {
  const fetchedAt = new Date().toISOString();
  try {
    const sum = await getJson(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(surface)}`);
    if (sum.status === 404) return { status: "notfound", fetchedAt };
    if (sum.status !== 200 || !sum.body) return { status: "error", fetchedAt };
    const b = sum.body as { title?: string; type?: string; description?: string; extract?: string };
    if (b.type === "disambiguation") return { status: "disambiguation", title: b.title, extract: b.extract?.slice(0, 300), fetchedAt };
    let views12m: number | null = null;
    if (b.title) {
      const { from, to } = monthRange();
      const title = encodeURIComponent(b.title.replace(/ /g, "_"));
      await sleep(80);
      const pv = await getJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/ja.wikipedia/all-access/user/${title}/monthly/${from}/${to}`);
      if (pv.status === 200 && pv.body) {
        const items = (pv.body as { items?: { views: number }[] }).items ?? [];
        views12m = items.reduce((a, x) => a + (x.views ?? 0), 0);
      }
    }
    return { status: "ok", title: b.title, description: b.description, extract: b.extract?.slice(0, 600), views12m, fetchedAt };
  } catch {
    return { status: "error", fetchedAt };
  }
}

async function processFile(file: string): Promise<void> {
  const entries = readBankFile(join(values.bank, file), file.replace(/\.json$/, ""));
  const cachePath = join(values.out, file);
  const cache: Cache = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as Cache) : {};
  const surfaces = [...new Set(entries.map((e) => e.surface))];
  const todo = surfaces.filter((s) => values.force || !cache[s] || cache[s]!.status === "error");
  console.log(`${file}: ${surfaces.length} 表記、取得 ${todo.length} 件`);
  let n = 0;
  for (const s of todo) {
    cache[s] = await lookup(s);
    n++;
    if (n % 25 === 0 || n === todo.length) {
      writeFileSync(cachePath, JSON.stringify(cache, null, 1) + "\n");
      process.stdout.write(`  ${n}/${todo.length}\n`);
    }
    await sleep(120);
  }
  writeFileSync(cachePath, JSON.stringify(cache, null, 1) + "\n");
  const by = (st: WikiInfo["status"]) => surfaces.filter((s) => cache[s]?.status === st);
  const ok = by("ok");
  const views = ok.map((s) => [s, cache[s]!.views12m ?? -1] as const).filter(([, v]) => v >= 0).sort((a, b) => a[1] - b[1]);
  console.log(`  ok ${ok.length} / 曖昧さ回避 ${by("disambiguation").length} / なし ${by("notfound").length} / エラー ${by("error").length}`);
  if (by("disambiguation").length) console.log(`  曖昧さ回避: ${by("disambiguation").join(" ")}`);
  if (by("notfound").length) console.log(`  なし: ${by("notfound").join(" ")}`);
  if (views.length) {
    const fmt = (x: readonly [string, number]) => `${x[0]}(${Math.round(x[1] / 1000)}k)`;
    console.log(`  閲覧数 低: ${views.slice(0, 8).map(fmt).join(" ")}`);
    console.log(`  閲覧数 高: ${views.slice(-8).reverse().map(fmt).join(" ")}`);
  }
}

mkdirSync(values.out, { recursive: true });
const files = values.all ? bankFiles(values.bank) : values.file ? [values.file.endsWith(".json") ? values.file : `${values.file}.json`] : [];
if (files.length === 0) throw new Error("--file <name> か --all を指定してください");
for (const f of files) await processFile(f);
