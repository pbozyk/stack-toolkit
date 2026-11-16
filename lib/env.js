import { existsSync, readFileSync } from 'node:fs';

// Minimal .env parser – no dependencies.
export function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

export function stackConfig(prefix) {
  const e = process.env;
  return {
    name: prefix === 'SOURCE' ? 'source' : 'target',
    region: e[`${prefix}_REGION`] || 'na',
    apiKey: e[`${prefix}_API_KEY`] || '',
    token: e[`${prefix}_MANAGEMENT_TOKEN`] || '',
    branch: e[`${prefix}_BRANCH`] || '',
    gfApiVersion: e.GLOBAL_FIELDS_API_VERSION ?? '3.2',
  };
}
