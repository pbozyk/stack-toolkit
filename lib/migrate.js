import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildExtensionMap, collectDeps, diffDefinitions, pickDefinition, remapExtensions, stableStringify,
} from './schema.js';

const KIND_LABEL = { ct: 'content type', gf: 'global field' };

async function safe(promise, warnings, label) {
  try { return await promise; } catch (e) {
    warnings.push(`Could not fetch: ${label} (${e.message})`);
    return [];
  }
}

// Fetches both stacks and builds the item list with status, dependencies and diff.
export async function loadState(source, target) {
  const warnings = [];
  const [sCt, sGf, tCt, tGf, sExt, tExt] = await Promise.all([
    source.listContentTypes(),
    source.listGlobalFields(),
    target.listContentTypes(),
    target.listGlobalFields(),
    safe(source.listExtensions(), warnings, 'extensions (source)'),
    safe(target.listExtensions(), warnings, 'extensions (target)'),
  ]);
  const ext = buildExtensionMap(sExt, tExt);

  const items = new Map();
  const add = (kind, list, side) => {
    for (const raw of list) {
      const key = `${kind}:${raw.uid}`;
      const it = items.get(key) || { key, kind, uid: raw.uid };
      it[side] = raw;
      items.set(key, it);
    }
  };
  add('gf', sGf, 'src');
  add('ct', sCt, 'src');
  add('gf', tGf, 'tgt');
  add('ct', tCt, 'tgt');

  for (const it of items.values()) {
    const base = it.src || it.tgt;
    it.title = base.title;
    it.inSource = !!it.src;
    it.inTarget = !!it.tgt;
    it.targetBody = it.tgt ? pickDefinition(it.kind, it.tgt) : null;
    if (it.src) {
      const { schema, missing } = remapExtensions(it.src.schema, ext.map);
      it.body = pickDefinition(it.kind, { ...it.src, schema });
      it.missingExtensions = [...missing].map((uid) => ({ uid, ...(ext.info.get(uid) || { title: '(unknown)' }) }));
    }
    it.status = !it.src ? 'target_only'
      : !it.tgt ? 'new'
      : stableStringify(it.body) === stableStringify(it.targetBody) ? 'same' : 'changed';
    it.diff = it.status === 'changed' ? diffDefinitions(it.body, it.targetBody) : null;

    const deps = collectDeps(base.schema);
    it.deps = [...[...deps.gf].map((u) => `gf:${u}`), ...[...deps.ct].map((u) => `ct:${u}`)]
      .filter((k) => k !== it.key);
    it.selfReference = deps.ct.has(it.uid) && it.kind === 'ct';
    it.extensions = [...deps.ext].map((uid) => ({ uid, ...(ext.info.get(uid) || {}), mapped: ext.map.has(uid) }));
    it.taxonomies = [...deps.tax];
  }
  for (const it of items.values()) it.usedBy = [];
  for (const it of items.values()) for (const d of it.deps) items.get(d)?.usedBy.push(it.key);

  return { items, warnings, loadedAt: new Date().toISOString() };
}

export function publicState(state) {
  const items = [...state.items.values()].map((it) => ({
    key: it.key, kind: it.kind, uid: it.uid, title: it.title,
    inSource: it.inSource, inTarget: it.inTarget, status: it.status,
    deps: it.deps, usedBy: it.usedBy, selfReference: it.selfReference,
    extensions: it.extensions, missingExtensions: it.missingExtensions || [],
    taxonomies: it.taxonomies, diff: it.diff,
    fieldCount: (it.src || it.tgt).schema?.length || 0,
  }));
  return { items, warnings: state.warnings, loadedAt: state.loadedAt };
}

// Order:
// 1) placeholders for new content types (title/url only), so references – including circular ones – have a target,
// 2) global fields in topological order (nested ones first),
// 3) full content type schemas.
export function buildPlan(state, keys) {
  const { items } = state;
  const selected = new Set(keys.filter((k) => items.get(k)?.inSource));
  const problems = [];
  const warnings = [];
  const steps = [];

  for (const k of selected) {
    const it = items.get(k);
    for (const d of it.deps) {
      if (selected.has(d) || items.get(d)?.inTarget) continue;
      problems.push({ key: k, dep: d, inSource: !!items.get(d)?.inSource });
    }
    for (const e of it.missingExtensions) {
      warnings.push(`${it.title}: extension "${e.title}" (${e.uid}) does not exist in the target stack – install it before migrating.`);
    }
    for (const t of it.taxonomies) {
      warnings.push(`${it.title}: uses taxonomy "${t}" – make sure it exists in the target stack.`);
    }
  }

  const active = [...selected].filter((k) => items.get(k).status !== 'same');
  for (const k of selected) {
    if (items.get(k).status === 'same') steps.push({ action: 'skip', key: k });
  }

  const cts = active.filter((k) => k.startsWith('ct:'));
  const gfs = new Set(active.filter((k) => k.startsWith('gf:')));

  for (const k of cts) if (!items.get(k).inTarget) steps.push({ action: 'create-placeholder', key: k });

  const done = new Set();
  const onStack = new Set();
  const visit = (k) => {
    if (done.has(k)) return;
    if (onStack.has(k)) { warnings.push(`Cycle between global fields around ${k}.`); return; }
    onStack.add(k);
    for (const d of items.get(k).deps) if (gfs.has(d)) visit(d);
    onStack.delete(k);
    done.add(k);
    steps.push({ action: items.get(k).inTarget ? 'update' : 'create', key: k });
  };
  for (const k of gfs) visit(k);

  for (const k of cts) steps.push({ action: items.get(k).inTarget ? 'update' : 'fill', key: k });

  for (const s of steps) {
    const it = items.get(s.key);
    s.title = it.title;
    s.kind = it.kind;
  }
  return { steps, problems, warnings: [...new Set(warnings)] };
}

function placeholderFor(src) {
  const schema = [{
    display_name: 'Title', uid: 'title', data_type: 'text', mandatory: true, unique: true,
    field_metadata: { _default: true }, multiple: false,
  }];
  const url = src.schema?.find((f) => f.uid === 'url');
  if (src.options?.is_page && url) schema.push(url);
  return {
    title: src.title,
    uid: src.uid,
    description: src.description || '',
    schema,
    options: { ...(src.options || {}), title: 'title', sub_title: [] },
  };
}

export async function executePlan(state, plan, target, backupRoot, log) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRoot, stamp);
  let ok = 0;
  let failed = 0;
  let backups = 0;

  for (const step of plan.steps) {
    const it = state.items.get(step.key);
    const label = `${KIND_LABEL[it.kind]} "${it.title}" (${it.uid})`;
    if (step.action === 'skip') {
      log({ level: 'info', msg: `Skipped ${label} – identical in both stacks.` });
      continue;
    }
    try {
      if (step.action === 'update') {
        await mkdir(backupDir, { recursive: true });
        await writeFile(path.join(backupDir, `${it.key.replace(':', '_')}.json`), JSON.stringify(it.tgt, null, 2));
        backups++;
      }
      if (step.action === 'create-placeholder') await target.createContentType(placeholderFor(it.body));
      else if (it.kind === 'gf' && step.action === 'create') await target.createGlobalField(it.body);
      else if (it.kind === 'gf') await target.updateGlobalField(it.uid, it.body);
      else await target.updateContentType(it.uid, it.body);

      ok++;
      const verb = {
        'create-placeholder': 'Created placeholder', create: 'Created', update: 'Updated', fill: 'Filled in schema',
      }[step.action];
      log({ level: 'ok', msg: `${verb}: ${label}` });
    } catch (e) {
      failed++;
      log({ level: 'error', msg: `Error (${step.action}) ${label}: ${e.message}` });
    }
  }
  log({
    level: failed ? 'error' : 'ok',
    msg: `Finished: ${ok} operations OK, ${failed} errors.${backups ? ` Backups of overwritten definitions: backups/${stamp}` : ''}`,
    done: true,
  });
}
