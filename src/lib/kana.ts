// カナ正規化と盤面で使える文字集合。
// SQL 側（supabase/migrations/002_rpc.sql の normalize_cells と文字クラス）と変換表を
// 文字単位で一致させること。smoketest 2 が SQL ファイルを読んで突き合わせる。

/** 小さい仮名 → 大きい仮名（クロスワード表記: ッ→ツ、ャ→ヤ …）。translate 用に順序対応 */
export const SMALL_FROM = "ァィゥェォッャュョヮ";
export const SMALL_TO = "アイウエオツヤユヨワ";

/** 長音記号の揺れ（半角ｰ・ハイフン・マイナス・ダッシュ・波ダッシュ）→ ー */
export const DASH_FROM = "ｰ-−—–〜～~";
export const DASH_TO = "ーーーーーーーー";

/**
 * 盤面に入れてよい 71 文字。清音 44（ヲ除く）+ ン + 濁音 20 + 半濁音 5 + ー。
 * ヴ・ヰ・ヱ・ヲ・小書き仮名は使わない（語彙バンクの lint で弾く）。
 */
export const GRID_KANA =
  "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン" +
  "ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポー";

export const GRID_KANA_SET: ReadonlySet<string> = new Set(GRID_KANA);

function translate(s: string, from: string, to: string): string {
  let out = "";
  for (const ch of s) {
    const i = from.indexOf(ch);
    out += i >= 0 ? to[i]! : ch;
  }
  return out;
}

/**
 * 入力（IME のひらがな・半角カナ・小書き・長音の揺れ）をクロスワード表記のカタカナに正規化する。
 * 冪等（normalizeKana(normalizeKana(x)) === normalizeKana(x)）。
 */
export function normalizeKana(s: string): string {
  let t = s.normalize("NFKC").normalize("NFC");
  // ひらがな（ぁ U+3041 〜 ゖ U+3096）→ カタカナ（+0x60）
  t = t.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  t = translate(t, SMALL_FROM, SMALL_TO);
  t = translate(t, DASH_FROM, DASH_TO);
  return t;
}

export function isGridKana(ch: string): boolean {
  return GRID_KANA_SET.has(ch);
}

/** 正規化済み文字列が盤面に入れられる文字だけで構成されているか */
export function isGridWord(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) if (!GRID_KANA_SET.has(ch)) return false;
  return true;
}

/** カタカナ → ひらがな（カギに答えの読みが漏れていないかの検査用。ー はそのまま） */
export function toHiragana(kana: string): string {
  return kana.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** 盤面の文字数（コードポイント数。サロゲートペアは使わないが念のため） */
export function kanaLength(s: string): number {
  return Array.from(s).length;
}
