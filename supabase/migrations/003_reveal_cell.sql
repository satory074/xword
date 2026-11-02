-- 003: ヒントを「1 語を丸ごと」から「1 マス（1 文字）」へ。
--   語を丸ごと見せると想起（思い出す過程）が消えて定着しにくい。1 文字だけ開けて残りは交差から推測させる。
--   通す: JST 今日以前で登録済みの日付、0〜48 の白マス。未ログインも呼べる（従来の reveal_slot と同じ）。
--   拒否: 未来日 PUZZLE_NOT_AVAILABLE ／ 未登録 PUZZLE_NOT_FOUND ／ 範囲外・黒マス INVALID_CELL。
--   書き込み: puzzles は読むだけ。ログイン中は本人の solves.reveals を +1（reveal_slot と同じ upsert）。
--   旧 reveal_slot はキャッシュされた旧クライアントのために残し、004 で削除する。
create or replace function reveal_cell(p_date date, p_cell int)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_p puzzles%rowtype;
  v_ch text;
  v_total int;
begin
  if p_date is null or p_date > jst_today() then
    raise exception 'PUZZLE_NOT_AVAILABLE';
  end if;
  if p_cell is null or p_cell < 0 or p_cell > 48 then
    raise exception 'INVALID_CELL';
  end if;
  select * into v_p from puzzles where puzzle_date = p_date;
  if not found then
    raise exception 'PUZZLE_NOT_FOUND';
  end if;
  v_ch := substr(v_p.solution, p_cell + 1, 1);
  if v_ch is null or v_ch = '' or v_ch = '#' then
    raise exception 'INVALID_CELL';
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
  return v_ch;
end;
$$;

revoke execute on function reveal_cell(date, int) from public;
grant execute on function reveal_cell(date, int) to anon, authenticated;

comment on column solves.reveals is 'ヒント回数（003 以降は 1 マス = 1 回。002 までは 1 語 = 1 回）';
