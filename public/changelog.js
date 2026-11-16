const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// `code` in changelog items
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

(async () => {
  const box = document.querySelector('#releases');
  try {
    const { version, releases } = await fetch('/api/changelog').then((r) => r.json());
    fetch('/api/config').then((r) => r.json()).then((c) => {
      document.querySelector('#stacks').innerHTML = `${stackCrumb('Source', c.source)}${icon('arrow-right', 'arrow')}${stackCrumb('Target', c.target)}`;
    }).catch(() => {});
    box.innerHTML = `<ol class="timeline">${releases.map((r) => {
      const current = r.version === version;
      const badge = current ? '<span class="pill s-new">Current</span>'
        : r.label === 'Next' ? '<span class="pill s-target_only">Next</span>'
        : r.label ? `<span class="tag">${esc(r.label)}</span>` : '';
      return `<li class="release ${current ? 'current' : ''} ${r.label === 'Next' ? 'next' : ''}">
        <div class="release-dot"></div>
        <div class="release-card">
          <div class="release-head"><span class="release-version">v${esc(r.version)}</span><h2>${esc(r.title)}</h2>${badge}</div>
          <ul>${r.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>
        </div>
      </li>`;
    }).join('')}</ol>`;
  } catch (e) {
    box.innerHTML = `<p class="empty">Could not load the changelog: ${esc(e.message)}</p>`;
  }
})();
