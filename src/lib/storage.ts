// 端末保存（localStorage）の形と、同期のマージ順序。
// キーはバージョン付き（majolica / mahjong-ime 方式）。betterSolve は SQL solve_better の鏡像。
import type { KV, LocalResult, SolveRow } from "./types";

export const RESULTS_KEY = "xword:results:v1";
export const progressKey = (date: string): string => `xword:progress:v1:${date}`;

export type ResultsMap = Record<string, LocalResult>;

/** 入力途中の状態（xword:progress:v1:<date> の値） */
export interface Progress {
  cells: string;
  elapsedSec: number;
  checks: number;
  reveals: number;
  /** ヒントで埋めたマス（0..48） */
  revealed: number[];
}

export function readProgress(kv: KV, date: string): Progress | null {
  const raw = kv.get(progressKey(date));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Progress>;
    if (typeof p.cells !== "string") return null;
    return {
      cells: p.cells,
      elapsedSec: Number(p.elapsedSec ?? 0),
      checks: Number(p.checks ?? 0),
      reveals: Number(p.reveals ?? 0),
      revealed: Array.isArray(p.revealed) ? p.revealed.map(Number) : [],
    };
  } catch {
    return null;
  }
}

export function writeProgress(kv: KV, date: string, p: Progress): void {
  kv.set(progressKey(date), JSON.stringify(p));
}

export function clearProgress(kv: KV, date: string): void {
  kv.remove(progressKey(date));
}

export function readResults(kv: KV): ResultsMap {
  const raw = kv.get(RESULTS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ResultsMap = {};
    for (const [date, v] of Object.entries(parsed as Record<string, Partial<LocalResult>>)) {
      if (!v || typeof v.cells !== "string") continue;
      out[date] = {
        cells: v.cells,
        correctCells: Number(v.correctCells ?? 0),
        totalCells: Number(v.totalCells ?? 0),
        solved: v.solved === true,
        checks: Number(v.checks ?? 0),
        reveals: Number(v.reveals ?? 0),
        durationSec: Number(v.durationSec ?? 0),
        solvedAt: typeof v.solvedAt === "string" ? v.solvedAt : null,
        syncedTo: Array.isArray(v.syncedTo) ? v.syncedTo.filter((s) => typeof s === "string") : [],
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeResults(kv: KV, map: ResultsMap): void {
  kv.set(RESULTS_KEY, JSON.stringify(map));
}

export function writeResult(kv: KV, date: string, result: LocalResult): void {
  const map = readResults(kv);
  map[date] = result;
  writeResults(kv, map);
}

/** そのユーザーへ未同期の結果 */
export function unsyncedFor(kv: KV, uid: string): [string, LocalResult][] {
  return Object.entries(readResults(kv)).filter(([, r]) => !r.syncedTo.includes(uid));
}

export function markSynced(kv: KV, uid: string, dates: string[]): void {
  const map = readResults(kv);
  for (const d of dates) {
    const r = map[d];
    if (r && !r.syncedTo.includes(uid)) r.syncedTo = [...r.syncedTo, uid];
  }
  writeResults(kv, map);
}

type Comparable = Pick<LocalResult, "solved" | "reveals" | "checks" | "correctCells" | "durationSec">;

/**
 * a が b より良い記録か。辞書順 (solved, -reveals, -checks, correctCells, -durationSec)。
 * SQL の solve_better と同じ順序を保つこと。
 */
export function betterSolve(a: Comparable, b: Comparable): boolean {
  const ka = [a.solved ? 1 : 0, -a.reveals, -a.checks, a.correctCells, -a.durationSec];
  const kb = [b.solved ? 1 : 0, -b.reveals, -b.checks, b.correctCells, -b.durationSec];
  for (let i = 0; i < ka.length; i++) {
    if (ka[i]! > kb[i]!) return true;
    if (ka[i]! < kb[i]!) return false;
  }
  return false;
}

/** サーバー行 → ローカル結果（同期済みとして保持する） */
export function resultFromRow(row: SolveRow, uid: string): LocalResult {
  return {
    cells: row.cells,
    correctCells: row.correctCells,
    totalCells: row.totalCells,
    solved: row.solved,
    checks: row.checks,
    reveals: row.reveals,
    durationSec: row.durationSec,
    solvedAt: row.solvedAt,
    syncedTo: [uid],
  };
}

/** メモリ KV（テストと localStorage 不可環境のフォールバック） */
export function memoryKV(init?: Record<string, string>): KV {
  const m = new Map<string, string>(Object.entries(init ?? {}));
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => {
      m.set(k, v);
    },
    remove: (k) => {
      m.delete(k);
    },
  };
}
