// Broken references: entries pointing at entries, content types or assets that no longer exist.
//
// Every entry of every content type is read in every locale and walked for
// - reference fields ({ uid, _content_type_uid }) and entries embedded in JSON RTE (attrs entry-uid / content-type-uid),
// - assets: file fields (asset objects or UIDs), assets embedded in JSON RTE (attrs asset-uid),
//   and asset URLs in HTML RTE / text (reported only – they can't be removed automatically).
import { cleanEntry, pool } from './entries.js';

const UID = /^blt[0-9a-f]{16}$/;
const ASSET_URL_RE = /\/v3\/assets\/[^/"'\s]+\/(blt[0-9a-f]{16})\//g;

// UIDs of every file field anywhere in content types and global fields (groups, blocks, nested fields).
function fileFieldKeys(schemas) {
  const keys = new Set();
  const walk = (fields) => {
    for (const f of fields || []) {
      if (f.data_type === 'file') keys.add(f.uid);
      walk(f.schema);
      for (const b of f.blocks || []) walk(b.schema);
    }
  };
  schemas.forEach((s) => walk(s.schema));
  return keys;
}

const isAssetObject = (v) => v && typeof v === 'object' && typeof v.uid === 'string' && 'filename' in v && 'url' in v;

export async function scanBrokenRefs(client, { onProgress = () => {} } = {}) {
  onProgress({ step: 'Reading content types, locales and assets…' });
  const [cts, gfs, locales, assets] = await Promise.all([
    client.listContentTypes(), client.listGlobalFields().catch(() => []), client.listLocales(), client.listAssets(),
  ]);
  const ctMap = new Map(cts.map((c) => [c.uid, c]));
  const assetSet = new Set(assets.filter((a) => !a.is_dir).map((a) => a.uid));
  const fileKeys = fileFieldKeys([...cts, ...gfs]);

  // All entries, really localized per locale: ct -> Map(uid -> versions)
  const entries = new Map();
  const total = cts.length * locales.length;
  let done = 0;
  let versions = 0;
  for (const ct of cts) {
    const byUid = new Map();
    for (const l of locales) {
      onProgress({ step: `Reading entries: ${ct.title} · ${l.code}`, done, total });
      for (const e of await client.listEntries(ct.uid, { locale: l.code })) {
        if (e.locale !== l.code) continue;
        if (!byUid.has(e.uid)) byUid.set(e.uid, []);
        byUid.get(e.uid).push(e);
        versions++;
      }
      done++;
    }
    entries.set(ct.uid, byUid);
  }

  onProgress({ step: 'Checking references…', done: total, total });
  const broken = [];
  for (const [ctUid, byUid] of entries) {
    const ctTitle = ctMap.get(ctUid).title;
    for (const [uid, vers] of byUid) {
      for (const v of vers) {
        const add = (path, kind, ref, refCt) => broken.push({
          id: `${ctUid}/${uid}/${v.locale}/${path}`, ct: ctUid, ctTitle, entry: uid, title: v.title, locale: v.locale,
          field: path.split(/[.[]/)[0], path, kind, ref, refCt: refCt || null, fixable: kind !== 'asset-url',
        });
        const checkEntry = (path, refUid, refCt) => {
          if (!ctMap.has(refCt)) add(path, 'content-type', refUid, refCt);
          else if (!entries.get(refCt)?.has(refUid)) add(path, 'entry', refUid, refCt);
        };
        const walk = (node, path, key) => {
          if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${path}[${i}]`, key));
          if (typeof node === 'string') {
            if (fileKeys.has(key) && UID.test(node) && !assetSet.has(node)) add(path, 'asset', node);
            for (const m of node.matchAll(ASSET_URL_RE)) if (!assetSet.has(m[1])) add(path, 'asset-url', m[1]);
            return;
          }
          if (!node || typeof node !== 'object') return;
          if (typeof node.uid === 'string' && typeof node._content_type_uid === 'string') return checkEntry(path, node.uid, node._content_type_uid);
          if (isAssetObject(node)) { if (!assetSet.has(node.uid)) add(path, 'asset', node.uid); return; }
          const a = node.attrs;
          if (a && typeof a['entry-uid'] === 'string' && typeof a['content-type-uid'] === 'string') checkEntry(path, a['entry-uid'], a['content-type-uid']);
          if (a && typeof a['asset-uid'] === 'string' && !assetSet.has(a['asset-uid'])) add(path, 'asset', a['asset-uid']);
          for (const [k, x] of Object.entries(node)) {
            if (k === 'attrs' || k === 'uid' || k === '_metadata') continue;
            walk(x, path ? `${path}.${k}` : k, k);
          }
        };
        for (const [k, x] of Object.entries(v)) {
          if (['uid', 'ACL', 'publish_details', '_metadata', 'created_by', 'updated_by'].includes(k)) continue;
          walk(x, k, k);
        }
      }
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    stats: { contentTypes: cts.length, locales: locales.length, entries: [...entries.values()].reduce((n, m) => n + m.size, 0), versions, assets: assetSet.size },
    fileKeys: [...fileKeys],
    broken,
  };
}

// Removes the broken references found by the scan from the given entry versions ({ ct, uid, locale }).
// Each version is read fresh, cleaned and written back; HTML RTE asset URLs are left alone.
export async function fixBrokenRefs(client, scan, targets, { onProgress, concurrency = 4 } = {}) {
  const missingEntries = new Set(scan.broken.filter((b) => b.kind === 'entry' || b.kind === 'content-type').map((b) => b.ref));
  const missingAssets = new Set(scan.broken.filter((b) => b.kind === 'asset').map((b) => b.ref));
  const fileKeys = new Set(scan.fileKeys);
  const isBroken = (x) => x && typeof x === 'object' && (
    (typeof x._content_type_uid === 'string' && missingEntries.has(x.uid))
    || (isAssetObject(x) && missingAssets.has(x.uid))
    || missingEntries.has(x.attrs?.['entry-uid'])
    || missingAssets.has(x.attrs?.['asset-uid']));
  const strip = (v, key) => {
    if (Array.isArray(v)) {
      return v.filter((x) => !isBroken(x) && !(typeof x === 'string' && fileKeys.has(key) && missingAssets.has(x))).map((x) => strip(x, key));
    }
    if (v && typeof v === 'object') {
      if (isAssetObject(v) && missingAssets.has(v.uid)) return null;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && fileKeys.has(k) && missingAssets.has(x) ? null : strip(x, k)]));
    }
    return v;
  };

  const failed = [];
  await pool(targets, concurrency, async (t) => {
    try {
      const e = await client.getEntry(t.ct, t.uid, { locale: t.locale });
      if (e.locale !== t.locale) throw new Error(`entry is not localized in ${t.locale}`);
      await client.updateEntry(t.ct, t.uid, cleanEntry(strip(e)), { locale: t.locale });
      onProgress?.({ ...t, ok: true });
    } catch (err) {
      failed.push({ ...t, error: err.message });
      onProgress?.({ ...t, ok: false, error: err.message });
    }
  });
  return { fixed: targets.length - failed.length, failed };
}
