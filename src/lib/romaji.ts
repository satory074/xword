// ローマ字 → カナ（IME をオフにしたまま英字で打たれたときの変換）。Google IME のローマ字表に準拠し、
// ヘボン式・訓令式の両方を受ける。純 TS（DOM 禁止）。出力はすべて normalizeKana を通すので、
// キャ→キヤ、ッ→ツ、ィ→イ の盤面表記は kana.ts の表に任せる（ここで二重管理しない）。
//
// バッファの約束: 未確定の綴り（"k" "ky" "n" など）を文字列で持ち回る。特別値 "N" は「nn の 2 つ目の n」で、
// 母音か y が続けばナ行として生き返り、子音が続けば捨てる（kanna→カンナ、kannji→カンジ、kann→カン）。
import { normalizeKana } from "./kana";

export interface RomajiStep {
  /** 確定したカナ（空のこともある） */
  out: string;
  /** 持ち越す未確定の綴り */
  buf: string;
}

const BASIC: Record<string, string> = {
  a: "ア", i: "イ", u: "ウ", e: "エ", o: "オ",
  ka: "カ", ki: "キ", ku: "ク", ke: "ケ", ko: "コ",
  sa: "サ", si: "シ", shi: "シ", su: "ス", se: "セ", so: "ソ",
  ta: "タ", ti: "チ", chi: "チ", tu: "ツ", tsu: "ツ", te: "テ", to: "ト",
  na: "ナ", ni: "ニ", nu: "ヌ", ne: "ネ", no: "ノ",
  ha: "ハ", hi: "ヒ", hu: "フ", fu: "フ", he: "ヘ", ho: "ホ",
  ma: "マ", mi: "ミ", mu: "ム", me: "メ", mo: "モ",
  ya: "ヤ", yu: "ユ", yo: "ヨ",
  ra: "ラ", ri: "リ", ru: "ル", re: "レ", ro: "ロ",
  wa: "ワ", wo: "ヲ",
  ga: "ガ", gi: "ギ", gu: "グ", ge: "ゲ", go: "ゴ",
  za: "ザ", zi: "ジ", ji: "ジ", zu: "ズ", ze: "ゼ", zo: "ゾ",
  da: "ダ", di: "ヂ", dji: "ヂ", du: "ヅ", dzu: "ヅ", de: "デ", do: "ド",
  ba: "バ", bi: "ビ", bu: "ブ", be: "ベ", bo: "ボ",
  pa: "パ", pi: "ピ", pu: "プ", pe: "ペ", po: "ポ",
  // 外来音（ヴ・ヲ は盤面に入れない文字なので、呼び出し側の isGridKana で落ちる）
  fa: "ファ", fi: "フィ", fe: "フェ", fo: "フォ",
  wi: "ウィ", we: "ウェ", ye: "イェ",
  she: "シェ", che: "チェ", je: "ジェ",
  thi: "ティ", dhi: "ディ", thu: "テュ", dhu: "デュ", twu: "トゥ", dwu: "ドゥ",
  va: "ヴァ", vi: "ヴィ", vu: "ヴ", ve: "ヴェ", vo: "ヴォ",
};

/** 拗音の頭: 子音 + {a,u,o} → 頭のカナ + ャュョ */
const YOUON: [string, string][] = [
  ["ky", "キ"], ["gy", "ギ"], ["sy", "シ"], ["sh", "シ"], ["zy", "ジ"], ["j", "ジ"], ["jy", "ジ"],
  ["ty", "チ"], ["ch", "チ"], ["cy", "チ"], ["dy", "ヂ"], ["ny", "ニ"], ["hy", "ヒ"], ["by", "ビ"],
  ["py", "ピ"], ["my", "ミ"], ["ry", "リ"], ["fy", "フ"], ["vy", "ヴ"],
];

/** 小書き: x/l + 母音・ya yu yo・tu/tsu・wa */
const SMALL: Record<string, string> = {
  a: "ァ", i: "ィ", u: "ゥ", e: "ェ", o: "ォ", ya: "ャ", yu: "ュ", yo: "ョ", tu: "ッ", tsu: "ッ", wa: "ヮ",
};

const TABLE: Record<string, string> = { ...BASIC };
for (const [head, kana] of YOUON) {
  TABLE[`${head}a`] = `${kana}ャ`;
  TABLE[`${head}u`] = `${kana}ュ`;
  TABLE[`${head}o`] = `${kana}ョ`;
}
for (const [k, v] of Object.entries(SMALL)) {
  TABLE[`x${k}`] = v;
  TABLE[`l${k}`] = v;
}

/** 表の全キーの真の接頭辞（"k" "ky" "sh" …）。これに含まれる綴りだけ未確定として溜める */
const PREFIXES: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const key of Object.keys(TABLE)) for (let i = 1; i < key.length; i++) set.add(key.slice(0, i));
  return set;
})();

const VOWEL_OR_Y = /^[aiueoy]$/;

/** 未確定の綴りを確定する（語の終わり・カーソル移動・blur）。"n" だけはン、他は捨てる */
export function flushRomaji(buf: string): string {
  return buf === "n" ? "ン" : "";
}

/** 1 文字入れる。英字と ' 以外が来たら綴りを確定して空にする */
export function feedRomaji(buf: string, input: string): RomajiStep {
  const ch = input.toLowerCase();
  if (!/^[a-z']$/.test(ch)) return { out: flushRomaji(buf), buf: "" };
  let b = buf;
  if (b === "N") {
    if (ch === "n") return { out: "", buf: "n" }; // nnn: ン + 次の n を保留
    b = VOWEL_OR_Y.test(ch) ? "n" : "";
  }
  if (b === "n") {
    if (ch === "n") return { out: "ン", buf: "N" };
    if (ch === "'") return { out: "ン", buf: "" };
    if (!VOWEL_OR_Y.test(ch)) return { out: "ン", buf: PREFIXES.has(ch) ? ch : "" }; // n + 子音
  }
  const s = b + ch;
  // 促音: 同じ子音の連続（kk, tt, pp …）→ ッ（normalizeKana でツ）。母音と n は除く
  if (s.length >= 2 && s[0] === s[1] && !/^[aiueon]$/.test(s[0]!)) return { out: normalizeKana("ッ"), buf: s.slice(1) };
  if (s === "tc") return { out: normalizeKana("ッ"), buf: "c" }; // tchi → ッチ
  const hit = TABLE[s];
  if (hit !== undefined) return { out: normalizeKana(hit), buf: "" };
  if (PREFIXES.has(s)) return { out: "", buf: s };
  // 行き止まり（"kx" など）: 溜めた綴りは捨てて、今の文字から仕切り直す
  if (ch === "n") return { out: "", buf: "n" };
  return { out: "", buf: PREFIXES.has(ch) ? ch : "" };
}

/**
 * 文字列をまとめて入れる。normalizeKana を通した後、英字と ' はローマ字として、
 * それ以外（カナ・ー など）は綴りを確定してから素通しする。
 */
export function feedText(buf: string, text: string): RomajiStep {
  let out = "";
  let b = buf;
  for (const ch of normalizeKana(text)) {
    if (/^[a-zA-Z']$/.test(ch)) {
      const r = feedRomaji(b, ch);
      out += r.out;
      b = r.buf;
    } else {
      out += flushRomaji(b) + ch;
      b = "";
    }
  }
  return { out, buf: b };
}

/** 文字列を丸ごと変換して確定する（プレビュー・テスト用）。カナはそのまま通る */
export function romajiToKana(text: string): string {
  const r = feedText("", text);
  return r.out + flushRomaji(r.buf);
}
