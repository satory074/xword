// 端末保存 → サーバーの同期。セッションがあるときに 1 回だけ呼ぶ。
// サーバーが再採点して確定した行で、ローカルの結果一覧を置き換える（入力途中はローカルのまま）。
import { markSynced, readResults, resultFromRow, unsyncedFor, writeResults } from "../lib/storage";
import type { AppDeps, SessionInfo, SolveRow, SyncItem } from "../lib/types";

export async function syncWithServer(deps: AppDeps, session: SessionInfo): Promise<SolveRow[]> {
  const uid = session.userId;
  const pending = unsyncedFor(deps.storage, uid);
  let rows: SolveRow[];
  if (pending.length > 0) {
    const items: SyncItem[] = pending.map(([date, r]) => ({
      date,
      cells: r.cells,
      checks: r.checks,
      reveals: r.reveals,
      durationSec: r.durationSec,
      solvedAt: r.solvedAt,
    }));
    rows = await deps.api.syncResults(items);
    markSynced(deps.storage, uid, pending.map(([d]) => d));
  } else {
    rows = await deps.api.fetchMySolves();
  }
  // サーバーの行を真実としてローカルへ反映（他端末の記録もここで取り込まれる）
  const map = readResults(deps.storage);
  for (const row of rows) map[row.puzzleDate] = resultFromRow(row, uid);
  writeResults(deps.storage, map);
  return rows;
}
