const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let config = null;
let entries = [];
let loaded = null; // { stack, ct, locale } of the loaded list
const selected = new Set();
const gone = new Set();
let busy = false;
let ctList = [];
let locales = [];

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

function renderStack() {
  const stack = $('#stack').value;
  $('#stacks').innerHTML = crumb($('#stack').selectedOptions[0].text, config[stack]);
  for (const b of document.querySelectorAll('[data-stack]')) b.classList.toggle('active', b.dataset.stack === stack);
}

// Left panel: content types of the selected stack, like Contentstack's "Content Type Views".
function renderCtPanel() {
  const q = $('#ctSearch').value.trim().toLowerCase();
  const list = ctList.filter((c) => !q || c.title.toLowerCase().includes(q) || c.uid.includes(q));
  $('#ctPanel').innerHTML = list.length
    ? list.map((c) => `<a href="#" data-ct="${esc(c.uid)}" class="${$('#ct').value === c.uid ? 'active' : ''}">
        <span>${esc(c.title)}<small>${esc(c.uid)}</small></span></a>`).join('')
    : '<p class="none">No content types</p>';
}

const localeName = (code) => {
  const l = locales.find((x) => x.code === code);
  return l ? `${l.name}${l.master ? ' (M)' : ''}` : code;
};

// Languages of the selected stack, like Contentstack's language switcher; "All languages" = whole entries.
async function loadLocales(stack) {
  const sel = $('#locale');
  const keep = sel.value;
  locales = [];
  sel.innerHTML = '<option value="">All languages</option>';
  if (!config[stack].configured) return;
  try {
    locales = await api(`/api/entries/locales?stack=${stack}`);
    sel.innerHTML += locales.map((l) => `<option value="${esc(l.code)}">${esc(l.name)}${l.master ? ' (M)' : ''} · ${esc(l.code)}</option>`).join('');
    if (locales.some((l) => l.code === keep)) sel.value = keep;
  } catch (e) {
    banner(esc(e.message));
  }
}

async function loadContentTypes() {
  const stack = $('#stack').value;
  renderStack();
  loadLocales(stack);
  entries = [];
  loaded = null;
  render();
  $('#ct').innerHTML = '<option value="">Loading…</option>';
  ctList = [];
  $('#ctPanel').innerHTML = '<p class="none">Loading…</p>';
  if (!config[stack].configured) {
    $('#ct').innerHTML = '<option value="">— not configured —</option>';
    renderCtPanel();
    return banner(`The ${stack} stack is not connected. <a href="/stacks?next=${encodeURIComponent(location.pathname)}">Connect it →</a>`, 'b-warn');
  }
  try {
    const cts = await api(`/api/entries/content-types?stack=${stack}`);
    $('#ct').innerHTML = `<option value="">— select (${cts.length}) —</option>${cts.map((c) => `<option value="${esc(c.uid)}">${esc(c.title)} (${esc(c.uid)})</option>`).join('')}`;
    ctList = cts;
    renderCtPanel();
    banner('');
  } catch (e) {
    $('#ct').innerHTML = '<option value="">— error —</option>';
    renderCtPanel();
    banner(esc(e.message));
  }
}

async function loadEntries() {
  const stack = $('#stack').value;
  const ct = $('#ct').value;
  if (!ct) return;
  const locale = $('#locale').value;
  const query = $('#query').value.trim();
  const params = new URLSearchParams({ stack, ct });
  if (locale) params.set('locale', locale);
  if (query) params.set('query', query);

  $('#load').disabled = true;
  renderCtPanel();
  $('#content').innerHTML = '<p class="empty">Fetching entries…</p>';
  try {
    entries = await api(`/api/entries?${params}`);
    loaded = { stack, ct, locale, query, title: ctList.find((c) => c.uid === ct)?.title || ct };
    selected.clear();
    gone.clear();
    for (const e of entries) selected.add(e.uid); // everything by default – the main use case is "delete all"
    banner('');
    render();
  } catch (e) {
    banner(esc(e.message));
    $('#content').innerHTML = '';
  } finally {
    $('#load').disabled = false;
  }
}

function render() {
  if (!loaded) {
    $('#content').innerHTML = '<p class="empty">Pick a content type on the left.</p>';
  } else {
    const fmt = (d) => (d ? new Date(d).toLocaleString('en-GB') : '');
    const alive = entries.filter((e) => !gone.has(e.uid));
    const all = alive.length && alive.every((e) => selected.has(e.uid));
    $('#content').innerHTML = `<section class="section">
      <div class="summary">
        <span class="big">${alive.length}</span>
        <span class="meta">entries in <b>${esc(loaded.title)}</b> · ${loaded.locale ? `only localized in <b>${esc(localeName(loaded.locale))}</b>` : 'all languages'}${loaded.query ? ` · query <code>${esc(loaded.query)}</code>` : ''}</span>
        <span class="spacer"></span>
        <button class="btn danger" id="deleteAll" ${alive.length && !busy ? '' : 'disabled'}>${icon('trash-2')}Delete all (${alive.length})</button>
      </div>
      ${entries.length ? `<table class="etable">
        <thead><tr><th><input type="checkbox" id="selAll" ${all ? 'checked' : ''}></th><th>Title</th><th>UID</th><th>Locale</th><th>Modified</th></tr></thead>
        <tbody>${entries.map((e) => `<tr class="${gone.has(e.uid) ? 'gone' : ''}">
          <td><input type="checkbox" data-uid="${esc(e.uid)}" ${selected.has(e.uid) ? 'checked' : ''} ${gone.has(e.uid) ? 'disabled' : ''}></td>
          <td>${esc(e.title)}</td><td><code>${esc(e.uid)}</code></td><td>${e.locales.map((l) => esc(localeName(l))).join(', ')}</td><td>${fmt(e.updated_at)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="empty">No entries.</p>'}
    </section>`;
  }
  const n = [...selected].filter((u) => !gone.has(u)).length;
  $('#selCount').innerHTML = loaded ? `Selected: <b>${n}</b> of ${entries.length - gone.size}` : '';
  $('#deleteBtn').disabled = !n || busy;
  $('#deleteBtn').innerHTML = `${icon('trash-2')}${n ? `Delete selected (${n})` : 'Delete selected'}`;
}

function openModal(title, body, foot = '') {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = foot;
  if (!$('#modal').open) $('#modal').showModal();
}

// Confirmation requires typing the content type UID – so hundreds of entries can't be deleted by one accidental click.
function askDelete(uids) {
  const stackLabel = loaded.stack === 'target' ? 'TARGET' : 'SOURCE';
  openModal('Confirm deletion', `
    <div class="box b-err">You are about to delete <b>${uids.length}</b> entries of content type <b>${esc(loaded.title)}</b>
      from the <b>${stackLabel}</b> stack (${esc(config[loaded.stack].host)}, <code>${esc(config[loaded.stack].apiKey)}</code>, branch ${esc(config[loaded.stack].branch)}).
      <br>${loaded.locale
        ? `Only the <b>${esc(localeName(loaded.locale))}</b> localization – other languages stay.`
        : 'All languages – each entry is deleted together with all its localized versions.'}
      <br>Treat this as irreversible.</div>
    <label class="check-option"><input type="checkbox" id="doBackup">
      <span><b>Download a backup first</b><br><small class="none">A JSON file with the full content of these entries${loaded.locale ? '' : ' in all their languages'}.
        It can be brought back later with “Restore backup”.</small></span></label>
    <label>Type the content type UID <code>${esc(loaded.ct)}</code> to confirm:
      <input class="confirm-input" id="confirmInput" autocomplete="off"></label>`,
  `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="confirmDelete" disabled>Delete ${uids.length} entries</button>`);
  $('#confirmInput').focus();
  $('#confirmInput').addEventListener('input', (e) => { $('#confirmDelete').disabled = e.target.value.trim() !== loaded.ct; });
  $('#confirmDelete').addEventListener('click', () => runDelete(uids, $('#doBackup').checked));
}

const fmtBytes = (b) => (b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

// Fetches the backup and saves it through the browser. Throws – so nothing gets deleted – if it fails.
async function downloadBackup(uids, line) {
  $('#progText').textContent = 'Preparing backup…';
  $('#progBar').parentElement.classList.add('indeterminate');
  try {
    const res = await fetch('/api/entries/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stack: loaded.stack, ct: loaded.ct, locale: loaded.locale, uids }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'entries-backup.json';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    line('ok', `Backup downloaded: ${name} (${fmtBytes(blob.size)})`);
  } catch (e) {
    throw new Error(`Backup failed – nothing was deleted. ${e.message}`);
  } finally {
    $('#progBar').parentElement.classList.remove('indeterminate');
    $('#progText').textContent = `0 / ${uids.length}`;
  }
}

async function runDelete(uids, withBackup) {
  busy = true;
  render();
  openModal('Deleting…', `
    <div id="progText">0 / ${uids.length}</div>
    <div class="progress"><div id="progBar"></div></div>
    <div class="log" id="log"></div>`);
  $('#modal').querySelector('[data-close]').disabled = true;

  let done = 0;
  let failed = 0;
  const log = $('#log');
  const line = (cls, msg) => log.insertAdjacentHTML('beforeend', `<div class="l-${cls}">${esc(msg)}</div>`);
  try {
    if (withBackup) await downloadBackup(uids, line);
    const res = await fetch('/api/entries/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stack: loaded.stack, ct: loaded.ct, locale: loaded.locale, uids }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.done) continue;
        done++;
        if (m.ok) gone.add(m.uid);
        else { failed++; line('error', `${m.uid}: ${m.error}`); }
        $('#progText').textContent = `${done} / ${uids.length}${failed ? ` · errors: ${failed}` : ''}`;
        $('#progBar').style.width = `${(done / uids.length) * 100}%`;
      }
    }
    line(failed ? 'error' : 'ok', `Done: ${done - failed} deleted, ${failed} errors.`);
  } catch (e) {
    line('error', e.message);
  }
  $('#modalTitle').textContent = 'Deletion finished';
  $('#modal').querySelector('[data-close]').disabled = false;
  for (const u of gone) selected.delete(u);
  busy = false;
  render();
}

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close]')) return $('#modal').close();
  if (t.id === 'deleteAll') return askDelete(entries.filter((e) => !gone.has(e.uid)).map((e) => e.uid));
  const ct = t.closest('[data-ct]');
  if (ct) {
    ev.preventDefault();
    $('#ct').value = ct.dataset.ct;
    return loadEntries();
  }
  const st = t.closest('[data-stack]');
  if (st && !busy) {
    $('#stack').value = st.dataset.stack;
    return loadContentTypes();
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.uid) {
    t.checked ? selected.add(t.dataset.uid) : selected.delete(t.dataset.uid);
    render();
  }
  if (t.id === 'selAll') {
    for (const e of entries) if (!gone.has(e.uid)) t.checked ? selected.add(e.uid) : selected.delete(e.uid);
    render();
  }
});

// --- restore -----------------------------------------------------------------

function askRestore(b, fileName) {
  const stack = $('#stack').value;
  const s = config[stack];
  const langs = [...new Set(b.entries.map((e) => e.locale))];
  const otherStack = b.stack && (b.stack.apiKey !== s.apiKey || b.stack.branch !== s.branch);
  const ctKnown = ctList.some((c) => c.uid === b.contentType.uid);
  openModal('Restore backup', `
    <ul class="facts">
      <li><span>File</span><b>${esc(fileName)}</b></li>
      <li><span>Content type</span><b>${esc(b.contentType.title)}</b> <code>${esc(b.contentType.uid)}</code></li>
      <li><span>Entries</span><b>${b.count}</b> · ${langs.map((l) => esc(localeName(l))).join(', ')}</li>
      <li><span>Backed up</span>${new Date(b.createdAt).toLocaleString('en-GB')}${b.stack ? ` from <code>${esc(b.stack.apiKey)}</code> · ${esc(b.stack.branch)}` : ''}</li>
      <li><span>Restore into</span><b>${stack.toUpperCase()}</b> <code>${esc(s.apiKey)}</code> · ${esc(s.branch)}</li>
    </ul>
    ${otherStack ? '<div class="box b-warn">This backup was made on a different stack or branch – it will be restored into the one above.</div>' : ''}
    ${ctKnown ? '' : `<div class="box b-err">Content type <code>${esc(b.contentType.uid)}</code> doesn't exist in this stack. Migrate its schema first.</div>`}
    <p>Entries that no longer exist are created again – Contentstack gives them new UIDs, and references between restored entries are updated.
      Entries that still exist aren't duplicated; only their missing languages are added back. Restored entries are not published.</p>`,
  `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="confirmRestore" ${ctKnown ? '' : 'disabled'}>${icon('upload')}Restore ${b.count} entries</button>`);
  $('#confirmRestore').addEventListener('click', () => runRestore(stack, b));
}

async function runRestore(stack, b) {
  busy = true;
  render();
  openModal('Restoring…', `
    <div id="progText">Starting…</div>
    <div class="progress indeterminate"><div id="progBar"></div></div>
    <div class="log" id="log"></div>`);
  $('#modal').querySelector('[data-close]').disabled = true;
  let done = 0;
  let failed = 0;
  const line = (cls, msg) => $('#log').insertAdjacentHTML('beforeend', `<div class="l-${cls}">${esc(msg)}</div>`);
  try {
    const res = await fetch('/api/entries/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack, backup: b }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        const m = JSON.parse(l);
        if (m.done) continue;
        if (m.uid) {
          done++;
          if (!m.ok) { failed++; line('error', `${m.uid}: ${m.error}`); }
          $('#progBar').parentElement.classList.remove('indeterminate');
          $('#progBar').style.width = `${(done / b.count) * 100}%`;
          $('#progText').textContent = `${done} / ${b.count}${failed ? ` · errors: ${failed}` : ''}`;
        } else if (m.step && !done) {
          $('#progText').textContent = m.step;
        }
      }
    }
    line(failed ? 'error' : 'ok', `Done: ${done - failed} restored, ${failed} errors. Restored entries are unpublished.`);
  } catch (e) {
    line('error', e.message);
  }
  $('#modalTitle').textContent = 'Restore finished';
  $('#modal').querySelector('[data-close]').disabled = false;
  busy = false;
  if (loaded?.ct === b.contentType.uid && loaded.stack === stack) loadEntries();
  else render();
}

$('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const b = JSON.parse(await file.text());
    if (b?.format !== 'stack-toolkit/entries-backup' || !Array.isArray(b.entries)) throw new Error('This is not a Stack Toolkit entries backup.');
    banner('');
    askRestore(b, file.name);
  } catch (e) {
    banner(esc(e instanceof SyntaxError ? 'The file is not valid JSON.' : e.message));
  }
});

$('#modal').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
$('#stack').addEventListener('change', loadContentTypes);
$('#ctSearch').addEventListener('input', renderCtPanel);
$('#locale').addEventListener('change', () => { if ($('#ct').value) loadEntries(); });
$('#ct').addEventListener('change', loadEntries);
$('#load').addEventListener('click', loadEntries);
$('#deleteBtn').addEventListener('click', () => askDelete([...selected].filter((u) => !gone.has(u))));

(async () => {
  try {
    config = await api('/api/config');
    if (!config.source.configured) {
      $('#stacks').innerHTML = stackCrumb('Source', config.source);
      return showRequired($('#content'), ['source']);
    }
    // The Source/Target switch only makes sense when both stacks are connected; Source is always the default.
    document.querySelector('.segmented').hidden = !(config.source.configured && config.target.configured);
    // Links from other tools (e.g. Lorem Ipsum) can preselect ?stack=, ?ct= and ?query=.
    const params = new URLSearchParams(location.search);
    $('#stack').value = params.get('stack') === 'target' && config.target.configured ? 'target' : 'source';
    if (params.get('query')) $('#query').value = params.get('query');
    await loadContentTypes();
    if (params.get('ct') && ctList.some((c) => c.uid === params.get('ct'))) {
      $('#ct').value = params.get('ct');
      await loadEntries();
    }
  } catch (e) {
    banner(esc(e.message));
  }
})();
