// Entry Migration: copies entries (all locales) from the source to the target stack, together with the
// entries they reference and the assets they use.
//
// UIDs differ between stacks, so entries are matched by a field (title by default, or e.g. external_id).
// Plan first (nothing is written), then run:
//   1) assets – reused when the target has the same file name and size, otherwise downloaded from the source
//      and uploaded into the same folder path;
//   2) entries to create – created without references to entries that don't exist yet;
//   3) every version written with entry/asset UIDs and asset URLs remapped to the target.
import { cleanEntry, listLocalesBrief, pool, stripRefs } from './entries.js';

const UID_RE = /blt[0-9a-f]{16}/g;
const URL_RE = /https?:\/\/[^"'\s)<>\\]+/g;
const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

// References in an entry: reference fields ({ uid, _content_type_uid }) and entries embedded in JSON RTE.
function refsOf(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => refsOf(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.uid === 'string' && typeof value._content_type_uid === 'string') out.push({ ct: value._content_type_uid, uid: value.uid });
    const a = value.attrs;
    if (a && typeof a['entry-uid'] === 'string' && typeof a['content-type-uid'] === 'string') out.push({ ct: a['content-type-uid'], uid: a['entry-uid'] });
    Object.values(value).forEach((v) => refsOf(v, out));
  }
  return out;
}

function folderPath(uid, folders) {
  const parts = [];
  for (let f = folders.get(uid); f && parts.length < 20; f = folders.get(f.parent_uid)) parts.unshift(f.name);
  return parts;
}

// Entries of a content type, really localized per locale: Map(uid -> versions[]).
async function loadVersions(client, ct, locales, fields) {
  const byUid = new Map();
  for (const l of locales) {
    const q = { locale: l };
    if (fields) q['only[BASE][]'] = [...new Set([...fields, 'locale'])]; // locale is needed to tell real localizations apart
    for (const e of await client.listEntries(ct, q)) {
      if (e.locale !== l) continue;
      if (!byUid.has(e.uid)) byUid.set(e.uid, []);
      byUid.get(e.uid).push(e);
    }
  }
  return byUid;
}

// Fields the user can match entries by: title plus top-level single-value text/number fields.
export function matchFields(schema = []) {
  return schema
    .filter((f) => f.uid === 'title' || (['text', 'number'].includes(f.data_type) && !f.multiple && !f.field_metadata?.allow_rich_text && !f.field_metadata?.markdown))
    .map((f) => ({ uid: f.uid, name: f.display_name || f.uid, unique: !!f.unique }));
}

// Source entries of one content type with their match status in the target.
export async function listForMigration(src, tgt, ct, matchField = 'title') {
  const [srcLocs, tgtLocs, tgtCts] = await Promise.all([listLocalesBrief(src), listLocalesBrief(tgt), tgt.listContentTypes()]);
  const inTarget = tgtCts.some((c) => c.uid === ct);
  const fields = ['title', 'updated_at', ...(matchField === 'title' ? [] : [matchField])];
  const source = await loadVersions(src, ct, srcLocs.map((l) => l.code), fields);
  const index = new Map();
  if (inTarget) {
    for (const [uid, vers] of await loadVersions(tgt, ct, tgtLocs.map((l) => l.code), ['title', matchField])) {
      for (const v of vers) if (norm(v[matchField])) index.set(norm(v[matchField]), uid);
    }
  }
  return {
    inTarget,
    entries: [...source.entries()].map(([uid, vers]) => {
      const hit = vers.map((v) => index.get(norm(v[matchField]))).find(Boolean);
      return {
        uid,
        title: vers[0].title,
        locales: vers.map((v) => v.locale),
        match: vers.map((v) => v[matchField]).find((x) => x != null && x !== '') ?? null,
        targetUid: hit || null,
        updated_at: vers.map((v) => v.updated_at).sort().pop(),
      };
    }),
  };
}

export async function planEntryMigration(src, tgt, { ct, uids, matchField = 'title', existing = 'skip', includeRefs = true, onProgress = () => {} }) {
  const warnings = [];
  onProgress({ step: 'Reading locales and content types…' });
  const [srcLocs, tgtLocs, srcCts, tgtCts] = await Promise.all([
    listLocalesBrief(src), listLocalesBrief(tgt), src.listContentTypes(), tgt.listContentTypes(),
  ]);
  const srcCtMap = new Map(srcCts.map((c) => [c.uid, c]));
  const tgtCtMap = new Map(tgtCts.map((c) => [c.uid, c]));
  if (!tgtCtMap.has(ct)) throw new Error(`Content type "${ct}" doesn't exist in the target stack – migrate its schema first.`);

  const tgtCodes = new Set(tgtLocs.map((l) => l.code));
  const srcCodes = srcLocs.map((l) => l.code);
  const tgtMaster = tgtLocs.find((l) => l.master)?.code;
  const missingLocales = srcCodes.filter((c) => !tgtCodes.has(c));
  if (missingLocales.length) warnings.push(`Locales missing in the target are skipped: ${missingLocales.join(', ')}.`);

  // Referenced content types are matched by the same field when they have it, otherwise by title.
  const fieldFor = (c) => (c === ct || srcCtMap.get(c)?.schema?.some((f) => f.uid === matchField) ? matchField : 'title');

  const srcCache = new Map();
  const tgtIndex = new Map();
  const loadSource = async (c) => {
    if (!srcCache.has(c)) {
      onProgress({ step: `Reading source entries: ${srcCtMap.get(c)?.title || c}` });
      srcCache.set(c, await loadVersions(src, c, srcCodes));
    }
    return srcCache.get(c);
  };
  const indexTarget = async (c) => {
    if (!tgtIndex.has(c)) {
      onProgress({ step: `Matching with the target: ${srcCtMap.get(c)?.title || c}` });
      const idx = new Map();
      const f = fieldFor(c);
      for (const [uid, vers] of await loadVersions(tgt, c, [...tgtCodes], ['title', f])) {
        for (const v of vers) if (norm(v[f])) idx.set(norm(v[f]), uid);
      }
      tgtIndex.set(c, idx);
    }
    return tgtIndex.get(c);
  };
  const matchInTarget = async (c, versions) => {
    const idx = await indexTarget(c);
    const f = fieldFor(c);
    return versions.map((v) => idx.get(norm(v[f]))).find(Boolean) || null;
  };

  // Selected entries plus (optionally) everything they reference, recursively.
  const items = new Map();
  const dropped = new Set(); // source entry UIDs that can't be linked in the target
  const external = new Map(); // referenced but not migrated: source uid -> target uid
  const missingCts = new Set();
  let missingSource = 0;
  let noMatch = 0;
  const queue = uids.map((uid) => ({ ct, uid, root: true }));
  while (queue.length) {
    const { ct: c, uid, root } = queue.shift();
    const key = `${c}/${uid}`;
    if (items.has(key) || dropped.has(uid) || external.has(uid)) continue;
    if (!tgtCtMap.has(c)) { missingCts.add(c); dropped.add(uid); continue; }
    const versions = (await loadSource(c)).get(uid);
    if (!versions) { missingSource++; dropped.add(uid); continue; }
    if (!root && !includeRefs) {
      const hit = await matchInTarget(c, versions);
      if (hit) external.set(uid, hit); else { noMatch++; dropped.add(uid); }
      continue;
    }
    const usable = versions.filter((v) => tgtCodes.has(v.locale));
    const item = { key, ct: c, uid, root, versions: usable, skippedLocales: versions.length - usable.length };
    item.targetUid = await matchInTarget(c, versions);
    item.action = item.targetUid ? (existing === 'update' ? 'update' : 'skip') : 'create';
    if (!usable.length) { item.action = 'skip-locales'; dropped.add(uid); }
    items.set(key, item);
    for (const r of refsOf(versions)) queue.push({ ct: r.ct, uid: r.uid, root: false });
  }
  if (missingCts.size) warnings.push(`References to content types missing in the target are removed: ${[...missingCts].join(', ')}.`);
  if (missingSource) warnings.push(`${missingSource} referenced entries no longer exist in the source – those references are removed.`);
  if (noMatch) warnings.push(`${noMatch} referenced entries have no match in the target – those references are removed. Turn on “Include referenced entries” to bring them along.`);
  const noLocale = [...items.values()].filter((i) => i.action === 'skip-locales').length;
  if (noLocale) warnings.push(`${noLocale} entries exist only in locales missing in the target and are skipped.`);

  // Fields present in the source schema but missing in the target would be lost or rejected.
  for (const c of new Set([...items.values()].filter((i) => ['create', 'update'].includes(i.action)).map((i) => i.ct))) {
    const tgtFields = new Set((tgtCtMap.get(c).schema || []).map((f) => f.uid));
    const missing = (srcCtMap.get(c)?.schema || []).map((f) => f.uid).filter((f) => !tgtFields.has(f));
    if (missing.length) warnings.push(`${srcCtMap.get(c)?.title || c}: fields missing in the target (${missing.join(', ')}) – run Schema Migration first.`);
  }

  // Assets used by the entries that will be written.
  onProgress({ step: 'Checking assets…' });
  const writing = [...items.values()].filter((i) => ['create', 'update'].includes(i.action));
  const [srcAll, tgtAll] = await Promise.all([src.listAssets({ include_folders: true }), tgt.listAssets({ include_folders: true })]);
  const srcAssets = new Map(srcAll.filter((a) => !a.is_dir).map((a) => [a.uid, a]));
  const srcFolders = new Map(srcAll.filter((a) => a.is_dir).map((f) => [f.uid, f]));
  const tgtByFile = new Map(tgtAll.filter((a) => !a.is_dir).map((a) => [`${a.filename}|${a.file_size}`, a]));
  const needed = new Set();
  for (const i of writing) for (const v of i.versions) for (const u of JSON.stringify(v).match(UID_RE) || []) if (srcAssets.has(u)) needed.add(u);
  const assets = [...needed].map((uid) => {
    const a = srcAssets.get(uid);
    const reuse = tgtByFile.get(`${a.filename}|${a.file_size}`);
    return {
      uid, filename: a.filename, title: a.title, description: a.description, url: a.url,
      size: Number(a.file_size) || 0, folder: folderPath(a.parent_uid, srcFolders),
      action: reuse ? 'reuse' : 'upload', target: reuse ? { uid: reuse.uid, url: reuse.url } : null,
    };
  });

  const list = [...items.values()];
  const count = (pred) => list.filter(pred).length;
  const byCt = [...new Set(list.map((i) => i.ct))].map((c) => ({
    ct: c,
    title: srcCtMap.get(c)?.title || c,
    create: count((i) => i.ct === c && i.action === 'create'),
    update: count((i) => i.ct === c && i.action === 'update'),
    skip: count((i) => i.ct === c && i.action.startsWith('skip')),
  }));
  const upload = assets.filter((a) => a.action === 'upload');

  return {
    summary: {
      contentType: { uid: ct, title: srcCtMap.get(ct)?.title || ct },
      selected: uids.length,
      pulledIn: count((i) => !i.root),
      create: count((i) => i.action === 'create'),
      update: count((i) => i.action === 'update'),
      skip: count((i) => i.action.startsWith('skip')),
      byCt,
      assets: { upload: upload.length, uploadBytes: upload.reduce((n, a) => n + a.size, 0), reuse: assets.length - upload.length },
      linkedExisting: external.size,
      warnings,
    },
    // Internal – kept on the server between plan and run.
    internal: { items: list, assets, dropped: [...dropped], external: [...external], tgtMaster, tgtAll },
  };
}

export async function runEntryMigration(tgt, plan, { onProgress = () => {}, concurrency = 4 } = {}) {
  const { items, assets, dropped, external, tgtMaster, tgtAll } = plan.internal;
  const uidMap = new Map(external);
  const urlMap = new Map();
  const failed = [];
  const writing = items.filter((i) => ['create', 'update'].includes(i.action));
  const total = assets.length + writing.length;
  let done = 0;
  const tick = (step) => onProgress({ step, done, total });

  // 1) Assets – folders recreated by path.
  const folderUid = new Map(); // "a/b" -> target folder uid
  const tgtFolders = tgtAll.filter((a) => a.is_dir);
  const ensureFolder = async (parts) => {
    let parent = null;
    for (let n = 1; n <= parts.length; n++) {
      const path = parts.slice(0, n).join('/');
      if (!folderUid.has(path)) {
        const name = parts[n - 1];
        const existing = tgtFolders.find((f) => f.name === name && (f.parent_uid || null) === parent);
        const f = existing || await tgt.createFolder(name, parent);
        if (!existing) tgtFolders.push(f);
        folderUid.set(path, f.uid);
      }
      parent = folderUid.get(path);
    }
    return parent;
  };
  for (const a of assets) {
    try {
      let target = a.target;
      if (a.action === 'upload') {
        tick(`Uploading asset ${a.filename}`);
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        const blob = await res.blob();
        const parentUid = a.folder.length ? await ensureFolder(a.folder) : null;
        const up = await tgt.uploadAsset(blob, { filename: a.filename, title: a.title, description: a.description, parentUid });
        target = { uid: up.uid, url: up.url };
      }
      uidMap.set(a.uid, target.uid);
      urlMap.set(a.url, target.url);
      onProgress({ asset: a.uid, ok: true, action: a.action });
    } catch (e) {
      failed.push({ asset: a.uid, error: e.message });
      onProgress({ asset: a.uid, ok: false, error: `Asset ${a.filename}: ${e.message}` });
    }
    done++;
  }

  // 2) Entries: existing matches are linked, new ones created without references to not-yet-created entries.
  for (const i of items) if (i.targetUid) uidMap.set(i.uid, i.targetUid);
  const droppedSet = new Set(dropped);
  const remap = (o) => JSON.parse(JSON.stringify(o)
    .replace(URL_RE, (u) => {
      const [base, qs] = u.split('?');
      const to = urlMap.get(u) || urlMap.get(base);
      return to ? (urlMap.has(u) ? to : `${to}${qs ? `?${qs}` : ''}`) : u;
    })
    .replace(UID_RE, (u) => uidMap.get(u) || u));
  const firstVersion = (i) => i.versions.find((v) => v.locale === tgtMaster) || i.versions[0];
  const toCreate = writing.filter((i) => i.action === 'create');
  const pending = new Set(toCreate.map((i) => i.uid));

  tick('Creating entries…');
  await pool(toCreate, concurrency, async (i) => {
    const first = firstVersion(i);
    try {
      const created = await tgt.createEntry(i.ct, remap(stripRefs(cleanEntry(first), new Set([...pending, ...droppedSet]))), { locale: first.locale });
      uidMap.set(i.uid, created.uid);
    } catch (e) {
      i.error = e.message;
    }
  });
  // Entries that failed to be created can't be linked either.
  for (const i of toCreate) if (i.error) droppedSet.add(i.uid);

  // 3) Every version written with final references.
  await pool(writing, concurrency, async (i) => {
    try {
      if (i.error) throw new Error(i.error);
      const first = firstVersion(i);
      for (const v of i.versions) {
        const refsPending = (JSON.stringify(cleanEntry(v)).match(UID_RE) || []).some((u) => pending.has(u));
        if (i.action === 'create' && v === first && !refsPending) continue; // already complete from step 2
        await tgt.updateEntry(i.ct, uidMap.get(i.uid), remap(stripRefs(cleanEntry(v), droppedSet)), { locale: v.locale });
      }
      onProgress({ entry: i.key, ok: true, action: i.action, targetUid: uidMap.get(i.uid), title: i.versions[0]?.title });
    } catch (e) {
      failed.push({ entry: i.key, error: e.message });
      onProgress({ entry: i.key, ok: false, error: `${i.versions[0]?.title || i.uid}: ${e.message}` });
    }
    done++;
    if (done % 5 === 0) tick(`Writing entries: ${done - assets.length} / ${writing.length}`);
  });

  return { assets: assets.length, entries: writing.length, failed };
}
