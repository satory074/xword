// DOM 層の共有ヘルパー。lib（純ロジック）はここから import してよいが逆は禁止。
import type { KV } from "../lib/types";

// Astro ビルド時は import.meta.env.BASE_URL（末尾スラッシュ付き）、tsx/jsdom 実行時は "/"
export const BASE: string =
  (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";

/** 内部リンク（base path 付与）。path は先頭スラッシュなしで渡す */
export function link(path: string): string {
  return BASE.endsWith("/") ? BASE + path : `${BASE}/${path}`;
}

export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function renderErrorPanel(root: HTMLElement, msg: string): void {
  root.innerHTML = `<pre class="error-panel">${esc(msg)}</pre>`;
}

export function showToast(msg: string, isError = false): void {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " toast-error" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/** localStorage の KV 実装。使えない環境（プライベートモード等）では黙ってメモリにフォールバック */
export function localKV(): KV {
  const mem = new Map<string, string>();
  const ok = (): boolean => {
    try {
      return typeof localStorage !== "undefined";
    } catch {
      return false;
    }
  };
  return {
    get(key) {
      try {
        if (ok()) return localStorage.getItem(key);
      } catch {
        /* fall through */
      }
      return mem.get(key) ?? null;
    },
    set(key, value) {
      mem.set(key, value);
      try {
        if (ok()) localStorage.setItem(key, value);
      } catch {
        /* 容量超過・プライベートモードでも動作は続ける */
      }
    },
    remove(key) {
      mem.delete(key);
      try {
        if (ok()) localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
