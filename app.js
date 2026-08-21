let marketers = [];
let bid = 1;
let minimumBid = 1;

const price = document.querySelector('#claimPrice');
const board = document.querySelector('#leaderboard');
const dialog = document.querySelector('#checkoutDialog');
const handleInput = document.querySelector('#handleInput');
const money = value => `$${Number(value).toLocaleString()}`;
const initials = name => name.split(' ').map(part => part[0]).join('').slice(0, 2);

function render() {
  if (!marketers.length) {
    board.innerHTML = '<div class="empty-board"><strong>No bids yet</strong><span>Be the first marketer to claim the top position.</span></div>';
    return;
  }
  board.innerHTML = marketers.map((marketer, index) => `<article class="card">
    <div class="rank-wrap"><div class="rank">#${index + 1}</div><div class="identity"><div class="avatar" style="--avatar:${marketer.color || '#6558f5'}">${initials(marketer.name)}</div><div><h2>${marketer.name}</h2><p>${marketer.title || ''}</p><small>${marketer.handle}${marketer.category ? ` · ${marketer.category}` : ''}</small></div></div></div>
    <div class="metrics"><strong>${marketer.followers || '—'}</strong> followers<br><strong>${marketer.engagement || '—'}</strong> engagement</div>
    <div class="amount">${money(marketer.bid)}</div>
  </article>`).join('');
}

function updateMarket(data = {}) {
  marketers = Array.isArray(data.marketers) ? data.marketers : [];
  const leading = Number(marketers[0]?.bid) || 0;
  minimumBid = Number(data.minimumBid) || 1;
  bid = minimumBid;
  price.textContent = money(bid);
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

function updateBid(change) { bid = Math.max(minimumBid, bid + change); price.textContent = money(bid); }
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
    const profile = await response.json();
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
    const result = await response.json();
    if (!response.ok || !result.checkoutUrl) throw new Error(result.error || 'Checkout could not be created.');
    window.location.assign(result.checkoutUrl);
  } catch (error) {
    warning.textContent = error.message || 'Payment setup is not complete yet.';
    warning.hidden = false;
  } finally { button.disabled = false; }
});

render();
loadLeaderboard();
