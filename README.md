# xword

毎日 1 問、7×7 のカタカナクロスワード。未ログインでも遊べて、Google でログインすると記録（完答日数・連続日数）が端末をまたいで残る。

- 本番: https://satory074.github.io/xword/
- スタック: Astro 5 + Tailwind v4 + TypeScript（GitHub Pages 静的ホスティング）＋ Supabase（Auth / Postgres）
- 問題は `../xword-private/`（**非公開リポ**）の語彙バンクからローカルで生成し、Supabase に登録する

## コマンド

```bash
npm install
npm run dev        # http://localhost:4321/xword/（.env に PUBLIC_SUPABASE_URL / ANON_KEY）
npm run build      # dist/ に静的ファイル生成
npm run typecheck  # astro check
npm run test       # smoketest（純ロジック・テンプレート・語彙バンク lint）+ domtest（jsdom、フェイク Api 注入）

npm run bankstats                         # 語彙バンクの統計（長さ別・薄い文字）
npm run stress -- --days 60               # 60 日連続生成の成功率・再利用間隔を計測（ファイルは書かない）
npm run gen -- --date 2026-11-02 --days 30   # 問題生成 → ../xword-private/out/<date>.json + preview.html
npm run push -- --dry                     # 登録内容の確認
npm run push                              # 未来日の問題を Supabase に登録（.env の SERVICE_ROLE_KEY）
```

## アーキテクチャ

**解答はサーバーにしかない。** 問題（盤面・カギ）も `get_puzzle` RPC が JST 今日以前だけ返す。答え合わせは `check_grid` RPC がサーバー側で採点し、ログイン中なら `solves` に記録する。未ログインの結果は localStorage に残り、ログイン時に `sync_results` RPC がサーバーで再採点して取り込む（クライアントの「解けた」は信用しない）。

```
src/lib/    純 TS（DOM・supabase 依存なし）: kana（正規化）/ grid（盤面・採点）/ bank（語彙索引）/ rng / date（JST）
            storage（端末保存・記録の優劣）/ stats（連続日数）/ share / errors / types（Api I/F = 境界）
src/app/    DOM 層: supabase / auth / api（Api 実装）/ real（エントリ）/ header / ui
            puzzle（盤面・入力・答え合わせ）/ keyboard（50 音）/ sync / archive / mypage
src/pages/  index（今日 / ?d=YYYY-MM-DD）/ archive / mypage
scripts/    gen.ts（生成 CLI）/ gen/{fill,lint,history,generate,preview,bankio}.ts / push.ts / stress.ts / bankstats.ts
data/templates/7x7.json   黒マステンプレート（7 種とその転置・反転のうち、実語彙で埋まることを確認した変種のみ）
supabase/migrations/      001_schema.sql（テーブル・RLS・不変トリガー）/ 002_rpc.sql（RPC・権限）
../xword-private/         words/*.json（語彙バンク）・out/（生成結果、解答入り）← 公開しない
```

### 作問ルール（生成器が強制するもの）

ニコリ式のハード制約: 黒マスを縦横に連続させない／白マスを分断しない／単語は 2 文字以上／同じ語を 2 回使わない／小さい仮名は大きく、濁点は区別、「ー」は 1 マス／ン・ー で始まる語なし／四隅は白／180° 点対称／黒マス ≤ 12。
品質: 難語（difficulty 3）は 1 問 ≤ 2 で互いに交差しない／同じ語は 10 日空ける／1 文字が白マスの 25% を超えない／カギに答えの表記・読みを含めない／二重解の恐れは warning（preview.html で目視）。

## セットアップ（初回のみ）

### 1. Supabase プロジェクト（無料枠）

1. https://supabase.com で新規プロジェクト作成（リージョン ap-northeast-1）
2. **Google OAuth**: Google Cloud Console で OAuth クライアント ID を作成
   - 承認済みリダイレクト URI: `https://<project-ref>.supabase.co/auth/v1/callback`
3. Supabase Dashboard > Authentication > Providers > Google を有効化（クライアント ID / シークレット）
4. Authentication > URL Configuration:
   - Site URL: `https://satory074.github.io/xword/`
   - Additional Redirect URLs: `http://localhost:4321/xword/`
5. SQL Editor で **順番に** 実行: `supabase/migrations/001_schema.sql` → `002_rpc.sql`

### 2. ローカル

```bash
cp .env.example .env   # Settings > API の URL / anon key / service_role key を記入
npm run gen -- --date <明日> --days 30
open ../xword-private/out/preview.html   # 盤面とカギを目視
npm run push
npm run dev
```

### 3. GitHub Pages

1. 公開リポ `xword` を作成して push（`../xword-private` は **private リポ**として別に push）
2. Settings > Pages > Source を「GitHub Actions」に
3. Settings > Secrets and variables > Actions > **Variables**: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`
4. main へ push すると `deploy.yml` が test → build → deploy。`keepalive.yml` が毎日 RPC を叩いて無料枠の一時停止を防ぐ

### セキュリティ確認（anon key で叩いて全部拒否されること）

```bash
U=https://<project-ref>.supabase.co; K=<anon key>
curl -s "$U/rest/v1/puzzles?select=*" -H "apikey: $K" -H "Authorization: Bearer $K"            # → [] （select ポリシーなし）
curl -s "$U/rest/v1/solves" -X POST -H "apikey: $K" -H "Authorization: Bearer $K" \
  -H "Content-Type: application/json" -d '{"user_id":"00000000-0000-0000-0000-000000000000","puzzle_date":"2030-01-01","puzzle_version":1,"cells":"","total_cells":0}'   # → 42501 エラー
curl -s "$U/rest/v1/rpc/get_puzzle" -X POST -H "apikey: $K" -H "Authorization: Bearer $K" \
  -H "Content-Type: application/json" -d '{"p_date":"2099-01-01"}'                           # → PUZZLE_NOT_AVAILABLE
curl -s "$U/rest/v1/rpc/sync_results" -X POST -H "apikey: $K" -H "Authorization: Bearer $K" \
  -H "Content-Type: application/json" -d '{"p_items":[]}'                                    # → permission denied
```

## 運用

- **月 1 回**: `npm run gen -- --date <最終日の翌日> --days 30` → `preview.html` を目視（変なカギ・二重解の警告）→ `npm run push`
- 問題の在庫が 7 日を切ると「過去の問題」ページ下部に注意書きが出る
- 公開済み（JST 今日以前）の問題は解答を変更できない（DB トリガー）。カギの文言だけなら `gen --force` → `push --force` で差し替え可
- `../xword-private/` を失うと語彙とクールダウン履歴を失う。private リポに必ず push する
- 語彙を増やすときは `words/*.json` に追記 → `npm run bankstats` で lint と偏りを確認
