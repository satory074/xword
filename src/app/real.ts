// ページの .astro <script> から呼ぶエントリポイント。
// 実 Supabase 依存を組み立てて boot に渡す（domtest はここを使わずフェイクを注入する）。
import type { AppDeps } from "../lib/types";
import { realApi } from "./api";
import { cleanupOAuthParams, realAuth } from "./auth";
import { errorMessage, localKV, renderErrorPanel } from "./ui";

export type BootFn = (root: HTMLElement, header: HTMLElement, deps: AppDeps) => void | Promise<void>;

export function start(boot: BootFn): void {
  const root = document.getElementById("app")!;
  const header = document.getElementById("site-header")!;
  try {
    cleanupOAuthParams();
    const deps: AppDeps = { api: realApi(), auth: realAuth(), storage: localKV(), now: () => Date.now() };
    void Promise.resolve(boot(root, header, deps)).catch((e) => {
      renderErrorPanel(root, errorMessage(e));
    });
  } catch (e) {
    renderErrorPanel(root, errorMessage(e));
  }
}
