// DOM レベルのテスト: フェイク Api / Auth / KV を注入して boot → 入力 → 答え合わせ → 同期を jsdom で検証。
// 実行: npx tsx scripts/domtest.ts（Supabase には一切接続しない）
// 不変条件: ①未ログインで解いた結果が端末に残る ②ログイン後の起動で未同期分だけが 1 回同期される
//           ③同期済みなら再送しない ④誤りマスは答え合わせで赤くなり、入力すると消える
//           ⑤IME で語をまとめて確定すると全文字が盤面に入り、変換中は何も書かれず、確定の Enter で答え合わせも縦横切替もされない
//           ⑥矢印は黒マスを飛ばして盤面を動き、語の外では未選択。Enter 1 回目でそのマスの語を選び、2 回目以降で縦横を切り替える
import { JSDOM } from "jsdom";
import { loadBank, type WordEntry } from "../src/lib/bank";
import { cellIndex, deriveSlots, scoreCells } from "../src/lib/grid";
import { toHiragana } from "../src/lib/kana";
import { createRng } from "../src/lib/rng";
import { memoryKV, progressKey, readResults } from "../src/lib/storage";
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
    async revealCell(_date, cell) {
      calls.reveal++;
      return gen.solution[cell]!;
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

// ---- ⓪ ヒントはカーソルのマス 1 文字だけ開く（語を丸ごと見せない）----
{
  const world = makeWorld();
  const deps: AppDeps = { api: world.api, auth: makeAuth(null), storage: memoryKV(), now: () => NOW };
  const dom = await bootPuzzle(deps);
  const cursor = slots[0]!.cells[0]!; // 初期カーソル
  dom.root.querySelector<HTMLElement>('[data-action="reveal"]')!.click();
  await tick();
  const revealed = dom.root.querySelectorAll<HTMLElement>(".xw-cell.is-revealed");
  assert(world.calls.reveal === 1 && revealed.length === 1, `ヒント 1 回で開くマスは 1 つ（${revealed.length}）`);
  assert(revealed[0]!.dataset.cell === String(cursor) && revealed[0]!.textContent!.includes(gen.solution[cursor]!), "開いたのはカーソルのマスで、文字は正解");
  dom.root.querySelector<HTMLElement>('[data-action="reveal"]')!.click();
  await tick();
  assert(world.calls.reveal === 1, "同じマスを二度は開かない（サーバーを呼ばない）");
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

// ---- ⑤ IME: 変換中は何も書かれず、確定で全文字が入る。確定の Enter は答え合わせにならない ----
{
  const kv: KV = memoryKV();
  const world = makeWorld();
  const deps: AppDeps = { api: world.api, auth: makeAuth(null), storage: kv, now: () => NOW };
  const dom = await bootPuzzle(deps);
  const win = dom.root.ownerDocument.defaultView!;
  const slot = slots[0]!;
  const answer = gen.answers[slot.id]!;
  const hira = toHiragana(answer); // IME はひらがなで確定しても normalizeKana でカタカナになる
  dom.root.querySelector<HTMLElement>(`[data-slot="${slot.id}"]`)!.click();
  const input = dom.hidden();
  assert(input.getAttribute("inputmode") === "text", "既定は端末のキーボード（inputmode=text）");

  // Chrome の順: compositionstart → input(isComposing) × N → compositionend
  input.dispatchEvent(new win.CompositionEvent("compositionstart", { data: "" }));
  for (let i = 1; i <= hira.length; i++) {
    const part = hira.slice(0, i);
    input.value = part;
    input.dispatchEvent(new win.CompositionEvent("compositionupdate", { data: part }));
    input.dispatchEvent(new win.InputEvent("input", { isComposing: true, inputType: "insertCompositionText", data: part }));
  }
  assert(input.value === hira, "変換中は隠し input の値を消さない");
  assert(kv.get(progressKey(DATE)) === null, "変換中は盤面に書かない（途中保存が無い）");
  assert(dom.root.querySelectorAll(".xw-cell.is-preview").length === answer.length, "変換中の文字がマスに仮表示される");
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
  await tick();
  assert(world.calls.check === 0, "確定の Enter（変換中）は答え合わせにならない");
  input.dispatchEvent(new win.CompositionEvent("compositionend", { data: hira }));
  input.dispatchEvent(new win.InputEvent("input", { isComposing: false, inputType: "insertText" })); // Firefox/Safari は後から input が来る
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", isComposing: false })); // Safari は確定の Enter が後から来る
  await tick();
  assert(world.calls.check === 0, "確定後の Enter 単独でも答え合わせにならない");
  const wordNow = [...dom.root.querySelectorAll<HTMLElement>(".xw-cell.is-word")].map((e) => Number(e.dataset.cell));
  assert(wordNow.length === slot.cells.length && slot.cells.every((c) => wordNow.includes(c)), "IME 確定直後の Enter（Safari の順）では縦横が切り替わらない");
  const got = slot.cells.map((c) => dom.root.querySelector(`[data-cell="${c}"] .xw-ch`)!.textContent).join("");
  assert(got === answer, `確定した全文字が語に入る（${got} / ${answer}）`);
  assert(dom.root.querySelectorAll(".xw-cell.is-preview").length === 0, "確定後に仮表示は残らない");
  const filled = dom.root.querySelectorAll<HTMLElement>("[data-cell]");
  const outside = [...filled].filter((el) => !slot.cells.includes(Number(el.dataset.cell)) && el.querySelector(".xw-ch")!.textContent !== "");
  assert(outside.length === 0, "語の外のマスには何も入らない");
  assert(input.value === "", "確定後の隠し input は空");

  // IME オフのローマ字: 1 字ずつ input が来る。n は語末で確定
  dom.root.querySelector<HTMLElement>('[data-action="clear"]')!.click();
  dom.root.querySelector<HTMLElement>(`[data-slot="${slot.id}"]`)!.click();
  for (const ch of "pan") {
    input.value = ch;
    input.dispatchEvent(new win.InputEvent("input", { isComposing: false, inputType: "insertText", data: ch }));
  }
  const c0 = slot.cells[0]!;
  const c1 = slot.cells[1]!;
  assert(dom.root.querySelector(`[data-cell="${c0}"] .xw-ch`)!.textContent === "パ", "pa → パ");
  assert(dom.root.querySelector(`[data-cell="${c1}"]`)!.classList.contains("is-preview"), "未確定の n はカーソルのマスに仮表示");
  input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight" }));
  assert(dom.root.querySelector(`[data-cell="${c1}"] .xw-ch`)!.textContent === "ン", "カーソル移動で n → ン が確定");

  // ゛は直前に打った文字に付く（カーソルは進んでいる）
  dom.root.querySelector<HTMLElement>('[data-action="clear"]')!.click();
  typeIntoSlot(dom, slot.id, "カ");
  dom.root.querySelector<HTMLElement>('[data-key="dakuten"]')!.click();
  assert(dom.root.querySelector(`[data-cell="${c0}"] .xw-ch`)!.textContent === "ガ", "カ → ゛ → ガ");

  // 切替: 50 音パネルにすると OS キーボードを出さない（inputmode=none）。端末ごとに保存
  dom.root.querySelector<HTMLElement>('[data-action="kb-mode"]')!.click();
  assert(dom.root.querySelector(".kb.kb-screen") !== null && input.getAttribute("inputmode") === "none", "50 音パネルに切り替わる");
  assert(kv.get("xword:kb") === "screen", "切替は端末に保存される");
  console.log("[ime] OK");
}

// ---- ⑥ 矢印で盤面を動く → 語の外では未選択 → Enter 1 回目で選ぶ → 2 回目以降で縦横切替。黒マスは飛ばす ----
{
  const world = makeWorld();
  const deps: AppDeps = { api: world.api, auth: makeAuth(null), storage: memoryKV(), now: () => NOW };
  const dom = await bootPuzzle(deps);
  const win = dom.root.ownerDocument.defaultView!;
  const input = dom.hidden();
  const key = (k: string) => input.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }));
  const cursor = () => Number(dom.root.querySelector<HTMLElement>(".xw-cell.is-cursor")!.dataset.cell);
  const word = () => [...dom.root.querySelectorAll<HTMLElement>(".xw-cell.is-word")].map((e) => Number(e.dataset.cell));
  const isWord = (cells: number[]) => word().length === cells.length && cells.every((c) => word().includes(c));

  // ヨコの語の先頭で、タテの語も通るマス X
  const across = slots.find((a) => a.dir === "A" && slots.some((d) => d.dir === "D" && d.cells.includes(a.cells[0]!)))!;
  const X = across.cells[0]!;
  const down = slots.find((d) => d.dir === "D" && d.cells.includes(X))!;
  const away = down.cells.indexOf(X) < down.cells.length - 1 ? "ArrowDown" : "ArrowUp"; // タテの語の隣の白マスへ
  const back = away === "ArrowDown" ? "ArrowUp" : "ArrowDown";

  dom.root.querySelector<HTMLElement>(`[data-slot="${across.id}"]`)!.click();
  assert(cursor() === X && isWord(across.cells), "カギを選ぶとヨコの語が選ばれる");
  key("ArrowRight");
  assert(cursor() === across.cells[1] && isWord(across.cells), "語の中の移動は選択のまま");
  key("ArrowLeft");
  key(away);
  assert(cursor() !== X && word().length === 0 && dom.root.querySelector(".xw-cell.is-pointing") !== null, "語の外へ出ると未選択（語の色なし）");
  key(back);
  assert(cursor() === X && word().length === 0, "戻っても Enter までは未選択");
  key("Enter");
  assert(isWord(across.cells) && dom.root.querySelector(".xw-cell.is-pointing") === null, "Enter 1 回目でそのマスの語を選ぶ");
  key("Enter");
  assert(cursor() === X && isWord(down.cells), "Enter 2 回目で縦横を切り替える");
  key("Enter");
  assert(isWord(across.cells), "Enter 3 回目でまた切り替える");
  assert(world.calls.check === 0, "Enter 単独では答え合わせしない");

  // 黒マスを飛ばす: 白・黒・白 と縦に並ぶ列で、上の白から ↓ で下の白へ
  const g = gen.spec.grid;
  let from = -1;
  let to = -1;
  for (let r = 0; r + 2 < 7 && from < 0; r++)
    for (let c = 0; c < 7 && from < 0; c++)
      if (g[r]![c] !== "#" && g[r + 1]![c] === "#" && g[r + 2]![c] !== "#") {
        from = cellIndex(r, c);
        to = cellIndex(r + 2, c);
      }
  assert(from >= 0, "フィクスチャに 白・黒・白 の縦並びがある");
  dom.root.querySelector<HTMLElement>(`[data-cell="${from}"]`)!.click();
  key("ArrowDown");
  assert(cursor() === to, "矢印は黒マスを飛ばして次の白マスへ");
  console.log("[arrows] OK");
}

console.log("✅ domtest passed");
process.exit(0);
