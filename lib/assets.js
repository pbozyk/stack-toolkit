// Unused asset detection and cleanup.
//
// Usage is found in two passes:
// 1) every entry of every content type, in every locale, is scanned for asset UIDs – this catches file fields,
//    assets in JSON RTE and asset URLs in HTML RTE / text fields;
// 2) assets the scan did not find are confirmed with the references API, Contentstack's own usage tracking.
// An asset counts as unused only when both passes agree.

const UID_RE = /blt[0-9a-f]{16}/g;
const MAX_REFS = 10; // usage details kept per asset (the count stays exact)

async function pool(items, concurrency, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let it = queue.shift(); it; it = queue.shift()) await fn(it);
  }));
}

function folderPath(uid, folders) {
  const parts = [];
  for (let f = folders.get(uid); f && parts.length < 20; f = folders.get(f.parent_uid)) parts.unshift(f.name);
  return parts.join(' / ');
}

export async function scanAssets(client, { onProgress = () => {}, concurrency = 5 } = {}) {
  onProgress({ step: 'Listing assets and folders…' });
  const all = await client.listAssets({ include_folders: true });
  const folders = new Map(all.filter((a) => a.is_dir).map((f) => [f.uid, f]));
  const assets = all.filter((a) => !a.is_dir);
  const ids = new Set(assets.map((a) => a.uid));

  const uses = new Map(); // asset uid -> Map(entry/locale key -> reference)
  const addUse = (uid, ref) => {
    if (!uses.has(uid)) uses.set(uid, new Map());
    uses.get(uid).set(`${ref.content_type_uid}/${ref.entry_uid}/${ref.locale}`, ref);
  };

  const [cts, locales] = await Promise.all([client.listContentTypes(), client.listLocales()]);
  const total = cts.length * locales.length;
  let done = 0;
  let entryCount = 0;
  for (const ct of cts) {
    for (const l of locales) {
      onProgress({ step: `Scanning entries: ${ct.title} · ${l.code}`, done, total });
      // With a locale the API also returns fallback versions – only really localized ones are scanned here.
      const entries = (await client.listEntries(ct.uid, { locale: l.code })).filter((e) => e.locale === l.code);
      entryCount += entries.length;
      for (const e of entries) {
        for (const uid of new Set(JSON.stringify(e).match(UID_RE) || [])) {
          if (ids.has(uid)) {
            addUse(uid, { entry_uid: e.uid, content_type_uid: ct.uid, content_type_title: ct.title, locale: e.locale, title: e.title });
          }
        }
      }
      done++;
    }
  }

  const candidates = assets.filter((a) => !uses.has(a.uid));
  const unverified = new Set();
  let checked = 0;
  await pool(candidates, concurrency, async (a) => {
    try {
      for (const r of await client.assetReferences(a.uid)) addUse(a.uid, r);
    } catch {
      unverified.add(a.uid);
    }
    checked++;
    if (checked % 10 === 0 || checked === candidates.length) {
      onProgress({ step: `Confirming with the references API: ${checked} / ${candidates.length}`, done: checked, total: candidates.length });
    }
  });

  return {
    scannedAt: new Date().toISOString(),
    stats: { assets: assets.length, folders: folders.size, contentTypes: cts.length, locales: locales.length, entries: entryCount },
    assets: assets.map((a) => {
      const refs = [...(uses.get(a.uid)?.values() || [])];
      return {
        uid: a.uid,
        title: a.title,
        filename: a.filename,
        content_type: a.content_type,
        file_size: Number(a.file_size) || 0,
        url: a.url,
        updated_at: a.updated_at,
        folder: folderPath(a.parent_uid, folders),
        useCount: refs.length,
        uses: refs.slice(0, MAX_REFS),
        unverified: unverified.has(a.uid),
      };
    }),
  };
}

// Deletes assets, re-checking each one with the references API right before deleting –
// an asset that got used since the scan is skipped.
export async function deleteAssets(client, uids, { onProgress, concurrency = 5 } = {}) {
  const failed = [];
  await pool(uids, concurrency, async (uid) => {
    try {
      const refs = await client.assetReferences(uid);
      if (refs.length) throw new Error(`Still used in ${refs.length} entr${refs.length === 1 ? 'y' : 'ies'} – skipped`);
      await client.deleteAsset(uid);
      onProgress?.({ uid, ok: true });
    } catch (e) {
      failed.push({ uid, error: e.message });
      onProgress?.({ uid, ok: false, error: e.message });
    }
  });
  return { deleted: uids.length - failed.length, failed };
}
