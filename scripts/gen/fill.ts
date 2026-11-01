// バックトラッキング CSP による盤面埋め。
//   変数 = スロット、値 = 語 id、制約 = 交差の一致・同語禁止・先頭ン/ー禁止・難語の上限と交差禁止。
//   変数順 MRV → 次数 → 長さ。値順は forward checking（隣接ドメイン最小が大きい順）→ 古い順 → ハッシュ順。
import { candidates, type Bank } from "../../src/lib/bank";
import { CELLS, cellSlotMap, type Slot } from "../../src/lib/grid";
import { cyrb53 } from "../../src/lib/rng";

export interface FillOptions {
  seed: number;
  /** クールダウン中の語（除外） */
  exclude: ReadonlySet<string>;
  /** 語 → 最後に使ってからの日数（未使用は未登録＝最優先） */
  recency: ReadonlyMap<string, number>;
  maxNodes?: number;
  maxDiff3?: number;
  /** forward checking にかける候補数の上限（コスト抑制） */
  fcLimit?: number;
  /** 診断用: 行き止まり（ドメインが空になったスロット）と代入の通知 */
  onDeadEnd?: (slotId: string, depth: number) => void;
  onAssign?: (slotId: string, kana: string, depth: number) => void;
}

export interface FillResult {
  answers: Record<string, string>;
  nodes: number;
}

interface Crossing {
  /** 自分の何文字目か */
  pos: number;
  other: Slot;
}

export function fill(slots: Slot[], bank: Bank, opts: FillOptions): FillResult | null {
  const maxNodes = opts.maxNodes ?? 20000;
  const maxDiff3 = opts.maxDiff3 ?? 2;
  const fcLimit = opts.fcLimit ?? 80;

  const cells: (string | null)[] = new Array<string | null>(CELLS).fill(null);
  const cellMap = cellSlotMap(slots);
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const firstCells = new Set(slots.map((s) => s.cells[0]!));
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
  let nodes = 0;

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
    if (w.difficulty === 3) {
      if (diff3Slots.size >= maxDiff3) return false;
      for (const x of crossings.get(s.id)!) if (diff3Slots.has(x.other.id)) return false;
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

  const order = (s: Slot, dom: number[]): number[] => {
    const pre = dom
      .map((id) => ({ id, rec: recencyOf(bank.words[id]!.kana), h: cyrb53(bank.words[id]!.kana, opts.seed) }))
      .sort((a, b) => b.rec - a.rec || a.h - b.h)
      .slice(0, fcLimit);
    const scored: { id: number; fc: number; rec: number; h: number }[] = [];
    for (const c of pre) {
      const touched = place(s, c.id);
      let fc = Number.POSITIVE_INFINITY;
      for (const x of crossings.get(s.id)!) {
        if (assigned.has(x.other.id)) continue;
        const n = domain(x.other).length;
        if (n < fc) fc = n;
        if (fc === 0) break;
      }
      unplace(touched);
      if (fc === 0) continue;
      scored.push({ id: c.id, fc, rec: c.rec, h: c.h });
    }
    scored.sort((a, b) => b.fc - a.fc || b.rec - a.rec || a.h - b.h);
    return scored.map((x) => x.id);
  };

  const recurse = (): boolean => {
    if (assigned.size === slots.length) return true;
    if (nodes > maxNodes) return false;
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
      if (nodes > maxNodes) return false;
      const w = bank.words[id]!;
      opts.onAssign?.(slot.id, w.kana, assigned.size);
      const touched = place(slot, id);
      assigned.set(slot.id, id);
      used.add(w.kana);
      if (w.difficulty === 3) diff3Slots.add(slot.id);
      if (recurse()) return true;
      if (w.difficulty === 3) diff3Slots.delete(slot.id);
      used.delete(w.kana);
      assigned.delete(slot.id);
      unplace(touched);
    }
    return false;
  };

  if (!recurse()) return null;
  const answers: Record<string, string> = {};
  for (const [sid, id] of assigned) answers[sid] = bank.words[id]!.kana;
  return { answers, nodes };
}
