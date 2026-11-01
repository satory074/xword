// 過去の問題一覧。公開済みの日付と自分の記録（✅ 完答 / ◐ 途中 / —）。
import { fmtDateJa, diffDays } from "../lib/date";
import { readResults } from "../lib/storage";
import type { AppDeps } from "../lib/types";
import { mountHeader } from "./header";
import { syncWithServer } from "./sync";
import { errorMessage, esc, link, showToast } from "./ui";

export async function boot(root: HTMLElement, header: HTMLElement, deps: AppDeps): Promise<void> {
  const session = await mountHeader(header, deps, "archive");
  if (session) {
    try {
      await syncWithServer(deps, session);
    } catch (e) {
      showToast(`記録の同期に失敗しました: ${errorMessage(e)}`, true);
    }
  }
  root.innerHTML = `<p class="muted">読み込み中…</p>`;
  const list = await deps.api.listDates();
  const results = readResults(deps.storage);
  const rows = list.dates
    .map((d) => {
      const r = results[d];
      const status = r?.solved ? (r.reveals > 0 ? "✅ 完答（ヒントあり）" : "✅ 完答") : r ? `◐ ${r.correctCells}/${r.totalCells}` : "—";
      return `<li><a href="${link("")}?d=${d}">${esc(fmtDateJa(d))}</a><span class="archive-status">${status}</span></li>`;
    })
    .join("");
  const remaining = list.latest ? diffDays(list.today, list.latest) : -1;
  const stock = remaining < 7 ? `<p class="muted">※ 問題の在庫が残り ${Math.max(remaining, 0)} 日分です（管理者向け: gen → push で補充）</p>` : "";
  root.innerHTML = `<div class="archive"><h1>過去の問題</h1>
    ${rows ? `<ul class="archive-list">${rows}</ul>` : `<p class="muted">まだ問題がありません。</p>`}${stock}</div>`;
}
