import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import DodoPayments from 'dodopayments';
import { Webhook } from 'standardwebhooks';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 4173;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function services() {
  const supabase = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const dodo = new DodoPayments({ bearerToken: required('DODO_PAYMENTS_API_KEY'), environment: process.env.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' ? 'live_mode' : 'test_mode' });
  return { supabase, dodo };
}

function normalizeHandle(input) {
  const value = String(input || '').trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').split(/[/?#]/)[0];
  const handle = `@${value.replace(/^@/, '')}`;
  if (!/^@[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('Enter a valid X handle.');
  return handle;
}

app.post('/api/webhooks/dodo', express.raw({ type: 'application/json' }), async (request, response) => {
  try {
    const secret = required('DODO_WEBHOOK_SECRET');
    const verifier = new Webhook(secret);
    const payloadText = request.body.toString('utf8');
    const event = verifier.verify(payloadText, {
      'webhook-id': request.get('webhook-id'),
      'webhook-timestamp': request.get('webhook-timestamp'),
      'webhook-signature': request.get('webhook-signature')
    });
    if (!String(event.type).startsWith('payment.')) return response.status(200).json({ received: true });
    const bidId = event.data?.metadata?.bid_id;
    if (!bidId) throw new Error('Webhook is missing bid metadata.');
    const { supabase } = services();
    const { error } = await supabase.rpc('process_dodo_payment', {
      p_webhook_id: request.get('webhook-id'), p_event_type: event.type,
      p_payment_id: event.data.payment_id, p_bid_id: bidId,
      p_amount_cents: event.data.total_amount, p_currency: event.data.currency,
      p_payload: event
    });
    if (error) throw error;
    response.status(200).json({ received: true });
  } catch (error) {
    console.error('Dodo webhook error:', error.message);
    response.status(400).json({ error: 'Invalid webhook.' });
  }
});

app.use(express.json({ limit: '100kb' }));

app.get('/api/leaderboard', async (_request, response) => {
  try {
    const { supabase } = services();
    const { data, error } = await supabase.from('leaderboard').select('*').order('amount_cents', { ascending: false }).order('paid_at', { ascending: true }).limit(100);
    if (error) throw error;
    const marketers = (data || []).map(row => ({
      name: row.name || row.handle.slice(1), handle: row.handle, title: row.title,
      category: row.category, followers: row.followers,
      engagement: row.engagement_rate == null ? null : `${row.engagement_rate}%`,
      bid: row.amount_cents / 100, avatarUrl: row.avatar_url
    }));
    const leadingCents = Number(data?.[0]?.amount_cents) || 0;
    response.json({ marketers, minimumBid: (leadingCents ? leadingCents + 100 : Number(process.env.MINIMUM_BID_CENTS || 100)) / 100 });
  } catch (error) {
    console.error('Leaderboard error:', error.message);
    response.status(503).json({ error: 'Leaderboard is temporarily unavailable.' });
  }
});

app.post('/api/checkout', async (request, response) => {
  let bidId;
  try {
    const { supabase, dodo } = services();
    const handle = normalizeHandle(request.body.handle);
    const amountCents = Math.round(Number(request.body.amount) * 100);
    const minimumCents = Number(process.env.MINIMUM_BID_CENTS || 100);
    const { data: leader } = await supabase.from('bids').select('amount_cents').eq('status', 'paid').order('amount_cents', { ascending: false }).limit(1).maybeSingle();
    const requiredCents = leader?.amount_cents ? Number(leader.amount_cents) + 100 : minimumCents;
    if (!Number.isSafeInteger(amountCents) || amountCents < requiredCents) return response.status(400).json({ error: `Minimum bid is $${(requiredCents / 100).toLocaleString()}.` });

    const { data: marketer, error: marketerError } = await supabase.from('marketers').upsert({ handle }, { onConflict: 'handle' }).select('id').single();
    if (marketerError) throw marketerError;
    bidId = crypto.randomUUID();
    const { error: bidError } = await supabase.from('bids').insert({ id: bidId, marketer_id: marketer.id, amount_cents: amountCents });
    if (bidError) throw bidError;

    const checkout = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: required('DODO_PRODUCT_ID'), quantity: 1, amount: amountCents }],
      metadata: { bid_id: bidId, handle },
      return_url: `${required('APP_URL').replace(/\/$/, '')}/?payment=complete`,
      customization: { theme: 'light', show_order_details: true }
    });
    await supabase.from('bids').update({ dodo_checkout_session_id: checkout.session_id }).eq('id', bidId);
    const { error: paymentError } = await supabase.from('payments').insert({ bid_id: bidId, dodo_checkout_session_id: checkout.session_id, amount_cents: amountCents });
    if (paymentError) throw paymentError;
    response.json({ checkoutUrl: checkout.checkout_url });
  } catch (error) {
    console.error('Checkout error:', error.message);
    response.status(500).json({ error: 'Payment checkout could not be created.' });
  }
});

app.use(express.static(root, { extensions: ['html'] }));
app.listen(port, () => console.log(`Outbid X running on http://localhost:${port}`));
