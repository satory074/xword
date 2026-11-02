-- 004: 旧ヒント RPC（語を丸ごと返す）を削除。003 と新フロントの配信から数日おいて適用する
--   （ブラウザにキャッシュされた旧 JS が reveal_slot を呼び続けるため）。
drop function if exists reveal_slot(date, text);
