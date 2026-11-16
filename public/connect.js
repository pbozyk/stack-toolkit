// Shared "connect a stack" card – used on the Stacks page and inline wherever a needed stack is missing.
// Needs icons.js. The token goes straight to the server and is never kept in the page.

const CONNECT_SIDES = { source: 'Source stack', target: 'Target stack' };
const CONNECT_HINT = {
  source: 'The stack you work on – schemas are copied from it, and the cleanups run on it.',
  target: 'Optional – only needed for Schema Migration, as the stack schemas are copied to.',
};
const cEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function connectStatus(s) {
  if (!s.configured) return '<span class="pill s-same">Not connected</span>';
  return s.origin === 'env'
    ? '<span class="pill s-target_only">Connected from .env</span>'
    : '<span class="pill s-new">Connected for this session</span>';
}

function connectCard(side, config, { disconnect = false } = {}) {
  const s = config[side];
  const regions = config.regions.map((r) => `<option value="${r}" ${r === s.region ? 'selected' : ''}>${r}</option>`).join('');
  return `<section class="section stack-card">
    <div class="section-head">${CONNECT_SIDES[side]} <span class="spacer"></span>${connectStatus(s)}</div>
    <form class="card-body" data-connect-side="${side}" autocomplete="off">
      <p class="none">${CONNECT_HINT[side]}${s.configured ? ` Currently: <code>${cEsc(s.apiKey)}</code> · ${cEsc(s.host)} · ${cEsc(s.branch)}.` : ''}
        ${s.origin === 'env' ? 'Values entered here override .env for your session only.' : ''}</p>
      <label class="form-field"><span class="lbl">Region <span class="req">(required)</span></span>
        <select name="region">${regions}</select></label>
      <label class="form-field"><span class="lbl">API key <span class="req">(required)</span></span>
        <input name="apiKey" placeholder="blt…" spellcheck="false" autocomplete="off"></label>
      <label class="form-field"><span class="lbl">Management token <span class="req">(required)</span></span>
        <span class="secret"><input name="token" type="password" placeholder="cs…" spellcheck="false" autocomplete="new-password">
        <button type="button" class="icon-btn" data-reveal title="Show / hide">${icon('eye')}</button></span></label>
      <label class="form-field"><span class="lbl">Branch</span>
        <input name="branch" value="${cEsc(s.origin === 'session' ? s.branch : 'main')}" spellcheck="false"></label>
      <div class="form-error" hidden></div>
      <div class="card-actions">
        <button class="btn primary" type="submit">${icon('key-round')}${s.configured ? 'Reconnect' : 'Connect'}</button>
        ${disconnect && s.origin === 'session' ? `<button class="btn" type="button" data-disconnect="${side}">${icon('unplug')}Disconnect</button>` : ''}
      </div>
    </form>
  </section>`;
}

// Handles submit and show/hide for every connect card on the page; onConnected(side) runs after a success.
function bindConnectForms(onConnected) {
  document.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('[data-connect-side]');
    if (!form) return;
    ev.preventDefault();
    const err = form.querySelector('.form-error');
    const btn = form.querySelector('[type=submit]');
    err.hidden = true;
    btn.disabled = true;
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ side: form.dataset.connectSide, ...Object.fromEntries(new FormData(form)) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      form.reset();
      await onConnected(form.dataset.connectSide);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  document.addEventListener('click', (ev) => {
    const reveal = ev.target.closest('[data-reveal]');
    if (!reveal) return;
    const input = reveal.previousElementSibling;
    input.type = input.type === 'password' ? 'text' : 'password';
    reveal.innerHTML = icon(input.type === 'password' ? 'eye' : 'eye-off');
  });
}
