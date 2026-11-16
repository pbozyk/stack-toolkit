const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS = { new: 'New', changed: 'Changed', same: 'Identical', target_only: 'Target only' };
const KIND = { gf: 'Global fields', ct: 'Content types' };
const ACTION = {
  skip: 'Skip (identical)',
  'create-placeholder': 'Create placeholder',
  create: 'Create',
  update: 'Overwrite in target',
  fill: 'Fill in full schema',
};

let items = [];
let kindFilter = '';
let byKey = {};
const selected = new Set();
const expanded = new Set();

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function banner(html, cls = 'b-err') {
  $('#banner').innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
}

// Breadcrumb like Contentstack's "Stack › branch" bar.
function crumb(label, s) {
  return `<span class="crumb ${s.configured ? '' : 'missing'}" title="${esc(s.host)}">
    ${icon('layers')}<b>${label}</b>${s.apiKey ? `<code>${esc(s.apiKey)}</code>` : '<em>not connected</em>'}
    ${icon('chevron-right', 'sep')}${icon('git-branch')}${esc(s.branch)}</span>`;
}

async function loadConfig() {
  const c = await api('/api/config');
  $('#stacks').innerHTML = `${crumb('Source', c.source)}${icon('arrow-right', 'arrow')}${crumb('Target', c.target)}`;
  return c;
}

async function start() {
  const c = await loadConfig();
  const missing = ['source', 'target'].filter((side) => !c[side].configured);
  if (missing.length) showRequired($('#lists'), missing);
  else await loadState();
}

async function loadState(refresh = false) {
  $('#refresh').disabled = true;
  if (!items.length) $('#lists').innerHTML = '<p class="empty">Fetching schemas from both stacks…</p>';
  try {
    const d = await api(`/api/state${refresh ? '?refresh=1' : ''}`);
    items = d.items;
    byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    for (const k of [...selected]) if (!byKey[k]?.inSource) selected.delete(k);
    banner(d.warnings.length ? d.warnings.map(esc).join('<br>') : '', 'b-warn');
    render();
  } catch (e) {
    banner(esc(e.message));
    $('#lists').innerHTML = '';
  } finally {
    $('#refresh').disabled = false;
  }
}

// --- relations ---------------------------------------------------------------

function chipClass(key) {
  const it = byKey[key];
  if (selected.has(key)) return 'c-sel';
  if (!it?.inTarget) return 'c-miss';
  return it.status === 'changed' ? 'c-warn' : 'c-ok';
}

// Status colors only make sense for dependencies; "used by" only shows selection.
function chip(key, isDep) {
  const it = byKey[key];
  const [kind, uid] = key.split(':');
  const tip = !isDep ? 'Show item'
    : !it ? 'Does not exist in either stack'
    : !it.inTarget ? 'Missing in target – must be migrated together with this item'
    : it.status === 'changed' ? 'Exists in target, but differs from source' : 'Exists in target';
  const cls = isDep ? chipClass(key) : selected.has(key) ? 'c-sel' : '';
  return `<span class="chip ${cls}" data-goto="${esc(key)}" title="${esc(tip)}"><i>${kind.toUpperCase()}</i>${esc(it?.title || uid)}</span>`;
}

const chips = (keys, isDep) => (keys.length
  ? `<div class="chips">${keys.map((k) => chip(k, isDep)).join('')}</div>`
  : '<span class="none">—</span>');

// Closure of dependencies that are missing in the target stack.
function requiredDeps(keys) {
  const out = new Set();
  const stack = [...keys];
  while (stack.length) {
    for (const d of byKey[stack.pop()]?.deps || []) {
      const it = byKey[d];
      if (!it?.inSource || it.inTarget || keys.has(d) || out.has(d)) continue;
      out.add(d);
      stack.push(d);
    }
  }
  return out;
}

// --- render ----------------------------------------------------------------

function details(it) {
  const parts = [];
  if (it.diff) {
    const { meta, added, removed, changed } = it.diff;
    const li = (arr, cls, sign) => arr.map((f) => `<li class="${cls}">${sign} <code>${esc(f.path)}</code> ${esc(f.type)}</li>`).join('');
    parts.push(`<h4>Differences (source vs target)</h4><ul>
      ${meta.map((m) => `<li class="d-chg">~ settings: <code>${esc(m)}</code></li>`).join('')}
      ${li(added, 'd-add', '+')}${li(removed, 'd-rem', '−')}${li(changed, 'd-chg', '~')}</ul>`);
    if (removed.length) parts.push('<p class="d-rem">Warning: overwriting will remove these fields from the target stack along with their entry data.</p>');
  }
  if (it.extensions.length) {
    parts.push(`<h4>Extensions</h4><ul>${it.extensions.map((e) => `<li class="${e.mapped ? '' : 'd-rem'}">
      ${esc(e.title || e.uid)} <code>${esc(e.uid)}</code> — ${e.mapped ? 'found in target' : 'MISSING in target'}</li>`).join('')}</ul>`);
  }
  if (it.taxonomies.length) parts.push(`<h4>Taxonomies</h4><p>${it.taxonomies.map((t) => `<code>${esc(t)}</code>`).join(', ')} – not migrated in this step.</p>`);
  if (it.selfReference) parts.push('<p class="none">References itself.</p>');
  parts.push(`<p><button class="btn small" data-json="${esc(it.key)}">Compare JSON</button> <span class="none">${it.fieldCount} top-level fields</span></p>`);
  return `<div class="details">${parts.join('')}</div>`;
}

function row(it) {
  const sel = selected.has(it.key);
  const open = expanded.has(it.key);
  return `<div class="row grid ${sel ? 'sel' : ''}" id="row-${esc(it.key)}">
      <input type="checkbox" data-sel="${esc(it.key)}" ${sel ? 'checked' : ''} ${it.inSource ? '' : 'disabled title="Does not exist in source"'}>
      <div><div class="title">${esc(it.title)}</div><code>${esc(it.uid)}</code></div>
      <div><span class="pill s-${it.status}">${STATUS[it.status]}</span></div>
      ${chips(it.deps, true)}
      ${chips(it.usedBy, false)}
      <button class="toggle" data-toggle="${esc(it.key)}" title="Details">${icon(open ? 'chevron-down' : 'chevron-right')}</button>
    </div>${open ? details(it) : ''}`;
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const st = $('#statusFilter').value;
  const visible = items.filter((i) => (!st || i.status === st)
    && (!q || i.title.toLowerCase().includes(q) || i.uid.toLowerCase().includes(q)));
  renderViews();

  $('#lists').innerHTML = ['gf', 'ct'].filter((k) => !kindFilter || k === kindFilter).map((kind) => {
    const list = visible.filter((i) => i.kind === kind).sort((a, b) => a.title.localeCompare(b.title));
    const selectable = list.filter((i) => i.inSource);
    const all = selectable.length && selectable.every((i) => selected.has(i.key));
    return `<section class="section">
      <div class="section-head">
        <input type="checkbox" data-all="${kind}" ${all ? 'checked' : ''} title="Select visible">
        ${KIND[kind]} <span class="count">${list.length}</span>
      </div>
      <div class="grid cols"><span></span><span>Name</span><span>Status</span><span>Depends on</span><span>Used by</span><span></span></div>
      ${list.length ? list.map(row).join('') : '<p class="empty">No items</p>'}
    </section>`;
  }).join('');

  const missing = requiredDeps(selected).size;
  $('#selCount').innerHTML = selected.size
    ? `Selected: <b>${selected.size}</b>${missing ? ` · <span class="d-rem">${missing} missing dependencies</span>` : ''}`
    : 'Nothing selected';
  $('#planBtn').disabled = !selected.size;
}

// Left "Views" panel – status and type filters with counts.
function renderViews() {
  const st = $('#statusFilter').value;
  const pool = items.filter((i) => !kindFilter || i.kind === kindFilter);
  const count = (s) => pool.filter((i) => !s || i.status === s).length;
  const view = (attr, value, label, n, active) => `<a href="#" class="${active ? 'active' : ''}" ${attr}="${value}">
    <span>${label}</span><span class="n">${n}</span></a>`;
  $('#views').innerHTML = `
    <div class="views-group"><h3>Status</h3>
      ${[['', 'All'], ['new', STATUS.new], ['changed', STATUS.changed], ['same', STATUS.same], ['target_only', STATUS.target_only]]
        .map(([v, l]) => view('data-view', v, l, count(v), st === v)).join('')}
    </div>
    <div class="views-group"><h3>Type</h3>
      ${[['', 'All types'], ['gf', KIND.gf], ['ct', KIND.ct]]
        .map(([v, l]) => view('data-kind', v, l, items.filter((i) => !v || i.kind === v).length, kindFilter === v)).join('')}
    </div>`;
}

// --- modal -----------------------------------------------------------------

function openModal(title, body, foot = '') {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = foot;
  if (!$('#modal').open) $('#modal').showModal();
}

async function showJson(key) {
  const it = byKey[key];
  const d = await api(`/api/item?key=${encodeURIComponent(key)}`);
  const pre = (o) => `<pre>${o ? esc(JSON.stringify(o, null, 2)) : '— none —'}</pre>`;
  openModal(`${it.title} (${it.uid})`, `<div class="json-cmp">
    <div><h4>Source (after extension mapping)</h4>${pre(d.source)}</div>
    <div><h4>Target</h4>${pre(d.target)}</div></div>`);
}

async function showPlan() {
  openModal('Migration plan', '<p class="empty">Computing plan…</p>');
  let plan;
  try {
    plan = await api('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: [...selected] }) });
  } catch (e) {
    return openModal('Migration plan', `<div class="box b-err">${esc(e.message)}</div>`);
  }
  const name = (k) => esc(byKey[k]?.title || k);
  let body = '';
  if (plan.problems.length) {
    body += `<div class="box b-err"><b>Unmet dependencies – missing in target and not selected:</b><ul>
      ${plan.problems.map((p) => `<li>${name(p.key)} → ${name(p.dep)} <code>${esc(p.dep)}</code>${p.inSource ? '' : ' (does not exist in source either!)'}</li>`).join('')}
      </ul></div>`;
  }
  if (plan.warnings.length) body += `<div class="box b-warn"><b>Warnings</b><ul>${plan.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;

  const phases = [
    ['Placeholders for new content types (so references have a target)', (s) => s.action === 'create-placeholder'],
    ['Global fields (nested ones first)', (s) => s.kind === 'gf' && s.action !== 'skip'],
    ['Content types – full schemas', (s) => s.kind === 'ct' && ['update', 'fill'].includes(s.action)],
    ['Skipped', (s) => s.action === 'skip'],
  ];
  for (const [title, fn] of phases) {
    const steps = plan.steps.filter(fn);
    if (!steps.length) continue;
    body += `<div class="phase">${title}</div><ol class="steps">${steps.map((s) => `<li>
      <span class="pill s-${s.action === 'update' ? 'changed' : s.action === 'skip' ? 'same' : 'new'}">${ACTION[s.action]}</span>
      <span>${esc(s.title)} <code>${esc(s.key)}</code></span></li>`).join('')}</ol>`;
  }
  const work = plan.steps.filter((s) => s.action !== 'skip').length;
  if (!work && !plan.problems.length) body += '<p class="empty">Everything is already in sync.</p>';

  const fixable = plan.problems.some((p) => p.inSource);
  const foot = `${fixable ? '<button class="btn" id="fixDeps">Add missing and recompute</button>' : ''}
    <button class="btn danger" id="runBtn" ${plan.problems.length || !work ? 'disabled' : ''}>Run migration (${work} operations)</button>`;
  openModal('Migration plan', body, foot);
}

async function runMigration() {
  if (!confirm(`Changes will be written to the TARGET stack (${selected.size} selected items). Continue?`)) return;
  openModal('Migration in progress…', '<div class="log" id="log"></div>');
  const log = $('#log');
  const append = (e) => {
    log.insertAdjacentHTML('beforeend', `<div class="l-${e.level}">${esc(e.msg)}</div>`);
    log.parentElement.scrollTop = log.parentElement.scrollHeight;
  };
  try {
    const res = await fetch('/api/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: [...selected] }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) append(JSON.parse(l));
    }
  } catch (e) {
    append({ level: 'error', msg: e.message });
  }
  $('#modalTitle').textContent = 'Migration finished';
  await loadState();
}

// --- events -------------------------------------------------------------

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close]')) return $('#modal').close();
  const go = t.closest('[data-goto]');
  if (go) {
    const el = document.getElementById(`row-${go.dataset.goto}`);
    if ($('#modal').open) $('#modal').close();
    if (!el) { $('#search').value = ''; $('#statusFilter').value = ''; render(); }
    const target = document.getElementById(`row-${go.dataset.goto}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target?.classList.remove('flash'); void target?.offsetWidth; target?.classList.add('flash');
    return;
  }
  const view = t.closest('[data-view], [data-kind]');
  if (view) {
    ev.preventDefault();
    if (view.dataset.kind !== undefined) kindFilter = view.dataset.kind;
    else $('#statusFilter').value = view.dataset.view;
    return render();
  }
  const tog = t.closest('[data-toggle]');
  if (tog) {
    const k = tog.dataset.toggle;
    expanded.has(k) ? expanded.delete(k) : expanded.add(k);
    return render();
  }
  const js = t.closest('[data-json]');
  if (js) return showJson(js.dataset.json).catch((e) => banner(esc(e.message)));
  if (t.id === 'fixDeps') {
    for (const k of requiredDeps(selected)) selected.add(k);
    render();
    return showPlan();
  }
  if (t.id === 'runBtn') return runMigration();
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.sel) {
    t.checked ? selected.add(t.dataset.sel) : selected.delete(t.dataset.sel);
    render();
  }
  if (t.dataset.all) {
    const boxes = document.querySelectorAll(`.section [data-sel^="${t.dataset.all}:"]:not(:disabled)`);
    for (const b of boxes) t.checked ? selected.add(b.dataset.sel) : selected.delete(b.dataset.sel);
    render();
  }
});

$('#search').addEventListener('input', render);
$('#statusFilter').addEventListener('change', render);
$('#refresh').addEventListener('click', () => loadState(true));
$('#planBtn').addEventListener('click', showPlan);
$('#clearSel').addEventListener('click', () => { selected.clear(); render(); });
$('#selectDiff').addEventListener('click', () => {
  for (const i of items) if (i.status === 'new' || i.status === 'changed') selected.add(i.key);
  render();
});
$('#addDeps').addEventListener('click', () => {
  for (const k of requiredDeps(selected)) selected.add(k);
  render();
});

(async () => {
  try {
    await start();
  } catch (e) {
    banner(esc(e.message));
  }
})();
