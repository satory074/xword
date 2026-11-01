// JST の日付キー（'YYYY-MM-DD'）。サーバーの jst_today() と同じ定義（UTC+9 固定、DST なし）。
// 注: new Date(epochMs) + getUTC* は実行環境のタイムゾーンに依存しない。

const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

export function jstDateKey(epochMs: number): string {
  return new Date(epochMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → その日の JST 0:00 の epochMs */
export function keyToEpoch(key: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - JST_OFFSET_MS;
}

export function addDays(key: string, n: number): string {
  return jstDateKey(keyToEpoch(key) + n * DAY_MS);
}

/** b - a（日数） */
export function diffDays(a: string, b: string): number {
  return Math.round((keyToEpoch(b) - keyToEpoch(a)) / DAY_MS);
}

export function isDateKey(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return jstDateKey(keyToEpoch(s)) === s;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** '2026-11-10' → '2026年11月10日（火）' */
export function fmtDateJa(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}年${m}月${d}日（${wd}）`;
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
