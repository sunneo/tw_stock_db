-- 遠端群組：房間登記表（見 DESIGN.remote-group.md 第 3 節）
-- 用法：Supabase 專案 → SQL Editor → 貼上整份 → Run。可重複執行（冪等）。
-- 這張表存：房間代號、「由密碼推導出來的驗證值」（不是密碼本身）、建立時間、最後活動時間、失敗次數。
-- 不存密碼、不存任何對話內容。用戶端只能透過下面的函式存取，資料表本身不開放
-- （開了資料列層級安全、沒有任何政策，也收回了所有權限）。
--
-- 驗證值是用戶端用「很慢的雜湊（PBKDF2，60 萬次）」從「密碼＋房間代號」推導出來再取雜湊的結果：
-- 可以拿來比對密碼對不對，但無法反推出密碼；連續猜錯會被暫時鎖住。

create table if not exists public.rg_rooms (
  code         text primary key check (code ~ '^[0-9]{8,}$'),
  verifier     text not null default '',
  created_at   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  fail_count   integer not null default 0,
  locked_until timestamptz
);
-- 舊版（沒有這些欄位）升級用
alter table public.rg_rooms add column if not exists verifier text not null default '';
alter table public.rg_rooms add column if not exists fail_count integer not null default 0;
alter table public.rg_rooms add column if not exists locked_until timestamptz;
alter table public.rg_rooms enable row level security;
revoke all on public.rg_rooms from anon, authenticated;

-- 設定值（要改就改這裡）：房間閒置多久回收（小時）、連續猜錯幾次鎖住、鎖多久（分鐘）
create or replace function public.rg_idle_hours() returns integer language sql immutable as $$ select 24 $$;
create or replace function public.rg_max_fails() returns integer language sql immutable as $$ select 8 $$;
create or replace function public.rg_lock_minutes() returns integer language sql immutable as $$ select 15 $$;

-- 清掉閒置的房間（每次建立房間時順便做，不需要排程）
create or replace function public.rg_cleanup() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.rg_rooms where last_seen < now() - make_interval(hours => public.rg_idle_hours());
  get diagnostics n = row_count;
  return n;
end $$;

-- 建立房間：代號由用戶端隨機挑（8 位數起；驗證值要用代號當鹽推導，所以得先有代號）。
-- 代號已被使用就回傳 false，用戶端換一個再試；連續撞號就多加一位。回傳 true 表示建立成功。
create or replace function public.rg_create_room(p_code text, p_verifier text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_code is null or p_code !~ '^[1-9][0-9]{7,13}$' then raise exception 'rg_create_room: 代號格式不合格'; end if;
  if p_verifier is null or length(p_verifier) < 32 then raise exception 'rg_create_room: 驗證值不合格'; end if;
  perform public.rg_cleanup();
  insert into public.rg_rooms(code, verifier) values (p_code, p_verifier) on conflict (code) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 加入房間：回傳 ok／not_found／bad_password／locked。密碼對時順便更新最後活動時間並清掉失敗次數
create or replace function public.rg_join_room(p_code text, p_verifier text) returns text
language plpgsql security definer set search_path = public as $$
declare r public.rg_rooms%rowtype;
begin
  select * into r from public.rg_rooms where code = p_code for update;
  if not found or r.last_seen < now() - make_interval(hours => public.rg_idle_hours()) then return 'not_found'; end if;
  if r.locked_until is not null and r.locked_until > now() then return 'locked'; end if;
  if r.verifier = p_verifier then
    update public.rg_rooms set last_seen = now(), fail_count = 0, locked_until = null where code = p_code;
    return 'ok';
  end if;
  if r.fail_count + 1 >= public.rg_max_fails() then
    update public.rg_rooms set fail_count = 0, locked_until = now() + make_interval(mins => public.rg_lock_minutes()) where code = p_code;
    return 'locked';
  end if;
  update public.rg_rooms set fail_count = r.fail_count + 1 where code = p_code;
  return 'bad_password';
end $$;

-- 在線時定期呼叫（每隔幾分鐘），讓房間不被回收；需要帶驗證值（只有知道密碼的人能延長房間壽命）
create or replace function public.rg_touch_room(p_code text, p_verifier text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.rg_rooms set last_seen = now() where code = p_code and verifier = p_verifier;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 離開／關閉房間（沒有人在線時由最後一個離開的人呼叫；也可以不呼叫，24 小時後自動回收）
create or replace function public.rg_close_room(p_code text, p_verifier text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.rg_rooms where code = p_code and verifier = p_verifier;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 舊版函式（沒有驗證值）移除
drop function if exists public.rg_create_room();
drop function if exists public.rg_create_room(text);
drop function if exists public.rg_touch_room(text);
drop function if exists public.rg_room_exists(text);

revoke all on function public.rg_create_room(text, text) from public;
revoke all on function public.rg_join_room(text, text) from public;
revoke all on function public.rg_touch_room(text, text) from public;
revoke all on function public.rg_close_room(text, text) from public;
revoke all on function public.rg_cleanup() from public;
grant execute on function public.rg_create_room(text, text) to anon, authenticated;
grant execute on function public.rg_join_room(text, text) to anon, authenticated;
grant execute on function public.rg_touch_room(text, text) to anon, authenticated;
grant execute on function public.rg_close_room(text, text) to anon, authenticated;
-- rg_cleanup 不開放給用戶端（只在 rg_create_room 內部呼叫）
