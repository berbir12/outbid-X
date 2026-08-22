import { createClient } from '@supabase/supabase-js';

const SOURCE_URL = 'https://foundationinc.co/lab/marketers-to-follow';
const USER_FIELDS = 'created_at,description,location,name,profile_image_url,protected,public_metrics,url,username,verified';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function plainText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function extractCandidates(html) {
  const articleStart = html.search(/id=["']copywriter["']/i);
  const articleEnd = html.search(/id=["']next(?:-|_)steps["']/i);
  const article = html.slice(Math.max(0, articleStart), articleEnd > articleStart ? articleEnd : undefined);
  const headingOrLink = /<h2\b[^>]*>([\s\S]*?)<\/h2>|<a\b[^>]*href=["']https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#][^"']*)?["'][^>]*>/gi;
  const ignored = new Set(['home', 'share', 'intent', 'search', 'i', 'hashtag']);
  const candidates = new Map();
  let category = 'Marketing';
  let match;
  while ((match = headingOrLink.exec(article))) {
    if (match[1]) {
      const heading = plainText(match[1]);
      if (heading && heading.length < 60) category = heading;
    } else if (match[2] && !ignored.has(match[2].toLowerCase())) {
      const key = match[2].toLowerCase();
      if (!candidates.has(key)) candidates.set(key, { username: match[2], category });
    }
  }
  return [...candidates.values()];
}

async function fetchProfiles(candidates) {
  const profiles = [];
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const categories = new Map(batch.map(item => [item.username.toLowerCase(), item.category]));
    const query = new URLSearchParams({ usernames: batch.map(item => item.username).join(','), 'user.fields': USER_FIELDS });
    const response = await fetch(`https://api.x.com/2/users/by?${query}`, {
      headers: { Authorization: `Bearer ${required('X_BEARER_TOKEN')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`X batch lookup failed (${response.status}): ${payload.detail || payload.title || 'Unknown error'}`);
    for (const user of payload.data || []) {
      profiles.push({
        handle: `@${user.username}`, x_user_id: user.id, name: user.name,
        bio: user.description || null, category: categories.get(user.username.toLowerCase()) || 'Marketing',
        location: user.location || null, website: user.url || null,
        avatar_url: user.profile_image_url?.replace('_normal.', '_400x400.') || null,
        followers: user.public_metrics?.followers_count ?? null,
        x_verified: Boolean(user.verified), x_protected: Boolean(user.protected),
        following_count: user.public_metrics?.following_count ?? null,
        tweet_count: user.public_metrics?.tweet_count ?? null,
        listed_count: user.public_metrics?.listed_count ?? null,
        account_created_at: user.created_at || null, x_profile_synced_at: new Date().toISOString()
      });
    }
    console.log(`Fetched ${Math.min(offset + batch.length, candidates.length)}/${candidates.length} candidates from X.`);
  }
  return profiles;
}

async function main() {
  const sourceResponse = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'TopMarketersDirectory/1.0' }, signal: AbortSignal.timeout(30000) });
  if (!sourceResponse.ok) throw new Error(`Foundation source returned ${sourceResponse.status}.`);
  const candidates = extractCandidates(await sourceResponse.text());
  if (!candidates.length) throw new Error('No X handles were found on the source page; its markup may have changed.');
  console.log(`Found ${candidates.length} unique candidates on Foundation.`);
  const profiles = await fetchProfiles(candidates);
  const supabase = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await supabase.from('marketers').upsert(profiles, { onConflict: 'handle' });
  if (error) throw error;
  console.log(`Imported ${profiles.length} current public X profiles. ${candidates.length - profiles.length} unavailable accounts were skipped.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
