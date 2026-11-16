const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let cts = [];
let current = null; // selected content type
let entries = [];
let inTarget = true;
const selected = new Set();
let busy = false;

const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-GB') : '');

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

// --- content types and entries ---------------------------------------------

function renderCtPanel() {
  const q = $('#ctSearch').value.trim().toLowerCase();
  const list = cts.filter((c) => !q || c.title.toLowerCase().includes(q) || c.uid.includes(q));
  $('#ctPanel').innerHTML = list.length
    ? list.map((c) => `<a href="#" data-ct="${esc(c.uid)}" class="${current?.uid === c.uid ? 'active' : ''}"
        ${c.inTarget ? '' : 'title="Not in the target stack – migrate its schema first"'}>
        <span>${esc(c.title)}<small>${esc(c.uid)}${c.inTarget ? '' : ' · not in target'}</small></span></a>`).join('')
    : '<p class="none">No content types</p>';
}

async function selectCt(uid) {
  current = cts.find((c) => c.uid === uid);
  const prev = $('#matchField').value;
  $('#matchField').innerHTML = current.fields.map((f) => `<option value="${esc(f.uid)}">${esc(f.name)}${f.unique ? ' (unique)' : ''}</option>`).join('');
  // Prefer a unique non-title field (e.g. an external id) – titles often repeat.
  const unique = current.fields.find((f) => f.unique && f.uid !== 'title');
  $('#matchField').value = current.fields.some((f) => f.uid === prev) ? prev : unique?.uid || 'title';
  renderCtPanel();
  await loadEntries();
}

async function loadEntries() {
  if (!current) return;
  selected.clear();
  entries = [];
  busy = true;
  render();
  $('#content').innerHTML = '<p class="empty">Reading entries from both stacks…</p>';
  try {
    const d = await api(`/api/entry-migration/entries?ct=${encodeURIComponent(current.uid)}&match=${encodeURIComponent($('#matchField').value)}`);
    entries = d.entries;
    inTarget = d.inTarget;
    for (const e of entries) if (!e.targetUid) selected.add(e.uid); // new entries selected by default
    banner(inTarget ? '' : `<b>${esc(current.title)}</b> doesn't exist in the target stack. <a href="/migrations">Migrate its schema first →</a>`, 'b-warn');
  } catch (e) {
    banner(esc(e.message));
  }
  busy = false;
  render();
}

function render() {
  const n = selected.size;
  $('#selCount').innerHTML = current ? `Selected: <b>${n}</b> of ${entries.length}` : '';
  $('#planBtn').disabled = !n || busy || !inTarget;
  if (busy || !current) return;

  const q = $('#search').value.trim().toLowerCase();
  const list = entries.filter((e) => !q || [e.title, e.uid, String(e.match ?? '')].some((v) => v?.toLowerCase().includes(q)));
  const all = list.length && list.every((e) => selected.has(e.uid));
  const fresh = entries.filter((e) => !e.targetUid).length;
  const field = $('#matchField').selectedOptions[0]?.textContent || 'Title';
  $('#content').innerHTML = `<section class="section">
    <div class="summary">
      <span class="big">${entries.length}</span>
      <span class="meta">entries in <b>${esc(current.title)}</b> · <b>${fresh}</b> new, <b>${entries.length - fresh}</b> already in target
        <br><small class="none">Matched with the target by ${esc(field)}</small></span>
    </div>
    ${list.length ? `<table class="etable">
      <thead><tr>
        <th><input type="checkbox" id="selAll" ${all ? 'checked' : ''}></th>
        <th>Title</th><th>${esc(field)}</th><th>Locales</th><th>In target</th><th>Modified</th>
      </tr></thead>
      <tbody>${list.map((e) => `<tr class="${selected.has(e.uid) ? 'sel' : ''}">
        <td><input type="checkbox" data-uid="${esc(e.uid)}" ${selected.has(e.uid) ? 'checked' : ''}></td>
        <td><div class="title">${esc(e.title)}</div><code>${esc(e.uid)}</code></td>
        <td>${e.match == null ? '<span class="none">—</span>' : esc(e.match)}</td>
        <td>${e.locales.map(esc).join(', ')}</td>
        <td>${e.targetUid ? `<span class="pill s-changed">Exists</span> <code>${esc(e.targetUid)}</code>` : '<span class="pill s-new">New</span>'}</td>
        <td>${fmtDate(e.updated_at)}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="empty">No entries.</p>'}
  </section>`;
}

// --- plan & run ------------------------------------------------------------

function openModal(title, body, foot = '') {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = foot;
  if (!$('#modal').open) $('#modal').showModal();
}

function progressView(text) {
  return `<div class="scan-progress">
    <div id="progText">${esc(text)}</div><div class="progress indeterminate"><div id="progBar"></div></div>
    <div class="log" id="log" hidden></div></div>`;
}

function setProgress(p) {
  if (!p || !$('#progText')) return;
  $('#progText').textContent = p.step;
  $('#progBar').parentElement.classList.toggle('indeterminate', !p.total);
  $('#progBar').style.width = p.total ? `${(p.done / p.total) * 100}%` : '';
}

async function previewPlan() {
  busy = true;
  render();
  openModal('Migration plan', progressView('Preparing the plan…'));
  let planId = null;
  let summary = null;
  try {
    const res = await fetch('/api/entry-migration/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ct: current.uid, uids: [...selected], matchField: $('#matchField').value,
        existing: $('#existing').value, includeRefs: $('#includeRefs').checked,
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readStream(res, (m) => {
      if (m.progress) setProgress(m.progress);
      if (m.error) throw new Error(m.error);
      if (m.summary) { summary = m.summary; planId = m.planId; }
    });
    showPlan(summary, planId);
  } catch (e) {
    openModal('Migration plan', `<div class="box b-err">${esc(e.message)}</div>`);
  }
  busy = false;
  render();
}

function showPlan(s, planId) {
  const work = s.create + s.update;
  const rows = s.byCt.map((c) => `<tr><td>${esc(c.title)} <code>${esc(c.ct)}</code></td><td>${c.create}</td><td>${c.update}</td><td>${c.skip}</td></tr>`).join('');
  openModal('Migration plan', `
    <ul class="facts">
      <li><span>Selected</span><b>${s.selected}</b> entries of ${esc(s.contentType.title)}</li>
      <li><span>Referenced</span>${s.pulledIn ? `<b>${s.pulledIn}</b> more entries pulled in by references` : 'none pulled in'}${s.linkedExisting ? ` · ${s.linkedExisting} linked to existing target entries` : ''}</li>
      <li><span>Entries</span><b>${s.create}</b> create · <b>${s.update}</b> update · ${s.skip} skip</li>
      <li><span>Assets</span><b>${s.assets.upload}</b> upload (${fmtSize(s.assets.uploadBytes)}) · ${s.assets.reuse} already in target</li>
    </ul>
    <table class="etable plan-table"><thead><tr><th>Content type</th><th>Create</th><th>Update</th><th>Skip</th></tr></thead><tbody>${rows}</tbody></table>
    ${s.warnings.length ? `<div class="box b-warn"><b>Warnings</b><ul>${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <p class="none">Entries are written to the target unpublished. Nothing is deleted in either stack.</p>`,
  `<button class="btn ghost" data-close>Cancel</button>
   <button class="btn primary" id="runBtn" ${work ? '' : 'disabled'}>${icon('files')}Migrate ${work} entries</button>`);
  $('#runBtn')?.addEventListener('click', () => runMigration(planId, s));
}

async function runMigration(planId, s) {
  busy = true;
  render();
  openModal('Migrating…', progressView('Starting…'));
  $('#modal').querySelector('[data-close]').disabled = true;
  const log = $('#log');
  const line = (cls, msg) => { log.hidden = false; log.insertAdjacentHTML('beforeend', `<div class="l-${cls}">${esc(msg)}</div>`); };
  try {
    const res = await fetch('/api/entry-migration/run', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readStream(res, (m) => {
      if (m.step) setProgress(m);
      if (m.ok === false) line('error', m.error);
      if (m.done) {
        line(m.failed ? 'error' : 'ok', `Done: ${m.entries} entries and ${m.assets} assets processed, ${m.failed} errors. Entries are unpublished in the target.`);
        setProgress({ step: 'Finished', done: 1, total: 1 });
      }
    });
  } catch (e) {
    line('error', e.message);
  }
  $('#modalTitle').textContent = 'Migration finished';
  $('#modal').querySelector('[data-close]').disabled = false;
  busy = false;
  loadEntries();
}

// --- events ----------------------------------------------------------------

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close]')) return $('#modal').close();
  const ct = t.closest('[data-ct]');
  if (ct && !busy) { ev.preventDefault(); return selectCt(ct.dataset.ct); }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.uid) {
    t.checked ? selected.add(t.dataset.uid) : selected.delete(t.dataset.uid);
    render();
  }
  if (t.id === 'selAll') {
    const q = $('#search').value.trim().toLowerCase();
    for (const e of entries) {
      if (q && ![e.title, e.uid, String(e.match ?? '')].some((v) => v?.toLowerCase().includes(q))) continue;
      t.checked ? selected.add(e.uid) : selected.delete(e.uid);
    }
    render();
  }
});

$('#modal').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
$('#ctSearch').addEventListener('input', renderCtPanel);
$('#search').addEventListener('input', render);
$('#matchField').addEventListener('change', loadEntries);
$('#planBtn').addEventListener('click', previewPlan);

(async () => {
  try {
    const c = await api('/api/config');
    $('#stacks').innerHTML = `${stackCrumb('Source', c.source)}${icon('arrow-right', 'arrow')}${stackCrumb('Target', c.target)}`;
    const missing = ['source', 'target'].filter((side) => !c[side].configured);
    if (missing.length) return showRequired($('#content'), missing);
    cts = await api('/api/entry-migration/content-types');
    renderCtPanel();
  } catch (e) {
    banner(esc(e.message));
  }
})();
