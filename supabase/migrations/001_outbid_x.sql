create extension if not exists pgcrypto;

create type public.bid_status as enum ('pending', 'paid', 'failed', 'refunded');
create type public.payment_status as enum ('checkout_created', 'processing', 'succeeded', 'failed', 'cancelled', 'refunded', 'amount_mismatch');

create table public.marketers (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^@[A-Za-z0-9_]{1,15}$'),
  name text,
  bio text,
  category text,
  location text,
  website text,
  avatar_url text,
  followers bigint,
  engagement_rate numeric(7,4),
  industries text[] not null default '{}',
  previous_campaigns jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bids (
  id uuid primary key,
  marketer_id uuid not null references public.marketers(id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  status public.bid_status not null default 'pending',
  dodo_checkout_session_id text unique,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid not null references public.bids(id) on delete restrict,
  dodo_payment_id text unique,
  dodo_checkout_session_id text unique,
  amount_cents bigint not null,
  currency text not null default 'USD',
  status public.payment_status not null default 'checkout_created',
  customer_email text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.webhook_events (
  webhook_id text primary key,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz not null default now()
);

create index bids_paid_ranking_idx on public.bids (amount_cents desc, paid_at asc) where status = 'paid';
create index bids_marketer_idx on public.bids (marketer_id, created_at desc);
create index payments_bid_idx on public.payments (bid_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger marketers_set_updated_at before update on public.marketers for each row execute function public.set_updated_at();
create trigger bids_set_updated_at before update on public.bids for each row execute function public.set_updated_at();
create trigger payments_set_updated_at before update on public.payments for each row execute function public.set_updated_at();

create or replace view public.leaderboard as
select distinct on (m.id)
  m.id, m.handle, m.name, m.bio as title, m.category, m.location, m.website,
  m.avatar_url, m.followers, m.engagement_rate, b.amount_cents, b.paid_at
from public.marketers m
join public.bids b on b.marketer_id = m.id and b.status = 'paid'
order by m.id, b.amount_cents desc, b.paid_at asc;

create or replace function public.process_dodo_payment(
  p_webhook_id text,
  p_event_type text,
  p_payment_id text,
  p_bid_id uuid,
  p_amount_cents bigint,
  p_currency text,
  p_payload jsonb
) returns boolean
language plpgsql security definer set search_path = public as $$
declare expected_amount bigint;
begin
  insert into webhook_events(webhook_id, event_type, payload)
  values (p_webhook_id, p_event_type, p_payload)
  on conflict (webhook_id) do nothing;
  if not found then return false; end if;

  select amount_cents into expected_amount from bids where id = p_bid_id for update;
  if expected_amount is null then raise exception 'Unknown bid'; end if;

  update payments set
    dodo_payment_id = coalesce(p_payment_id, dodo_payment_id),
    amount_cents = p_amount_cents,
    currency = p_currency,
    raw_payload = p_payload,
    status = case
      when p_event_type = 'payment.succeeded' and (p_amount_cents <> expected_amount or p_currency <> 'USD') then 'amount_mismatch'::payment_status
      when p_event_type = 'payment.succeeded' then 'succeeded'::payment_status
      when p_event_type = 'payment.processing' then 'processing'::payment_status
      when p_event_type = 'payment.cancelled' then 'cancelled'::payment_status
      else 'failed'::payment_status end
  where bid_id = p_bid_id;

  update bids set
    status = case
      when p_event_type = 'payment.succeeded' and p_amount_cents = expected_amount and p_currency = 'USD' then 'paid'::bid_status
      when p_event_type in ('payment.failed','payment.cancelled') or (p_event_type = 'payment.succeeded' and (p_amount_cents <> expected_amount or p_currency <> 'USD')) then 'failed'::bid_status
      else status end,
    paid_at = case when p_event_type = 'payment.succeeded' and p_amount_cents = expected_amount and p_currency = 'USD' then now() else paid_at end
  where id = p_bid_id;
  return true;
end;
$$;

alter table public.marketers enable row level security;
alter table public.bids enable row level security;
alter table public.payments enable row level security;
alter table public.webhook_events enable row level security;

revoke all on public.marketers, public.bids, public.payments, public.webhook_events from anon, authenticated;
revoke all on function public.process_dodo_payment from public, anon, authenticated;
grant execute on function public.process_dodo_payment to service_role;
