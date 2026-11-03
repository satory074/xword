// 純ロジックの不変条件テスト。実行: npx tsx scripts/smoketest.ts
// 件数ではなく「壊れたら困る不変条件」を 1 つずつ検証する:
//   1) 同梱テンプレートが合法  2) カナ正規化が不動点で SQL と変換表が一致  3) 語彙バンク（あれば）が健全
//   2b) ローマ字→カナが Google IME と同じ結果で、出力が盤面の文字集合に収まる
//   4) 埋めが正しく決定的  5) 採点が正しい  6) 記録の優劣順序  7) 連続日数
//   8) 生成結果に答えが漏れず、難しいカギ・新出語が公平な位置にあり、難語の間隔反復（blackout / ウィンドウ）が守られる
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { candidates, lintEntry, loadBank, type WordEntry } from "../src/lib/bank";
import { addDays, diffDays, fmtDateJa, isDateKey, jstDateKey } from "../src/lib/date";
import { deriveSlots, scoreCells, solutionFromAnswers, validateTemplate, cellSlotMap } from "../src/lib/grid";
import { DASH_FROM, DASH_TO, GRID_KANA, normalizeKana, SMALL_FROM, SMALL_TO, toHiragana } from "../src/lib/kana";
import { feedText, flushRomaji, romajiToKana } from "../src/lib/romaji";
import { createRng } from "../src/lib/rng";
import { computeStats } from "../src/lib/stats";
import { betterSolve } from "../src/lib/storage";
import { DEFAULT_BANK_DIR, readBank, readTemplates } from "./gen/bankio";
import { fill } from "./gen/fill";
import { generatePuzzle } from "./gen/generate";
import { addToHistory, emptyHistory, HARD_SCHEDULE, schedule } from "./gen/history";
import { DEFAULT_PROFILE } from "./gen/level";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}

// ---- 1) テンプレートが合法（読み込み時に validateTemplate が走り、違反なら例外） ----
const templates = readTemplates();
{
  assert(templates.length >= 2, "テンプレートが 2 つ以上ある");
  for (const t of templates) assert(validateTemplate(t.rows).length === 0, `${t.id} が合法`);
  // 不正例を検出できること（連続黒・分断・孤立）
  assert(validateTemplate(["##.....", ".......", ".......", ".......", ".......", ".......", ".....##"]).length > 0, "連続黒を検出");
  assert(validateTemplate([".#.....", "#......", ".......", ".......", ".......", "......#", ".....#."]).length > 0, "孤立マスを検出");
  console.log(`[templates] OK (${templates.map((t) => t.id).join(", ")})`);
}

// ---- 2) カナ正規化: 不動点・ひらがな→カタカナ・小書き→大書き・長音の揺れ、SQL と変換表が一致 ----
{
  const n = normalizeKana("きゃっとｰ−—－〜ｶﾞ");
  assert(n === "キヤツトーーーーーガ", `正規化結果: ${n}`);
  assert(normalizeKana(n) === n, "正規化は冪等");
  assert(toHiragana("コーヒー") === "こーひー", "カタカナ→ひらがな");
  assert(Array.from(SMALL_FROM).length === Array.from(SMALL_TO).length, "SMALL 表の長さ一致");
  assert(Array.from(DASH_FROM).length === Array.from(DASH_TO).length, "DASH 表の長さ一致");
  const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/002_rpc.sql"), "utf8");
  const tr = [...sql.matchAll(/translate\((?:p|v), '([^']*)', '([^']*)'\)/g)].map((m) => [m[1], m[2]]);
  assert(tr.length === 2, `SQL に translate が 2 つ（${tr.length}）`);
  assert(tr[0]![0] === SMALL_FROM && tr[0]![1] === SMALL_TO, "SQL の SMALL 表が kana.ts と一致");
  assert(tr[1]![0] === DASH_FROM && tr[1]![1] === DASH_TO, "SQL の DASH 表が kana.ts と一致");
  const cls = sql.match(/v_class constant text := '([^']*)'/);
  assert(cls !== null && cls[1] === GRID_KANA, "SQL の文字クラスが GRID_KANA と一致");
  assert(Array.from(GRID_KANA).length === 71 && new Set(GRID_KANA).size === 71, "GRID_KANA は 71 文字で重複なし");
  console.log("[kana] OK");
}

// ---- 2b) ローマ字→カナ: ヘボン/訓令の同義、n の規則、促音、カナ素通し。出力は盤面の文字だけ ----
{
  const cases: [string, string][] = [
    ["kyatto", "キヤツト"],
    ["kanna", "カンナ"],
    ["kannji", "カンジ"],
    ["konnichiha", "コンニチハ"],
    ["shinbun", "シンブン"],
    ["matchi", "マツチ"],
    ["pan", "パン"],
    ["kann", "カン"],
    ["kan'i", "カンイ"],
    ["カナ-", "カナー"],
    ["ｋａｎａ", "カナ"],
  ];
  for (const [src, want] of cases) assert(romajiToKana(src) === want, `romaji ${src} → ${romajiToKana(src)}（期待 ${want}）`);
  for (const [a, b] of [["si", "shi"], ["ti", "chi"], ["tu", "tsu"], ["hu", "fu"], ["zi", "ji"], ["zya", "ja"], ["sya", "sha"], ["tya", "cha"]])
    assert(romajiToKana(a!) === romajiToKana(b!), `訓令 ${a} と ヘボン ${b} が同じ`);
  const step = feedText("", "k");
  assert(step.out === "" && step.buf === "k", "子音だけなら未確定のまま持ち越す");
  assert(flushRomaji("n") === "ン" && flushRomaji("k") === "" && flushRomaji("N") === "", "確定は n だけがン");
  for (const [src] of cases) for (const ch of romajiToKana(src)) assert(GRID_KANA.includes(ch), `${src} の出力 ${ch} が盤面の文字`);
  console.log("[romaji] OK");
}

// ---- 3) 語彙バンク（../xword-private/words があれば）----
{
  if (existsSync(DEFAULT_BANK_DIR)) {
    const { bank, errors, entryCount } = readBank(DEFAULT_BANK_DIR);
    assert(errors.length === 0, `語彙バンク lint:\n  ${errors.slice(0, 20).join("\n  ")}`);
    assert(new Set(bank.words.map((w) => w.kana)).size === bank.words.length, "統合後の kana が一意");
    console.log(`[bank] OK (${entryCount} entries → ${bank.words.length} words)`);
  } else {
    console.log("[bank] skipped（../xword-private/words が無い）");
  }
  // レベル別配列（clues2 / clues3）も漏れ lint の対象で、2 文字語に clues3 は付けられない
  const base: WordEntry = { kana: "テスト", surface: "試験", category: "x", difficulty: 1, clues: ["ok"] };
  assert(lintEntry(base).length === 0, "正常エントリは lint を通る");
  assert(lintEntry({ ...base, clues3: ["テストを含む"] }).length > 0, "clues3 の答え漏れを検出");
  assert(lintEntry({ ...base, kana: "テス", clues3: ["x"] }).length > 0, "2 文字語の clues3 を拒否");
}

// ---- 合成バンク（埋めアルゴリズムの検査用。日本語の意味は持たない） ----
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
      const i = entries.length;
      // difficulty 1: 70% / 2: 20% / 3: 10%（d2 が無いと「新出は lv1」が clueCap[3]=1 と区別できない）
      const r = rng.int(1, 10);
      entries.push({
        kana: k,
        surface: k,
        category: "fixture",
        difficulty: r > 9 ? 3 : r > 7 ? 2 : 1,
        clues: [`fixture ${i}`],
        clues2: [`f2 ${i}`],
        ...(len >= 3 ? { clues3: [`f3 ${i}`] } : {}),
      });
    }
  }
  const { bank, errors } = loadBank(entries);
  assert(errors.length === 0, `合成バンクに lint エラー: ${errors[0]}`);
  return bank;
}
const synth = syntheticBank();

// ---- 4) 埋め: 全テンプレートで成功（実語彙があればそれで、無ければ合成語彙で過半数）、
//         全語がバンク、交差一致、重複なし、難語制約、決定的 ----
{
  const real = existsSync(DEFAULT_BANK_DIR) ? readBank(DEFAULT_BANK_DIR).bank : null;
  const bankForFill = real ?? synth;
  let okCount = 0;
  for (const t of templates) {
    const slots = deriveSlots(t.rows);
    // generatePuzzle と同じく 3 シードまで試す（語彙が増えると 1 シードでは探索が発散することがある）
    let opts = { seed: 7, exclude: new Set<string>(), recency: new Map<string, number>() };
    let a = fill(slots, bankForFill, opts);
    for (let k = 1; k < 3 && !a; k++) {
      opts = { ...opts, seed: (7 + k * 7919) >>> 0 };
      a = fill(slots, bankForFill, opts);
    }
    if (real) assert(a !== null, `${t.id} の埋めが実語彙で成功（3 シード以内）`);
    if (!a) continue;
    okCount++;
    const b = fill(slots, bankForFill, opts);
    assert(JSON.stringify(a.answers) === JSON.stringify(b!.answers), `${t.id} の埋めが決定的`);
    const kanas = Object.values(a.answers);
    assert(new Set(kanas).size === kanas.length, `${t.id} に同じ語がない`);
    for (const k of kanas) assert(bankForFill.byKana.has(k), `${t.id} の語 ${k} がバンクにある`);
    solutionFromAnswers(t.rows, slots, a.answers); // 交差が矛盾すれば例外
    const diff3 = slots.filter((s) => bankForFill.words[bankForFill.byKana.get(a.answers[s.id]!)!]!.difficulty === 3);
    assert(diff3.length <= 2, `${t.id} の難語 ≤ 2`);
    for (const x of diff3) for (const y of diff3) if (x.id < y.id) assert(!x.cells.some((c) => y.cells.includes(c)), "難語同士が交差しない");
    for (const s of slots) {
      const first = a.answers[s.id]![0];
      assert(first !== "ン" && first !== "ー", "ン・ー で始まる語がない");
    }
  }
  assert(okCount * 2 > templates.length, `テンプレートの過半数が埋まる (${okCount}/${templates.length})`);
  // 候補検索: ワイルドカードと固定文字
  const c1 = candidates(synth, 3, [null, null, null]);
  assert(c1.length === 400, "長さ 3 の全候補");
  const c2 = candidates(synth, 3, ["ア", null, "ア"]);
  assert(c2.every((id) => synth.words[id]!.kana[0] === "ア" && synth.words[id]!.kana[2] === "ア"), "固定文字で絞れる");
  console.log(`[fill] OK (${okCount}/${templates.length} templates${existsSync(DEFAULT_BANK_DIR) ? ", real bank" : ", synthetic"})`);
}

// ---- 5) 採点（49 文字形式）----
{
  const rows = templates[0]!.rows;
  const slots = deriveSlots(rows);
  const res = fill(slots, synth, { seed: 1, exclude: new Set(), recency: new Map() })!;
  const sol = solutionFromAnswers(rows, slots, res.answers);
  const whites = Array.from(sol).filter((ch) => ch !== "#").length;
  const blank = sol.replace(/[^#]/g, "_");
  const s0 = scoreCells(sol, blank);
  assert(s0.correct === 0 && s0.total === whites && !s0.solved && !s0.mask.includes("1"), "空盤面は 0 点");
  const full = scoreCells(sol, sol);
  assert(full.correct === whites && full.solved && !full.mask.includes("0"), "完全一致は満点");
  // 3 正解・2 誤り・残り空欄
  const idx = [...sol].map((ch, i) => (ch === "#" ? -1 : i)).filter((i) => i >= 0);
  const arr = [...blank];
  for (const i of idx.slice(0, 3)) arr[i] = sol[i]!;
  for (const i of idx.slice(3, 5)) arr[i] = sol[i] === "ア" ? "イ" : "ア";
  const part = scoreCells(sol, arr.join(""));
  assert(part.correct === 3 && [...part.mask].filter((m) => m === "0").length === 2, "部分採点が正しい");
  let threw = false;
  try { scoreCells(sol, blank.slice(1)); } catch { threw = true; }
  assert(threw, "長さ違いは INVALID_CELLS");
  threw = false;
  try { scoreCells(sol, blank.replace("#", "_")); } catch { threw = true; }
  assert(threw, "黒マス位置違いは INVALID_CELLS");
  console.log("[score] OK");
}

// ---- 6) 記録の優劣（SQL solve_better と同じ順序）----
{
  const base = { solved: true, reveals: 0, checks: 1, correctCells: 37, durationSec: 300 };
  assert(betterSolve(base, { ...base, solved: false, checks: 0 }), "完答 > 未完答（チェック回数に関係なく）");
  assert(betterSolve(base, { ...base, reveals: 1, checks: 0 }), "ヒント少 > チェック少");
  assert(betterSolve({ ...base, solved: false, correctCells: 20 }, { ...base, solved: false, correctCells: 10 }), "未完答同士は正解マス数");
  assert(!betterSolve(base, base), "同一は better でない");
  console.log("[betterSolve] OK");
}

// ---- 7) 日付と連続日数 ----
{
  assert(jstDateKey(Date.UTC(2026, 10, 9, 14, 59)) === "2026-11-09", "JST 23:59 はその日");
  assert(jstDateKey(Date.UTC(2026, 10, 9, 15, 0)) === "2026-11-10", "JST 0:00 は翌日");
  assert(addDays("2026-12-31", 1) === "2027-01-01" && diffDays("2026-11-01", "2026-11-11") === 10, "日付演算");
  assert(isDateKey("2026-02-29") === false && isDateKey("2028-02-29") === true, "日付の妥当性");
  assert(fmtDateJa("2026-11-10") === "2026年11月10日（火）", "日本語表示");
  const rec = (date: string, solved = true, reveals = 0) => ({ date, solved, reveals });
  const s1 = computeStats([rec("2026-11-08"), rec("2026-11-09"), rec("2026-11-10")], "2026-11-10");
  assert(s1.currentStreak === 3 && s1.maxStreak === 3 && s1.solved === 3, "3 日連続");
  const s2 = computeStats([rec("2026-11-08"), rec("2026-11-09")], "2026-11-10");
  assert(s2.currentStreak === 2, "今日未解答なら昨日までを数える");
  const s3 = computeStats([rec("2026-11-05"), rec("2026-11-06"), rec("2026-11-09")], "2026-11-10");
  assert(s3.currentStreak === 1 && s3.maxStreak === 2, "途切れ後の現在 1・最長 2");
  const s4 = computeStats([rec("2026-11-09", false), rec("2026-11-10", true, 2)], "2026-11-10");
  assert(s4.played === 2 && s4.solved === 1 && s4.clean === 0, "ヒントありはクリーンに数えない");
  console.log("[date/stats] OK");
}

// ---- 8) 生成結果: spec に答えが含まれない、連続日で語が重ならない（クールダウン）、
//         新出語は完全交差・互いに非交差・lv1、難語は blackout 中に戻らない、新出 / 復習の判定が履歴と一致 ----
{
  const h = emptyHistory();
  const d1 = "2027-03-01";
  const p1 = generatePuzzle(d1, synth, templates, h);
  addToHistory(h, { date: d1, answers: p1.answers, clueIndex: p1.clueIndex });
  const p2 = generatePuzzle(addDays(d1, 1), synth, templates, h);
  const specJson = JSON.stringify(p1.spec);
  for (const kana of Object.values(p1.answers)) assert(!specJson.includes(kana), `spec に答え ${kana} が漏れていない`);
  const used1 = new Set(Object.values(p1.answers));
  for (const kana of Object.values(p2.answers)) assert(!used1.has(kana), `翌日に同じ語 ${kana} を使わない`);
  assert(p1.solution.length === 49 && Array.from(p1.solution).filter((c) => c === "#").length === p1.spec.grid.join("").split("#").length - 1, "解答の黒マス数が盤面と一致");
  const slots1 = deriveSlots(p1.spec.grid);
  const cm = cellSlotMap(slots1);
  assert(p1.spec.slots.every((s) => s.clue.length > 0), "全スロットにカギがある");
  assert(cm.size === p1.solution.replace(/#/g, "").length, "全白マスがいずれかの語に属する");
  // カギのレベル配分の公平性: 配分の合計 = スロット数で lv3 が 1 つ以上、lv3 は完全交差の語だけ、lv3 同士は交差しない
  const lv3 = slots1.filter((s) => p1.levels[s.id] === 3);
  assert(p1.mix[1] + p1.mix[2] + p1.mix[3] === slots1.length && p1.mix[3] > 0, `mix がスロット数に一致し lv3 がある (${JSON.stringify(p1.mix)})`);
  assert(lv3.every((s) => s.cells.every((c) => cm.get(c)!.length === 2)), "lv3 カギは完全交差スロットのみ");
  assert(lv3.every((a) => lv3.every((b) => a.id >= b.id || !a.cells.some((c) => b.cells.includes(c)))), "lv3 スロット同士は交差しない");

  // 6 日連続生成: 新出語の位置とカギ、難語の blackout、新出 / 復習ラベルの正しさ（復習が「必ず 1 語ある」は埋め都合で揺れるので見ない）
  addToHistory(h, { date: addDays(d1, 1), answers: p2.answers, clueIndex: p2.clueIndex });
  const hardUses = new Map<string, string>(); // 難語 → 最後に使った日
  const noteHard = (p: typeof p1, date: string) => {
    for (const sid of p.hard) hardUses.set(p.answers[sid]!, date);
  };
  noteHard(p1, d1);
  noteHard(p2, addDays(d1, 1));
  let newTotal = p1.learn.new.length + p2.learn.new.length;
  for (let i = 2; i < 6; i++) {
    const date = addDays(d1, i);
    const p = generatePuzzle(date, synth, templates, h);
    const slots = deriveSlots(p.spec.grid);
    const cmap = cellSlotMap(slots);
    const fresh = slots.filter((s) => p.learn.new.includes(s.id));
    assert(fresh.length <= DEFAULT_PROFILE.maxNew, `${date}: 新出語 ≤ maxNew`);
    assert(fresh.every((s) => s.cells.every((c) => cmap.get(c)!.length === 2)), `${date}: 新出語は完全交差スロットのみ`);
    assert(fresh.every((a) => fresh.every((b) => a.id >= b.id || !a.cells.some((c) => b.cells.includes(c)))), `${date}: 新出語同士は交差しない`);
    assert(fresh.every((s) => p.levels[s.id] === 1), `${date}: 新出語のカギは lv1`);
    for (const sid of p.learn.new) {
      const kana = p.answers[sid]!;
      assert(synth.words[synth.byKana.get(kana)!]!.difficulty >= 2 && !hardUses.has(kana), `${date}: 新出語 ${kana} は初出の難語`);
    }
    for (const sid of p.learn.review) assert(hardUses.has(p.answers[sid]!), `${date}: 復習語 ${p.answers[sid]} は既出の難語`);
    for (const sid of p.hard) {
      const kana = p.answers[sid]!;
      const last = hardUses.get(kana);
      if (last) assert(diffDays(last, date) >= HARD_SCHEDULE[0]!.blackout, `${date}: 難語 ${kana} が blackout 中（前回 ${last}）に戻っていない`);
      assert(p.learn.new.includes(sid) || p.learn.review.includes(sid), `${date}: 難語 ${kana} は新出か復習のどちらか`);
    }
    newTotal += p.learn.new.length;
    noteHard(p, date);
    addToHistory(h, { date, answers: p.answers, clueIndex: p.clueIndex });
  }
  assert(newTotal > 0, "6 日間で新出語が 1 語以上出る");

  // schedule(): blackout 中は除外、ウィンドウ内は window、過ぎたら due。difficulty 1 は 10 日クールダウン
  const hard2 = synth.words.filter((w) => w.difficulty >= 2).slice(0, 4).map((w) => w.kana);
  const easy = synth.words.filter((w) => w.difficulty === 1).slice(0, 2).map((w) => w.kana);
  const today = "2027-06-30";
  const hs = emptyHistory();
  hs.uses.set(hard2[0]!, [addDays(today, -2)]);
  hs.uses.set(hard2[1]!, [addDays(today, -5)]);
  hs.uses.set(hard2[2]!, [addDays(today, -9)]);
  hs.uses.set(hard2[3]!, [addDays(today, -40), addDays(today, -10)]);
  hs.uses.set(easy[0]!, [addDays(today, -5)]);
  hs.uses.set(easy[1]!, [addDays(today, -12)]);
  const sch = schedule(hs, today, synth);
  assert(sch.exclude.has(hard2[0]!) && !sch.review.has(hard2[0]!), "難語: 2 日前に使った語は除外");
  assert(sch.review.get(hard2[1]!) === "window", "難語: 5 日前に使った語は復習ウィンドウ内");
  assert(sch.review.get(hard2[2]!) === "due", "難語: 9 日前に使った語はウィンドウを過ぎて due");
  assert(sch.exclude.has(hard2[3]!), "難語: 2 回使って 10 日前なら除外（2 回目の blackout は 14 日）");
  assert(sch.exclude.has(easy[0]!) && !sch.exclude.has(easy[1]!), "difficulty 1: 5 日前は除外、12 日前は使える");
  console.log(`[generate] OK (mix ${p1.mix[1]}/${p1.mix[2]}/${p1.mix[3]}, 6 日で新出 ${newTotal} 語)`);
}

console.log("✅ smoketest passed");
