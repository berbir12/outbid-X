alter table public.marketers
  add column if not exists x_user_id text unique,
  add column if not exists x_verified boolean not null default false,
  add column if not exists x_protected boolean not null default false,
  add column if not exists following_count bigint,
  add column if not exists tweet_count bigint,
  add column if not exists listed_count bigint,
  add column if not exists account_created_at timestamptz,
  add column if not exists x_profile_synced_at timestamptz;
