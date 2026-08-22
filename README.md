# Outbid X

## Local setup

1. Copy `.env.example` to `.env.local` and fill in the Supabase and Dodo values.
2. In Supabase, open **SQL Editor** and run both migrations in order: `001_outbid_x.sql`, then `002_x_profiles.sql`.
3. In Dodo Payments, use a **One Time** product with **Pay What You Want** enabled and a minimum price of `$1`.
4. Add a Dodo webhook pointing to `https://YOUR_DOMAIN/api/webhooks/dodo` and subscribe to:
   - `payment.succeeded`
   - `payment.processing`
   - `payment.failed`
   - `payment.cancelled`
5. Put the webhook signing secret in `DODO_WEBHOOK_SECRET`.
6. Run `npm run dev`.

## DataFast analytics

The official `datafast` SDK records page views for website `dfid_1z9kdsJAlIyP9h5JcvBPk`. Configure `DATAFAST_API_KEY` for the server-side realtime online visitor count. A website API key beginning with `df_` needs no other setting. For a `dft_` account token with `analytics:read` access, also configure `DATAFAST_WEBSITE_ID` with DataFast's internal website ID.

## X profile verification

Create an app in the X Developer Console, copy its app-only Bearer Token, and set `X_BEARER_TOKEN` in `.env.local`. Outbid X uses the official `GET /2/users/by/username/:username` endpoint to validate the account and fetch its public profile fields before checkout. The token remains server-side.

To refresh the discovery directory from Foundation's public marketers-to-follow list and current X profile data, run:

```sh
npm run import:marketers
```

Sponsored profiles are ranked by verified paid bids. All other imported profiles are shuffled deterministically once per UTC day.

## Data and payment flow

- `marketers` stores X profiles, metrics, industries, and campaign history.
- `bids` stores every attempted bid and its ranking status.
- `payments` stores Dodo checkout sessions and verified transactions.
- `webhook_events` prevents the same Dodo event from being processed twice.
- `leaderboard` exposes only bids confirmed as paid.

The browser never receives the Supabase service-role key, Dodo API key, or webhook secret. A bid is not ranked until a signed Dodo `payment.succeeded` webhook is verified and the paid amount matches the expected bid exactly.
