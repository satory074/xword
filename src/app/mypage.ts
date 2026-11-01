// マイページ: 記録の統計（解いた日数・完答・ヒントなし・連続）とログイン案内。
import { jstDateKey } from "../lib/date";
import { readResults } from "../lib/storage";
import { computeStats } from "../lib/stats";
import type { AppDeps } from "../lib/types";
import { mountHeader } from "./header";
import { syncWithServer } from "./sync";
import { errorMessage, esc, showToast } from "./ui";

export async function boot(root: HTMLElement, header: HTMLElement, deps: AppDeps): Promise<void> {
  const session = await mountHeader(header, deps, "mypage");
  if (session) {
    try {
      await syncWithServer(deps, session);
    } catch (e) {
      showToast(`記録の同期に失敗しました: ${errorMessage(e)}`, true);
    }
  }
  const results = readResults(deps.storage);
  const stats = computeStats(
    Object.entries(results).map(([date, r]) => ({ date, solved: r.solved, reveals: r.reveals })),
    jstDateKey(deps.now()),
  );
  const tile = (label: string, value: number, unit: string) =>
    `<div class="stat-tile"><div class="stat-value tnum">${value}<span class="stat-unit">${unit}</span></div><div class="stat-label">${label}</div></div>`;
  root.innerHTML = `<div class="mypage">
    <h1>マイページ</h1>
    <p class="muted">${session ? `${esc(session.displayName)} さんの記録（サーバーに保存）` : "この端末の記録。<b>Google でログイン</b>すると端末をまたいで保存され、過去の記録も引き継がれます。"}</p>
    <div class="stat-grid">
      ${tile("完答した日", stats.solved, "日")}
      ${tile("ヒントなしで完答", stats.clean, "日")}
      ${tile("現在の連続", stats.currentStreak, "日")}
      ${tile("最長の連続", stats.maxStreak, "日")}
      ${tile("挑戦した日", stats.played, "日")}
    </div>
    ${session ? "" : `<div class="play-actions"><button class="btn btn-primary" data-action="signin">Google でログイン</button></div>`}
  </div>`;
  root.addEventListener("click", (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-action="signin"]');
    if (t) void deps.auth.signIn();
  });
}
