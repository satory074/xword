-- xword RPC: 問題配信・答え合わせ・ヒント・端末保存の取り込み。クライアントはこれらを呼ぶだけ。
--
-- 規約:
--   * 全関数 SECURITY DEFINER + SET search_path = public
--   * エラーは 'ERROR_KEY' 形式で RAISE（src/lib/errors.ts が日本語化）
--   * 未来日（> jst_today()）は全 RPC で PUZZLE_NOT_AVAILABLE
--   * 文字の正規化表は src/lib/kana.ts と文字単位で一致させる（smoketest 2 が検査）

-- 1 問あたりの答え合わせ上限（正誤マスクは総当たりの oracle になるため）
create or replace function check_limit()
returns int
language sql immutable
set search_path = public
as $$ select 30 $$;

-- ---- 正規化: 小書き仮名→大きい仮名、長音の揺れ→ー、形式検査 ----
create or replace function normalize_cells(p text)
returns text
language plpgsql immutable
security definer set search_path = public
as $$
declare
  v text;
  -- @kana GRID_KANA（src/lib/kana.ts と同一）
  v_class constant text := 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポー';
begin
  if p is null then
    raise exception 'INVALID_CELLS';
  end if;
  -- @kana SMALL_FROM / SMALL_TO
  v := translate(p, 'ァィゥェォッャュョヮ', 'アイウエオツヤユヨワ');
  -- @kana DASH_FROM / DASH_TO
  v := translate(v, 'ｰ-−—–〜～~', 'ーーーーーーーー');
  if length(v) <> 49 or v !~ ('^[' || v_class || '_#]{49}$') then
    raise exception 'INVALID_CELLS';
  end if;
  return v;
end;
$$;

-- ---- 採点（src/lib/grid.ts scoreCells の鏡像）----
create or replace function score_cells(p_solution text, p_cells text, out mask text, out correct int, out total int)
language plpgsql immutable
security definer set search_path = public
as $$
declare
  i int;
  s text;
  x text;
begin
  mask := '';
  correct := 0;
  total := 0;
  for i in 1..49 loop
    s := substr(p_solution, i, 1);
    x := substr(p_cells, i, 1);
    if s = '#' then
      if x <> '#' then
        raise exception 'INVALID_CELLS';
      end if;
      mask := mask || '#';
    else
      total := total + 1;
      if x = '_' then
        mask := mask || '_';
      elsif x = s then
        mask := mask || '1';
        correct := correct + 1;
      else
        mask := mask || '0';
      end if;
    end if;
  end loop;
end;
$$;

-- ---- 記録の良し悪し（src/lib/storage.ts betterSolve の鏡像）----
create or replace function solve_better(
  c_solved boolean, c_reveals int, c_checks int, c_correct int, c_duration int, e solves
)
returns boolean
language sql immutable
security definer set search_path = public
as $$
  select row(c_solved, -c_reveals, -c_checks, c_correct, -c_duration)
       > row(e.solved, -e.reveals, -e.checks, e.correct_cells, -e.duration_sec)
$$;

-- ---- 問題配信（spec のみ。p_date null = JST 今日）----
create or replace function get_puzzle(p_date date default null)
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_date date := coalesce(p_date, jst_today());
  v_spec jsonb;
begin
  if v_date > jst_today() then
    raise exception 'PUZZLE_NOT_AVAILABLE';
  end if;
  select spec into v_spec from puzzles where puzzle_date = v_date;
  return jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'puzzle', v_spec);
end;
$$;

-- ---- 公開済みの日付一覧（新しい順）と、登録済みの最終日（補充の目安）----
create or replace function list_puzzle_dates()
returns jsonb
language sql stable
security definer set search_path = public
as $$
  select jsonb_build_object(
    'dates', coalesce((
      select jsonb_agg(to_char(puzzle_date, 'YYYY-MM-DD') order by puzzle_date desc)
      from puzzles where puzzle_date <= jst_today()
    ), '[]'::jsonb),
    'latest', (select to_char(max(puzzle_date), 'YYYY-MM-DD') from puzzles),
    'today', to_char(jst_today(), 'YYYY-MM-DD')
  )
$$;

-- ---- 答え合わせ（未ログインでも可。ログイン中は solves に記録）----
create or replace function check_grid(p_date date, p_cells text, p_duration_sec int default 0)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_p puzzles%rowtype;
  v_cells text;
  v_mask text;
  v_correct int;
  v_total int;
  v_solved boolean;
  v_checks int := null;
  v_existing solves%rowtype;
  v_dur int := greatest(0, least(coalesce(p_duration_sec, 0), 86400));
begin
  if p_date is null or p_date > jst_today() then
    raise exception 'PUZZLE_NOT_AVAILABLE';
  end if;
  select * into v_p from puzzles where puzzle_date = p_date;
  if not found then
    raise exception 'PUZZLE_NOT_FOUND';
  end if;
  v_cells := normalize_cells(p_cells);
  select mask, correct, total into v_mask, v_correct, v_total from score_cells(v_p.solution, v_cells);
  v_solved := v_correct = v_total;

  if v_uid is not null then
    select * into v_existing from solves where user_id = v_uid and puzzle_date = p_date for update;
    if found and v_existing.puzzle_version = v_p.version and v_existing.checks >= check_limit() then
      raise exception 'CHECK_LIMIT';
    end if;
    insert into solves (user_id, puzzle_date, puzzle_version, cells, correct_cells, total_cells,
                        solved, checks, reveals, duration_sec, solved_at)
    values (v_uid, p_date, v_p.version, v_cells, v_correct, v_total,
            v_solved, 1, 0, v_dur, case when v_solved then now() end)
    on conflict (user_id, puzzle_date) do update set
      puzzle_version = excluded.puzzle_version,
      cells = case when solves.puzzle_version <> excluded.puzzle_version or not solves.solved
                   then excluded.cells else solves.cells end,
      correct_cells = case when solves.puzzle_version <> excluded.puzzle_version or not solves.solved
                   then excluded.correct_cells else solves.correct_cells end,
      total_cells = excluded.total_cells,
      solved = case when solves.puzzle_version <> excluded.puzzle_version
                   then excluded.solved else solves.solved or excluded.solved end,
      checks = case when solves.puzzle_version <> excluded.puzzle_version then 1 else solves.checks + 1 end,
      reveals = case when solves.puzzle_version <> excluded.puzzle_version then 0 else solves.reveals end,
      duration_sec = case when solves.puzzle_version <> excluded.puzzle_version or not solves.solved
                   then excluded.duration_sec else solves.duration_sec end,
      solved_at = case when solves.puzzle_version <> excluded.puzzle_version
                   then excluded.solved_at else coalesce(solves.solved_at, excluded.solved_at) end,
      synced_from_local = case when solves.puzzle_version <> excluded.puzzle_version then false else solves.synced_from_local end,
      updated_at = now()
    returning checks into v_checks;
  end if;

  return jsonb_build_object('mask', v_mask, 'correct', v_correct, 'total', v_total,
                            'solved', v_solved, 'checks', v_checks);
end;
$$;

-- ---- ヒント: 1 語だけ答えを返す（ログイン中は reveals を加算）----
create or replace function reveal_slot(p_date date, p_slot_id text)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_p puzzles%rowtype;
  v_word text;
  v_total int;
begin
  if p_date is null or p_date > jst_today() then
    raise exception 'PUZZLE_NOT_AVAILABLE';
  end if;
  select * into v_p from puzzles where puzzle_date = p_date;
  if not found then
    raise exception 'PUZZLE_NOT_FOUND';
  end if;
  v_word := v_p.answers ->> p_slot_id;
  if v_word is null then
    raise exception 'SLOT_NOT_FOUND';
  end if;

  if v_uid is not null then
    v_total := length(replace(v_p.solution, '#', ''));
    insert into solves (user_id, puzzle_date, puzzle_version, cells, correct_cells, total_cells,
                        solved, checks, reveals)
    values (v_uid, p_date, v_p.version, regexp_replace(v_p.solution, '[^#]', '_', 'g'), 0, v_total,
            false, 0, 1)
    on conflict (user_id, puzzle_date) do update set
      puzzle_version = excluded.puzzle_version,
      cells = case when solves.puzzle_version <> excluded.puzzle_version then excluded.cells else solves.cells end,
      correct_cells = case when solves.puzzle_version <> excluded.puzzle_version then 0 else solves.correct_cells end,
      solved = case when solves.puzzle_version <> excluded.puzzle_version then false else solves.solved end,
      checks = case when solves.puzzle_version <> excluded.puzzle_version then 0 else solves.checks end,
      reveals = case when solves.puzzle_version <> excluded.puzzle_version then 1 else solves.reveals + 1 end,
      solved_at = case when solves.puzzle_version <> excluded.puzzle_version then null else solves.solved_at end,
      updated_at = now();
  end if;
  return v_word;
end;
$$;

-- ---- 端末保存の取り込み（ログイン必須）。クライアントの「解けた」は信用せず再採点する ----
-- p_items: [{"date": "2026-11-10", "cells": "...49...", "checks": 2, "reveals": 0,
--            "durationSec": 312, "solvedAt": "2026-11-10T12:34:56Z"}, ...]
-- 戻り値: このユーザーの solves 全行（取り込み後の確定値）
create or replace function sync_results(p_items jsonb)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_date date;
  v_p puzzles%rowtype;
  v_cells text;
  v_mask text;
  v_correct int;
  v_total int;
  v_solved boolean;
  v_checks int;
  v_reveals int;
  v_dur int;
  v_solved_at timestamptz;
  v_existing solves%rowtype;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_CELLS';
  end if;
  if jsonb_array_length(p_items) > 400 then
    raise exception 'TOO_MANY_ITEMS';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_date := (v_item ->> 'date')::date;
      if v_date is null or v_date > jst_today() then
        continue;
      end if;
      select * into v_p from puzzles where puzzle_date = v_date;
      if not found then
        continue;
      end if;
      v_cells := normalize_cells(v_item ->> 'cells');
      select mask, correct, total into v_mask, v_correct, v_total from score_cells(v_p.solution, v_cells);
      v_solved := v_correct = v_total;
      v_checks := greatest(1, least(coalesce((v_item ->> 'checks')::int, 1), check_limit()));
      v_reveals := greatest(0, least(coalesce((v_item ->> 'reveals')::int, 0), 49));
      v_dur := greatest(0, least(coalesce((v_item ->> 'durationSec')::int, 0), 86400));
      v_solved_at := case
        when v_solved then least(
          greatest(coalesce((v_item ->> 'solvedAt')::timestamptz, now()),
                   (v_date::timestamp at time zone 'Asia/Tokyo')),
          now())
        else null end;

      select * into v_existing from solves where user_id = v_uid and puzzle_date = v_date for update;
      if not found then
        insert into solves (user_id, puzzle_date, puzzle_version, cells, correct_cells, total_cells,
                            solved, checks, reveals, duration_sec, solved_at, synced_from_local)
        values (v_uid, v_date, v_p.version, v_cells, v_correct, v_total,
                v_solved, v_checks, v_reveals, v_dur, v_solved_at, true);
      elsif v_existing.puzzle_version <> v_p.version
            or solve_better(v_solved, v_reveals, v_checks, v_correct, v_dur, v_existing) then
        update solves set
          puzzle_version = v_p.version, cells = v_cells, correct_cells = v_correct, total_cells = v_total,
          solved = v_solved, checks = v_checks, reveals = v_reveals, duration_sec = v_dur,
          solved_at = v_solved_at, synced_from_local = true, updated_at = now()
        where user_id = v_uid and puzzle_date = v_date;
      end if;
    exception
      when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
        continue; -- 壊れた項目は読み飛ばす
      when raise_exception then
        continue; -- INVALID_CELLS など
    end;
  end loop;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'puzzle_date', to_char(s.puzzle_date, 'YYYY-MM-DD'), 'cells', s.cells,
      'correct_cells', s.correct_cells, 'total_cells', s.total_cells, 'solved', s.solved,
      'checks', s.checks, 'reveals', s.reveals, 'duration_sec', s.duration_sec,
      'solved_at', s.solved_at) order by s.puzzle_date desc), '[]'::jsonb)
    from solves s where s.user_id = v_uid
  );
end;
$$;

-- ---- 権限: 既定の execute を外し、必要な役割にだけ付与 ----
revoke execute on function check_limit() from public, anon, authenticated;
revoke execute on function normalize_cells(text) from public, anon, authenticated;
revoke execute on function score_cells(text, text) from public, anon, authenticated;
revoke execute on function solve_better(boolean, int, int, int, int, solves) from public, anon, authenticated;

revoke execute on function get_puzzle(date) from public;
grant execute on function get_puzzle(date) to anon, authenticated;

revoke execute on function list_puzzle_dates() from public;
grant execute on function list_puzzle_dates() to anon, authenticated;

revoke execute on function check_grid(date, text, int) from public;
grant execute on function check_grid(date, text, int) to anon, authenticated;

revoke execute on function reveal_slot(date, text) from public;
grant execute on function reveal_slot(date, text) to anon, authenticated;

revoke execute on function sync_results(jsonb) from public, anon;
grant execute on function sync_results(jsonb) to authenticated;
