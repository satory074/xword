// バックトラッキング CSP による盤面埋め。
//   変数 = スロット、値 = 語 id、制約 = 交差の一致・同語禁止・先頭ン/ー禁止・難語の上限・
//   新出語（履歴に無い難語）は完全交差スロットのみ＆新出同士は交差しない・difficulty 3 も同様（上限 maxDiff3）。
//   変数順 MRV → 次数 → 長さ。値順は forward checking（隣接ドメイン最小が大きい順）→ 古い順 → ハッシュ順。
//   復習語（間隔反復で戻す既出の難語）は特定の文字列なので、探索の途中で交差パターンに合う機会がほぼ無い。
//   そこで探索の前に「種」として置く（置き方を数通り、ノード予算つきで試し、全部だめなら種なしで埋める）。
//   新出語は候補が多いので、targetNew に達するまで候補順で先頭に昇格させるだけでよい（開放度 ≥ HARD_FC_FLOOR、SEED_PROMOTE_MAX 語まで）。
//   スロットの選び方は変えない（種を置けるスロットを優先すると MRV が崩れて探索が発散する）。
import { candidates, type Bank } from "../../src/lib/bank";
import { CELLS, cellSlotMap, uncheckedCount, type Slot } from "../../src/lib/grid";
import { cyrb53 } from "../../src/lib/rng";
import type { ReviewState } from "./history";
import { HARD_FC_FLOOR, SEED_PROMOTE_MAX } from "./level";

export interface FillOptions {
  seed: number;
  /** クールダウン・blackout 中の語（除外） */
  exclude: ReadonlySet<string>;
  /** 語 → 最後に使ってからの日数（未使用は未登録＝最優先。難語なら未登録 = 新出） */
  recency: ReadonlyMap<string, number>;
  /** 使用済みで使える難語 → window（復習ウィンドウ内）| due（過ぎた）。schedule() の出力 */
  review?: ReadonlyMap<string, ReviewState>;
  maxNodes?: number;
  maxDiff3?: number;
  /** 新出語の目標数（ソフト: 候補順のバイアスのみ） */
  targetNew?: number;
  /** 新出語の上限（ハード制約） */
  maxNew?: number;
  /** 復習語の目標数（ソフト: 事前配置を試す数） */
  targetReview?: number;
  /** difficulty ≥ 2 の語の上限（ハード制約） */
  maxHard?: number;
  /** forward checking にかける候補数の上限（コスト抑制） */
  fcLimit?: number;
  /** 診断用: 行き止まり（ドメインが空になったスロット）と代入の通知 */
  onDeadEnd?: (slotId: string, depth: number) => void;
  onAssign?: (slotId: string, kana: string, depth: number) => void;
}

export interface FillResult {
  answers: Record<string, string>;
  nodes: number;
  /** difficulty ≥ 2 の語数 */
  hard: number;
  /** 新出語のスロット id */
  fresh: string[];
  /** 復習語のスロット id */
  review: string[];
}

interface Crossing {
  /** 自分の何文字目か */
  pos: number;
  other: Slot;
}

/** 復習語の事前配置: 語の組ごとに試す置き方の数（開放度の高い順）。1 回あたりのノード予算は SEED_BUDGET_SHARE × maxNodes、種まき全体で SEED_TOTAL_SHARE × maxNodes まで */
const SEED_COMBOS_PER_SET = 6;
const SEED_BUDGET_SHARE = 0.15;
const SEED_TOTAL_SHARE = 0.5;

export function fill(slots: Slot[], bank: Bank, opts: FillOptions): FillResult | null {
  const maxNodes = opts.maxNodes ?? 20000;
  const maxDiff3 = opts.maxDiff3 ?? 2;
  const targetNew = opts.targetNew ?? 0;
  const maxNew = opts.maxNew ?? Number.POSITIVE_INFINITY;
  const targetReview = opts.targetReview ?? 0;
  const review: ReadonlyMap<string, ReviewState> = opts.review ?? new Map();
  const maxHard = opts.maxHard ?? Number.POSITIVE_INFINITY;
  const fcLimit = opts.fcLimit ?? 80;

  const cells: (string | null)[] = new Array<string | null>(CELLS).fill(null);
  const cellMap = cellSlotMap(slots);
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const firstCells = new Set(slots.map((s) => s.cells[0]!));
  const fullyChecked = new Set(slots.filter((s) => uncheckedCount(s, cellMap) === 0).map((s) => s.id));
  const crossings = new Map<string, Crossing[]>();
  for (const s of slots) {
    const list: Crossing[] = [];
    s.cells.forEach((cell, pos) => {
      for (const otherId of cellMap.get(cell) ?? []) {
        if (otherId !== s.id) list.push({ pos, other: slotById.get(otherId)! });
      }
    });
    crossings.set(s.id, list);
  }

  const assigned = new Map<string, number>();
  const used = new Set<string>();
  const diff3Slots = new Set<string>();
  const newSlots = new Set<string>();
  let hardCount = 0;
  let reviewCount = 0;
  let nodes = 0;
  let nodeLimit = maxNodes;

  const isHard = (id: number): boolean => bank.words[id]!.difficulty >= 2;
  /** 新出 = 履歴に無い難語（recency 未登録）。復習 = schedule() が使えると判定した既出の難語 */
  const isNew = (id: number): boolean => isHard(id) && !opts.recency.has(bank.words[id]!.kana);
  const reviewState = (id: number): ReviewState | undefined => review.get(bank.words[id]!.kana);
  const patternOf = (s: Slot): (string | null)[] => s.cells.map((c) => cells[c]!);

  const allowed = (s: Slot, id: number): boolean => {
    const w = bank.words[id]!;
    if (used.has(w.kana) || opts.exclude.has(w.kana)) return false;
    const chars = w.kana;
    for (let i = 0; i < s.len; i++) {
      const cell = s.cells[i]!;
      if (cells[cell] === null && firstCells.has(cell)) {
        const ch = chars[i];
        if (ch === "ン" || ch === "ー") return false;
      }
    }
    if (w.difficulty >= 2 && hardCount >= maxHard) return false;
    if (isNew(id)) {
      // 初めて出す難語は、知らなくても交差から埋められる位置にだけ置き、新出同士を交差させない（Natick 禁止）
      if (!fullyChecked.has(s.id)) return false;
      if (newSlots.size >= maxNew) return false;
      for (const x of crossings.get(s.id)!) if (newSlots.has(x.other.id)) return false;
    }
    if (w.difficulty === 3) {
      // 難語は交差から埋められる位置にだけ置く（NYT: never let two obscure words cross）
      if (!fullyChecked.has(s.id)) return false;
      if (diff3Slots.size >= maxDiff3) return false;
      for (const x of crossings.get(s.id)!) if (diff3Slots.has(x.other.id)) return false;
    }
    return true;
  };

  const matches = (s: Slot, id: number): boolean => {
    const kana = bank.words[id]!.kana;
    for (let i = 0; i < s.len; i++) {
      const ch = cells[s.cells[i]!];
      if (ch !== null && ch !== kana[i]) return false;
    }
    return true;
  };

  const domain = (s: Slot): number[] => candidates(bank, s.len, patternOf(s)).filter((id) => allowed(s, id));

  const place = (s: Slot, id: number): number[] => {
    const w = bank.words[id]!;
    const touched: number[] = [];
    s.cells.forEach((cell, i) => {
      if (cells[cell] === null) {
        cells[cell] = w.kana[i]!;
        touched.push(cell);
      }
    });
    return touched;
  };
  const unplace = (touched: number[]): void => {
    for (const cell of touched) cells[cell] = null;
  };

  /** 代入と帳簿（難語数・新出・復習・difficulty 3）。戻り値は unassign に渡す */
  const assign = (s: Slot, id: number): { touched: number[]; fresh: boolean; rev: boolean } => {
    const w = bank.words[id]!;
    const touched = place(s, id);
    assigned.set(s.id, id);
    used.add(w.kana);
    const fresh = isNew(id);
    const rev = reviewState(id) !== undefined;
    if (w.difficulty === 3) diff3Slots.add(s.id);
    if (w.difficulty >= 2) hardCount++;
    if (fresh) newSlots.add(s.id);
    if (rev) reviewCount++;
    return { touched, fresh, rev };
  };
  const unassign = (s: Slot, id: number, u: { touched: number[]; fresh: boolean; rev: boolean }): void => {
    const w = bank.words[id]!;
    if (u.rev) reviewCount--;
    if (u.fresh) newSlots.delete(s.id);
    if (w.difficulty >= 2) hardCount--;
    if (w.difficulty === 3) diff3Slots.delete(s.id);
    used.delete(w.kana);
    assigned.delete(s.id);
    unplace(u.touched);
  };

  const pick = (): { slot: Slot; dom: number[] } | null => {
    let best: { slot: Slot; dom: number[]; degree: number } | null = null;
    for (const s of slots) {
      if (assigned.has(s.id)) continue;
      const dom = domain(s);
      const degree = crossings.get(s.id)!.filter((x) => !assigned.has(x.other.id)).length;
      if (
        best === null ||
        dom.length < best.dom.length ||
        (dom.length === best.dom.length && degree > best.degree) ||
        (dom.length === best.dom.length && degree === best.degree && s.len > best.slot.len)
      ) {
        best = { slot: s, dom, degree };
      }
      if (dom.length === 0) break;
    }
    return best ? { slot: best.slot, dom: best.dom } : null;
  };

  const recencyOf = (kana: string): number => opts.recency.get(kana) ?? Number.POSITIVE_INFINITY;

  /** forward checking: id を s に置いたときの、未割当の交差スロットの残り候補の最小（0 = 行き止まり） */
  const openness = (s: Slot, id: number): number => {
    const touched = place(s, id);
    let fc = Number.POSITIVE_INFINITY;
    for (const x of crossings.get(s.id)!) {
      if (assigned.has(x.other.id)) continue;
      const n = domain(x.other).length;
      if (n < fc) fc = n;
      if (fc === 0) break;
    }
    unplace(touched);
    return fc;
  };

  const order = (s: Slot, dom: number[]): number[] => {
    const needNew = newSlots.size < targetNew;
    const all = dom
      .map((id) => ({ id, rec: recencyOf(bank.words[id]!.kana), h: cyrb53(bank.words[id]!.kana, opts.seed) }))
      .sort((a, b) => b.rec - a.rec || a.h - b.h);
    const pre = all.slice(0, fcLimit);
    if (needNew) {
      // 新出語は少数なので、fcLimit の外でも必ず forward checking に載せる
      const inPre = new Set(pre.map((c) => c.id));
      for (const c of all) if (isNew(c.id) && !inPre.has(c.id)) pre.push(c);
    }
    const scored: { id: number; fc: number; rec: number; h: number }[] = [];
    for (const c of pre) {
      const fc = openness(s, c.id);
      if (fc === 0) continue;
      scored.push({ id: c.id, fc, rec: c.rec, h: c.h });
    }
    scored.sort((a, b) => b.fc - a.fc || b.rec - a.rec || a.h - b.h);
    if (needNew && scored.length) {
      // 新出語を先頭へ（開放度順）。開放度 < HARD_FC_FLOOR は昇格しない（盤面を詰まらせる）。
      // 昇格は SEED_PROMOTE_MAX 語まで（全部が行き止まりでも探索が発散しない）
      const promoted = scored.filter((x) => x.fc >= HARD_FC_FLOOR && isNew(x.id)).slice(0, SEED_PROMOTE_MAX);
      if (promoted.length) {
        const ids = new Set(promoted.map((x) => x.id));
        return [...promoted.map((x) => x.id), ...scored.filter((x) => !ids.has(x.id)).map((x) => x.id)];
      }
    }
    return scored.map((x) => x.id);
  };

  const recurse = (): boolean => {
    if (assigned.size === slots.length) return true;
    if (nodes > nodeLimit) return false;
    const picked = pick();
    if (!picked || picked.dom.length === 0) {
      if (picked) opts.onDeadEnd?.(picked.slot.id, assigned.size);
      return false;
    }
    const { slot, dom } = picked;
    const ordered = order(slot, dom);
    if (ordered.length === 0) opts.onDeadEnd?.(slot.id, assigned.size);
    for (const id of ordered) {
      nodes++;
      if (nodes > nodeLimit) return false;
      const w = bank.words[id]!;
      opts.onAssign?.(slot.id, w.kana, assigned.size);
      const u = assign(slot, id);
      if (recurse()) return true;
      unassign(slot, id, u);
    }
    return false;
  };

  // ---- 復習語の事前配置: ウィンドウ内 → 過ぎた順（同順位はハッシュ）で targetReview 語を選び、
  //      「全部」→「1 語ずつ」の順に、置き方を開放度の高い順に試す。各試行はノード予算つき。全部だめなら種なし ----
  type Placement = { slot: Slot; id: number };
  const reviewIds = [...review.entries()]
    .map(([kana, st]) => ({ id: bank.byKana.get(kana), st, h: cyrb53(kana, opts.seed) }))
    .filter((x): x is { id: number; st: ReviewState; h: number } => x.id !== undefined)
    .sort((a, b) => (a.st === b.st ? a.h - b.h : a.st === "window" ? -1 : 1))
    .map((x) => x.id)
    .slice(0, targetReview);

  /** 語の列 ids を全部置く置き方を、開放度の高い順に最大 SEED_COMBOS_PER_SET 通り */
  const combosFor = (ids: number[]): Placement[][] => {
    const out: Placement[][] = [];
    const rec = (i: number, cur: Placement[]): void => {
      if (out.length >= SEED_COMBOS_PER_SET) return;
      if (i >= ids.length) {
        out.push([...cur]);
        return;
      }
      const id = ids[i]!;
      const len = bank.words[id]!.len;
      const spots = slots
        .filter((s) => s.len === len && !assigned.has(s.id) && matches(s, id) && allowed(s, id))
        .map((s) => ({ s, fc: openness(s, id), h: cyrb53(s.id + bank.words[id]!.kana, opts.seed) }))
        .filter((x) => x.fc >= HARD_FC_FLOOR)
        .sort((a, b) => b.fc - a.fc || a.h - b.h);
      for (const { s } of spots) {
        const u = assign(s, id);
        cur.push({ slot: s, id });
        rec(i + 1, cur);
        cur.pop();
        unassign(s, id, u);
        if (out.length >= SEED_COMBOS_PER_SET) return;
      }
    };
    rec(0, []);
    return out;
  };
  const seedSets: number[][] = [];
  if (targetReview > 0 && reviewIds.length) {
    seedSets.push(reviewIds);
    if (reviewIds.length > 1) for (const id of reviewIds) seedSets.push([id]);
  }

  const finish = (): FillResult => {
    const answers: Record<string, string> = {};
    const reviewSlots: string[] = [];
    for (const [sid, id] of assigned) {
      answers[sid] = bank.words[id]!.kana;
      if (reviewState(id) !== undefined) reviewSlots.push(sid);
    }
    return { answers, nodes, hard: hardCount, fresh: [...newSlots], review: reviewSlots };
  };

  const budget = Math.max(1000, Math.floor(maxNodes * SEED_BUDGET_SHARE));
  const seedTotal = Math.floor(maxNodes * SEED_TOTAL_SHARE);
  outer: for (const set of seedSets) {
    for (const combo of combosFor(set)) {
      const undo: { slot: Slot; id: number; u: ReturnType<typeof assign> }[] = [];
      for (const p of combo) undo.push({ slot: p.slot, id: p.id, u: assign(p.slot, p.id) });
      nodeLimit = Math.min(seedTotal, nodes + budget);
      if (recurse()) return finish();
      for (const x of undo.reverse()) unassign(x.slot, x.id, x.u);
      if (nodes >= seedTotal) break outer;
    }
  }
  // 種なし（復習語は通常の候補として残る）
  nodeLimit = maxNodes;
  if (!recurse()) return null;
  return finish();
}
