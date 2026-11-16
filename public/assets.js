const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let config = null;
let scan = null; // last scan result of the selected stack
let statusView = 'unused';
let typeView = '';
const selected = new Set();
let busy = false;

const STATUS_LABEL = { unused: 'Unused', used: 'Used', unknown: 'Not verified', '': 'All assets' };
const TYPE_LABEL = { '': 'All types', image: 'Images', video: 'Videos', document: 'Documents', other: 'Other' };

const statusOf = (a) => (a.unverified ? 'unknown' : a.useCount ? 'used' : 'unused');
const typeOf = (a) => {
  const t = a.content_type || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t === 'application/pdf' || t.startsWith('text/') || t.includes('document') || t.includes('sheet')) return 'document';
  return 'other';
};
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-GB') : '');
const sum = (list) => list.reduce((n, a) => n + a.file_size, 0);

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function banner(html, cls = 'b-err') {
  $('#banner').innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
}

// Reads NDJSON lines from a streaming response.
async function readStream(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l.trim()) onLine(JSON.parse(l));
  }
}

const currentStack = () => document.querySelector('[data-stack].active')?.dataset.stack || 'source';

function crumb(label, s) {
  return `<span class="crumb ${s.configured ? '' : 'missing'}" title="${esc(s.host)}">
    ${icon('layers')}<b>${label}</b>${s.apiKey ? `<code>${esc(s.apiKey)}</code>` : '<em>not connected</em>'}
    ${icon('chevron-right', 'sep')}${icon('git-branch')}${esc(s.branch)}</span>`;
}

async function selectStack(stack) {
  for (const b of document.querySelectorAll('[data-stack]')) b.classList.toggle('active', b.dataset.stack === stack);
  $('#stacks').innerHTML = crumb(stack === 'source' ? 'Source' : 'Target', config[stack]);
  scan = null;
  selected.clear();
  banner('');
  if (!config[stack].configured) {
    render();
    return banner(`The ${stack} stack is not connected. <a href="/stacks?next=${encodeURIComponent(location.pathname)}">Connect it →</a>`, 'b-warn');
  }
  try {
    const d = await api(`/api/assets?stack=${stack}`);
    scan = d.scan;
    if (d.job) return followJob(stack, d.job);
  } catch (e) {
    banner(esc(e.message));
  }
  render();
}

// --- render ----------------------------------------------------------------

function visibleAssets() {
  const q = $('#search').value.trim().toLowerCase();
  return (scan?.assets || []).filter((a) => (!statusView || statusOf(a) === statusView)
    && (!typeView || typeOf(a) === typeView)
    && (!q || [a.title, a.filename, a.uid].some((v) => v?.toLowerCase().includes(q))));
}

function renderViews() {
  const all = scan?.assets || [];
  const view = (attr, value, label, list, active) => `<a href="#" class="${active ? 'active' : ''}" ${attr}="${value}">
    <span>${label}<small>${fmtSize(sum(list))}</small></span><span class="n">${list.length}</span></a>`;
  const byStatus = all.filter((a) => !typeView || typeOf(a) === typeView);
  const statuses = ['unused', 'used', ...(all.some((a) => a.unverified) ? ['unknown'] : []), ''];
  $('#views').innerHTML = scan ? `
    <div class="views-group"><h3>Usage</h3>
      ${statuses.map((s) => view('data-status', s, STATUS_LABEL[s], byStatus.filter((a) => !s || statusOf(a) === s), statusView === s)).join('')}
    </div>
    <div class="views-group"><h3>Type</h3>
      ${Object.keys(TYPE_LABEL).map((t) => view('data-type', t, TYPE_LABEL[t], all.filter((a) => !t || typeOf(a) === t), typeView === t)).join('')}
    </div>` : '';
}

function preview(a) {
  if (typeOf(a) === 'image' && a.url) {
    const src = a.content_type === 'image/svg+xml' ? a.url : `${a.url}?width=96&height=96&fit=crop`;
    return `<img class="thumb" src="${esc(src)}" alt="" loading="lazy">`;
  }
  const ic = { video: 'film', document: 'file-text' }[typeOf(a)] || 'file';
  return `<span class="thumb">${icon(ic)}</span>`;
}

function usage(a) {
  if (a.unverified) return '<span class="pill s-changed">Could not verify</span>';
  if (!a.useCount) return '<span class="pill s-same">Not used</span>';
  const chips = a.uses.slice(0, 2).map((u) => `<span class="chip" title="${esc(u.content_type_title)} · ${esc(u.locale)}">
    <i>${esc(u.locale)}</i>${esc(u.title || u.entry_uid)}</span>`).join('');
  const more = a.useCount - Math.min(2, a.uses.length);
  return `<div class="chips">${chips}${more > 0 ? `<span class="chip">+${more} more</span>` : ''}</div>`;
}

function render() {
  renderViews();
  $('#scanBtn').disabled = busy || !config?.[currentStack()]?.configured;
  $('#scannedAt').textContent = scan ? `Last scan: ${fmtDate(scan.scannedAt)}` : '';

  if (!busy) {
    if (!scan) {
      $('#content').innerHTML = `<section class="section"><div class="empty">
        <p>Scan the stack to find assets that no entry uses.</p>
        <button class="btn primary" id="scanBtn2">${icon('scan-search')}Scan stack</button></div></section>`;
    } else {
      const list = visibleAssets();
      const selectable = list.filter((a) => statusOf(a) === 'unused');
      const all = selectable.length && selectable.every((a) => selected.has(a.uid));
      const unused = scan.assets.filter((a) => statusOf(a) === 'unused');
      const s = scan.stats;
      $('#content').innerHTML = `<section class="section">
        <div class="summary">
          <span class="big">${unused.length}</span>
          <span class="meta">unused of ${scan.assets.length} assets · <b>${fmtSize(sum(unused))}</b> to free up
            <br><small class="none">Scanned ${s.entries} entries in ${s.contentTypes} content types × ${s.locales} locales</small></span>
        </div>
        ${list.length ? `<table class="etable">
          <thead><tr>
            <th><input type="checkbox" id="selAll" ${all ? 'checked' : ''} ${selectable.length ? '' : 'disabled'} title="Select visible unused assets"></th>
            <th>Asset</th><th>Type</th><th>Size</th><th>Folder</th><th>Used in</th><th>Modified</th>
          </tr></thead>
          <tbody>${list.map((a) => `<tr class="${selected.has(a.uid) ? 'sel' : ''}">
            <td><input type="checkbox" data-uid="${esc(a.uid)}" ${selected.has(a.uid) ? 'checked' : ''}
              ${statusOf(a) === 'unused' ? '' : 'disabled title="Only unused assets can be deleted"'}></td>
            <td><div class="asset">${preview(a)}<div><div class="title">${esc(a.title || a.filename)}</div>
              <small class="none">${esc(a.filename)} · <code>${esc(a.uid)}</code></small></div></div></td>
            <td>${esc(a.content_type)}</td>
            <td>${fmtSize(a.file_size)}</td>
            <td>${a.folder ? `${icon('folder')} ${esc(a.folder)}` : '<span class="none">—</span>'}</td>
            <td>${usage(a)}</td>
            <td>${fmtDate(a.updated_at)}</td>
          </tr>`).join('')}</tbody></table>` : '<p class="empty">No assets in this view.</p>'}
      </section>`;
    }
  }

  const sel = (scan?.assets || []).filter((a) => selected.has(a.uid));
  $('#selCount').innerHTML = scan ? `Selected: <b>${sel.length}</b>${sel.length ? ` · ${fmtSize(sum(sel))}` : ''}` : '';
  $('#deleteBtn').disabled = !sel.length || busy;
  $('#deleteBtn').innerHTML = `${icon('trash-2')}${sel.length ? `Delete selected (${sel.length})` : 'Delete selected'}`;
}

// --- scan ------------------------------------------------------------------

// Animated "scanner": a beam sweeping over a grid of asset tiles.
function showProgress(kind) {
  const tiles = Array.from({ length: 15 }, (_, i) => `<span style="--col:${i % 5}"></span>`).join('');
  $('#content').innerHTML = `<section class="section"><div class="scan-progress ${kind === 'delete' ? 'is-delete' : ''}">
    <div class="scan-visual" aria-hidden="true">${tiles}<div class="beam"></div></div>
    <div id="progText">Starting…</div><div class="progress indeterminate"><div id="progBar"></div></div>
    <small class="none">${kind === 'delete'
      ? 'Assets are being deleted – started from another tab or window.'
      : 'Every entry in every locale is scanned, then candidates are confirmed with the references API. This can take a few minutes on large stacks.'}</small>
  </div></section>`;
}

function setProgress(p) {
  if (!p || !$('#progText')) return;
  $('#progText').textContent = p.step;
  $('#progBar').parentElement.classList.toggle('indeterminate', !p.total);
  $('#progBar').style.width = p.total ? `${(p.done / p.total) * 100}%` : '';
}

// A scan or delete is already running (another tab, or a reload) – show its progress and pick up the result.
async function followJob(stack, job) {
  busy = true;
  selected.clear();
  render();
  showProgress(job?.kind);
  setProgress(job?.progress);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (currentStack() !== stack) return;
      const d = await api(`/api/assets?stack=${stack}`);
      if (!d.job) { scan = d.scan; break; }
      setProgress(d.job.progress);
    }
  } catch (e) {
    banner(esc(e.message));
  } finally {
    if (currentStack() === stack) { busy = false; render(); }
  }
}

async function runScan() {
  const stack = currentStack();
  busy = true;
  selected.clear();
  banner('');
  render();
  showProgress('scan');
  try {
    const res = await fetch('/api/assets/scan', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack }),
    });
    if (res.status === 409) return followJob(stack, null);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readStream(res, (m) => {
      setProgress(m.progress);
      if (m.error) throw new Error(m.error);
      if (m.result) scan = m.result;
    });
  } catch (e) {
    banner(esc(e.message));
  }
  busy = false;
  render();
}

// --- delete ----------------------------------------------------------------

function openModal(title, body, foot = '') {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = foot;
  if (!$('#modal').open) $('#modal').showModal();
}

// Confirmation requires typing "delete" – assets are shared by all entries and environments.
function askDelete() {
  const stack = currentStack();
  const uids = [...selected];
  const list = scan.assets.filter((a) => selected.has(a.uid));
  openModal('Confirm deletion', `
    <div class="box b-err">You are about to delete <b>${uids.length}</b> assets (${fmtSize(sum(list))})
      from the <b>${stack.toUpperCase()}</b> stack (${esc(config[stack].host)}, <code>${esc(config[stack].apiKey)}</code>, branch ${esc(config[stack].branch)}).
      <br>Each asset is checked with the references API again right before it is deleted; assets that got used since the scan are skipped.
      <br>Treat this as irreversible.</div>
    <label>Type <code>delete</code> to confirm:
      <input class="confirm-input" id="confirmInput" autocomplete="off"></label>`,
  `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="confirmDelete" disabled>Delete ${uids.length} assets</button>`);
  $('#confirmInput').focus();
  $('#confirmInput').addEventListener('input', (e) => { $('#confirmDelete').disabled = e.target.value.trim() !== 'delete'; });
  $('#confirmDelete').addEventListener('click', () => runDelete(stack, uids));
}

async function runDelete(stack, uids) {
  busy = true;
  render();
  openModal('Deleting…', `
    <div id="progText">0 / ${uids.length}</div>
    <div class="progress"><div id="progBar"></div></div>
    <div class="log" id="log"></div>`);
  $('#modal').querySelector('[data-close]').disabled = true;

  let done = 0;
  let failed = 0;
  const gone = new Set();
  const line = (cls, msg) => $('#log').insertAdjacentHTML('beforeend', `<div class="l-${cls}">${esc(msg)}</div>`);
  try {
    const res = await fetch('/api/assets/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack, uids }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readStream(res, (m) => {
      if (m.done) return;
      done++;
      if (m.ok) gone.add(m.uid);
      else { failed++; line('error', `${m.uid}: ${m.error}`); }
      $('#progText').textContent = `${done} / ${uids.length}${failed ? ` · errors: ${failed}` : ''}`;
      $('#progBar').style.width = `${(done / uids.length) * 100}%`;
    });
    line(failed ? 'error' : 'ok', `Done: ${done - failed} deleted, ${failed} errors.`);
  } catch (e) {
    line('error', e.message);
  }
  scan.assets = scan.assets.filter((a) => !gone.has(a.uid));
  for (const u of gone) selected.delete(u);
  $('#modalTitle').textContent = 'Deletion finished';
  $('#modal').querySelector('[data-close]').disabled = false;
  busy = false;
  render();
}

// --- events ----------------------------------------------------------------

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close]')) return $('#modal').close();
  if (t.closest('#scanBtn, #scanBtn2') && !busy) return runScan();
  const st = t.closest('[data-stack]');
  if (st && !busy) return selectStack(st.dataset.stack);
  const v = t.closest('[data-status], [data-type]');
  if (v) {
    ev.preventDefault();
    if (v.dataset.type !== undefined) typeView = v.dataset.type;
    else statusView = v.dataset.status;
    return render();
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.uid) {
    t.checked ? selected.add(t.dataset.uid) : selected.delete(t.dataset.uid);
    render();
  }
  if (t.id === 'selAll') {
    for (const a of visibleAssets()) if (statusOf(a) === 'unused') t.checked ? selected.add(a.uid) : selected.delete(a.uid);
    render();
  }
});

$('#modal').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
$('#search').addEventListener('input', render);
$('#deleteBtn').addEventListener('click', askDelete);

(async () => {
  try {
    config = await api('/api/config');
    if (!config.source.configured) {
      $('#stacks').innerHTML = stackCrumb('Source', config.source);
      return showRequired($('#content'), ['source']);
    }
    // The Source/Target switch only makes sense when both stacks are connected; Source is always the default.
    document.querySelector('.segmented').hidden = !(config.source.configured && config.target.configured);
    await selectStack('source');
  } catch (e) {
    banner(esc(e.message));
  }
})();
