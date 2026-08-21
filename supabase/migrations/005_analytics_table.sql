-- Persist all-time page view counter so it survives server restarts

create table if not exists public.analytics (
key text primary key,
value bigint not null default 0
);

-- Seed the counter row so it always exists
insert into public.analytics (key, value)
values ('total_views', 0)
on conflict (key) do nothing;

-- The server uses the service-role key, which bypasses RLS. No public policy is
-- needed; browser clients must not be able to rewrite all-time analytics.
alter table public.analytics enable row level security;

-- Atomic increment function: adds 1 to the given key and returns the new value.
-- Using an upsert so it works even if the row was never seeded.
create or replace function public.increment_analytics(key_name text)
returns bigint
language sql
security definer
set search_path = public
as $$
insert into public.analytics (key, value)
values (key_name, 1)
on conflict (key) do update
set value = public.analytics.value + 1
returning value;
$$;

revoke all on function public.increment_analytics(text) from public;
grant execute on function public.increment_analytics(text) to service_role;
