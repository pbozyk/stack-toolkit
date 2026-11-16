const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Only same-site paths are accepted as the page to return to.
const next = (() => {
  const n = new URLSearchParams(location.search).get('next');
  return n && /^\/[a-z]*(\.html)?$/.test(n) ? n : null;
})();

let config = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function banner(html, cls = 'b-err') {
  $('#banner').innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
}

function crumb(label, s) {
  return `<span class="crumb ${s.configured ? '' : 'missing'}" title="${esc(s.host)}">
    ${icon('layers')}<b>${label}</b>${s.apiKey ? `<code>${esc(s.apiKey)}</code>` : '<em>not connected</em>'}
    ${icon('chevron-right', 'sep')}${icon('git-branch')}${esc(s.branch)}</span>`;
}

async function load() {
  config = await api('/api/config');
  $('#stacks').innerHTML = `${crumb('Source', config.source)}${icon('arrow-right', 'arrow')}${crumb('Target', config.target)}`;
  $('#cards').innerHTML = connectCard('source', config, { disconnect: true }) + connectCard('target', config, { disconnect: true });
  $('#idle').textContent = `${config.session.idleHours} hours`;
  $('#expires').textContent = `This session expires ${new Date(config.session.expiresAt).toLocaleString('en-GB')} at the latest (extended while you use the panel).`;
  if (next && (config.source.configured || config.target.configured)) {
    const PAGES = { '/': 'Home', '/migrations': 'Schema Migration', '/entries': 'Entry Cleanup', '/assets': 'Asset Cleanup' };
    banner(`Connected. <a href="${next}">Continue to ${esc(PAGES[next.replace(/\.html$/, '')] || 'the panel')} →</a>`, 'b-ok');
  }
}

bindConnectForms(() => load());

document.addEventListener('click', async (ev) => {
  const dc = ev.target.closest('[data-disconnect]');
  if (dc) {
    await api(`/api/credentials?side=${dc.dataset.disconnect}`, { method: 'DELETE' }).catch((e) => banner(esc(e.message)));
    return load();
  }
  if (ev.target.closest('#logout')) {
    if (!confirm('Forget all credentials entered in this browser session?')) return;
    await api('/api/logout', { method: 'POST', body: '{}' }).catch((e) => banner(esc(e.message)));
    banner('');
    return load();
  }
});

load().catch((e) => banner(esc(e.message)));
