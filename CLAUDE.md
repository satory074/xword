# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

# `xword` — 毎日 1 問のカタカナクロスワード

Astro 5, Tailwind v4, TypeScript, GitHub Pages 静的サイト ＋ Supabase（Auth/Postgres）。cookmaker と同じ構成。

```bash
npm run dev / build / typecheck
npm run test        # smoketest（テンプレート・カナ正規化と SQL の一致・語彙バンク lint・埋め・採点・連続日数）+ domtest（jsdom、フェイク Api）
npm run gen -- --date YYYY-MM-DD --days N [--force] [--mix 24/48/28] [--hard 3]   # 問題生成 → ../xword-private/out/
npm run push        # Supabase へ登録（.env の SUPABASE_SERVICE_ROLE_KEY）
npm run stress / bankstats                  # bankstats はカギのレベル網羅率（lv2 欠・lv3 欠）も出す
npm run wiki -- --file animals              # ja.wikipedia の要約・閲覧数を ../xword-private/wiki/ にキャッシュ（カギ執筆の裏取り）
```

**アーキテクチャ**: **解答はサーバー側にしかない**。`puzzles` に select ポリシーを作らず、`get_puzzle` RPC が JST 今日以前の spec だけ返す。答え合わせは `check_grid` RPC で採点、ヒントは `reveal_slot`。未ログインは localStorage、ログイン時に `sync_results` がサーバーで再採点して取り込む。`src/lib/`（純 TS、相対 import、DOM/supabase 禁止）→ `src/app/`（DOM 層。`real.ts` が実依存を注入、domtest はフェイク注入）→ `src/pages/` 殻。詳細は README。

**語彙バンクと生成結果は `../xword-private/`（非公開リポ）**。公開リポに置くとカギ→答えが grep できる。`out/*.json` は解答入りで、削除しない（語のクールダウン履歴）。

**Gotcha**:
- カナの変換表（小書き→大書き、長音の揺れ）は `src/lib/kana.ts` と `002_rpc.sql` の `translate()` の**二重管理**。smoketest 2 が文字単位で突き合わせる。変更は両方同時に
- `scoreCells`（grid.ts）と `score_cells`（SQL）、`betterSolve`（storage.ts）と `solve_better`（SQL）も鏡像。順序を変えるときは両方
- 盤面・解答は 49 文字の行優先文字列（`#` 黒 / `_` 空欄 / カナ）。テンプレートは `data/templates/7x7.json` に変種（転置・反転）も明示的に列挙し、読み込み時に `validateTemplate` で再検証する。反転で語頭マスの位置が変わると実語彙で埋まらない変種があるので自動生成しない
- 公開済み問題の solution/answers は DB トリガーで変更不可。`push` は今日以前を `--force` なしで拒否、`solves` がある日は `--force` でも拒否
- 二重解 lint は warning のみ（片方向にしか属さないマスがある語は構造的に別候補が必ずある）。preview.html で目視する
- カギの読み漏れ検査（ひらがな）は 3 文字以上だけ。2 文字は「めでたい」の「たい」のような偽陽性が多い
- 語彙バンクの `kana` は正規化済みで書く（ッ→ツ、ャ→ヤ、ヴ・ヲ不可、2〜5 文字、ン・ー 先頭禁止）。lint が `npm test` と `bankstats` で走る
- **カギは 3 配列** `clues`（lv1 直接）/ `clues2`（ひとひねり）/ `clues3`（ひねり）。書き方と例は `../xword-private/CLUES.md`。difficulty ≥ 2 の語に `clues3` は書かない（生成器が使わない）。2 文字語の `clues3` は lint エラー。未知のキー（`clue2` 等の typo）は読み込みで例外
- **難易度の調整は `scripts/gen/level.ts` の `DEFAULT_PROFILE` だけ**。公平性ルール（lv3 は完全交差の語のみ・実効難易度 3 同士は交差しない・二重解注意の語は lv1）は `lintLevels` が最後の砦。配分未達は warning で埋めは捨てない
- `gen --force` で作り直すとき、開始日以降の旧 `out/*.json` は履歴に数えない（数えると直近の語が全部クールダウンに入る）。`cooldown()` も未来日は除外しない。`ALGO_VERSION` を上げると同じ日付でも別の問題になる（現在 2）
- Supabase 無料枠は 1 週間無アクセスで停止 → `.github/workflows/keepalive.yml` が毎日 RPC を叩く
- OAuth の redirectTo は base path `/xword/` 込み（`app/auth.ts`）。Supabase の Redirect URLs に localhost と本番の両方を登録
