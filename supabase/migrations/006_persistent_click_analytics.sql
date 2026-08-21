-- Keep marketer click analytics as an atomic, all-time counter.

create or replace function public.increment_marketer_clicks(marketer_handle text, increment_by bigint default 1)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_clicks bigint;
begin
  if increment_by < 1 then
    raise exception 'increment_by must be positive';
  end if;

  update public.marketers
  set clicks = coalesce(clicks, 0) + increment_by
  where handle = marketer_handle
  returning clicks into new_clicks;

  if new_clicks is null then
    raise exception 'Marketer not found';
  end if;

  return new_clicks;
end;
$$;

revoke all on function public.increment_marketer_clicks(text, bigint) from public;
grant execute on function public.increment_marketer_clicks(text, bigint) to service_role;
