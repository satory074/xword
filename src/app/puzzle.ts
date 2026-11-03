// 盤面ページ（今日 / ?d=YYYY-MM-DD）。盤面・カギ・入力・答え合わせ・ヒント・完了表示。
// 解答はサーバーにしかない。答え合わせは api.checkGrid、ヒントは api.revealCell（カーソルのマス 1 文字だけ。語を丸ごと見せると想起が消える）。
import { fmtDateJa, fmtDuration, isDateKey } from "../lib/date";
import { errorKey } from "../lib/errors";
import { BLACK, CELLS, cellIndex, deriveSlots, EMPTY, SIZE, type Dir, type Slot } from "../lib/grid";
import { isGridKana } from "../lib/kana";
import { feedText, flushRomaji, romajiToKana } from "../lib/romaji";
import { shareText } from "../lib/share";
import { computeStats } from "../lib/stats";
import {
  betterSolve,
  clearProgress,
  readProgress,
  readResults,
  writeProgress,
  writeResult,
  type Progress,
} from "../lib/storage";
import type { AppDeps, LocalResult, PublicPuzzle, SessionInfo } from "../lib/types";
import { mountHeader } from "./header";
import {
  actionFromEvent,
  keyboardHtml,
  readKbMode,
  toggleDakuten,
  toggleHandakuten,
  writeKbMode,
  type KbMode,
  type KeyAction,
} from "./keyboard";
import { syncWithServer } from "./sync";
import { BASE, errorMessage, esc, link, showToast } from "./ui";

interface PlaySlot extends Slot {
  clue: string;
}

interface State {
  date: string;
  isToday: boolean;
  puzzle: PublicPuzzle;
  slots: PlaySlot[];
  cells: string[];
  /** 直近の答え合わせの正誤（'1' '0' '_' '#'）。入力で該当マスはクリアされる */
  mask: string[] | null;
  revealed: Set<number>;
  cursor: number;
  dir: Dir;
  elapsedSec: number;
  checks: number;
  reveals: number;
  solved: boolean;
  solvedAt: string | null;
  session: SessionInfo | null;
}

export async function boot(root: HTMLElement, header: HTMLElement, deps: AppDeps): Promise<void> {
  const session = await mountHeader(header, deps, "today");
  if (session) {
    try {
      await syncWithServer(deps, session);
    } catch (e) {
      showToast(`記録の同期に失敗しました: ${errorMessage(e)}`, true);
    }
  }

  const param = new URLSearchParams(window.location.search).get("d");
  const requested = param && isDateKey(param) ? param : null;
  root.innerHTML = `<p class="muted">読み込み中…</p>`;
  const res = await deps.api.getPuzzle(requested);
  if (!res.puzzle) {
    root.innerHTML = `<div class="card pad"><p>${esc(fmtDateJa(res.date))}の問題は${requested ? "ありません" : "準備中です"}。</p>
      <p class="muted"><a href="${link("archive")}">過去の問題</a>から選べます。</p></div>`;
    return;
  }
  const state = initState(res.date, requested === null, res.puzzle, session, deps);
  const view = new PlayView(root, state, deps);
  view.render();
  if (state.isToday) watchForNewPuzzle(deps, state.date);
}

function initState(date: string, isToday: boolean, puzzle: PublicPuzzle, session: SessionInfo | null, deps: AppDeps): State {
  const slots: PlaySlot[] = deriveSlots(puzzle.grid).map((s) => ({
    ...s,
    clue: puzzle.slots.find((p) => p.id === s.id)?.clue ?? "",
  }));
  const blank: string[] = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) blank.push(puzzle.grid[r]![c] === BLACK ? BLACK : EMPTY);

  const state: State = {
    date,
    isToday,
    puzzle,
    slots,
    cells: blank,
    mask: null,
    revealed: new Set(),
    cursor: slots[0]!.cells[0]!,
    dir: "A",
    elapsedSec: 0,
    checks: 0,
    reveals: 0,
    solved: false,
    solvedAt: null,
    session,
  };

  // 完答済み（ローカル or 同期済みサーバー記録）ならその状態を復元
  const result = readResults(deps.storage)[date];
  if (result?.solved && result.cells.length === CELLS) {
    state.cells = Array.from(result.cells);
    state.solved = true;
    state.solvedAt = result.solvedAt;
    state.checks = result.checks;
    state.reveals = result.reveals;
    state.elapsedSec = result.durationSec;
    state.mask = state.cells.map((ch) => (ch === BLACK ? BLACK : "1"));
    return state;
  }
  const progress = readProgress(deps.storage, date);
  if (progress && progress.cells.length === CELLS) {
    const saved = Array.from(progress.cells);
    if (saved.every((ch, i) => (ch === BLACK) === (blank[i] === BLACK))) {
      state.cells = saved;
      state.elapsedSec = progress.elapsedSec;
      state.checks = progress.checks;
      state.reveals = progress.reveals;
      state.revealed = new Set(progress.revealed);
    }
  } else if (result && result.cells.length === CELLS) {
    // 未完答の記録（別端末から同期）を途中状態として引き継ぐ
    state.cells = Array.from(result.cells);
    state.checks = result.checks;
    state.reveals = result.reveals;
    state.elapsedSec = result.durationSec;
  }
  return state;
}

/** 日付が変わっていたら知らせる（JST 0:00 の切り替わりをサーバーに聞く） */
function watchForNewPuzzle(deps: AppDeps, currentDate: string): void {
  let checking = false;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || checking) return;
    checking = true;
    deps.api
      .getPuzzle(null)
      .then((r) => {
        if (r.date !== currentDate && r.puzzle && !document.querySelector(".new-puzzle-banner")) {
          const b = document.createElement("div");
          b.className = "new-puzzle-banner";
          b.innerHTML = `新しい問題（${esc(fmtDateJa(r.date))}）があります。<a href="${link("")}">開く</a>`;
          document.getElementById("app")?.prepend(b);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  });
}

/** マウス等の精密ポインタがある端末（≒ PC）。jsdom は matchMedia が無いので false */
function finePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

interface Placement {
  writes: { cell: number; ch: string }[];
  cursor: number;
}

/**
 * text をカーソルから語の末尾へ順に置く計画。IME の確定・画面キーボード・変換中プレビューで共通。
 * 開示済み（ヒント）のマスは 1 文字消費して通過し、書かない。語の末尾で打ち切り、余りは捨てる。
 * カーソルは最後に訪れたマスの次（無ければ語の最後のマス。折り返さない）。
 */
function planPlacement(slot: Slot | undefined, from: number, text: string[], revealed: Set<number>): Placement {
  if (text.length === 0) return { writes: [], cursor: from };
  const pos0 = slot ? slot.cells.indexOf(from) : -1;
  if (!slot || pos0 < 0) return { writes: revealed.has(from) ? [] : [{ cell: from, ch: text[0]! }], cursor: from };
  const writes: Placement["writes"] = [];
  let pos = pos0;
  for (let k = 0; k < text.length && pos < slot.cells.length; k++, pos++) {
    const cell = slot.cells[pos]!;
    if (!revealed.has(cell)) writes.push({ cell, ch: text[k]! });
  }
  return { writes, cursor: slot.cells[Math.min(pos, slot.cells.length - 1)]! };
}

class PlayView {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private hidden!: HTMLInputElement;
  // ---- 入力の一時状態（State には入れず、保存もしない）----
  /** IME 変換中（compositionstart〜compositionend） */
  private composing = false;
  /** 変換中の文字列（正規化済み）。マスに薄く描くだけで state には書かない */
  private preview = "";
  /** 未確定のローマ字（"k" "ky" "n"、"N" = nn の 2 つ目）。romaji.ts の約束どおり */
  private romaji = "";
  /** consumeHidden の再入ガード（Firefox は value 代入中に同期で compositionend を投げる） */
  private consuming = false;
  /** 直前に文字を書いたマス。゛゜はカーソルではなくここに掛ける（打った直後はカーソルが進んでいる） */
  private lastTyped: number | null = null;
  private kbMode: KbMode;

  constructor(
    private root: HTMLElement,
    private s: State,
    private deps: AppDeps,
  ) {
    // 既定は端末のキーボード（PC は物理キー、スマホは OS キーボード）。50 音パネルは切替で出す
    this.kbMode = readKbMode(deps.storage) ?? "device";
  }

  // ---- 描画 ----

  render(): void {
    const s = this.s;
    this.root.innerHTML = `
      <div class="play">
        <div class="play-head">
          <h1 class="play-title">${esc(fmtDateJa(s.date))}の問題</h1>
          <div class="play-meta"><span class="timer tnum" data-role="timer">${fmtDuration(s.elapsedSec)}</span></div>
        </div>
        <div class="play-main">
          <div class="play-left">
            <div class="xw-grid-wrap">
              <div class="xw-grid" role="grid" aria-label="クロスワード盤面" data-role="grid"></div>
              <input class="hidden-input" data-role="hidden" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="カナ入力" inputmode="${this.kbMode === "screen" ? "none" : "text"}" />
            </div>
            <div class="current-clue" data-role="current-clue"></div>
            <div data-role="keyboard">${keyboardHtml(this.kbMode)}</div>
            <div class="play-actions">
              <button class="btn btn-primary" data-action="check">答え合わせ</button>
              <button class="btn" data-action="reveal">ヒント（このマスの 1 文字）</button>
              <button class="btn btn-ghost" data-action="clear">入力を消す</button>
            </div>
            <div data-role="result"></div>
          </div>
          <div class="play-right">
            <section class="clues">
              <h2>ヨコのカギ</h2>
              <ol data-role="clues-A">${this.cluesHtml("A")}</ol>
              <h2>タテのカギ</h2>
              <ol data-role="clues-D">${this.cluesHtml("D")}</ol>
            </section>
          </div>
        </div>
      </div>`;
    this.hidden = this.root.querySelector<HTMLInputElement>('[data-role="hidden"]')!;
    this.bind();
    this.refresh();
    if (s.solved) this.renderSolved();
    else {
      this.startTimer();
      // PC はすぐ打てるように。スマホは勝手に OS キーボードを出さない（マスのタップで出す）
      if (finePointer()) this.focusHidden();
    }
  }

  private cluesHtml(dir: Dir): string {
    return this.s.slots
      .filter((x) => x.dir === dir)
      .map((x) => `<li data-slot="${x.id}"><span class="clue-num">${x.num}</span><span class="clue-text">${esc(x.clue)}</span><span class="clue-len">(${x.len})</span></li>`)
      .join("");
  }

  private renderGrid(): void {
    const s = this.s;
    const grid = this.root.querySelector<HTMLElement>('[data-role="grid"]')!;
    const numAt = new Map<number, number>();
    for (const sl of s.slots) numAt.set(cellIndex(sl.r, sl.c), sl.num);
    const word = new Set(this.currentSlot()?.cells ?? []);
    // 変換中の文字列・未確定ローマ字を薄く重ねる（state には書かない）
    const overlay = new Map<number, string>();
    if (this.preview) {
      for (const w of planPlacement(this.currentSlot(), s.cursor, Array.from(this.preview).filter(isGridKana), s.revealed).writes) overlay.set(w.cell, w.ch);
    } else if (this.romaji && this.romaji !== "N" && !s.revealed.has(s.cursor)) {
      overlay.set(s.cursor, this.romaji);
    }
    let html = "";
    for (let i = 0; i < CELLS; i++) {
      const ch = s.cells[i]!;
      if (ch === BLACK) {
        html += `<div class="xw-cell is-black" role="gridcell" aria-hidden="true"></div>`;
        continue;
      }
      const cls = ["xw-cell"];
      if (i === s.cursor) cls.push("is-cursor");
      if (word.has(i)) cls.push("is-word");
      if (s.mask && s.mask[i] === "0") cls.push("is-wrong");
      if (s.solved) cls.push("is-solved");
      if (s.revealed.has(i)) cls.push("is-revealed");
      const ov = overlay.get(i);
      if (ov !== undefined) cls.push("is-preview");
      const shown = ov ?? (ch === EMPTY ? "" : ch);
      const num = numAt.get(i);
      html += `<div class="${cls.join(" ")}" role="gridcell" data-cell="${i}" aria-label="${num ? `${num} ` : ""}${ch === EMPTY ? "空" : ch}">
        ${num ? `<span class="xw-num">${num}</span>` : ""}<span class="xw-ch">${esc(shown)}</span></div>`;
    }
    grid.innerHTML = html;
  }

  private renderClueState(): void {
    const cur = this.currentSlot();
    for (const li of this.root.querySelectorAll<HTMLElement>("[data-slot]")) {
      li.classList.toggle("is-active", li.dataset.slot === cur?.id);
      const slot = this.s.slots.find((x) => x.id === li.dataset.slot)!;
      li.classList.toggle("is-filled", slot.cells.every((c) => this.s.cells[c] !== EMPTY));
    }
    const bar = this.root.querySelector<HTMLElement>('[data-role="current-clue"]')!;
    bar.innerHTML = cur
      ? `<span class="clue-dir">${cur.dir === "A" ? "ヨコ" : "タテ"} ${cur.num}</span> ${esc(cur.clue)} <span class="clue-len">(${cur.len})</span>`
      : "";
    const active = this.root.querySelector<HTMLElement>(`[data-slot="${cur?.id}"]`);
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
  }

  private renderSolved(): void {
    const s = this.s;
    this.stopTimer();
    const stats = computeStats(
      Object.entries(readResults(this.deps.storage)).map(([date, r]) => ({ date, solved: r.solved, reveals: r.reveals })),
      s.date,
    );
    const box = this.root.querySelector<HTMLElement>('[data-role="result"]')!;
    box.innerHTML = `<div class="card pad solved-panel">
      <h2>完成！ 🎉</h2>
      <p class="tnum">タイム ${fmtDuration(s.elapsedSec)} ／ 答え合わせ ${s.checks} 回${s.reveals ? ` ／ ヒント ${s.reveals} 文字` : ""}</p>
      <p class="muted">${stats.currentStreak > 1 ? `🔥 ${stats.currentStreak} 日連続` : "明日も挑戦しよう"}${s.session ? "" : "　※ログインすると記録が端末をまたいで保存されます"}</p>
      <div class="play-actions">
        <button class="btn btn-primary" data-action="share">結果をコピー</button>
        <a class="btn" href="${link("archive")}">過去の問題へ</a>
      </div></div>`;
    this.root.querySelector<HTMLElement>('[data-role="keyboard"]')!.style.display = "none";
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-action="check"],[data-action="reveal"],[data-action="clear"]')) b.disabled = true;
    this.hidden.blur(); // 完成したら OS キーボードを閉じる
  }

  // ---- 入力 ----

  private bind(): void {
    const root = this.root;
    // 盤面・キー・カギ・ボタンのタップで隠し input からフォーカスを奪わない（click はこの後も発火する）。
    // これが無いとスマホはタップのたびに OS キーボードが閉じ、変換も途切れる
    root.addEventListener("pointerdown", (ev) => {
      if ((ev.target as HTMLElement).closest("[data-cell],[data-key],[data-slot],[data-action]")) ev.preventDefault();
    });
    root.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      const cell = target.closest<HTMLElement>("[data-cell]");
      if (cell) {
        this.onCellTap(Number(cell.dataset.cell));
        return;
      }
      const li = target.closest<HTMLElement>("[data-slot]");
      if (li) {
        this.selectSlot(li.dataset.slot!);
        return;
      }
      const key = actionFromEvent(ev);
      if (key) {
        ev.preventDefault();
        this.flushPendingRomaji();
        this.onKey(key);
        this.focusHidden();
        return;
      }
      const btn = target.closest<HTMLElement>("[data-action]");
      const action = btn?.dataset.action;
      if (action === "kb-mode") this.setKbMode(btn!.dataset.mode === "screen" ? "screen" : "device");
      if (action === "check") void this.check();
      if (action === "reveal") void this.reveal();
      if (action === "clear") this.clearAll();
      if (action === "share") void this.share();
    });

    // 物理キーボード・OS キーボード（IME 含む）: 隠し input の value が唯一の真実。読んだら必ず空にするので、
    // input と compositionend の発火順がブラウザで違っても（Chrome: input→compositionend、Firefox/Safari: 逆）
    // 後から来た方は "" を読んで何もしない。変換中の input だけは無視する
    this.hidden.addEventListener("compositionstart", () => {
      this.composing = true;
      this.preview = "";
    });
    this.hidden.addEventListener("compositionupdate", (ev) => {
      this.preview = romajiToKana(ev.data ?? "");
      this.renderGrid();
    });
    this.hidden.addEventListener("input", (ev) => {
      if ((ev as InputEvent).isComposing || this.composing) return;
      this.consumeHidden(false);
    });
    this.hidden.addEventListener("compositionend", () => {
      this.composing = false;
      this.preview = "";
      this.consumeHidden(true);
    });
    this.hidden.addEventListener("blur", () => {
      // 末尾の n を確定し、compositionend を出さない Android IME の値も拾う
      this.composing = false;
      this.preview = "";
      this.consumeHidden(true);
    });
    this.hidden.addEventListener("keydown", (ev) => {
      // 229 = Chrome/Edge が IME 処理中に出す "Process"
      if (ev.isComposing || ev.keyCode === 229 || this.composing) return;
      if (ev.key === "Backspace") {
        ev.preventDefault();
        if (this.romaji && this.romaji !== "N") this.popRomaji();
        else {
          this.romaji = "";
          this.onKey({ type: "delete" });
        }
        return;
      }
      const map: Record<string, KeyAction> = {
        Delete: { type: "delete" },
        ArrowLeft: { type: "prev" },
        ArrowRight: { type: "next" },
        ArrowUp: { type: "prev" },
        ArrowDown: { type: "next" },
        " ": { type: "toggleDir" },
      };
      const a = map[ev.key];
      if (a) {
        ev.preventDefault();
        this.flushPendingRomaji();
        this.onKey(a);
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        this.flushPendingRomaji();
        this.nextSlot(ev.shiftKey ? -1 : 1);
      } else if (ev.key === "Enter") {
        // Enter は IME の確定キー（Safari は確定の Enter を compositionend の後に isComposing=false で届ける）。
        // 単独では答え合わせしない。Ctrl/⌘+Enter だけ答え合わせ
        ev.preventDefault();
        this.flushPendingRomaji();
        this.refresh();
        if (ev.ctrlKey || ev.metaKey) void this.check();
      }
      // それ以外（文字キー）は preventDefault しない → input イベントで受ける
    });
  }

  /** 隠し input の値を盤面へ。wordEnd なら未確定ローマ字も確定する */
  private consumeHidden(wordEnd: boolean): void {
    if (this.consuming) return;
    this.consuming = true;
    try {
      const raw = this.hidden.value;
      if (raw) this.hidden.value = "";
      const r = feedText(this.romaji, raw);
      this.romaji = wordEnd ? "" : r.buf;
      this.typeText(r.out + (wordEnd ? flushRomaji(r.buf) : ""));
      this.refresh();
    } finally {
      this.consuming = false;
    }
  }

  /** 文字列をカーソルから語に沿って書く（盤面に入れられる文字だけ）。IME 確定・画面キーボードの共通経路 */
  private typeText(text: string): void {
    const s = this.s;
    if (s.solved) return;
    const chars = Array.from(text).filter(isGridKana);
    if (chars.length === 0) return;
    const p = planPlacement(this.currentSlot(), s.cursor, chars, s.revealed);
    for (const w of p.writes) {
      s.cells[w.cell] = w.ch;
      if (s.mask) s.mask[w.cell] = "_";
    }
    s.cursor = p.cursor;
    this.lastTyped = p.writes.length ? p.writes[p.writes.length - 1]!.cell : null;
    if (p.writes.length) this.saveProgress();
  }

  /** 未確定ローマ字を確定（n → ン、他は捨てる）。カーソル移動・タップ・Enter の前に呼ぶ */
  private flushPendingRomaji(): void {
    const out = flushRomaji(this.romaji);
    this.romaji = "";
    if (out) this.typeText(out);
  }

  private popRomaji(): void {
    this.romaji = this.romaji === "N" ? "" : this.romaji.slice(0, -1);
    this.refresh();
  }

  /** 変換中に別のマス等をタップしたとき: blur でブラウザ自身に確定させる（compositionend → consumeHidden）。呼び出し側が後で focus し直す */
  private commitComposition(): void {
    if (!this.composing) return;
    this.hidden.blur();
    this.composing = false;
    this.preview = "";
  }

  private focusHidden(): void {
    // 端末キーボードのスマホで、既にフォーカスがあるのにキーボードが閉じている（Android の戻るキー等）と
    // focus() だけでは再表示されないので、一度 blur してから focus する
    if (this.kbMode === "device" && !finePointer() && document.activeElement === this.hidden) this.hidden.blur();
    this.hidden.focus({ preventScroll: true });
  }

  /** 隠し input をカーソルのマスに重ねる（IME の候補窓がマスの横に出る。iOS は盤面へスクロールする） */
  private placeHidden(): void {
    const cell = this.root.querySelector<HTMLElement>(`[data-cell="${this.s.cursor}"]`);
    if (!cell) return;
    const st = this.hidden.style;
    st.left = `${cell.offsetLeft}px`;
    st.top = `${cell.offsetTop}px`;
    st.width = `${cell.offsetWidth}px`;
    st.height = `${cell.offsetHeight}px`;
  }

  private setKbMode(mode: KbMode): void {
    if (mode === this.kbMode) return;
    this.commitComposition();
    this.flushPendingRomaji();
    this.kbMode = mode;
    writeKbMode(this.deps.storage, mode);
    this.root.querySelector<HTMLElement>('[data-role="keyboard"]')!.innerHTML = keyboardHtml(mode);
    // inputmode の変更はクリックのジェスチャ内で blur → focus しないと iOS が反映しない
    this.hidden.setAttribute("inputmode", mode === "screen" ? "none" : "text");
    this.hidden.blur();
    this.refresh();
    this.focusHidden();
  }

  private onCellTap(i: number): void {
    if (this.s.cells[i] === BLACK) return;
    this.commitComposition();
    this.flushPendingRomaji();
    this.lastTyped = null;
    if (i === this.s.cursor) {
      this.toggleDir();
    } else {
      this.s.cursor = i;
      if (!this.currentSlot()) this.s.dir = this.s.dir === "A" ? "D" : "A";
    }
    this.refresh();
    this.focusHidden();
  }

  private selectSlot(id: string): void {
    const slot = this.s.slots.find((x) => x.id === id);
    if (!slot) return;
    this.commitComposition();
    this.flushPendingRomaji();
    this.lastTyped = null;
    this.s.dir = slot.dir;
    this.s.cursor = slot.cells.find((c) => this.s.cells[c] === EMPTY) ?? slot.cells[0]!;
    this.refresh();
    this.focusHidden();
  }

  private currentSlot(): PlaySlot | undefined {
    return this.s.slots.find((x) => x.dir === this.s.dir && x.cells.includes(this.s.cursor));
  }

  private toggleDir(): void {
    const other: Dir = this.s.dir === "A" ? "D" : "A";
    if (this.s.slots.some((x) => x.dir === other && x.cells.includes(this.s.cursor))) this.s.dir = other;
  }

  private nextSlot(step: 1 | -1): void {
    const ordered = [...this.s.slots.filter((x) => x.dir === "A"), ...this.s.slots.filter((x) => x.dir === "D")];
    const cur = this.currentSlot();
    const idx = cur ? ordered.findIndex((x) => x.id === cur.id) : -1;
    const next = ordered[(idx + step + ordered.length) % ordered.length]!;
    this.selectSlot(next.id);
  }

  private onKey(a: KeyAction): void {
    const s = this.s;
    if (s.solved) return;
    const slot = this.currentSlot();
    switch (a.type) {
      case "char": {
        this.typeText(a.ch);
        break;
      }
      case "dakuten":
      case "handakuten": {
        // 打った直後はカーソルが次のマスに進んでいるので、直前に書いたマスに掛ける（カ → ゛ → ガ）
        const target = this.lastTyped ?? s.cursor;
        const ch = s.cells[target]!;
        if (ch === EMPTY || ch === BLACK || s.revealed.has(target)) break;
        this.setCell(target, a.type === "dakuten" ? toggleDakuten(ch) : toggleHandakuten(ch));
        break;
      }
      case "delete": {
        this.lastTyped = null;
        if (s.cells[s.cursor] !== EMPTY && !s.revealed.has(s.cursor)) {
          this.setCell(s.cursor, EMPTY);
        } else if (slot) {
          const pos = slot.cells.indexOf(s.cursor);
          if (pos > 0) {
            s.cursor = slot.cells[pos - 1]!;
            if (!s.revealed.has(s.cursor)) this.setCell(s.cursor, EMPTY);
          }
        }
        break;
      }
      case "prev":
        this.lastTyped = null;
        this.move(-1);
        break;
      case "next":
        this.lastTyped = null;
        this.move(1);
        break;
      case "toggleDir":
        this.lastTyped = null;
        this.toggleDir();
        break;
    }
    this.refresh();
  }

  private setCell(i: number, ch: string): void {
    this.s.cells[i] = ch;
    if (this.s.mask) this.s.mask[i] = "_";
    this.saveProgress();
  }

  private move(step: 1 | -1): void {
    const slot = this.currentSlot();
    if (!slot) return;
    const pos = slot.cells.indexOf(this.s.cursor);
    const np = pos + step;
    if (np >= 0 && np < slot.cells.length) this.s.cursor = slot.cells[np]!;
  }

  private refresh(): void {
    this.renderGrid();
    this.renderClueState();
    this.placeHidden();
  }

  private clearAll(): void {
    const s = this.s;
    if (s.solved) return;
    for (let i = 0; i < CELLS; i++) if (s.cells[i] !== BLACK && !s.revealed.has(i)) s.cells[i] = EMPTY;
    s.mask = null;
    this.romaji = "";
    this.lastTyped = null;
    this.saveProgress();
    this.refresh();
    if (finePointer()) this.focusHidden();
  }

  // ---- 永続化・タイマー ----

  private progress(): Progress {
    const s = this.s;
    return { cells: s.cells.join(""), elapsedSec: s.elapsedSec, checks: s.checks, reveals: s.reveals, revealed: [...s.revealed] };
  }

  private saveProgress(): void {
    writeProgress(this.deps.storage, this.s.date, this.progress());
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (document.visibilityState !== "visible" || this.s.solved) return;
      this.s.elapsedSec++;
      const el = this.root.querySelector('[data-role="timer"]');
      if (el) el.textContent = fmtDuration(this.s.elapsedSec);
      if (this.s.elapsedSec % 10 === 0) this.saveProgress();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- サーバー呼び出し ----

  private async check(): Promise<void> {
    const s = this.s;
    if (s.solved || this.busy) return;
    if (!s.cells.some((ch) => ch !== BLACK && ch !== EMPTY)) {
      showToast("まだ何も入力されていません", true);
      return;
    }
    this.busy = true;
    try {
      const r = await this.deps.api.checkGrid(s.date, s.cells.join(""), s.elapsedSec);
      s.mask = Array.from(r.mask);
      s.checks = r.checks ?? s.checks + 1;
      if (r.solved) {
        s.solved = true;
        s.solvedAt = new Date(this.deps.now()).toISOString();
        clearProgress(this.deps.storage, s.date);
      } else {
        this.saveProgress();
        const empty = s.cells.filter((ch) => ch === EMPTY).length;
        showToast(`正解 ${r.correct} / ${r.total} マス${empty ? `（空欄 ${empty}）` : ""}`);
      }
      this.recordResult(r.correct, r.total, r.solved);
      this.refresh();
      if (r.solved) this.renderSolved();
      else if (finePointer()) this.focusHidden();
    } catch (e) {
      const key = errorKey(e);
      showToast(key === "CHECK_LIMIT" ? "答え合わせの回数が上限に達しました" : errorMessage(e), true);
    } finally {
      this.busy = false;
    }
  }

  /** ヒント: カーソルのマス 1 文字だけ開ける（語を丸ごと見せない。残りは交差から推測してもらう） */
  private async reveal(): Promise<void> {
    const s = this.s;
    const slot = this.currentSlot();
    if (s.solved || this.busy || !slot) return;
    const cell = s.cursor;
    if (s.revealed.has(cell)) {
      showToast("このマスはすでに表示されています");
      return;
    }
    this.busy = true;
    try {
      const ch = Array.from(await this.deps.api.revealCell(s.date, cell))[0] ?? EMPTY;
      s.cells[cell] = ch;
      s.revealed.add(cell);
      if (s.mask) s.mask[cell] = "1";
      s.reveals++;
      this.saveProgress();
      this.refresh();
      if (finePointer()) this.focusHidden();
      showToast(`${slot.dir === "A" ? "ヨコ" : "タテ"} ${slot.num} の 1 文字を表示しました`);
    } catch (e) {
      showToast(errorMessage(e), true);
    } finally {
      this.busy = false;
    }
  }

  /** ローカル結果を更新（より良い記録のときだけ置換。ログイン時はサーバーも同時に記録済み） */
  private recordResult(correct: number, total: number, solved: boolean): void {
    const s = this.s;
    const candidate: LocalResult = {
      cells: s.cells.join(""),
      correctCells: correct,
      totalCells: total,
      solved,
      checks: s.checks,
      reveals: s.reveals,
      durationSec: s.elapsedSec,
      solvedAt: solved ? s.solvedAt : null,
      syncedTo: s.session ? [s.session.userId] : [],
    };
    const existing = readResults(this.deps.storage)[s.date];
    if (!existing || betterSolve(candidate, existing) || candidate.cells !== existing.cells) {
      if (existing && !betterSolve(candidate, existing)) {
        // 記録としては劣るが最新の盤面は保持したいので、記録値は既存を優先
        candidate.solved = existing.solved || candidate.solved;
        candidate.syncedTo = existing.syncedTo.length ? existing.syncedTo : candidate.syncedTo;
      }
      writeResult(this.deps.storage, s.date, candidate);
    }
  }

  private async share(): Promise<void> {
    const s = this.s;
    const stats = computeStats(
      Object.entries(readResults(this.deps.storage)).map(([date, r]) => ({ date, solved: r.solved, reveals: r.reveals })),
      s.date,
    );
    const text = shareText({
      date: s.date,
      durationSec: s.elapsedSec,
      checks: s.checks,
      reveals: s.reveals,
      streak: stats.currentStreak,
      url: window.location.origin + BASE,
    });
    try {
      await navigator.clipboard.writeText(text);
      showToast("結果をコピーしました");
    } catch {
      showToast(text);
    }
  }
}
