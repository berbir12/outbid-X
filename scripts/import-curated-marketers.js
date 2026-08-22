import { createClient } from '@supabase/supabase-js';
import { CURATED_MARKETERS } from '../data/curated-marketers.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function main() {
  const categoryByUsername = new Map(CURATED_MARKETERS.map(item => [item.username.toLowerCase(), item.category]));
  const query = new URLSearchParams({
    usernames: CURATED_MARKETERS.map(item => item.username).join(','),
    'user.fields': 'created_at,description,location,name,profile_image_url,protected,public_metrics,url,username,verified'
  });
  const xResponse = await fetch(`https://api.x.com/2/users/by?${query}`, {
    headers: { Authorization: `Bearer ${required('X_BEARER_TOKEN')}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
  const payload = await xResponse.json().catch(() => ({}));
  if (!xResponse.ok) throw new Error(`X returned ${xResponse.status}: ${payload.detail || payload.title || 'Unknown error'}`);
  const profiles = (payload.data || []).map(user => ({
    handle: `@${user.username}`, x_user_id: user.id, name: user.name,
    bio: user.description || null, category: categoryByUsername.get(user.username.toLowerCase()) || 'Marketing',
    location: user.location || null, website: user.url || null,
    avatar_url: user.profile_image_url?.replace('_normal.', '_400x400.') || null,
    followers: user.public_metrics?.followers_count ?? null,
    x_verified: Boolean(user.verified), x_protected: Boolean(user.protected),
    following_count: user.public_metrics?.following_count ?? null,
    tweet_count: user.public_metrics?.tweet_count ?? null,
    listed_count: user.public_metrics?.listed_count ?? null,
    account_created_at: user.created_at || null, x_profile_synced_at: new Date().toISOString()
  }));
  const supabase = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.from('marketers').upsert(profiles, { onConflict: 'handle' });
  if (error) throw error;
  const returned = new Set(profiles.map(profile => profile.handle.toLowerCase()));
  const unavailable = CURATED_MARKETERS.filter(item => !returned.has(`@${item.username}`.toLowerCase())).map(item => `@${item.username}`);
  console.log(`Imported ${profiles.length}/${CURATED_MARKETERS.length} curated X profiles.`);
  if (unavailable.length) console.log(`Unavailable: ${unavailable.join(', ')}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
