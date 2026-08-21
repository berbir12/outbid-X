let marketers = [];
let bid = 1;
let minimumBid = 1;

const bidInput = document.querySelector('#bidInput');
const board = document.querySelector('#leaderboard');
const dialog = document.querySelector('#checkoutDialog');
const handleInput = document.querySelector('#handleInput');
const money = value => `$${Number(value).toLocaleString()}`;
const initials = name => (name || 'X').split(' ').map(part => part[0]).join('').slice(0, 2);

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

function render() {
  if (!marketers.length) {
    board.innerHTML = '<div class="empty-board"><strong>No bids yet</strong><span>Be the first marketer to claim the top position.</span></div>';
    return;
  }
  board.innerHTML = marketers.map((marketer, index) => {
    const handleClean = (marketer.handle || '').replace(/^@/, '');
    const profileUrl = `https://x.com/${encodeURIComponent(handleClean)}`;
    return `<a href="${profileUrl}" target="_blank" rel="noopener noreferrer" class="card" aria-label="Visit ${marketer.name}'s X profile (${marketer.handle})">
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
      <div class="metrics"><strong>${marketer.followers != null ? Number(marketer.followers).toLocaleString() : '—'}</strong> followers<br><strong>${marketer.engagement || '—'}</strong> engagement</div>
      <div class="amount">${money(marketer.bid)}</div>
    </a>`;
  }).join('');
}

let userHasCustomizedBid = false;

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

  document.querySelector('#leadingBid').textContent = leading ? `Current #1 is ${money(leading)}` : 'No bids yet';
  document.querySelector('.top-status strong').textContent = `${marketers.length} competing`;
  render();
}

async function loadLeaderboard() {
  board.classList.add('refreshing');
  try {
    const response = await fetch('/api/leaderboard', { cache: 'no-store', headers: { Accept: 'application/json' } });
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
