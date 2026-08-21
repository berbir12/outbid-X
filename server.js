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

async function fetchXProfile(input) {
  const handle = normalizeHandle(input);
  const username = handle.slice(1);
  const fields = 'created_at,description,entities,location,name,profile_image_url,protected,public_metrics,url,username,verified';
  const xResponse = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(username)}?user.fields=${encodeURIComponent(fields)}`, {
    headers: { Authorization: `Bearer ${required('X_BEARER_TOKEN')}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  const payload = await xResponse.json().catch(() => ({}));
  if (xResponse.status === 404 || (!payload.data && payload.errors?.length)) {
    const error = new Error('That X account does not exist.'); error.status = 404; throw error;
  }
  if (xResponse.status === 429) {
    const error = new Error('X lookup limit reached. Try again shortly.'); error.status = 429; throw error;
  }
  if (xResponse.status === 401) {
    const error = new Error('X rejected the API token. Check the X_BEARER_TOKEN production environment variable.'); error.status = 502; throw error;
  }
  if (xResponse.status === 403) {
    const error = new Error('The X developer app does not have access to user lookup. Check the app plan and permissions.'); error.status = 502; throw error;
  }
  if (xResponse.status === 402) {
    const error = new Error('X API credits are required to verify accounts. Add credits in the X Developer Console.'); error.status = 502; throw error;
  }
  if (!xResponse.ok || !payload.data) {
    console.error('X lookup failed:', xResponse.status, payload.errors?.[0]?.title || payload.title || 'Unknown X API error');
    const error = new Error(`X profile lookup failed with API status ${xResponse.status}.`); error.status = 502; throw error;
  }
  const user = payload.data;
  return {
    xUserId: user.id, handle: `@${user.username}`, name: user.name,
    bio: user.description || null, location: user.location || null, website: user.url || null,
    avatarUrl: user.profile_image_url?.replace('_normal.', '_400x400.') || null,
    followers: user.public_metrics?.followers_count ?? null,
    following: user.public_metrics?.following_count ?? null,
    tweets: user.public_metrics?.tweet_count ?? null,
    listed: user.public_metrics?.listed_count ?? null,
    verified: Boolean(user.verified), protected: Boolean(user.protected),
    accountCreatedAt: user.created_at || null
  };
}

async function applySuccessfulPayment(supabase, { bidId, paymentId, checkoutSessionId, amountCents, currency, payload, webhookId }) {
  let targetBidId = bidId;

  // If bidId is missing, attempt to resolve via checkout_session_id or payment_id
  if (!targetBidId && checkoutSessionId) {
    const { data: b } = await supabase.from('bids').select('id, amount_cents').eq('dodo_checkout_session_id', checkoutSessionId).maybeSingle();
    if (b) targetBidId = b.id;
  }
  if (!targetBidId && paymentId) {
    const { data: p } = await supabase.from('payments').select('bid_id, amount_cents').eq('dodo_payment_id', paymentId).maybeSingle();
    if (p) targetBidId = p.bid_id;
  }

  if (!targetBidId) {
    console.warn('applySuccessfulPayment: Unable to find target bid for', { bidId, paymentId, checkoutSessionId });
    return { success: false, error: 'Target bid not found' };
  }

  // Try RPC first
  try {
    const { error: rpcError } = await supabase.rpc('process_dodo_payment', {
      p_webhook_id: webhookId || `manual_${paymentId || targetBidId}_${Date.now()}`,
      p_event_type: 'payment.succeeded',
      p_payment_id: paymentId || null,
      p_bid_id: targetBidId,
      p_amount_cents: amountCents || 0,
      p_currency: currency || 'USD',
      p_payload: payload || {}
    });
    if (!rpcError) return { success: true, bidId: targetBidId };
    console.warn('RPC process_dodo_payment had an error, using direct DB update:', rpcError.message);
  } catch (err) {
    console.warn('RPC call threw exception, falling back to direct DB update:', err.message);
  }

  // Direct DB update fallback
  const now = new Date().toISOString();
  const { error: bidUpdateError } = await supabase.from('bids').update({
    status: 'paid',
    paid_at: now,
    updated_at: now
  }).eq('id', targetBidId);

  if (bidUpdateError) throw bidUpdateError;

  await supabase.from('payments').update({
    dodo_payment_id: paymentId || null,
    amount_cents: amountCents || 0,
    currency: currency || 'USD',
    status: 'succeeded',
    raw_payload: payload || {},
    updated_at: now
  }).eq('bid_id', targetBidId);

  return { success: true, bidId: targetBidId };
}

app.post('/api/webhooks/dodo', express.raw({ type: 'application/json' }), async (request, response) => {
  try {
    const secret = required('DODO_WEBHOOK_SECRET');
    const verifier = new Webhook(secret);
    const payloadText = Buffer.isBuffer(request.body)
      ? request.body.toString('utf8')
      : typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body);

    const event = verifier.verify(payloadText, {
      'webhook-id': request.get('webhook-id') || request.get('Webhook-Id') || request.get('svix-id'),
      'webhook-timestamp': request.get('webhook-timestamp') || request.get('Webhook-Timestamp') || request.get('svix-timestamp'),
      'webhook-signature': request.get('webhook-signature') || request.get('Webhook-Signature') || request.get('svix-signature')
    });

    if (!String(event.type).startsWith('payment.')) return response.status(200).json({ received: true });

    const { supabase } = services();
    const bidId = event.data?.metadata?.bid_id;
    const checkoutSessionId = event.data?.checkout_session_id;
    const paymentId = event.data?.payment_id;
    const amountCents = event.data?.total_amount;
    const currency = event.data?.currency;

    if (event.type === 'payment.succeeded') {
      await applySuccessfulPayment(supabase, {
        bidId,
        paymentId,
        checkoutSessionId,
        amountCents,
        currency,
        payload: event,
        webhookId: request.get('webhook-id') || request.get('Webhook-Id') || request.get('svix-id')
      });
    } else {
      await supabase.rpc('process_dodo_payment', {
        p_webhook_id: request.get('webhook-id') || request.get('Webhook-Id') || `wh_${Date.now()}`,
        p_event_type: event.type,
        p_payment_id: paymentId,
        p_bid_id: bidId,
        p_amount_cents: amountCents,
        p_currency: currency,
        p_payload: event
      }).catch(err => console.warn('Non-success webhook error:', err.message));
    }

    response.status(200).json({ received: true });
  } catch (error) {
    console.error('Dodo webhook error:', error.message);
    response.status(400).json({ error: 'Invalid webhook.' });
  }
});

app.use(express.json({ limit: '100kb' }));

app.get('/api/verify-payment', async (request, response) => {
  try {
    const paymentId = request.query.payment_id;
    const checkoutSessionId = request.query.checkout_session_id || request.query.session_id;
    const bidId = request.query.bid_id;

    const { supabase, dodo } = services();

    // If payment_id is provided, verify directly with Dodo Payments API
    if (paymentId) {
      const payment = await dodo.payments.retrieve(paymentId);
      if (payment && payment.status === 'succeeded') {
        const resolvedBidId = payment.metadata?.bid_id || bidId;
        const result = await applySuccessfulPayment(supabase, {
          bidId: resolvedBidId,
          paymentId: payment.payment_id,
          checkoutSessionId: payment.checkout_session_id,
          amountCents: payment.total_amount,
          currency: payment.currency,
          payload: payment
        });
        return response.json({
          verified: true,
          status: 'paid',
          handle: payment.metadata?.handle,
          amount: payment.total_amount / 100,
          bidId: result.bidId
        });
      }
      return response.json({ verified: false, status: payment?.status || 'unknown' });
    }

    // Check bid status directly in Supabase
    if (bidId || checkoutSessionId) {
      let query = supabase.from('bids').select('*, marketers(*)');
      if (bidId) query = query.eq('id', bidId);
      else if (checkoutSessionId) query = query.eq('dodo_checkout_session_id', checkoutSessionId);
      const { data: bid, error } = await query.maybeSingle();
      if (error) throw error;
      if (bid) {
        return response.json({
          verified: bid.status === 'paid',
          status: bid.status,
          handle: bid.marketers?.handle,
          amount: bid.amount_cents / 100,
          bidId: bid.id
        });
      }
    }

    response.status(400).json({ error: 'Provide payment_id, checkout_session_id, or bid_id.' });
  } catch (error) {
    console.error('Verify payment error:', error.message);
    response.status(500).json({ error: error.message || 'Could not verify payment.' });
  }
});

app.get('/api/x-profile', async (request, response) => {
  try { response.json(await fetchXProfile(request.query.handle)); }
  catch (error) { response.status(error.status || 500).json({ error: error.message || 'Profile verification failed.' }); }
});

const activeSessions = new Map();
const clicksMap = new Map();

// Increment the persistent view counter in Supabase and return the new total.
// Falls back to an in-memory counter if the analytics table doesn't exist yet.
let fallbackViews = 0;
async function incrementTotalViews(supabase) {
  try {
    const { data, error } = await supabase.rpc('increment_analytics', { key_name: 'total_views' });
    if (!error && data != null) return Number(data);
  } catch { /* fall through */ }
  // Fallback: in-memory (resets on restart but won't crash)
  fallbackViews += 1;
  return fallbackViews;
}

async function getTotalViews(supabase) {
  try {
    const { data, error } = await supabase.from('analytics').select('value').eq('key', 'total_views').single();
    if (!error && data) return Number(data.value);
  } catch { /* fall through */ }
  return fallbackViews;
}

function getOnlineCount() {
  const now = Date.now();
  for (const [id, time] of activeSessions.entries()) {
    if (now - time > 120000) activeSessions.delete(id);
  }
  return activeSessions.size;
}

app.post('/api/heartbeat', async (request, response) => {
  const sessionId = request.body?.sessionId || request.headers['x-session-id'] || request.ip;
  let totalViews = fallbackViews;
  try {
    const { supabase } = services();
    const isNew = !activeSessions.has(sessionId);
    activeSessions.set(sessionId, Date.now());
    if (isNew) {
      totalViews = await incrementTotalViews(supabase);
    } else {
      totalViews = await getTotalViews(supabase);
    }
  } catch { /* ignore */ }
  response.json({ online: getOnlineCount(), totalViews });
});

app.post('/api/track-click', async (request, response) => {
  try {
    const handle = request.body?.handle;
    if (!handle) return response.status(400).json({ error: 'Handle required' });

    // Persist clicks atomically. Keep an in-memory delta only while the database
    // is unavailable so a restart never makes successfully stored clicks vanish.
    try {
      const { supabase } = services();
      const pendingClicks = clicksMap.get(handle) || 0;
      const { data, error } = await supabase.rpc('increment_marketer_clicks', {
        marketer_handle: handle,
        increment_by: pendingClicks + 1
      });
      if (error) throw error;
      clicksMap.delete(handle);
      return response.json({ success: true, clicks: Number(data) });
    } catch (error) {
      console.warn('Using temporary click counter:', error.message);
      const current = (clicksMap.get(handle) || 0) + 1;
      clicksMap.set(handle, current);
      return response.json({ success: true, clicks: current, pending: true });
    }
  } catch (err) {
    console.error('Click tracking error:', err.message);
    response.status(500).json({ error: 'Failed to record click' });
  }
});

app.get('/api/leaderboard', async (request, response) => {
  try {
    const sessionId = request.query?.sessionId || request.headers['x-session-id'];
    const { supabase } = services();

    // Record presence and get persistent view count
    let totalViews = fallbackViews;
    if (sessionId) {
      const isNew = !activeSessions.has(sessionId);
      activeSessions.set(sessionId, Date.now());
      if (isNew) {
        totalViews = await incrementTotalViews(supabase);
      } else {
        totalViews = await getTotalViews(supabase);
      }
    } else {
      totalViews = await getTotalViews(supabase);
    }
    const { data, error } = await supabase.from('leaderboard').select('*').order('amount_cents', { ascending: false }).order('paid_at', { ascending: true }).limit(100);
    if (error) throw error;
    const marketers = (data || []).map(row => ({
      name: row.name || row.handle.slice(1),
      handle: row.handle,
      title: row.title,
      category: row.category,
      followers: row.followers,
      clicks: (Number(row.clicks) || 0) + (clicksMap.get(row.handle) || 0),
      paidAt: row.paid_at,
      engagement: row.engagement_rate == null ? null : `${row.engagement_rate}%`,
      bid: row.amount_cents / 100,
      avatarUrl: row.avatar_url
    }));
    const stats = { online: getOnlineCount(), totalViews };
    response.json({
      marketers,
      minimumBid: Number(process.env.MINIMUM_BID_CENTS || 100) / 100,
      stats: {
        ...stats,
        competing: marketers.length
      }
    });
  } catch (error) {
    console.error('Leaderboard error:', error.message);
    response.status(503).json({ error: 'Leaderboard is temporarily unavailable.' });
  }
});

app.post('/api/checkout', async (request, response) => {
  let bidId;
  try {
    const { supabase, dodo } = services();
    const xProfile = await fetchXProfile(request.body.handle);
    const handle = xProfile.handle;
    const amountCents = Math.round(Number(request.body.amount) * 100);
    const minimumCents = Number(process.env.MINIMUM_BID_CENTS || 100);
    const requiredCents = minimumCents;
    if (!Number.isSafeInteger(amountCents) || amountCents < requiredCents) return response.status(400).json({ error: `Minimum bid is $${(requiredCents / 100).toLocaleString()}.` });

    const { data: marketer, error: marketerError } = await supabase.from('marketers').upsert({
      handle, x_user_id: xProfile.xUserId, name: xProfile.name, bio: xProfile.bio,
      location: xProfile.location, website: xProfile.website, avatar_url: xProfile.avatarUrl,
      followers: xProfile.followers, x_verified: xProfile.verified, x_protected: xProfile.protected,
      following_count: xProfile.following, tweet_count: xProfile.tweets, listed_count: xProfile.listed,
      account_created_at: xProfile.accountCreatedAt, x_profile_synced_at: new Date().toISOString()
    }, { onConflict: 'handle' }).select('id').single();
    if (marketerError) throw marketerError;
    bidId = crypto.randomUUID();
    const { error: bidError } = await supabase.from('bids').insert({ id: bidId, marketer_id: marketer.id, amount_cents: amountCents });
    if (bidError) throw bidError;

    const checkout = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: required('DODO_PRODUCT_ID'), quantity: 1, amount: amountCents }],
      metadata: { bid_id: bidId, handle },
      return_url: `${required('APP_URL').replace(/\/$/, '')}/?payment=complete&bid_id=${bidId}`,
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

export default app;

if (!process.env.VERCEL) {
  app.listen(port, () => console.log(`Top Marketers running on http://localhost:${port}`));
}
