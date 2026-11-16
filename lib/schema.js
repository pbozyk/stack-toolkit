// Schema analysis: dependencies, extension remapping, comparison and field diff.

const toArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const IGNORED_REFS = new Set(['sys_assets']); // assets embedded in RTE – not a content type

export function collectDeps(schema, deps = { ct: new Set(), gf: new Set(), ext: new Set(), tax: new Set() }) {
  for (const f of schema || []) {
    if (f.data_type === 'global_field') {
      if (f.reference_to) deps.gf.add(f.reference_to);
      continue;
    }
    // Reference fields and entries embedded in RTE / JSON RTE.
    for (const uid of toArray(f.reference_to)) if (!IGNORED_REFS.has(uid)) deps.ct.add(uid);
    if (f.extension_uid) deps.ext.add(f.extension_uid);
    for (const p of toArray(f.plugins)) deps.ext.add(typeof p === 'string' ? p : p?.uid);
    for (const t of toArray(f.taxonomies)) if (t?.taxonomy_uid) deps.tax.add(t.taxonomy_uid);
    if (f.data_type === 'group') collectDeps(f.schema, deps);
    if (f.data_type === 'blocks') {
      for (const b of f.blocks || []) {
        if (b.reference_to) deps.gf.add(b.reference_to); // block based on a global field
        else collectDeps(b.schema, deps);
      }
    }
  }
  deps.ext.delete(undefined);
  return deps;
}

// Extension UIDs (custom fields, RTE plugins) differ between stacks – map them by title and type.
export function buildExtensionMap(sourceExt, targetExt) {
  const byTitle = new Map(targetExt.map((e) => [`${e.type}|${e.title}`, e.uid]));
  const map = new Map();
  const info = new Map();
  for (const e of sourceExt) {
    info.set(e.uid, { title: e.title, type: e.type });
    const t = byTitle.get(`${e.type}|${e.title}`);
    if (t) map.set(e.uid, t);
  }
  return { map, info };
}

export function remapExtensions(schema, map, missing = new Set()) {
  const swap = (uid) => {
    if (map.has(uid)) return map.get(uid);
    missing.add(uid);
    return uid;
  };
  const out = (schema || []).map((f) => {
    const n = { ...f };
    if (n.extension_uid) n.extension_uid = swap(n.extension_uid);
    if (Array.isArray(n.plugins)) n.plugins = n.plugins.map((p) => (typeof p === 'string' ? swap(p) : p));
    if (n.data_type === 'group') n.schema = remapExtensions(n.schema, map, missing).schema;
    if (n.data_type === 'blocks' && n.blocks) {
      n.blocks = n.blocks.map((b) => (b.schema ? { ...b, schema: remapExtensions(b.schema, map, missing).schema } : b));
    }
    return n;
  });
  return { schema: out, missing };
}

// Only these keys are sent to the API and compared (no created_at, _version, ACL etc.).
export function pickDefinition(kind, o) {
  const b = { title: o.title, uid: o.uid, description: o.description || '', schema: o.schema || [] };
  if (kind === 'ct') {
    b.options = o.options || {};
    if (o.field_rules?.length) b.field_rules = o.field_rules;
  }
  return b;
}

export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function flattenFields(schema, prefix = '', out = new Map()) {
  for (const f of schema || []) {
    const path = prefix + f.uid;
    const { schema: _s, blocks: _b, ...own } = f;
    out.set(path, { type: f.data_type, sig: stableStringify(own) });
    if (f.data_type === 'group') flattenFields(f.schema, `${path}.`, out);
    if (f.data_type === 'blocks') {
      for (const b of f.blocks || []) {
        const bp = `${path}[${b.uid}]`;
        const { schema: _bs, ...bOwn } = b;
        out.set(bp, { type: b.reference_to ? `block → ${b.reference_to}` : 'block', sig: stableStringify(bOwn) });
        if (b.schema) flattenFields(b.schema, `${bp}.`, out);
      }
    }
  }
  return out;
}

// Field-level diff: what was added, removed or changed in the source compared to the target.
export function diffDefinitions(src, tgt) {
  const meta = ['title', 'description', 'options', 'field_rules']
    .filter((k) => stableStringify(src[k]) !== stableStringify(tgt[k]));
  const a = flattenFields(src.schema);
  const b = flattenFields(tgt.schema);
  const added = [], removed = [], changed = [];
  for (const [p, f] of a) {
    if (!b.has(p)) added.push({ path: p, type: f.type });
    else if (b.get(p).sig !== f.sig) changed.push({ path: p, type: f.type });
  }
  for (const [p, f] of b) if (!a.has(p)) removed.push({ path: p, type: f.type });
  return { meta, added, removed, changed };
}
