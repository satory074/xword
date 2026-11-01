-- xword スキーマ: テーブル・RLS・公開済み問題の不変トリガー・新規ユーザートリガー
-- 適用方法: Supabase ダッシュボードの SQL エディタで 001 → 002 の順に実行
--
-- 設計原則:
--   * 問題の解答（puzzles.solution / answers）はクライアントに出さない。
--     puzzles に select ポリシーを作らず、閲覧は RPC get_puzzle（spec のみ返す）経由に限る
--   * クライアントからの書き込みは全面禁止（write ポリシーを一切作らない）。
--     記録は 002 の SECURITY DEFINER RPC がサーバー側で再採点して行う
--   * JST 今日以前の問題は solution / answers を変更できない（トリガー。service role でも不可）

-- ---- JST の今日（サーバーが決める。クライアントの時計は信用しない） ----
create or replace function jst_today()
returns date
language sql stable
security definer set search_path = public
as $$
  select (now() at time zone 'Asia/Tokyo')::date
$$;

-- ---- プロフィール ----
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- ---- 問題（1 日 1 問）----
create table puzzles (
  puzzle_date date primary key,
  spec jsonb not null,                                   -- 配信用（盤面・カギ・番号）。解答を含まない
  solution text not null check (length(solution) = 49), -- 49 文字: '#' 黒 / カナ
  answers jsonb not null,                                -- {"A1": "コーヒー", ...}（ヒント用）
  version int not null default 1,                        -- 緊急差し替え時に上げる（solves と突き合わせる）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---- 記録（ユーザー × 日付で 1 行）----
create table solves (
  user_id uuid not null references profiles (id) on delete cascade,
  puzzle_date date not null references puzzles (puzzle_date),
  puzzle_version int not null,
  cells text not null check (length(cells) = 49),       -- 最後に採点した盤面（'_' 空欄）
  correct_cells int not null default 0,
  total_cells int not null,
  solved boolean not null default false,
  checks int not null default 0,                         -- 答え合わせ回数
  reveals int not null default 0,                        -- ヒント（1 語表示）回数
  duration_sec int not null default 0 check (duration_sec >= 0),
  solved_at timestamptz,
  synced_from_local boolean not null default false,      -- 端末保存からの取り込み
  updated_at timestamptz not null default now(),
  primary key (user_id, puzzle_date)
);
create index idx_solves_date on solves (puzzle_date);

-- ---- RLS: 本人の行の読み取りだけを許し、書き込みポリシーは一切作らない ----
alter table profiles enable row level security;
alter table puzzles enable row level security;
alter table solves enable row level security;

create policy "profiles は本人のみ閲覧可" on profiles for select using (id = auth.uid());
create policy "solves は本人のみ閲覧可" on solves for select using (user_id = auth.uid());
-- puzzles: ポリシーなし（anon / authenticated は一切読めない。閲覧は get_puzzle 経由）

-- ---- 公開済み問題の不変性（解いた後に答えが変わる事故を構造的に防ぐ）----
create or replace function puzzles_guard_published()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.puzzle_date <= jst_today() then
      raise exception 'PUZZLE_PUBLISHED_IMMUTABLE';
    end if;
    return old;
  end if;
  if old.puzzle_date <= jst_today()
     and (new.solution is distinct from old.solution or new.answers is distinct from old.answers) then
    raise exception 'PUZZLE_PUBLISHED_IMMUTABLE';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger puzzles_published_immutable
  before update or delete on puzzles
  for each row execute function puzzles_guard_published();

-- ---- 新規ユーザー: プロフィール作成（cookmaker と同じ）----
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_name text;
begin
  v_name := coalesce(
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'full_name',
    split_part(coalesce(new.email, 'ユーザー'), '@', 1)
  );
  insert into profiles (id, display_name, avatar_url)
  values (
    new.id,
    v_name,
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- 内部関数はクライアントから直接呼べないようにする
revoke execute on function jst_today() from public, anon, authenticated;
revoke execute on function puzzles_guard_published() from public, anon, authenticated;
revoke execute on function handle_new_user() from public, anon, authenticated;
