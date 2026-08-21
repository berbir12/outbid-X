# Outbid X

## Local setup

1. Copy `.env.example` to `.env.local` and fill in the Supabase and Dodo values.
2. In Supabase, open **SQL Editor**, paste `supabase/migrations/001_outbid_x.sql`, and run it once.
3. In Dodo Payments, use a **One Time** product with **Pay What You Want** enabled and a minimum price of `$1`.
4. Add a Dodo webhook pointing to `https://YOUR_DOMAIN/api/webhooks/dodo` and subscribe to:
   - `payment.succeeded`
   - `payment.processing`
   - `payment.failed`
   - `payment.cancelled`
5. Put the webhook signing secret in `DODO_WEBHOOK_SECRET`.
6. Run `npm run dev`.

## Data and payment flow

- `marketers` stores X profiles, metrics, industries, and campaign history.
- `bids` stores every attempted bid and its ranking status.
- `payments` stores Dodo checkout sessions and verified transactions.
- `webhook_events` prevents the same Dodo event from being processed twice.
- `leaderboard` exposes only bids confirmed as paid.

The browser never receives the Supabase service-role key, Dodo API key, or webhook secret. A bid is not ranked until a signed Dodo `payment.succeeded` webhook is verified and the paid amount matches the expected bid exactly.
