let marketers = [];
let bid = 1;
let minimumBid = 1;
let userHasCustomizedBid = false;

// Unique visitor session identifier for live presence
let sessionId = sessionStorage.getItem('tm_session_id');
if (!sessionId) {
  sessionId = 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem('tm_session_id', sessionId);
}

const bidInput = document.querySelector('#bidInput');
const board = document.querySelector('#leaderboard');
const dialog = document.querySelector('#checkoutDialog');
const handleInput = document.querySelector('#handleInput');
const money = value => `$${Number(value).toLocaleString()}`;
const initials = name => (name || 'X').split(' ').map(part => part[0]).join('').slice(0, 2);

function formatTimeAgo(dateInput) {
  if (!dateInput) return 'recently';
  const date = new Date(dateInput);
  const now = new Date();
  const diffSec = Math.max(1, Math.floor((now - date) / 1000));

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function setBid(value, syncInput = true) {
  const parsed = parseInt(value, 10);
  bid = isNaN(parsed) ? minimumBid : Math.max(minimumBid, parsed);
  if (syncInput && bidInput && document.activeElement !== bidInput) {
    bidInput.value = bid;
  }
}

async function readApiResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('The application API is not running. Start the Node server and try again.');
  }
  return response.json();
}

function trackMarketerClick(handle, index) {
  // Optimistically increment on screen
  if (marketers[index]) {
    marketers[index].clicks = (Number(marketers[index].clicks) || 0) + 1;
    const clickEl = document.querySelector(`#clicks-${index}`);
    if (clickEl) clickEl.textContent = `${marketers[index].clicks.toLocaleString()} clicks`;
  }
  // Send click event to backend non-blockingly
  try {
    fetch('/api/track-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
      keepalive: true
    }).catch(() => {});
  } catch {}
}

function render() {
  if (!marketers.length) {
    board.innerHTML = '<div class="empty-board"><strong>No bids yet</strong><span>Be the first marketer to claim the top position.</span></div>';
    return;
  }
  board.innerHTML = marketers.map((marketer, index) => {
    const handleClean = (marketer.handle || '').replace(/^@/, '');
    const profileUrl = `https://x.com/${encodeURIComponent(handleClean)}`;
    const clicksCount = Number(marketer.clicks || 0);
    const timeAgo = formatTimeAgo(marketer.paidAt);

    return `<a href="${profileUrl}" target="_blank" rel="noopener noreferrer" class="card" onclick="trackMarketerClick('${marketer.handle}', ${index})" aria-label="Visit ${marketer.name}'s X profile (${marketer.handle})">
      <div class="rank-wrap">
        <div class="rank">#${index + 1}</div>
        <div class="identity">
          <div class="avatar" style="--avatar:${marketer.color || '#6558f5'}">
            ${marketer.avatarUrl ? `<img src="${marketer.avatarUrl}" alt="${marketer.name}" onerror="this.remove()" />` : initials(marketer.name)}
          </div>
          <div>
            <h2>${marketer.name}</h2>
            <p>${marketer.title || ''}</p>
            <small>${marketer.handle}${marketer.category ? ` · ${marketer.category}` : ''}</small>
          </div>
        </div>
      </div>
      <div class="metrics">
        <strong>${marketer.followers != null ? Number(marketer.followers).toLocaleString() : '—'}</strong> followers
        <span class="clicks-stat" id="clicks-${index}">${clicksCount.toLocaleString()} clicks</span>
      </div>
      <div class="amount-wrap">
        <div class="amount">${money(marketer.bid)}</div>
        <div class="bid-time" title="${marketer.paidAt ? new Date(marketer.paidAt).toLocaleString() : ''}">⚡ ${timeAgo}</div>
      </div>
    </a>`;
  }).join('');
}

function updateMarket(data = {}) {
  marketers = Array.isArray(data.marketers) ? data.marketers : [];
  const leading = Number(marketers[0]?.bid) || 0;
  minimumBid = Number(data.minimumBid) || 1;
  if (bidInput) bidInput.min = minimumBid;

  const defaultOutbid = leading ? leading + 1 : minimumBid;
  if (!userHasCustomizedBid) {
    setBid(defaultOutbid, true);
  } else {
    setBid(Math.max(minimumBid, bid), true);
  }

  // Update live presence and leaderboard statistics.
  if (data.stats) {
    const onlineEl = document.querySelector('#onlineCount');
    const competingEl = document.querySelector('#competingCount');
    if (onlineEl) onlineEl.textContent = data.stats.online;
    if (competingEl) competingEl.textContent = `${marketers.length} competing`;
  } else {
    const competingEl = document.querySelector('#competingCount');
    if (competingEl) competingEl.textContent = `${marketers.length} competing`;
  }

  document.querySelector('#leadingBid').textContent = leading ? `Current #1 is ${money(leading)}` : 'No bids yet';
  render();
}

async function loadLeaderboard() {
  board.classList.add('refreshing');
  try {
    const response = await fetch(`/api/leaderboard?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
    updateMarket(response.ok ? await response.json() : {});
  } catch { updateMarket(); }
  finally { setTimeout(() => board.classList.remove('refreshing'), 300); }
}

async function handlePaymentRedirect() {
  const params = new URLSearchParams(window.location.search);
  const isPaymentReturn = params.has('payment') || params.has('payment_id') || params.has('bid_id');
  if (!isPaymentReturn) return;

  const paymentId = params.get('payment_id');
  const bidId = params.get('bid_id');
  const toast = document.querySelector('#paymentNotification');

  if (toast) {
    toast.className = 'payment-toast processing';
    toast.innerHTML = '<span>⚡ Verifying payment with Dodo Payments...</span>';
    toast.hidden = false;
  }

  try {
    const query = new URLSearchParams();
    if (paymentId) query.set('payment_id', paymentId);
    if (bidId) query.set('bid_id', bidId);

    const response = await fetch(`/api/verify-payment?${query.toString()}`);
    const data = await readApiResponse(response);

    if (data.verified) {
      if (toast) {
        toast.className = 'payment-toast';
        toast.innerHTML = `<span>🎉 Payment confirmed! <strong>${data.handle || 'Your profile'}</strong> is now live on the leaderboard.</span><button type="button" onclick="this.parentElement.hidden=true">✕</button>`;
      }
      await loadLeaderboard();
      document.querySelector('.leaderboard-section')?.scrollIntoView({ behavior: 'smooth' });
    } else {
      if (toast) {
        toast.className = 'payment-toast processing';
        toast.innerHTML = '<span>⏳ Payment is processing. Refreshing rankings...</span>';
      }
      await loadLeaderboard();
    }
  } catch (err) {
    console.error('Payment verification failed:', err);
    if (toast) {
      toast.className = 'payment-toast';
      toast.innerHTML = '<span>Payment received! Updating leaderboard...</span><button type="button" onclick="this.parentElement.hidden=true">✕</button>';
    }
    await loadLeaderboard();
  } finally {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

function updateBid(change) {
  const highestBid = Number(marketers[0]?.bid) || 0;
  userHasCustomizedBid = true;
  if (change > 0) {
    if (highestBid > 0 && bid <= highestBid) {
      setBid(highestBid + 1, true);
    } else {
      setBid(bid + change, true);
    }
  } else {
    setBid(bid + change, true);
  }
}
function estimatedRank(value) { const index = marketers.findIndex(marketer => value > marketer.bid); return index === -1 ? marketers.length + 1 : index + 1; }
function openCheckout() {
  const handle = handleInput.value.trim();
  if (!handle) { handleInput.focus(); return; }
  document.querySelector('#summaryHandle').textContent = handle;
  document.querySelector('#summaryBid').textContent = money(bid);
  document.querySelector('#summaryRank').textContent = `#${estimatedRank(bid)}`;
  document.querySelector('#configWarning').hidden = true;
  dialog.showModal();
}

async function verifyXProfile() {
  const button = document.querySelector('.submit-bid');
  const field = document.querySelector('.handle-field');
  const preview = document.querySelector('#profilePreview');
  document.querySelector('.handle-error')?.remove();
  field.classList.remove('invalid');
  preview.hidden = true;
  button.disabled = true;
  button.firstChild.textContent = 'Verifying account ';
  try {
    const response = await fetch(`/api/x-profile?handle=${encodeURIComponent(handleInput.value.trim())}`);
    const profile = await readApiResponse(response);
    if (!response.ok) throw new Error(profile.error || 'This X account could not be verified.');
    handleInput.value = profile.handle;
    preview.replaceChildren();
    if (profile.avatarUrl) { const image = document.createElement('img'); image.src = profile.avatarUrl; image.alt = ''; preview.append(image); }
    const details = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = profile.name;
    const metrics = document.createElement('span'); metrics.textContent = `${profile.handle} · ${Number(profile.followers || 0).toLocaleString()} followers`;
    details.append(name, metrics);
    const verified = document.createElement('b'); verified.textContent = 'VERIFIED';
    preview.append(details, verified);
    preview.hidden = false;
    return profile;
  } catch (error) {
    field.classList.add('invalid');
    const message = document.createElement('p'); message.className = 'handle-error'; message.textContent = error.message; field.after(message);
    return null;
  } finally {
    button.disabled = false;
    button.firstChild.textContent = 'Continue to bid ';
  }
}

if (bidInput) {
  bidInput.addEventListener('input', () => {
    userHasCustomizedBid = true;
    const val = parseInt(bidInput.value, 10);
    if (!isNaN(val) && val >= 1) {
      bid = val;
    }
  });
  bidInput.addEventListener('change', () => {
    userHasCustomizedBid = true;
    setBid(bidInput.value, true);
  });
  bidInput.addEventListener('blur', () => {
    setBid(bidInput.value, true);
  });
}

document.querySelector('#minusBid').addEventListener('click', () => updateBid(-1));
document.querySelector('#plusBid').addEventListener('click', () => updateBid(1));
document.querySelector('#quickBidForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (await verifyXProfile()) openCheckout();
});
handleInput.addEventListener('input', () => { document.querySelector('#profilePreview').hidden = true; document.querySelector('.handle-error')?.remove(); document.querySelector('.handle-field').classList.remove('invalid'); });
document.querySelector('#headerBid').addEventListener('click', () => { document.querySelector('.bid-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }); handleInput.focus({ preventScroll: true }); });
document.querySelector('#closeDialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
document.querySelector('#refreshButton').addEventListener('click', loadLeaderboard);
document.querySelector('#dodoCheckout').addEventListener('click', async () => {
  const button = document.querySelector('#dodoCheckout');
  const warning = document.querySelector('#configWarning');
  button.disabled = true; warning.hidden = true;
  try {
    const response = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: handleInput.value.trim(), amount: bid }) });
    const result = await readApiResponse(response);
    if (!response.ok || !result.checkoutUrl) throw new Error(result.error || 'Checkout could not be created.');
    window.location.assign(result.checkoutUrl);
  } catch (error) {
    warning.textContent = error.message || 'Payment setup is not complete yet.';
    warning.hidden = false;
  } finally { button.disabled = false; }
});

render();
loadLeaderboard();
handlePaymentRedirect();

// Send heartbeat every 45 seconds to keep live visitor presence active
setInterval(async () => {
  try {
    const res = await fetch('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    if (res.ok) {
      const stats = await res.json();
      const onlineEl = document.querySelector('#onlineCount');
      if (onlineEl) onlineEl.textContent = stats.online;
    }
  } catch {}
}, 45000);

// Re-render every 30 seconds to update relative bid times
setInterval(() => {
  if (marketers.length) render();
}, 30000);
