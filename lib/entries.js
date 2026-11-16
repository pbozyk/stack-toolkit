// Bulk entry operations used by Entry Cleanup.

// Locales of the stack, master locale first and flagged.
// GET /stacks needs a user authtoken, so with a management token the master is recognized
// as the only locale without a fallback.
export async function listLocalesBrief(client) {
  const [locales, stackMaster] = await Promise.all([
    client.listLocales(),
    client.getStack().then((s) => s?.master_locale).catch(() => null),
  ]);
  const roots = locales.filter((l) => !l.fallback_locale);
  const master = stackMaster || (roots.length === 1 ? roots[0].code : null);
  return locales
    .map((l) => ({ code: l.code, name: l.name, master: l.code === master }))
    .sort((a, b) => b.master - a.master || a.name.localeCompare(b.name));
}

// Entries really localized in one locale. With a locale the API also returns unlocalized entries
// (falling back to another locale), so those are filtered out – a delete must never hit another version.
async function listLocalized(client, ct, locale, query) {
  const q = { 'only[BASE][]': ['title', 'locale', 'updated_at'], locale };
  if (query) q.query = query;
  return (await client.listEntries(ct, q)).filter((e) => e.locale === locale);
}

// Without a locale: every entry in any language, merged by UID, with the locales it exists in.
// (Listing without a locale would only return entries that exist in the master locale.)
export async function listEntriesBrief(client, ct, { query, locale } = {}) {
  if (locale) {
    return (await listLocalized(client, ct, locale, query)).map((e) => ({ ...e, locales: [e.locale] }));
  }
  const locales = await listLocalesBrief(client);
  const byUid = new Map();
  for (const l of locales) {
    for (const e of await listLocalized(client, ct, l.code, query)) {
      const cur = byUid.get(e.uid);
      if (!cur) byUid.set(e.uid, { ...e, locales: [e.locale] });
      else {
        cur.locales.push(e.locale);
        if (e.updated_at > cur.updated_at) cur.updated_at = e.updated_at;
      }
    }
  }
  return [...byUid.values()];
}

// Deletes entries a few at a time in parallel; the client handles 429 retries.
// With a locale only that localization is deleted. Without one, the current localizations of each entry
// are looked up and deleted one by one – the master version last, after its localized versions.
export async function deleteEntries(client, ct, uids, { locale, concurrency = 5, onProgress } = {}) {
  let plan;
  if (locale) {
    plan = new Map(uids.map((uid) => [uid, [locale]]));
  } else {
    const master = (await listLocalesBrief(client)).find((l) => l.master)?.code;
    const current = new Map((await listEntriesBrief(client, ct)).map((e) => [e.uid, e.locales]));
    plan = new Map(uids.map((uid) => [uid, (current.get(uid) || [])
      .sort((a, b) => (a === master) - (b === master))]));
  }

  const queue = [...uids];
  const failed = [];

  async function worker() {
    for (let uid = queue.shift(); uid; uid = queue.shift()) {
      try {
        const locs = plan.get(uid);
        if (!locs.length) throw new Error('Entry not found in any locale (already deleted?)');
        for (const l of locs) await client.deleteEntry(ct, uid, { locale: l });
        onProgress?.({ uid, ok: true });
      } catch (e) {
        failed.push({ uid, error: e.message });
        onProgress?.({ uid, ok: false, error: e.message });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { deleted: uids.length - failed.length, failed };
}

// --- backup & restore -------------------------------------------------------------
// A backup is one JSON file with the full content of the selected entries in every backed-up locale.
// Restoring creates the entries again (Contentstack assigns new UIDs), fixes references between restored
// entries, and only re-adds missing localizations for entries that still exist. Restored entries are unpublished.

export const BACKUP_FORMAT = 'stack-toolkit/entries-backup';
const UID_RE = /blt[0-9a-f]{16}/g;
// System fields that can't (or shouldn't) be written back.
const SYSTEM_KEYS = ['uid', 'created_at', 'updated_at', 'created_by', 'updated_by', '_version', 'ACL',
  'publish_details', '_in_progress', 'locale', '_metadata', '_workflow', '_rules'];

export async function pool(items, concurrency, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let it = queue.shift(); it; it = queue.shift()) await fn(it);
  }));
}

export async function backupEntries(client, ct, uids, { locale } = {}) {
  const locales = await listLocalesBrief(client);
  const want = new Set(uids);
  const entries = [];
  for (const l of locale ? locales.filter((x) => x.code === locale) : locales) {
    const list = await client.listEntries(ct, { locale: l.code });
    entries.push(...list.filter((e) => want.has(e.uid) && e.locale === l.code));
  }
  const ctDef = (await client.listContentTypes()).find((c) => c.uid === ct);
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    contentType: { uid: ct, title: ctDef?.title || ct },
    scope: locale || 'all',
    masterLocale: locales.find((l) => l.master)?.code || null,
    count: new Set(entries.map((e) => e.uid)).size,
    entries,
  };
}

// File fields come back from the API as full asset objects, but are written as asset UIDs.
function assetsToUids(v) {
  if (Array.isArray(v)) return v.map(assetsToUids);
  if (v && typeof v === 'object') {
    if (typeof v.uid === 'string' && 'filename' in v && 'url' in v) return v.uid;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, assetsToUids(x)]));
  }
  return v;
}

// Entry data ready to be written: no system fields, file fields as asset UIDs.
export function cleanEntry(e) {
  const o = { ...e };
  for (const k of SYSTEM_KEYS) delete o[k];
  return assetsToUids(o);
}

// Drops references (reference fields and entries embedded in JSON RTE) to the given entry UIDs –
// used for entries that don't exist (yet) in the stack being written to.
export function stripRefs(v, uids) {
  if (Array.isArray(v)) {
    return v.filter((x) => !(x && typeof x === 'object' && (uids.has(x.uid) || uids.has(x.attrs?.['entry-uid']))))
      .map((x) => stripRefs(x, uids));
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripRefs(x, uids)]));
  return v;
}

const clean = cleanEntry;

export function validateBackup(b) {
  if (!b || b.format !== BACKUP_FORMAT || !Array.isArray(b.entries) || !/^[a-z0-9_]+$/.test(b.contentType?.uid || '')) {
    throw new Error('This is not a Stack Toolkit entries backup.');
  }
  for (const e of b.entries) {
    if (!/^blt[0-9a-z]+$/.test(e?.uid || '') || !/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(e?.locale || '')) throw new Error('The backup contains an invalid entry.');
  }
}

export async function restoreEntries(client, backup, { onProgress = () => {}, concurrency = 5 } = {}) {
  validateBackup(backup);
  const ct = backup.contentType.uid;
  const byUid = new Map();
  for (const e of backup.entries) {
    if (!byUid.has(e.uid)) byUid.set(e.uid, []);
    byUid.get(e.uid).push(e);
  }
  const internal = new Set(byUid.keys());
  const existing = new Set((await listEntriesBrief(client, ct)).map((e) => e.uid));
  const master = (await listLocalesBrief(client)).find((l) => l.master)?.code;
  const firstVersion = (vers) => vers.find((v) => v.locale === master) || vers[0];

  const map = new Map(); // old uid -> uid in the stack now
  const failed = [];
  let done = 0;
  const total = byUid.size;
  const step = (msg) => onProgress({ step: msg, done, total });

  // Pass 1: create entries that no longer exist (in their master version if they had one).
  step('Creating entries…');
  await pool([...byUid.entries()], concurrency, async ([uid, vers]) => {
    if (existing.has(uid)) { map.set(uid, uid); return; }
    const first = firstVersion(vers);
    try {
      const created = await client.createEntry(ct, stripRefs(clean(first), internal), { locale: first.locale });
      map.set(uid, created.uid);
    } catch (e) {
      failed.push({ uid, error: e.message });
      onProgress({ uid, ok: false, error: e.message });
    }
  });

  // Pass 2: write every localization with references remapped to the new UIDs.
  const remap = (o) => JSON.parse(JSON.stringify(o).replace(UID_RE, (u) => map.get(u) || u));
  await pool([...byUid.entries()], concurrency, async ([uid, vers]) => {
    if (!map.has(uid)) { done++; return; }
    try {
      const first = firstVersion(vers);
      for (const v of vers) {
        const refsOthers = (JSON.stringify(v).match(UID_RE) || []).some((u) => u !== uid && internal.has(u));
        if (!existing.has(uid) && v === first && !refsOthers) continue; // already written in pass 1
        await client.updateEntry(ct, map.get(uid), remap(clean(v)), { locale: v.locale });
      }
      done++;
      onProgress({ uid, newUid: map.get(uid), ok: true, existed: existing.has(uid) });
    } catch (e) {
      done++;
      failed.push({ uid, error: e.message });
      onProgress({ uid, ok: false, error: e.message });
    }
    if (done % 10 === 0) step(`Writing entries: ${done} / ${total}`);
  });

  return { restored: total - failed.length, failed };
}
