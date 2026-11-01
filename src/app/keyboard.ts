// 画面内の 50 音キーボード。清音 + ン + ー、濁点/半濁点トグル、削除、移動。
// 物理キーボード（IME）の入力は puzzle.ts の隠し input が受ける。
export type KeyAction =
  | { type: "char"; ch: string }
  | { type: "dakuten" }
  | { type: "handakuten" }
  | { type: "delete" }
  | { type: "prev" }
  | { type: "next" }
  | { type: "toggleDir" };

const ROWS: string[][] = [
  ["ア", "カ", "サ", "タ", "ナ", "ハ", "マ", "ヤ", "ラ", "ワ"],
  ["イ", "キ", "シ", "チ", "ニ", "ヒ", "ミ", "", "リ", "ン"],
  ["ウ", "ク", "ス", "ツ", "ヌ", "フ", "ム", "ユ", "ル", "ー"],
  ["エ", "ケ", "セ", "テ", "ネ", "ヘ", "メ", "", "レ", "゛"],
  ["オ", "コ", "ソ", "ト", "ノ", "ホ", "モ", "ヨ", "ロ", "゜"],
];

const DAKUTEN_FROM = "カキクケコサシスセソタチツテトハヒフヘホ";
const DAKUTEN_TO = "ガギグゲゴザジズゼゾダヂヅデドバビブベボ";
const HANDAKUTEN_FROM = "ハヒフヘホ";
const HANDAKUTEN_TO = "パピプペポ";

/** 濁点トグル（カ→ガ→カ）。対象外ならそのまま */
export function toggleDakuten(ch: string): string {
  let i = DAKUTEN_FROM.indexOf(ch);
  if (i >= 0) return DAKUTEN_TO[i]!;
  i = DAKUTEN_TO.indexOf(ch);
  if (i >= 0) return DAKUTEN_FROM[i]!;
  i = HANDAKUTEN_TO.indexOf(ch);
  if (i >= 0) return DAKUTEN_TO[DAKUTEN_FROM.indexOf(HANDAKUTEN_FROM[i]!)]!;
  return ch;
}

/** 半濁点トグル（ハ→パ→ハ）。対象外ならそのまま */
export function toggleHandakuten(ch: string): string {
  let i = HANDAKUTEN_FROM.indexOf(ch);
  if (i >= 0) return HANDAKUTEN_TO[i]!;
  i = HANDAKUTEN_TO.indexOf(ch);
  if (i >= 0) return HANDAKUTEN_FROM[i]!;
  i = DAKUTEN_TO.indexOf(ch);
  if (i >= 0 && i >= 15) return HANDAKUTEN_TO[i - 15]!; // バ行 → パ行
  return ch;
}

export function keyboardHtml(): string {
  const rows = ROWS.map((row) => {
    const keys = row
      .map((k) => {
        if (k === "") return `<span class="kb-gap"></span>`;
        if (k === "゛") return `<button type="button" class="kb-key kb-mod" data-key="dakuten">゛</button>`;
        if (k === "゜") return `<button type="button" class="kb-key kb-mod" data-key="handakuten">゜</button>`;
        return `<button type="button" class="kb-key" data-key="char" data-ch="${k}">${k}</button>`;
      })
      .join("");
    return `<div class="kb-row">${keys}</div>`;
  });
  rows.push(
    `<div class="kb-row kb-ctrl">
      <button type="button" class="kb-key kb-wide" data-key="prev" aria-label="前のマス">◀</button>
      <button type="button" class="kb-key kb-wide" data-key="toggleDir" aria-label="方向を切り替え">ヨコ/タテ</button>
      <button type="button" class="kb-key kb-wide" data-key="next" aria-label="次のマス">▶</button>
      <button type="button" class="kb-key kb-wide kb-del" data-key="delete" aria-label="削除">⌫</button>
    </div>`,
  );
  return `<div class="kb" role="group" aria-label="カナ入力">${rows.join("")}</div>`;
}

/** クリックイベント → KeyAction（キーボード以外なら null） */
export function actionFromEvent(ev: Event): KeyAction | null {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (!t) return null;
  switch (t.dataset.key) {
    case "char":
      return { type: "char", ch: t.dataset.ch! };
    case "dakuten":
      return { type: "dakuten" };
    case "handakuten":
      return { type: "handakuten" };
    case "delete":
      return { type: "delete" };
    case "prev":
      return { type: "prev" };
    case "next":
      return { type: "next" };
    case "toggleDir":
      return { type: "toggleDir" };
    default:
      return null;
  }
}
