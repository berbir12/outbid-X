-- Add clicks column to marketers table and recreate leaderboard view safely

alter table public.marketers add column if not exists clicks bigint not null default 0;

drop view if exists public.leaderboard;

create view public.leaderboard as
select distinct on (m.id)
  m.id,
  m.handle,
  m.name,
  m.bio as title,
  m.category,
  m.location,
  m.website,
  m.avatar_url,
  m.followers,
  m.engagement_rate,
  coalesce(m.clicks, 0) as clicks,
  b.amount_cents,
  b.paid_at
from public.marketers m
join public.bids b on b.marketer_id = m.id and b.status = 'paid'
order by m.id, b.amount_cents desc, b.paid_at asc;
