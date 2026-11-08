-- Stores which devices want a daily reminder, and when.

create table if not exists public.push_subscriptions (
  endpoint text primary key check (char_length(endpoint) <= 1000),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  tz text not null default 'UTC' check (char_length(tz) <= 64),
  remind_at text not null default '20:00' check (remind_at ~ '^[0-2][0-9]:[0-5][0-9]$'),
  last_day date
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "own reminders: read" on public.push_subscriptions;
drop policy if exists "own reminders: add" on public.push_subscriptions;
drop policy if exists "own reminders: change" on public.push_subscriptions;
drop policy if exists "own reminders: remove" on public.push_subscriptions;

create policy "own reminders: read" on public.push_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "own reminders: add" on public.push_subscriptions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own reminders: change" on public.push_subscriptions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own reminders: remove" on public.push_subscriptions for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- The schedule itself is created separately because it contains a private value.
