// RPC が RAISE EXCEPTION で投げるエラーキー → 日本語メッセージ。
// キーは supabase/migrations/002_rpc.sql・003_reveal_cell.sql と同期を保つこと。
const MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: "ログインが必要です",
  PUZZLE_NOT_AVAILABLE: "その日の問題はまだ公開されていません",
  PUZZLE_NOT_FOUND: "問題が見つかりません",
  INVALID_CELLS: "入力の形式が不正です（ページを再読み込みしてください）",
  INVALID_CELL: "そのマスにはヒントを出せません",
  CHECK_LIMIT: "この問題の答え合わせ回数が上限に達しました",
  TOO_MANY_ITEMS: "同期する件数が多すぎます",
};

/** 生のエラー文字列からエラーキーを探して日本語化。未知なら原文を返す */
export function apiErrorMessage(raw: string): string {
  for (const [key, msg] of Object.entries(MESSAGES)) {
    if (raw.includes(key)) return msg;
  }
  return `エラーが発生しました: ${raw}`;
}

export function errorKey(e: unknown): string | null {
  const raw = e instanceof Error ? e.message : String(e);
  for (const key of Object.keys(MESSAGES)) if (raw.includes(key)) return key;
  return null;
}
