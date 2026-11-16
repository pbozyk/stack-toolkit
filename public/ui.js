// Shared UI pieces: the "Stack › branch" crumb and the "stack is required" empty state. Needs icons.js.

const uEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function stackCrumb(label, s) {
  return `<span class="crumb ${s.configured ? '' : 'missing'}" title="${uEsc(s.host)}">
    ${icon('layers')}<b>${label}</b>${s.apiKey ? `<code>${uEsc(s.apiKey)}</code>` : '<em>not connected</em>'}
    ${icon('chevron-right', 'sep')}${icon('git-branch')}${uEsc(s.branch)}</span>`;
}

// Same mark as the logo, just bigger.
const EMPTY_MARK = `<span class="empty-mark">${icon('layers')}</span>`;

const REQUIRED_TEXT = {
  source: ['Source stack is required', 'Connect the stack you want to work on to use this tool.'],
  target: ['Target stack is required', 'Schema Migration copies content types and global fields from the source into a target stack. Connect the target to compare and migrate.'],
  both: ['Source and target stacks are required', 'Schema Migration compares two stacks and copies schemas from the source into the target. Connect both to get started.'],
};

// missing: ['source'], ['target'] or ['source', 'target'].
function requiredState(missing) {
  const [title, text] = REQUIRED_TEXT[missing.length > 1 ? 'both' : missing[0]];
  const label = missing.length > 1 ? 'Connect stacks' : `Connect ${missing[0]} stack`;
  return `<div class="empty-state">
    ${EMPTY_MARK}
    <h2>${title}</h2>
    <p>${text}<br><small>Credentials stay in server memory for your browser session only.</small></p>
    <a class="btn primary" href="/stacks?next=${encodeURIComponent(location.pathname)}">${icon('key-round')}${label}</a>
  </div>`;
}

// Hides the tool's controls and shows the empty state in their place.
function showRequired(container, missing) {
  document.body.classList.add('needs-stack');
  container.innerHTML = requiredState(missing);
}
