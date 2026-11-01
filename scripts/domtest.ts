// DOM レベルのテスト: フェイク Api / Auth / KV を注入して boot → 入力 → 答え合わせ → 同期を jsdom で検証。
// 実行: npx tsx scripts/domtest.ts（Supabase には一切接続しない）
// 不変条件: ①未ログインで解いた結果が端末に残る ②ログイン後の起動で未同期分だけが 1 回同期される
//           ③同期済みなら再送しない ④誤りマスは答え合わせで赤くなり、入力すると消える
import { JSDOM } from "jsdom";
import { loadBank, type WordEntry } from "../src/lib/bank";
import { deriveSlots, scoreCells } from "../src/lib/grid";
import { createRng } from "../src/lib/rng";
import { memoryKV, readResults } from "../src/lib/storage";
import type { Api, AppDeps, AuthCtl, KV, SessionInfo, SolveRow, SyncItem } from "../src/lib/types";
import { readTemplates } from "./gen/bankio";
import { generatePuzzle } from "./gen/generate";
import { emptyHistory } from "./gen/history";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}
const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

// ---- 問題フィクスチャ（合成バンク）----
function syntheticBank() {
  const ALPHA = "アイウエオカキクケコサシスセソタチツテトナニヌネノ";
  const rng = createRng(42);
  const entries: WordEntry[] = [];
  const seen = new Set<string>();
  const want: Record<number, number> = { 2: 150, 3: 400, 4: 320, 5: 200 };
  for (const [lenS, n] of Object.entries(want)) {
    const len = Number(lenS);
    let count = 0;
    while (count < n) {
      let k = "";
      for (let i = 0; i < len; i++) k += ALPHA[rng.int(0, ALPHA.length - 1)];
      if (seen.has(k) || k[0] === "ン") continue;
      seen.add(k);
      count++;
      entries.push({ kana: k, surface: k, category: "fixture", difficulty: 1, clues: [`fixture ${entries.length}`] });
    }
  }
  return loadBank(entries).bank;
}
const bank = syntheticBank();
const DATE = "2027-05-01";
const gen = generatePuzzle(DATE, bank, readTemplates(), emptyHistory());
const NOW = Date.UTC(2027, 4, 1, 3, 0); // JST 2027-05-01 12:00
const slots = deriveSlots(gen.spec.grid);

// ---- フェイク ----
interface World {
  api: Api;
  calls: { check: number; reveal: number; sync: SyncItem[][]; fetch: number };
  rows: SolveRow[];
}
function makeWorld(): World {
  const calls = { check: 0, reveal: 0, sync: [] as SyncItem[][], fetch: 0 };
  const rows: SolveRow[] = [];
  const api: Api = {
    async getPuzzle(date) {
      return { date: date ?? DATE, puzzle: (date ?? DATE) === DATE ? gen.spec : null };
    },
    async listDates() {
      return { dates: [DATE], latest: DATE, today: DATE };
    },
    async checkGrid(date, cells) {
      calls.check++;
      assert(date === DATE, "checkGrid の日付");
      const sc = scoreCells(gen.solution, cells);
      return { ...sc, checks: null };
    },
    async revealSlot(_date, slotId) {
      calls.reveal++;
      return gen.answers[slotId]!;
    },
    async syncResults(items) {
      calls.sync.push(items);
      for (const it of items) {
        const sc = scoreCells(gen.solution, it.cells);
        rows.push({
          puzzleDate: it.date,
          cells: it.cells,
          correctCells: sc.correct,
          totalCells: sc.total,
          solved: sc.solved,
          checks: it.checks,
          reveals: it.reveals,
          durationSec: it.durationSec,
          solvedAt: it.solvedAt,
        });
      }
      return rows;
    },
    async fetchMySolves() {
      calls.fetch++;
      return rows;
    },
  };
  return { api, calls, rows };
}
function makeAuth(session: SessionInfo | null): AuthCtl {
  return {
    async getSession() {
      return session;
    },
    async signIn() {},
    async signOut() {},
    onChange() {
      return () => undefined;
    },
  };
}

// ---- jsdom ----
function setupDom(): { root: HTMLElement; header: HTMLElement; hidden: () => HTMLInputElement } {
  const dom = new JSDOM(`<!doctype html><html><body><header id="site-header"></header><main id="app"></main></body></html>`, {
    url: "http://localhost/xword/",
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement;
  g.HTMLInputElement = dom.window.HTMLInputElement;
  g.Event = dom.window.Event;
  g.CustomEvent = dom.window.CustomEvent;
  // Node 22 では navigator がゲッターなので defineProperty で差し替える
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  g.history = dom.window.history;
  Object.defineProperty(globalThis, "location", { value: dom.window.location, configurable: true });
  const root = dom.window.document.getElementById("app")!;
  const header = dom.window.document.getElementById("site-header")!;
  return { root, header, hidden: () => root.querySelector<HTMLInputElement>('[data-role="hidden"]')! };
}

async function bootPuzzle(deps: AppDeps) {
  const { boot } = await import("../src/app/puzzle");
  const dom = setupDom();
  await boot(dom.root, dom.header, deps);
  await tick();
  return dom;
}

function typeIntoSlot(dom: ReturnType<typeof setupDom>, slotId: string, text: string): void {
  // カギをクリック → 方向とスロットが選ばれる（カーソルは最初の空マス）。先頭マスから打ちたいので
  // 先頭がカーソルでなければ先頭マスをクリックして合わせる（同じマスの再クリックは方向切替なので避ける）
  dom.root.querySelector<HTMLElement>(`[data-slot="${slotId}"]`)!.click();
  const firstCell = slots.find((s) => s.id === slotId)!.cells[0]!;
  const el = dom.root.querySelector<HTMLElement>(`[data-cell="${firstCell}"]`)!;
  if (!el.classList.contains("is-cursor")) el.click();
  const input = dom.hidden();
  input.value = text;
  input.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
}

// ---- ① 未ログインで解く → 端末に結果が残る ----
{
  const kv: KV = memoryKV();
  const world = makeWorld();
  const deps: AppDeps = { api: world.api, auth: makeAuth(null), storage: kv, now: () => NOW };
  const dom = await bootPuzzle(deps);
  assert(dom.root.querySelectorAll("[data-cell]").length === 49 - gen.spec.grid.join("").split("#").length + 1, "白マスの数だけセルが描画される");
  assert(dom.root.querySelectorAll("[data-slot]").length === slots.length, "全スロットのカギが並ぶ");

  // ④ わざと 1 マス間違えて答え合わせ → 赤表示 → 入力し直すと消える
  const first = slots[0]!;
  const wrong = Array.from(gen.answers[first.id]!);
  wrong[0] = wrong[0] === "ア" ? "イ" : "ア";
  typeIntoSlot(dom, first.id, wrong.join(""));
  dom.root.querySelector<HTMLElement>('[data-action="check"]')!.click();
  await tick();
  assert(world.calls.check === 1, "答え合わせが 1 回呼ばれる");
  assert(dom.root.querySelectorAll(".xw-cell.is-wrong").length === 1, "誤りマスが 1 つ赤くなる");
  typeIntoSlot(dom, first.id, gen.answers[first.id]!);
  assert(dom.root.querySelectorAll(".xw-cell.is-wrong").length === 0, "入力し直すと赤表示が消える");

  for (const s of slots) typeIntoSlot(dom, s.id, gen.answers[s.id]!);
  dom.root.querySelector<HTMLElement>('[data-action="check"]')!.click();
  await tick();
  assert(world.calls.check === 2, "2 回目の答え合わせ");
  assert(dom.root.querySelector(".solved-panel") !== null, "完成パネルが出る");
  const results = readResults(kv);
  assert(results[DATE]?.solved === true && results[DATE].checks === 2, "端末の結果が solved / checks=2 で残る");
  assert(results[DATE]!.syncedTo.length === 0, "未ログインなので未同期");
  assert(kv.get(`xword:progress:v1:${DATE}`) === null, "完答したら途中保存は消える");
  console.log("[play] OK");

  // ---- ② ログインして起動 → 未同期分だけ 1 回同期、サーバー行で置換 ----
  const session: SessionInfo = { userId: "u1", displayName: "テスト", avatarUrl: null };
  const deps2: AppDeps = { api: world.api, auth: makeAuth(session), storage: kv, now: () => NOW };
  const dom2 = await bootPuzzle(deps2);
  assert(world.calls.sync.length === 1 && world.calls.sync[0]!.length === 1, "同期が 1 回・1 件");
  assert(world.calls.sync[0]![0]!.date === DATE && world.calls.sync[0]![0]!.cells === gen.solution, "同期内容は完成盤面");
  const after = readResults(kv);
  assert(after[DATE]!.syncedTo.includes("u1"), "同期済みマークが付く");
  assert(dom2.root.querySelector(".solved-panel") !== null, "ログイン後も完成状態で表示");

  // ---- ③ 再起動 → 再送しない ----
  await bootPuzzle(deps2);
  assert(world.calls.sync.length === 1, "同期済みは再送しない");
  assert(world.calls.fetch === 1, "代わりに自分の記録を取得する");
  console.log("[sync] OK");
}

console.log("✅ domtest passed");
process.exit(0);
