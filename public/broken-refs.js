const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let config = null;
let scan = null; // last scan of the selected stack
let kindView = '';
let ctView = '';
const selected = new Set(); // entry version keys: ct/uid/locale
let busy = false;

const KIND_LABEL = {
  entry: 'Missing entry', 'content-type': 'Missing content type', asset: 'Missing asset', 'asset-url': 'Missing asset (URL in text)',
};
const KIND_VIEW = { '': 'All', entry: 'Missing entries', asset: 'Missing assets', 'content-type': 'Missing content types', 'asset-url': 'Asset URLs in text' };
const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-GB') : '');
const versionKey = (b) => `${b.ct}/${b.entry}/${b.locale}`;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function banner(html, cls = 'b-err') {
  $('#banner').innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
}

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

async function selectStack(stack) {
  for (const b of document.querySelectorAll('[data-stack]')) b.classList.toggle('active', b.dataset.stack === stack);
  $('#stacks').innerHTML = stackCrumb(stack === 'source' ? 'Source' : 'Target', config[stack]);
  scan = null;
  selected.clear();
  banner('');
  try {
    const d = await api(`/api/broken-refs?stack=${stack}`);
    scan = d.scan;
    if (d.job) return followJob(stack, d.job);
  } catch (e) {
    banner(esc(e.message));
  }
  render();
}

// --- render ----------------------------------------------------------------

// Broken references grouped by entry version – a fix rewrites a whole version.
function groups() {
  const q = $('#search').value.trim().toLowerCase();
  const list = (scan?.broken || []).filter((b) => (!kindView || b.kind === kindView) && (!ctView || b.ct === ctView)
    && (!q || [b.title, b.entry, b.path, b.ref, b.ctTitle].some((v) => v?.toLowerCase().includes(q))));
  const map = new Map();
  for (const b of list) {
    const k = versionKey(b);
    if (!map.has(k)) map.set(k, { key: k, ct: b.ct, ctTitle: b.ctTitle, uid: b.entry, title: b.title, locale: b.locale, refs: [] });
    map.get(k).refs.push(b);
  }
  return [...map.values()];
}

const fixableGroup = (g) => g.refs.some((r) => r.fixable);

function renderViews() {
  const all = scan?.broken || [];
  const view = (attr, value, label, n, active) => `<a href="#" class="${active ? 'active' : ''}" ${attr}="${value}">
    <span>${label}</span><span class="n">${n}</span></a>`;
  const byKind = all.filter((b) => !ctView || b.ct === ctView);
  const kinds = Object.keys(KIND_VIEW).filter((k) => !k || all.some((b) => b.kind === k));
  const cts = [...new Map(all.map((b) => [b.ct, b.ctTitle])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  $('#views').innerHTML = scan ? `
    <div class="views-group"><h3>Problem</h3>
      ${kinds.map((k) => view('data-kind', k, KIND_VIEW[k], byKind.filter((b) => !k || b.kind === k).length, kindView === k)).join('')}
    </div>
    ${cts.length ? `<div class="views-group"><h3>Content type</h3>
      ${view('data-ctv', '', 'All content types', all.filter((b) => !kindView || b.kind === kindView).length, !ctView)}
      ${cts.map(([uid, title]) => view('data-ctv', uid, esc(title), all.filter((b) => b.ct === uid && (!kindView || b.kind === kindView)).length, ctView === uid)).join('')}
    </div>` : ''}` : '';
}

function refChip(r) {
  const target = r.kind === 'entry' || r.kind === 'content-type' ? `${r.refCt} / ${r.ref}` : r.ref;
  return `<div class="ref-line ${r.fixable ? '' : 'not-fixable'}">
    <code>${esc(r.path)}</code> ${icon('arrow-right', 'arrow')}
    <span class="pill ${r.kind === 'asset-url' ? 's-same' : 's-changed'}">${KIND_LABEL[r.kind]}</span>
    <code>${esc(target)}</code></div>`;
}

function render() {
  renderViews();
  $('#scanBtn').disabled = busy;
  $('#scannedAt').textContent = scan ? `Last scan: ${fmtDate(scan.scannedAt)}` : '';

  if (!busy) {
    if (!scan) {
      $('#content').innerHTML = `<section class="section"><div class="empty">
        <p>Scan the stack to find references to entries, content types and assets that no longer exist.</p>
        <button class="btn primary" id="scanBtn2">${icon('scan-search')}Scan stack</button></div></section>`;
    } else if (!scan.broken.length) {
      $('#content').innerHTML = `<section class="section"><div class="empty-state">
        <span class="empty-mark ok">${icon('circle-check')}</span>
        <h2>No broken references</h2>
        <p>All ${scan.stats.versions} entry versions point at existing entries and assets.</p></div></section>`;
    } else {
      const list = groups();
      const selectable = list.filter(fixableGroup);
      const all = selectable.length && selectable.every((g) => selected.has(g.key));
      const s = scan.stats;
      const entries = new Set(scan.broken.map((b) => `${b.ct}/${b.entry}`)).size;
      $('#content').innerHTML = `<section class="section">
        <div class="summary">
          <span class="big">${scan.broken.length}</span>
          <span class="meta">broken references in <b>${entries}</b> entries
            <br><small class="none">Scanned ${s.versions} entry versions in ${s.contentTypes} content types × ${s.locales} locales, ${s.assets} assets</small></span>
        </div>
        ${list.length ? `<table class="etable refs-table">
          <thead><tr>
            <th><input type="checkbox" id="selAll" ${all ? 'checked' : ''} ${selectable.length ? '' : 'disabled'} title="Select visible"></th>
            <th>Entry</th><th>Locale</th><th>Broken references</th>
          </tr></thead>
          <tbody>${list.map((g) => `<tr class="${selected.has(g.key) ? 'sel' : ''}">
            <td><input type="checkbox" data-key="${esc(g.key)}" ${selected.has(g.key) ? 'checked' : ''}
              ${fixableGroup(g) ? '' : 'disabled title="Asset URLs in text can only be fixed by hand"'}></td>
            <td><div class="title">${esc(g.title || g.uid)}</div><small class="none">${esc(g.ctTitle)} · <code>${esc(g.uid)}</code></small></td>
            <td>${esc(g.locale)}</td>
            <td class="refs">${g.refs.map(refChip).join('')}</td>
          </tr>`).join('')}</tbody></table>` : '<p class="empty">Nothing in this view.</p>'}
      </section>`;
    }
  }

  const n = selected.size;
  const refs = (scan?.broken || []).filter((b) => b.fixable && selected.has(versionKey(b))).length;
  $('#selCount').innerHTML = scan ? `Selected: <b>${n}</b> entry versions${n ? ` · ${refs} references to remove` : ''}` : '';
  $('#fixBtn').disabled = !n || busy;
}

// --- scan ------------------------------------------------------------------

function showProgress(kind) {
  const tiles = Array.from({ length: 15 }, (_, i) => `<span style="--col:${i % 5}"></span>`).join('');
  $('#content').innerHTML = `<section class="section"><div class="scan-progress">
    <div class="scan-visual" aria-hidden="true">${tiles}<div class="beam"></div></div>
    <div id="progText">Starting…</div><div class="progress indeterminate"><div id="progBar"></div></div>
    <small class="none">${kind === 'fix' ? 'Broken references are being removed – started from another tab or window.'
      : 'Every entry in every locale is read and checked. This can take a few minutes on large stacks.'}</small>
  </div></section>`;
}

function setProgress(p) {
  if (!p || !$('#progText')) return;
  $('#progText').textContent = p.step;
  $('#progBar').parentElement.classList.toggle('indeterminate', !p.total);
  $('#progBar').style.width = p.total ? `${(p.done / p.total) * 100}%` : '';
}

async function followJob(stack, job) {
  busy = true;
  render();
  showProgress(job?.kind);
  setProgress(job?.progress);
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (currentStack() !== stack) return;
      const d = await api(`/api/broken-refs?stack=${stack}`);
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
    const res = await fetch('/api/broken-refs/scan', {
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

// --- fix -------------------------------------------------------------------

function openModal(title, body, foot = '') {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = foot;
  if (!$('#modal').open) $('#modal').showModal();
}

function askFix() {
  const stack = currentStack();
  const targets = [...selected].map((k) => { const [ct, uid, locale] = k.split('/'); return { ct, uid, locale }; });
  const refs = scan.broken.filter((b) => b.fixable && selected.has(versionKey(b))).length;
  openModal('Remove broken references', `
    <div class="box b-warn">Removes <b>${refs}</b> broken references from <b>${targets.length}</b> entry versions
      in the <b>${stack.toUpperCase()}</b> stack (<code>${esc(config[stack].apiKey)}</code> · ${esc(config[stack].branch)}).
      <br>Each version is read fresh and saved without the references to missing entries and assets – everything else stays as it is.
      Published versions keep their published content until you publish again.</div>
    <p class="none">If a field is mandatory and the broken reference was its only value, Contentstack rejects the save – such entries are listed as errors.
      Asset URLs inside text are not changed.</p>`,
  `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="confirmFix">${icon('unlink')}Remove from ${targets.length} versions</button>`);
  $('#confirmFix').addEventListener('click', () => runFix(stack, targets));
}

async function runFix(stack, targets) {
  busy = true;
  render();
  openModal('Removing…', `<div id="progText">0 / ${targets.length}</div>
    <div class="progress"><div id="progBar"></div></div><div class="log" id="log"></div>`);
  $('#modal').querySelector('[data-close]').disabled = true;
  let done = 0;
  let failed = 0;
  const line = (cls, msg) => $('#log').insertAdjacentHTML('beforeend', `<div class="l-${cls}">${esc(msg)}</div>`);
  try {
    const res = await fetch('/api/broken-refs/fix', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack, targets }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readStream(res, (m) => {
      if (m.done) return;
      done++;
      if (!m.ok) { failed++; line('error', `${m.ct} / ${m.uid} (${m.locale}): ${m.error}`); }
      $('#progText').textContent = `${done} / ${targets.length}${failed ? ` · errors: ${failed}` : ''}`;
      $('#progBar').style.width = `${(done / targets.length) * 100}%`;
    });
    line(failed ? 'error' : 'ok', `Done: ${done - failed} entry versions fixed, ${failed} errors.`);
  } catch (e) {
    line('error', e.message);
  }
  $('#modalTitle').textContent = 'Finished';
  $('#modal').querySelector('[data-close]').disabled = false;
  busy = false;
  selected.clear();
  const d = await api(`/api/broken-refs?stack=${stack}`).catch(() => null);
  if (d) scan = d.scan;
  render();
}

// --- events ----------------------------------------------------------------

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close]')) return $('#modal').close();
  if (t.closest('#scanBtn, #scanBtn2') && !busy) return runScan();
  const st = t.closest('[data-stack]');
  if (st && !busy) return selectStack(st.dataset.stack);
  const v = t.closest('[data-kind], [data-ctv]');
  if (v) {
    ev.preventDefault();
    if (v.dataset.kind !== undefined) kindView = v.dataset.kind;
    else ctView = v.dataset.ctv;
    return render();
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.key) {
    t.checked ? selected.add(t.dataset.key) : selected.delete(t.dataset.key);
    render();
  }
  if (t.id === 'selAll') {
    for (const g of groups()) if (fixableGroup(g)) t.checked ? selected.add(g.key) : selected.delete(g.key);
    render();
  }
});

$('#modal').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
$('#search').addEventListener('input', render);
$('#fixBtn').addEventListener('click', askFix);

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
