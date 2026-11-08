-- Creates Steady's two online tables. Each row belongs to one signed-in person,
-- and the policies below stop anyone from reading or changing someone else's rows.

create table if not exists public.habits (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  name text not null default '' check (char_length(name) <= 60),
  emoji text not null default '',
  color text not null default '',
  per_week integer not null default 7 check (per_week between 1 and 7),
  unit text not null default '' check (char_length(unit) <= 32),
  pos integer not null default 0,
  deleted boolean not null default false,
  t bigint not null,
  primary key (user_id, id)
);

create table if not exists public.logs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  habit_id text not null check (char_length(habit_id) <= 64),
  value numeric,
  deleted boolean not null default false,
  t bigint not null,
  primary key (user_id, day, habit_id)
);

alter table public.habits enable row level security;
alter table public.logs enable row level security;

drop policy if exists "own habits: read" on public.habits;
drop policy if exists "own habits: add" on public.habits;
drop policy if exists "own habits: change" on public.habits;
drop policy if exists "own logs: read" on public.logs;
drop policy if exists "own logs: add" on public.logs;
drop policy if exists "own logs: change" on public.logs;

create policy "own habits: read" on public.habits for select to authenticated using ((select auth.uid()) = user_id);
create policy "own habits: add" on public.habits for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own habits: change" on public.habits for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "own logs: read" on public.logs for select to authenticated using ((select auth.uid()) = user_id);
create policy "own logs: add" on public.logs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own logs: change" on public.logs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.habits, public.logs from anon;
grant select, insert, update on public.habits, public.logs to authenticated;
