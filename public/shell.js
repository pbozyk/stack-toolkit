// Shared page shell: fills the version badge in the header (links to the changelog).
fetch('/api/version')
  .then((r) => r.json())
  .then((v) => {
    for (const el of document.querySelectorAll('[data-app-version]')) el.textContent = `v${v.version}`;
  })
  .catch(() => {});
