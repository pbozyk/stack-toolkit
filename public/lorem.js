const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let config = null;
let stack = 'source';
let cts = [];
let current = null; // selected content type
let locales = [];
let preview = null;
let busy = false;
let previewSeq = 0;

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

// --- stack and content types -----------------------------------------------

function renderStack() {
  $('#stacks').innerHTML = stackCrumb(stack === 'target' ? 'Target' : 'Source', config[stack]);
  for (const b of document.querySelectorAll('[data-stack]')) b.classList.toggle('active', b.dataset.stack === stack);
}

function renderCtPanel() {
  const q = $('#ctSearch').value.trim().toLowerCase();
  const list = cts.filter((c) => !q || c.title.toLowerCase().includes(q) || c.uid.includes(q));
  $('#ctPanel').innerHTML = list.length
    ? list.map((c) => `<a href="#" data-ct="${esc(c.uid)}" class="${current?.uid === c.uid ? 'active' : ''}">
        <span>${esc(c.title)}<small>${esc(c.uid)}</small></span></a>`).join('')
    : '<p class="none">No content types</p>';
}

async function loadStack() {
  renderStack();
  current = null;
  preview = null;
  cts = [];
  $('#ctPanel').innerHTML = '<p class="none">Loading…</p>';
  $('#content').innerHTML = '<p class="empty">Pick a content type on the left.</p>';
  render();
  try {
    [cts, locales] = await Promise.all([
      api(`/api/entries/content-types?stack=${stack}`),
      api(`/api/entries/locales?stack=${stack}`),
    ]);
    banner('');
  } catch (e) {
    banner(esc(e.message));
  }
  renderCtPanel();
}

// --- options ---------------------------------------------------------------

function optionsView() {
  const master = locales.find((l) => l.master)?.code;
  return `<section class="section">
    <div class="section-head">Options</div>
    <div class="card-body lorem-options">
      <label class="form-field"><span class="lbl">Number of entries</span>
        <input type="number" id="count" min="1" max="500" value="10"></label>
      <label class="form-field"><span class="lbl">Fields</span>
        <select id="fill">
          <option value="all">All fields</option>
          <option value="required">Required fields only</option>
        </select></label>
      <label class="form-field"><span class="lbl">Assets</span>
        <select id="assetMode">
          <option value="existing">Use existing assets</option>
          <option value="placeholder">Upload placeholder images</option>
          <option value="none">Leave file fields empty</option>
        </select></label>
      <label class="form-field"><span class="lbl">Tag</span>
        <input id="tag" value="lorem-ipsum" spellcheck="false"></label>
      <div class="form-field wide"><span class="lbl">Languages</span>
        <div class="locale-checks">${locales.map((l) => `<label class="check-row">
          <input type="checkbox" data-locale="${esc(l.code)}" ${l.code === master ? 'checked disabled' : ''}>
          <span>${esc(l.name)}${l.master ? ' (M)' : ''}</span><code>${esc(l.code)}</code></label>`).join('')}
        </div>
        <small class="none">Entries are created in the master language; checked languages get a localized version too.</small>
      </div>
    </div>
  </section>
  <div id="previewBox"></div>`;
}

function options() {
  return {
    count: Number($('#count').value),
    fill: $('#fill').value,
    assetMode: $('#assetMode').value,
    tag: $('#tag').value.trim(),
    locales: [...document.querySelectorAll('[data-locale]:checked')].map((c) => c.dataset.locale),
  };
}

// --- preview ---------------------------------------------------------------

async function loadPreview() {
  if (!current) return;
  const seq = ++previewSeq;
  preview = null;
  render();
  $('#previewBox').innerHTML = '<section class="section"><p class="empty">Generating a sample entry…</p></section>';
  try {
    const p = await api('/api/lorem/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stack, ct: current.uid, options: options() }),
    });
    if (seq !== previewSeq) return; // a newer preview is on its way
    preview = p;
    $('#previewBox').innerHTML = `<section class="section">
      <div class="section-head">Sample entry <span class="spacer"></span>
        <button class="btn ghost" id="reroll">${icon('refresh-cw')}Another sample</button></div>
      <div class="card-body">
        ${p.warnings.length ? `<div class="box b-warn"><b>Some fields won't be filled</b><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
        <p class="none">Each entry gets its own random content like this. Nothing is written until you click Generate.
          Assets in the stack: ${p.assets.available} (${p.assets.images} images).</p>
        <pre class="json-view">${esc(JSON.stringify(p.sample, null, 2))}</pre>
      </div>
    </section>`;
  } catch (e) {
    if (seq !== previewSeq) return;
    $('#previewBox').innerHTML = `<div class="box b-err">${esc(e.message)}</div>`;
  }
  render();
}

async function selectCt(uid) {
  current = cts.find((c) => c.uid === uid);
  renderCtPanel();
  $('#content').innerHTML = optionsView();
  await loadPreview();
}

function render() {
  const n = current && $('#count') ? Number($('#count').value) || 0 : 0;
  $('#selCount').innerHTML = current ? `<b>${n}</b> ${n === 1 ? 'entry' : 'entries'} of <b>${esc(current.title)}</b>` : '';
  $('#generateBtn').disabled = !current || !preview || busy || n < 1 || n > 500;
  $('#generateBtn').innerHTML = `${icon('pilcrow')}Generate ${n || ''} ${n === 1 ? 'entry' : 'entries'}`;
}

// --- generate --------------------------------------------------------------

function openModal(title, body, foot = '') {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalFoot').innerHTML = foot;
  if (!$('#modal').open) $('#modal').showModal();
}

function askGenerate() {
  const o = options();
  const s = config[stack];
  const assetText = { existing: 'random existing assets', placeholder: 'placeholder images uploaded into the “Lorem Ipsum” folder', none: 'none – file fields stay empty' };
  openModal('Generate entries', `
    <ul class="facts">
      <li><span>Stack</span><b>${stack.toUpperCase()}</b> <code>${esc(s.apiKey)}</code> · ${esc(s.branch)}</li>
      <li><span>Content type</span><b>${esc(current.title)}</b> <code>${esc(current.uid)}</code></li>
      <li><span>Entries</span><b>${o.count}</b> in ${o.locales.length > 1 ? `${o.locales.length} languages (${o.locales.map(esc).join(', ')})` : esc(preview.master)}</li>
      <li><span>Assets</span>${assetText[o.assetMode]}</li>
      <li><span>Tag</span><code>${esc(o.tag)}</code></li>
    </ul>
    <p class="none">Entries are created unpublished. Find and delete them later in Entry Cleanup by the tag.</p>`,
  `<button class="btn ghost" data-close>Cancel</button>
   <button class="btn primary" id="runBtn">${icon('pilcrow')}Generate ${o.count} ${o.count === 1 ? 'entry' : 'entries'}</button>`);
  $('#runBtn').addEventListener('click', () => generate(o));
}

async function generate(o) {
  busy = true;
  render();
  openModal('Generating…', `<div class="scan-progress">
    <div id="progText">Starting…</div><div class="progress indeterminate"><div id="progBar"></div></div>
    <div class="log" id="log" hidden></div></div>`);
  $('#modal').querySelector('[data-close]').disabled = true;
  const log = $('#log');
  const line = (cls, msg) => { log.hidden = false; log.insertAdjacentHTML('beforeend', `<div class="l-${cls}">${esc(msg)}</div>`); };
  let result = null;
  try {
    const res = await fetch('/api/lorem/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stack, ct: current.uid, options: o }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readStream(res, (m) => {
      if (m.step) {
        $('#progText').textContent = m.step;
        $('#progBar').parentElement.classList.toggle('indeterminate', !m.total);
        $('#progBar').style.width = m.total ? `${(m.done / m.total) * 100}%` : '';
      }
      if (m.ok === false) line('error', m.error);
      if (m.done) {
        if (m.error) throw new Error(m.error);
        result = m;
      }
    });
  } catch (e) {
    line('error', e.message);
  }
  busy = false;
  $('#modal').querySelector('[data-close]').disabled = false;
  if (!result) { $('#modalTitle').textContent = 'Generation failed'; render(); return; }

  $('#modalTitle').textContent = 'Entries generated';
  $('#progText').textContent = 'Finished';
  $('#progBar').parentElement.classList.remove('indeterminate');
  $('#progBar').style.width = '100%';
  line(result.failed ? 'error' : 'ok', `Created ${result.created} entries${result.failed ? `, ${result.failed} failed` : ''}`
    + `${result.placeholders ? ` · uploaded ${result.placeholders} placeholder images` : ''}. Entries are unpublished.`);
  const query = JSON.stringify({ tags: { $in: [o.tag] } });
  $('#modalFoot').innerHTML = `<button class="btn ghost" data-close>Close</button>
    <a class="btn" href="/entries?${new URLSearchParams({ stack, ct: current.uid, query })}">${icon('list')}Open in Entry Cleanup</a>`;
  render();
}

// --- events ----------------------------------------------------------------

let debounce = null;
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close]')) return $('#modal').close();
  const ct = t.closest('[data-ct]');
  if (ct && !busy) { ev.preventDefault(); return selectCt(ct.dataset.ct); }
  const st = t.closest('[data-stack]');
  if (st && !busy && st.dataset.stack !== stack) { stack = st.dataset.stack; return loadStack(); }
  if (t.closest('#reroll')) return loadPreview();
});

document.addEventListener('change', (ev) => {
  if (ev.target.closest('.lorem-options') && ev.target.id !== 'count') loadPreview();
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'count') render();
  if (ev.target.id === 'tag') { clearTimeout(debounce); debounce = setTimeout(loadPreview, 500); }
});

$('#modal').addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
$('#ctSearch').addEventListener('input', renderCtPanel);
$('#generateBtn').addEventListener('click', askGenerate);

(async () => {
  try {
    config = await api('/api/config');
    if (!config.source.configured) {
      $('#stacks').innerHTML = stackCrumb('Source', config.source);
      return showRequired($('#content'), ['source']);
    }
    // The Source/Target switch only when both stacks are connected; Source is always the default.
    document.querySelector('.segmented').hidden = !config.target.configured;
    await loadStack();
  } catch (e) {
    banner(esc(e.message));
  }
})();
