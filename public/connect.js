// Shared "connect a stack" card – used on the Stacks page and inline wherever a needed stack is missing.
// Needs icons.js. The token goes straight to the server and is never kept in the page.

const CONNECT_SIDES = { source: 'Source stack', target: 'Target stack' };
const CONNECT_HINT = {
  source: 'The stack you work on – schemas are copied from it, and the cleanups run on it.',
  target: 'Optional – only needed for Schema Migration, as the stack schemas are copied to.',
};
// Paste a .env file into any field: SOURCE_* / TARGET_* lines fill their cards, unprefixed or other prefixes
// (e.g. CONTENTSTACK_API_KEY) fill the card pasted into.
const ENV_FIELD = { REGION: 'region', API_HOST: 'region', API_KEY: 'apiKey', MANAGEMENT_TOKEN: 'token', BRANCH: 'branch' };
let connectRegionHosts = {};
const cEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function connectStatus(s) {
  if (!s.configured) return '<span class="pill s-same">Not connected</span>';
  return s.origin === 'env'
    ? '<span class="pill s-target_only">Connected from .env</span>'
    : '<span class="pill s-new">Connected for this session</span>';
}

function connectCard(side, config, { disconnect = false } = {}) {
  const s = config[side];
  connectRegionHosts = config.regionHosts || {};
  const regions = config.regions.map((r) => `<option value="${r}" ${r === s.region ? 'selected' : ''}>${r}</option>`).join('');
  return `<section class="section stack-card">
    <div class="section-head">${CONNECT_SIDES[side]} <span class="spacer"></span>${connectStatus(s)}</div>
    <form class="card-body" data-connect-side="${side}" autocomplete="off">
      <p class="none">${CONNECT_HINT[side]}${s.configured ? ` Currently: <code>${cEsc(s.apiKey)}</code> · ${cEsc(s.host)} · ${cEsc(s.branch)}.` : ''}
        ${s.origin === 'env' ? 'Values entered here override .env for your session only.' : ''}</p>
      <p class="paste-tip">${icon('clipboard-paste')}<span>Tip: paste your <code>.env</code> into any field to fill the form.</span></p>
      <label class="form-field"><span class="lbl">Region <span class="req">(required)</span></span>
        <select name="region">${regions}</select></label>
      <label class="form-field"><span class="lbl">API key <span class="req">(required)</span></span>
        <input name="apiKey" placeholder="blt…" spellcheck="false" autocomplete="off"></label>
      <label class="form-field"><span class="lbl">Management token <span class="req">(required)</span></span>
        <span class="secret"><input name="token" type="password" placeholder="cs…" spellcheck="false" autocomplete="new-password">
        <button type="button" class="icon-btn" data-reveal title="Show / hide">${icon('eye')}</button></span></label>
      <label class="form-field"><span class="lbl">Branch</span>
        <input name="branch" value="${cEsc(s.origin === 'session' ? s.branch : 'main')}" spellcheck="false"></label>
      <div class="form-note" hidden></div>
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
      // Re-rendering the cards must not lose what was filled into the other card (e.g. from one pasted .env).
      const others = [...document.querySelectorAll('[data-connect-side]')].filter((f) => f !== form)
        .map((f) => [f.dataset.connectSide, Object.fromEntries(new FormData(f)), !f.querySelector('.form-note').hidden && f.querySelector('.form-note').innerHTML]);
      await onConnected(form.dataset.connectSide);
      for (const [side, values, note] of others) {
        const f = document.querySelector(`[data-connect-side="${side}"]`);
        if (!f) continue;
        for (const [k, v] of Object.entries(values)) if (v && f.elements[k]) f.elements[k].value = v;
        if (note) Object.assign(f.querySelector('.form-note'), { innerHTML: note, hidden: false });
      }
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

function parseEnv(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*?)\s*$/);
    if (!m) continue;
    const quoted = m[2].match(/^(['"])(.*)\1(?:\s+#.*)?$/);
    vars[m[1].toUpperCase()] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '');
  }
  return vars;
}

// "eu", "EU", "us" or a full host like eu-api.contentstack.com → a region from the list, or null.
function toRegion(value) {
  const v = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (v === 'us') return 'na';
  if (v in connectRegionHosts) return v;
  return Object.keys(connectRegionHosts).find((r) => connectRegionHosts[r] === v) || null;
}

function fillFromEnv(pastedInto, text) {
  const forms = Object.fromEntries([...document.querySelectorAll('[data-connect-side]')].map((f) => [f.dataset.connectSide, f]));
  const filled = {}; // side → { field: value }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (!value) continue;
    const field = Object.keys(ENV_FIELD).find((f) => key === f || key.endsWith(`_${f}`));
    if (!field) continue;
    const side = key.startsWith('SOURCE_') ? 'source' : key.startsWith('TARGET_') ? 'target' : pastedInto.dataset.connectSide;
    // A more specific key (…_REGION) wins over a host for the same field.
    if (ENV_FIELD[field] === 'region' && field !== 'REGION' && filled[side]?.region) continue;
    (filled[side] ||= {})[ENV_FIELD[field]] = value;
  }
  const sides = Object.keys(filled).filter((side) => forms[side]);
  for (const side of sides) {
    const form = forms[side];
    const notes = [];
    for (const [name, value] of Object.entries(filled[side])) {
      const v = name === 'region' ? toRegion(value) : value.trim();
      if (!v) { notes.push(`unknown region “${cEsc(value)}”`); continue; }
      form.elements[name].value = v;
      form.elements[name].classList.remove('just-filled');
      void form.elements[name].offsetWidth; // restart the highlight animation
      form.elements[name].classList.add('just-filled');
    }
    const missing = ['apiKey', 'token'].filter((n) => !form.elements[n].value).map((n) => (n === 'token' ? 'management token' : 'API key'));
    const note = form.querySelector('.form-note');
    note.innerHTML = `${icon('circle-check')}<span>Filled from the pasted .env${missing.length ? ` – still missing: ${missing.join(', ')}` : ''}${notes.length ? ` – ${notes.join(', ')}` : ''}. Check it and connect.</span>`;
    note.hidden = false;
  }
  return sides.length > 0;
}

document.addEventListener('paste', (ev) => {
  const form = ev.target.closest?.('[data-connect-side]');
  if (!form) return;
  const text = ev.clipboardData?.getData('text') || '';
  if (!/[=:]/.test(text)) return;
  if (fillFromEnv(form, text)) ev.preventDefault();
});
