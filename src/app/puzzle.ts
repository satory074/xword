// 盤面ページ（今日 / ?d=YYYY-MM-DD）。盤面・カギ・入力・答え合わせ・ヒント・完了表示。
// 解答はサーバーにしかない。答え合わせは api.checkGrid、ヒントは api.revealCell（カーソルのマス 1 文字だけ。語を丸ごと見せると想起が消える）。
import { fmtDateJa, fmtDuration, isDateKey } from "../lib/date";
import { errorKey } from "../lib/errors";
import { BLACK, CELLS, cellIndex, deriveSlots, EMPTY, SIZE, type Dir, type Slot } from "../lib/grid";
import { isGridKana, normalizeKana } from "../lib/kana";
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
import { actionFromEvent, keyboardHtml, toggleDakuten, toggleHandakuten, type KeyAction } from "./keyboard";
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

class PlayView {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private hidden!: HTMLInputElement;

  constructor(
    private root: HTMLElement,
    private s: State,
    private deps: AppDeps,
  ) {}

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
            <div class="xw-grid" role="grid" aria-label="クロスワード盤面" data-role="grid"></div>
            <div class="current-clue" data-role="current-clue"></div>
            <input class="hidden-input" data-role="hidden" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="カナ入力" inputmode="none" />
            <div data-role="keyboard">${keyboardHtml()}</div>
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
    this.renderGrid();
    this.renderClueState();
    if (s.solved) this.renderSolved();
    else this.startTimer();
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
      const num = numAt.get(i);
      html += `<div class="${cls.join(" ")}" role="gridcell" data-cell="${i}" aria-label="${num ? `${num} ` : ""}${ch === EMPTY ? "空" : ch}">
        ${num ? `<span class="xw-num">${num}</span>` : ""}<span class="xw-ch">${ch === EMPTY ? "" : esc(ch)}</span></div>`;
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
  }

  // ---- 入力 ----

  private bind(): void {
    const root = this.root;
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
        this.onKey(key);
        this.focusHidden();
        return;
      }
      const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "check") void this.check();
      if (action === "reveal") void this.reveal();
      if (action === "clear") this.clearAll();
      if (action === "share") void this.share();
    });

    // 物理キーボード（IME 含む）: 隠し input に入った文字を順に盤面へ
    this.hidden.addEventListener("input", () => {
      if ((this.hidden as HTMLInputElement & { isComposing?: boolean }).isComposing) return;
      this.consumeHidden();
    });
    this.hidden.addEventListener("compositionend", () => this.consumeHidden());
    this.hidden.addEventListener("keydown", (ev) => {
      if (ev.isComposing) return;
      const map: Record<string, KeyAction> = {
        Backspace: { type: "delete" },
        ArrowLeft: { type: "prev" },
        ArrowRight: { type: "next" },
        ArrowUp: { type: "prev" },
        ArrowDown: { type: "next" },
        " ": { type: "toggleDir" },
      };
      const a = map[ev.key];
      if (a) {
        ev.preventDefault();
        this.onKey(a);
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        this.nextSlot(ev.shiftKey ? -1 : 1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        void this.check();
      }
    });
  }

  private consumeHidden(): void {
    const text = normalizeKana(this.hidden.value);
    this.hidden.value = "";
    for (const ch of text) if (isGridKana(ch)) this.onKey({ type: "char", ch });
  }

  private focusHidden(): void {
    // モバイルでは画面内キーボードを使う（inputmode=none で OS キーボードを出さない）
    this.hidden.focus({ preventScroll: true });
  }

  private onCellTap(i: number): void {
    if (this.s.cells[i] === BLACK) return;
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
        if (s.revealed.has(s.cursor)) {
          this.move(1);
          break;
        }
        this.setCell(s.cursor, a.ch);
        this.move(1);
        break;
      }
      case "dakuten":
      case "handakuten": {
        const ch = s.cells[s.cursor]!;
        if (ch === EMPTY || s.revealed.has(s.cursor)) break;
        this.setCell(s.cursor, a.type === "dakuten" ? toggleDakuten(ch) : toggleHandakuten(ch));
        break;
      }
      case "delete": {
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
        this.move(-1);
        break;
      case "next":
        this.move(1);
        break;
      case "toggleDir":
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
  }

  private clearAll(): void {
    const s = this.s;
    if (s.solved) return;
    for (let i = 0; i < CELLS; i++) if (s.cells[i] !== BLACK && !s.revealed.has(i)) s.cells[i] = EMPTY;
    s.mask = null;
    this.saveProgress();
    this.refresh();
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
