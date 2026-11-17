import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, stackConfig } from './lib/env.js';
import { createClient, resolveHost, REGIONS } from './lib/contentstack.js';
import { buildPlan, executePlan, loadState, publicState } from './lib/migrate.js';
import { backupEntries, deleteEntries, listEntriesBrief, listLocalesBrief, restoreEntries, validateBackup } from './lib/entries.js';
import { deleteAssets, scanAssets } from './lib/assets.js';
import { createSessionStore } from './lib/session.js';
import { fixBrokenRefs, scanBrokenRefs } from './lib/broken-refs.js';
import { listForMigration, matchFields, planEntryMigration, runEntryMigration } from './lib/entry-migration.js';
import { randomUUID } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
loadEnv(path.join(ROOT, '.env'));
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// CHANGELOG.md: "## <version> — <title>", an optional "Label: …" line, then "- " bullet points.
async function readChangelog() {
  const md = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const releases = [];
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(\S+)\s+[—–-]\s+(.+)$/);
    if (h) { releases.push({ version: h[1], title: h[2].trim(), label: null, items: [] }); continue; }
    const r = releases[releases.length - 1];
    if (!r) continue;
    const l = line.match(/^Label:\s*(.+)$/);
    if (l) r.label = l[1].trim();
    else if (line.startsWith('- ')) r.items.push(line.slice(2).trim());
  }
  return releases;
}

const env = process.env;
const port = Number(env.PORT) || 3000;
const bindHost = env.HOST || '127.0.0.1';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(bindHost);
// Host header allow-list – blocks DNS rebinding (a foreign site resolving its name to this server).
const allowedHosts = new Set((env.ALLOWED_HOSTS || `localhost:${port},127.0.0.1:${port}`)
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
// On Render, the service's own *.onrender.com name is always allowed.
if (env.RENDER_EXTERNAL_HOSTNAME) allowedHosts.add(env.RENDER_EXTERNAL_HOSTNAME.toLowerCase());
const trustProxy = env.TRUST_PROXY === '1';

const sessions = createSessionStore({
  idleMs: (Number(env.SESSION_IDLE_HOURS) || 8) * 3600_000,
  maxMs: (Number(env.SESSION_MAX_HOURS) || 24) * 3600_000,
});

// Stacks from .env – shared by everyone who can open the panel. On a shared server leave them empty.
const envStacks = {};
for (const side of ['source', 'target']) {
  const cfg = stackConfig(side.toUpperCase());
  envStacks[side] = cfg.apiKey && cfg.token ? { cfg, client: createClient(cfg), origin: 'env' } : null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' https: data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; '),
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 1_000_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, 'Request body too large.');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function startStream(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  return (o) => res.write(`${JSON.stringify(o)}\n`);
}

const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '');
const CT_UID = /^[a-z0-9_]+$/;
const isHttps = (req) => (trustProxy ? req.headers['x-forwarded-proto'] === 'https' : !!req.socket.encrypted) || env.COOKIE_SECURE === '1';

// --- per-request context --------------------------------------------------------
// Credentials entered in the panel (session) win over .env. All caches are per session,
// so two people on one server never see each other's stacks or scans.

function contextFor(session) {
  const stacks = {};
  for (const side of ['source', 'target']) stacks[side] = session.creds[side] || envStacks[side];
  const d = session.data;
  d.assetScans ??= {};
  d.assetJobs ??= new Map();
  return { session, stacks, data: d };
}

function pickStack(ctx, name) {
  if (!['source', 'target'].includes(name)) throw new HttpError(400, 'Unknown stack (allowed: source, target).');
  const s = ctx.stacks[name];
  if (!s) throw new HttpError(400, `The ${name} stack is not connected – connect it on the Stacks page.`);
  return s.client;
}

function assertBothConnected(ctx) {
  const { source, target } = ctx.stacks;
  if (!source || !target) throw new HttpError(400, 'Connect both the source and the target stack on the Stacks page.');
  if (source.cfg.apiKey === target.cfg.apiKey && (source.cfg.branch || 'main') === (target.cfg.branch || 'main')) {
    throw new HttpError(400, 'Source and target point to the same stack and branch.');
  }
}

const describe = (s, region) => (s
  ? { configured: true, origin: s.origin, region: s.cfg.region, host: resolveHost(s.cfg.region), branch: s.cfg.branch || 'main', apiKey: mask(s.cfg.apiKey) }
  : { configured: false, region, host: resolveHost(region), branch: 'main', apiKey: '' });

// --- credentials ---------------------------------------------------------------

async function credentialsApi(req, res, ctx, route, url) {
  const { session } = ctx;
  if (route === 'POST /api/credentials') {
    const now = Date.now();
    session.data.attempts = (session.data.attempts || []).filter((t) => now - t < 60_000);
    if (session.data.attempts.length >= 10) throw new HttpError(429, 'Too many attempts – wait a minute.');
    session.data.attempts.push(now);

    const { side, region, apiKey, token, branch } = await readBody(req);
    if (!['source', 'target'].includes(side)) throw new HttpError(400, 'Unknown stack side.');
    if (!REGIONS.includes(region)) throw new HttpError(400, 'Unknown region.');
    if (typeof apiKey !== 'string' || !/^blt[a-z0-9]{8,40}$/i.test(apiKey.trim())) throw new HttpError(400, 'The API key should look like blt… (letters and digits).');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(token.trim())) throw new HttpError(400, 'The management token looks invalid.');
    const br = (branch || 'main').trim();
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(br)) throw new HttpError(400, 'Invalid branch name.');

    const cfg = {
      name: side, region, apiKey: apiKey.trim(), token: token.trim(), branch: br,
      gfApiVersion: env.GLOBAL_FIELDS_API_VERSION ?? '3.2',
    };
    const client = createClient(cfg);
    try {
      await client.listLocales(); // cheap call that proves the key, token and branch work together
    } catch (e) {
      throw new HttpError(400, e.status === 401 || e.status === 412 || e.status === 422
        ? 'Contentstack rejected these credentials (API key, management token or branch).'
        : `Could not reach Contentstack: ${e.message}`);
    }
    session.creds[side] = { cfg, client, origin: 'session' };
    resetCaches(ctx, side);
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'DELETE /api/credentials') {
    const side = url.searchParams.get('side');
    if (!['source', 'target'].includes(side)) throw new HttpError(400, 'Unknown stack side.');
    delete session.creds[side];
    resetCaches(ctx, side);
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'POST /api/logout') {
    sessions.destroy(session, res, { secure: isHttps(req) });
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Unknown endpoint');
}

function resetCaches(ctx, side) {
  ctx.data.schemaState = null;
  delete ctx.data.assetScans[side];
}

// --- assets ---------------------------------------------------------------------

async function assetsApi(req, res, ctx, route, url) {
  const { assetScans, assetJobs } = ctx.data;
  if (route === 'GET /api/assets') {
    const stack = url.searchParams.get('stack');
    pickStack(ctx, stack);
    return sendJson(res, 200, { scan: assetScans[stack] || null, job: assetJobs.get(stack) || null });
  }
  const { stack, uids } = await readBody(req);
  const client = pickStack(ctx, stack);
  if (assetJobs.has(stack)) throw new HttpError(409, 'A scan or deletion is already running for this stack.');

  if (route === 'POST /api/assets/scan') {
    const job = { kind: 'scan', progress: { step: 'Starting…' } };
    assetJobs.set(stack, job);
    try {
      const write = startStream(res);
      try {
        assetScans[stack] = await scanAssets(client, {
          onProgress: (p) => { job.progress = p; write({ progress: p }); },
        });
        write({ done: true, result: assetScans[stack] });
      } catch (e) {
        write({ done: true, error: e.message });
      }
      res.end();
    } finally {
      assetJobs.delete(stack);
    }
    return;
  }
  if (route === 'POST /api/assets/delete') {
    if (!Array.isArray(uids) || !uids.length || !uids.every((u) => typeof u === 'string' && CT_UID.test(u))) {
      throw new HttpError(400, 'Invalid delete request.');
    }
    const job = { kind: 'delete', progress: { step: `Deleting 0 / ${uids.length} assets…`, done: 0, total: uids.length } };
    assetJobs.set(stack, job);
    try {
      const write = startStream(res);
      let done = 0;
      const result = await deleteAssets(client, uids, {
        onProgress: (m) => {
          done++;
          job.progress = { step: `Deleting ${done} / ${uids.length} assets…`, done, total: uids.length };
          write(m);
        },
      });
      const scan = assetScans[stack];
      if (scan) {
        const gone = new Set(uids.filter((u) => !result.failed.some((f) => f.uid === u)));
        scan.assets = scan.assets.filter((a) => !gone.has(a.uid));
      }
      write({ done: true, deleted: result.deleted, failed: result.failed.length });
      res.end();
    } finally {
      assetJobs.delete(stack);
    }
    return;
  }
  throw new HttpError(404, 'Unknown endpoint');
}

// --- broken references -----------------------------------------------------------

async function brokenRefsApi(req, res, ctx, route, url) {
  const scans = (ctx.data.refScans ??= {});
  const jobs = (ctx.data.refJobs ??= new Map());
  if (route === 'GET /api/broken-refs') {
    const stack = url.searchParams.get('stack');
    pickStack(ctx, stack);
    return sendJson(res, 200, { scan: scans[stack] || null, job: jobs.get(stack) || null });
  }
  const { stack, targets } = await readBody(req);
  const client = pickStack(ctx, stack);
  if (jobs.has(stack)) throw new HttpError(409, 'A scan or fix is already running for this stack.');

  if (route === 'POST /api/broken-refs/scan') {
    const job = { kind: 'scan', progress: { step: 'Starting…' } };
    jobs.set(stack, job);
    try {
      const write = startStream(res);
      try {
        scans[stack] = await scanBrokenRefs(client, { onProgress: (p) => { job.progress = p; write({ progress: p }); } });
        write({ done: true, result: scans[stack] });
      } catch (e) {
        write({ done: true, error: e.message });
      }
      res.end();
    } finally {
      jobs.delete(stack);
    }
    return;
  }
  if (route === 'POST /api/broken-refs/fix') {
    const scan = scans[stack];
    if (!scan) throw new HttpError(409, 'Scan the stack first.');
    const valid = Array.isArray(targets) && targets.length && targets.every((t) => t && CT_UID.test(t.ct || '')
      && CT_UID.test(t.uid || '') && /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(t.locale || ''));
    if (!valid) throw new HttpError(400, 'Invalid fix request.');
    const job = { kind: 'fix', progress: { step: `Fixing 0 / ${targets.length} entries…`, done: 0, total: targets.length } };
    jobs.set(stack, job);
    try {
      const write = startStream(res);
      let done = 0;
      const result = await fixBrokenRefs(client, scan, targets, {
        onProgress: (m) => {
          done++;
          job.progress = { step: `Fixing ${done} / ${targets.length} entries…`, done, total: targets.length };
          write(m);
        },
      });
      // Fixed versions no longer have the removable broken references.
      const fixed = new Set(targets.filter((t) => !result.failed.some((f) => f.ct === t.ct && f.uid === t.uid && f.locale === t.locale))
        .map((t) => `${t.ct}/${t.uid}/${t.locale}`));
      scan.broken = scan.broken.filter((b) => !(b.fixable && fixed.has(`${b.ct}/${b.entry}/${b.locale}`)));
      write({ done: true, fixed: result.fixed, failed: result.failed.length });
      res.end();
    } finally {
      jobs.delete(stack);
    }
    return;
  }
  throw new HttpError(404, 'Unknown endpoint');
}

// --- entries --------------------------------------------------------------------

async function entriesApi(req, res, ctx, route, url) {
  if (route === 'GET /api/entries/content-types') {
    const cts = await pickStack(ctx, url.searchParams.get('stack')).listContentTypes();
    return sendJson(res, 200, cts.map((c) => ({ uid: c.uid, title: c.title })).sort((a, b) => a.title.localeCompare(b.title)));
  }
  if (route === 'GET /api/entries/locales') {
    return sendJson(res, 200, await listLocalesBrief(pickStack(ctx, url.searchParams.get('stack'))));
  }
  if (route === 'GET /api/entries') {
    const client = pickStack(ctx, url.searchParams.get('stack'));
    const ct = url.searchParams.get('ct') || '';
    if (!CT_UID.test(ct)) throw new HttpError(400, 'Invalid content type UID.');
    const query = url.searchParams.get('query') || undefined;
    if (query) {
      try { JSON.parse(query); } catch { throw new HttpError(400, 'Query must be valid JSON.'); }
    }
    const entries = await listEntriesBrief(client, ct, { query, locale: url.searchParams.get('locale') || undefined });
    return sendJson(res, 200, entries.map((e) => ({ uid: e.uid, title: e.title, locales: e.locales, updated_at: e.updated_at })));
  }
  if (route === 'POST /api/entries/backup') {
    const { stack, ct, uids, locale } = await readBody(req);
    const client = pickStack(ctx, stack);
    if (!CT_UID.test(ct || '') || !Array.isArray(uids) || !uids.length || !uids.every((u) => typeof u === 'string' && CT_UID.test(u))) {
      throw new HttpError(400, 'Invalid backup request.');
    }
    if (locale && !/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(locale)) throw new HttpError(400, 'Invalid locale.');
    const backup = await backupEntries(client, ct, uids, { locale: locale || undefined });
    const s = ctx.stacks[stack].cfg;
    backup.stack = { side: stack, apiKey: mask(s.apiKey), branch: s.branch || 'main', host: resolveHost(s.region) };
    const name = `entries-backup_${ct}_${locale || 'all-languages'}_${backup.createdAt.replace(/[:.]/g, '-')}.json`;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    return res.end(JSON.stringify(backup, null, 2));
  }
  if (route === 'POST /api/entries/restore') {
    const { stack, backup } = await readBody(req, 200_000_000);
    const client = pickStack(ctx, stack);
    try { validateBackup(backup); } catch (e) { throw new HttpError(400, e.message); }
    if (ctx.data.deletingEntries) throw new HttpError(409, 'A deletion or restore is already running.');
    ctx.data.deletingEntries = true;
    try {
      const write = startStream(res);
      const result = await restoreEntries(client, backup, { onProgress: write });
      write({ done: true, restored: result.restored, failed: result.failed.length });
      res.end();
    } finally {
      ctx.data.deletingEntries = false;
    }
    return;
  }
  if (route === 'POST /api/entries/delete') {
    const { stack, ct, uids, locale } = await readBody(req);
    const client = pickStack(ctx, stack);
    if (!CT_UID.test(ct || '') || !Array.isArray(uids) || !uids.length || !uids.every((u) => typeof u === 'string' && CT_UID.test(u))) {
      throw new HttpError(400, 'Invalid delete request.');
    }
    if (locale && !/^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(locale)) throw new HttpError(400, 'Invalid locale.');
    if (ctx.data.deletingEntries) throw new HttpError(409, 'A deletion is already running.');
    ctx.data.deletingEntries = true;
    try {
      const write = startStream(res);
      const result = await deleteEntries(client, ct, uids, { locale: locale || undefined, onProgress: write });
      write({ done: true, deleted: result.deleted, failed: result.failed.length });
      res.end();
    } finally {
      ctx.data.deletingEntries = false;
    }
    return;
  }
  throw new HttpError(404, 'Unknown endpoint');
}

// --- entry migration --------------------------------------------------------------

async function entryMigrationApi(req, res, ctx, route, url) {
  assertBothConnected(ctx);
  const src = ctx.stacks.source.client;
  const tgt = ctx.stacks.target.client;
  if (route === 'GET /api/entry-migration/content-types') {
    const [cts, tgtCts] = await Promise.all([src.listContentTypes(), tgt.listContentTypes()]);
    const inTarget = new Set(tgtCts.map((c) => c.uid));
    return sendJson(res, 200, cts.map((c) => ({ uid: c.uid, title: c.title, inTarget: inTarget.has(c.uid), fields: matchFields(c.schema) }))
      .sort((a, b) => a.title.localeCompare(b.title)));
  }
  if (route === 'GET /api/entry-migration/entries') {
    const ct = url.searchParams.get('ct') || '';
    const match = url.searchParams.get('match') || 'title';
    if (!CT_UID.test(ct) || !CT_UID.test(match)) throw new HttpError(400, 'Invalid content type or match field.');
    return sendJson(res, 200, await listForMigration(src, tgt, ct, match));
  }
  if (route === 'POST /api/entry-migration/plan') {
    const { ct, uids, matchField = 'title', existing = 'skip', includeRefs = true } = await readBody(req);
    if (!CT_UID.test(ct || '') || !CT_UID.test(matchField) || !['skip', 'update'].includes(existing)
      || !Array.isArray(uids) || !uids.length || !uids.every((u) => typeof u === 'string' && CT_UID.test(u))) {
      throw new HttpError(400, 'Invalid migration request.');
    }
    if (ctx.data.entryMigrating) throw new HttpError(409, 'An entry migration is already running.');
    const write = startStream(res);
    try {
      const plan = await planEntryMigration(src, tgt, {
        ct, uids, matchField, existing, includeRefs: !!includeRefs, onProgress: (p) => write({ progress: p }),
      });
      ctx.data.entryPlan = { id: randomUUID(), plan };
      write({ done: true, planId: ctx.data.entryPlan.id, summary: plan.summary });
    } catch (e) {
      write({ done: true, error: e.message });
    }
    return res.end();
  }
  if (route === 'POST /api/entry-migration/run') {
    const { planId } = await readBody(req);
    const stored = ctx.data.entryPlan;
    if (!stored || stored.id !== planId) throw new HttpError(409, 'The plan expired – preview it again.');
    if (ctx.data.entryMigrating) throw new HttpError(409, 'An entry migration is already running.');
    ctx.data.entryMigrating = true;
    ctx.data.entryPlan = null; // a plan runs once
    try {
      const write = startStream(res);
      const result = await runEntryMigration(tgt, stored.plan, { onProgress: write });
      write({ done: true, assets: result.assets, entries: result.entries, failed: result.failed.length });
      res.end();
    } finally {
      ctx.data.entryMigrating = false;
    }
    return;
  }
  throw new HttpError(404, 'Unknown endpoint');
}

// --- schemas --------------------------------------------------------------------

async function getSchemaState(ctx, refresh) {
  if (!ctx.data.schemaState || refresh) {
    ctx.data.schemaState = await loadState(ctx.stacks.source.client, ctx.stacks.target.client);
  }
  return ctx.data.schemaState;
}

async function schemasApi(req, res, ctx, route, url) {
  assertBothConnected(ctx);
  if (route === 'GET /api/state') {
    return sendJson(res, 200, publicState(await getSchemaState(ctx, url.searchParams.has('refresh'))));
  }
  if (route === 'GET /api/item') {
    const it = (await getSchemaState(ctx)).items.get(url.searchParams.get('key'));
    if (!it) throw new HttpError(404, 'Item not found');
    return sendJson(res, 200, { source: it.body || null, target: it.targetBody });
  }
  if (route === 'POST /api/plan') {
    const { keys = [] } = await readBody(req);
    return sendJson(res, 200, buildPlan(await getSchemaState(ctx), keys));
  }
  if (route === 'POST /api/migrate') {
    if (ctx.data.migrating) throw new HttpError(409, 'A migration is already running.');
    const { keys = [] } = await readBody(req);
    ctx.data.migrating = true;
    try {
      // Always use fresh state – never migrate based on a stale comparison.
      const fresh = await getSchemaState(ctx, true);
      const plan = buildPlan(fresh, keys);
      if (plan.problems.length) throw new HttpError(400, 'The plan has unmet dependencies – refresh the plan preview.');
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const log = (entry) => res.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
      log({ level: 'info', msg: `Starting migration: ${plan.steps.length} steps.` });
      await executePlan(fresh, plan, ctx.stacks.target.client, path.join(ROOT, 'backups'), log);
      res.end();
    } finally {
      ctx.data.migrating = false;
      ctx.data.schemaState = null;
    }
    return;
  }
  throw new HttpError(404, 'Unknown endpoint');
}

// --- routing --------------------------------------------------------------------

async function api(req, res, url) {
  // Cross-site request guard: state-changing calls must be same-origin JSON.
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.headers.origin;
    const expected = `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
    if (origin && origin !== expected) throw new HttpError(403, 'Cross-origin request blocked.');
    if (req.method !== 'DELETE' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new HttpError(415, 'Expected application/json.');
    }
  }

  // Public, session-less info.
  if (req.method === 'GET' && url.pathname === '/api/version') return sendJson(res, 200, { name: PKG.name, version: PKG.version });
  if (req.method === 'GET' && url.pathname === '/api/changelog') {
    return sendJson(res, 200, { version: PKG.version, releases: await readChangelog() });
  }

  const session = sessions.get(req, res, { secure: isHttps(req) });
  const ctx = contextFor(session);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/config') {
    return sendJson(res, 200, {
      source: describe(ctx.stacks.source, 'eu'),
      target: describe(ctx.stacks.target, 'eu'),
      regions: REGIONS,
      regionHosts: Object.fromEntries(REGIONS.map((r) => [r, resolveHost(r)])),
      session: { expiresAt: sessions.expiresAt(session), idleHours: Number(env.SESSION_IDLE_HOURS) || 8 },
    });
  }
  if (url.pathname.startsWith('/api/credentials') || route === 'POST /api/logout') return credentialsApi(req, res, ctx, route, url);
  if (url.pathname.startsWith('/api/entries')) return entriesApi(req, res, ctx, route, url);
  if (url.pathname.startsWith('/api/assets')) return assetsApi(req, res, ctx, route, url);
  if (url.pathname.startsWith('/api/broken-refs')) return brokenRefsApi(req, res, ctx, route, url);
  if (url.pathname.startsWith('/api/entry-migration')) return entryMigrationApi(req, res, ctx, route, url);
  return schemasApi(req, res, ctx, route, url);
}

// Clean URLs: "/" is the home page, "/migrations" serves migrations.html, and so on.
async function serveStatic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : path.extname(pathname) ? pathname : `${pathname.replace(/\/$/, '')}.html`;
  const file = path.normalize(path.join(PUBLIC, name));
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'Forbidden');
  let data;
  try { data = await readFile(file); } catch { throw new HttpError(404, 'Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
      throw new HttpError(421, `Host not allowed. Add it to ALLOWED_HOSTS in .env if this is intended.`);
    }
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (e) {
    if (res.headersSent) res.end(`${JSON.stringify({ level: 'error', msg: e.message, done: true })}\n`);
    else sendJson(res, e instanceof HttpError ? e.status : 500, { error: e.message });
  }
});

server.listen(port, bindHost, () => {
  console.log(`Stack Toolkit v${PKG.version}: http://localhost:${port}`);
  for (const side of ['source', 'target']) {
    const s = envStacks[side];
    console.log(`  ${side}: ${s ? `${resolveHost(s.cfg.region)}  ${mask(s.cfg.apiKey)}  branch=${s.cfg.branch || 'main'} (from .env – shared by everyone)` : 'not in .env – each user connects it in the panel'}`);
  }
  if (!loopback) {
    console.log(`  Listening on ${bindHost}: put it behind HTTPS (TRUST_PROXY=1 or COOKIE_SECURE=1) and set ALLOWED_HOSTS.`);
    if (envStacks.source || envStacks.target) console.log('  WARNING: .env credentials are usable by anyone who can reach this server.');
  }
});
