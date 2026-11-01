// ドメイン型と Api インターフェース。app/api.ts が Supabase 実装を提供し、
// domtest はフェイク実装を注入する（このファイルが境界）。
import type { Dir } from "./grid";

export interface PublicSlot {
  id: string;
  dir: Dir;
  num: number;
  r: number;
  c: number;
  len: number;
  clue: string;
}

/** 配信用の問題（解答を含まない。puzzles.spec と同じ形） */
export interface PublicPuzzle {
  date: string;
  template: string;
  size: number;
  /** 7 行。'#' 黒 / '.' 白 */
  grid: string[];
  slots: PublicSlot[];
}

export interface CheckResult {
  /** 49 文字: '1' 正解 / '0' 誤り / '_' 空欄 / '#' 黒 */
  mask: string;
  correct: number;
  total: number;
  solved: boolean;
  /** ログイン中のみ: サーバーに記録された累計チェック回数 */
  checks: number | null;
}

/** localStorage に持つ 1 日分の結果（xword:results:v1 の値） */
export interface LocalResult {
  cells: string;
  correctCells: number;
  totalCells: number;
  solved: boolean;
  checks: number;
  reveals: number;
  durationSec: number;
  /** ISO 8601 */
  solvedAt: string | null;
  /** 同期済みのユーザー id 一覧 */
  syncedTo: string[];
}

/** サーバーの solves 行 */
export interface SolveRow {
  puzzleDate: string;
  cells: string;
  correctCells: number;
  totalCells: number;
  solved: boolean;
  checks: number;
  reveals: number;
  durationSec: number;
  solvedAt: string | null;
}

export interface SyncItem {
  date: string;
  cells: string;
  checks: number;
  reveals: number;
  durationSec: number;
  solvedAt: string | null;
}

export interface PuzzleResponse {
  /** サーバーが決めた JST 日付（p_date null のときは今日） */
  date: string;
  /** その日の問題。未登録なら null */
  puzzle: PublicPuzzle | null;
}

export interface DateList {
  /** 公開済み（JST 今日以前）の日付、新しい順 */
  dates: string[];
  /** 登録済みの最終日（未来を含む）。補充の目安 */
  latest: string | null;
  /** サーバーが決めた JST 今日 */
  today: string;
}

export interface Api {
  getPuzzle(date: string | null): Promise<PuzzleResponse>;
  listDates(): Promise<DateList>;
  checkGrid(date: string, cells: string, durationSec: number): Promise<CheckResult>;
  revealSlot(date: string, slotId: string): Promise<string>;
  syncResults(items: SyncItem[]): Promise<SolveRow[]>;
  fetchMySolves(): Promise<SolveRow[]>;
}

export interface SessionInfo {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthCtl {
  getSession(): Promise<SessionInfo | null>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** 戻り値は unsubscribe */
  onChange(cb: (s: SessionInfo | null) => void): () => void;
}

/** localStorage の抽象（domtest はメモリ実装を注入） */
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** boot に注入する依存一式 */
export interface AppDeps {
  api: Api;
  auth: AuthCtl;
  storage: KV;
  now(): number;
}
