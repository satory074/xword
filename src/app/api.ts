// Api インターフェース（src/lib/types.ts）の Supabase 実装。
// snake_case ⇔ camelCase の変換とエラーの日本語化はここで完結させる。
import { apiErrorMessage } from "../lib/errors";
import type { Api, CheckResult, DateList, PublicPuzzle, PuzzleResponse, SolveRow, SyncItem } from "../lib/types";
import { getSupabase } from "./supabase";

function fail(error: { message: string }): never {
  throw new Error(apiErrorMessage(error.message));
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase 行の境界変換 */
type Row = Record<string, any>;

function mapSolve(row: Row): SolveRow {
  return {
    puzzleDate: row.puzzle_date,
    cells: row.cells,
    correctCells: Number(row.correct_cells),
    totalCells: Number(row.total_cells),
    solved: row.solved === true,
    checks: Number(row.checks),
    reveals: Number(row.reveals),
    durationSec: Number(row.duration_sec),
    solvedAt: row.solved_at ?? null,
  };
}

export function realApi(): Api {
  const sb = getSupabase();

  return {
    async getPuzzle(date): Promise<PuzzleResponse> {
      const { data, error } = await sb.rpc("get_puzzle", { p_date: date });
      if (error) fail(error);
      const r = data as Row;
      return { date: r.date, puzzle: (r.puzzle as PublicPuzzle | null) ?? null };
    },

    async listDates(): Promise<DateList> {
      const { data, error } = await sb.rpc("list_puzzle_dates");
      if (error) fail(error);
      const r = data as Row;
      return { dates: (r.dates as string[]) ?? [], latest: r.latest ?? null, today: r.today };
    },

    async checkGrid(date, cells, durationSec): Promise<CheckResult> {
      const { data, error } = await sb.rpc("check_grid", {
        p_date: date,
        p_cells: cells,
        p_duration_sec: durationSec,
      });
      if (error) fail(error);
      const r = data as Row;
      return {
        mask: r.mask,
        correct: Number(r.correct),
        total: Number(r.total),
        solved: r.solved === true,
        checks: r.checks === null || r.checks === undefined ? null : Number(r.checks),
      };
    },

    async revealSlot(date, slotId): Promise<string> {
      const { data, error } = await sb.rpc("reveal_slot", { p_date: date, p_slot_id: slotId });
      if (error) fail(error);
      return String(data);
    },

    async syncResults(items: SyncItem[]): Promise<SolveRow[]> {
      const { data, error } = await sb.rpc("sync_results", { p_items: items });
      if (error) fail(error);
      return ((data as Row[]) ?? []).map(mapSolve);
    },

    async fetchMySolves(): Promise<SolveRow[]> {
      const { data, error } = await sb
        .from("solves")
        .select("*")
        .order("puzzle_date", { ascending: false })
        .limit(1000);
      if (error) fail(error);
      return (data as Row[]).map(mapSolve);
    },
  };
}
