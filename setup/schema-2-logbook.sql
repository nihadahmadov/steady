-- Adds Steady's Logbook table for films, books and workouts.
-- Like the other tables, each row is visible only to the person who owns it.

create table if not exists public.items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) <= 64),
  kind text not null check (kind in ('film', 'book', 'workout')),
  day date not null,
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) < 20000),
  deleted boolean not null default false,
  t bigint not null,
  primary key (user_id, id)
);

alter table public.items enable row level security;

drop policy if exists "own items: read" on public.items;
drop policy if exists "own items: add" on public.items;
drop policy if exists "own items: change" on public.items;

create policy "own items: read" on public.items for select to authenticated using ((select auth.uid()) = user_id);
create policy "own items: add" on public.items for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own items: change" on public.items for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.items from anon;
grant select, insert, update on public.items to authenticated;
