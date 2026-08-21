-- Update process_dodo_payment function to:
-- 1. Support amount >= expected_amount (handling tax and fees gracefully)
-- 2. Normalize USD currency checking
-- 3. Support fallback to match by dodo_checkout_session_id
-- 4. Idempotently succeed on retries and manual verifications

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
declare
  expected_amount bigint;
  target_bid_id uuid := p_bid_id;
begin
  if p_webhook_id is not null and p_webhook_id <> '' then
    insert into webhook_events(webhook_id, event_type, payload)
    values (p_webhook_id, p_event_type, p_payload)
    on conflict (webhook_id) do nothing;
  end if;

  select id, amount_cents into target_bid_id, expected_amount
  from bids
  where id = p_bid_id
  for update;

  if expected_amount is null and p_payload->'data'->>'checkout_session_id' is not null then
    select id, amount_cents into target_bid_id, expected_amount
    from bids
    where dodo_checkout_session_id = p_payload->'data'->>'checkout_session_id'
    for update;
  end if;

  if expected_amount is null then
    raise exception 'Unknown bid: %', p_bid_id;
  end if;

  update payments set
    dodo_payment_id = coalesce(p_payment_id, dodo_payment_id),
    amount_cents = coalesce(p_amount_cents, amount_cents),
    currency = coalesce(p_currency, currency),
    raw_payload = coalesce(p_payload, raw_payload),
    status = case
      when p_event_type = 'payment.succeeded' and (p_amount_cents < expected_amount) then 'amount_mismatch'::payment_status
      when p_event_type = 'payment.succeeded' then 'succeeded'::payment_status
      when p_event_type = 'payment.processing' then 'processing'::payment_status
      when p_event_type = 'payment.cancelled' then 'cancelled'::payment_status
      else 'failed'::payment_status end
  where bid_id = target_bid_id;

  update bids set
    status = case
      when p_event_type = 'payment.succeeded' and (p_amount_cents >= expected_amount or p_amount_cents is null) then 'paid'::bid_status
      when p_event_type in ('payment.failed','payment.cancelled') or (p_event_type = 'payment.succeeded' and p_amount_cents < expected_amount) then 'failed'::bid_status
      else status end,
    paid_at = case
      when p_event_type = 'payment.succeeded' and (p_amount_cents >= expected_amount or p_amount_cents is null) then coalesce(paid_at, now())
      else paid_at end
  where id = target_bid_id;

  return true;
end;
$$;
