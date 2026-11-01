// 共通ヘッダー: ブランド・ナビ・ログイン状態。mountHeader はセッションを返す。
import type { AppDeps, SessionInfo } from "../lib/types";
import { esc, link } from "./ui";

export type PageKey = "today" | "archive" | "mypage";

const NAV: { key: PageKey; label: string; path: string }[] = [
  { key: "today", label: "今日の問題", path: "" },
  { key: "archive", label: "過去の問題", path: "archive" },
  { key: "mypage", label: "マイページ", path: "mypage" },
];

export async function mountHeader(el: HTMLElement, deps: AppDeps, active: PageKey): Promise<SessionInfo | null> {
  const session = await deps.auth.getSession();
  const nav = NAV.map(
    (n) => `<a href="${link(n.path)}"${n.key === active ? ' class="is-active"' : ""}>${n.label}</a>`,
  ).join("");
  const user = session
    ? `${session.avatarUrl ? `<img class="avatar" src="${esc(session.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : ""}
       <button class="btn btn-sm" data-action="signout" title="${esc(session.displayName)}">ログアウト</button>`
    : `<button class="btn btn-primary btn-sm" data-action="signin">Google でログイン</button>`;

  el.innerHTML = `
    <div class="header-inner">
      <a class="brand" href="${link("")}">x<span class="brand-accent">word</span></a>
      <nav class="header-nav">${nav}</nav>
      <div class="header-user">${user}</div>
    </div>`;

  el.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!t) return;
    ev.preventDefault();
    if (t.dataset.action === "signin") void deps.auth.signIn();
    if (t.dataset.action === "signout") void deps.auth.signOut();
  });
  return session;
}
