const HOSTS = {
  na: 'api.contentstack.io',
  us: 'api.contentstack.io',
  eu: 'eu-api.contentstack.com',
  au: 'au-api.contentstack.com',
  'azure-na': 'azure-na-api.contentstack.com',
  'azure-eu': 'azure-eu-api.contentstack.com',
  'gcp-na': 'gcp-na-api.contentstack.com',
  'gcp-eu': 'gcp-eu-api.contentstack.com',
};

// Regions selectable in the panel (only known hosts – a token is never sent to an arbitrary host).
export const REGIONS = Object.keys(HOSTS).filter((r) => r !== 'us');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resolveHost(region) {
  return HOSTS[String(region).toLowerCase()] || region;
}

// Content Management API (v3) client authorized with a management token.
export function createClient(cfg) {
  const base = `https://${resolveHost(cfg.region)}/v3`;
  const gfHeaders = cfg.gfApiVersion ? { api_version: cfg.gfApiVersion } : {};

  async function request(method, path, { body, query, headers } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) {
      for (const x of [].concat(v)) url.searchParams.append(k, String(x));
    }

    // FormData (asset uploads) sets its own multipart content type.
    const isForm = body instanceof FormData;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          api_key: cfg.apiKey,
          authorization: cfg.token,
          ...(isForm ? {} : { 'content-type': 'application/json' }),
          ...(cfg.branch ? { branch: cfg.branch } : {}),
          ...headers,
        },
        body: isForm ? body : body ? JSON.stringify(body) : undefined,
      });
      // CMA rate limit – retry with increasing delay.
      if (res.status === 429 && attempt < 5) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!res.ok) {
        const details = data.errors ? ` ${JSON.stringify(data.errors)}` : '';
        const err = new Error(`[${cfg.name}] ${method} ${path} → ${res.status}: ${data.error_message || text}${details}`);
        err.status = res.status;
        throw err;
      }
      return data;
    }
  }

  async function listAll(path, key, query = {}, headers) {
    const items = [];
    for (let skip = 0; ; ) {
      const data = await request('GET', path, { query: { ...query, include_count: true, limit: 100, skip }, headers });
      const page = data[key] || [];
      items.push(...page);
      skip += page.length;
      if (!page.length || skip >= (data.count ?? 0)) break;
    }
    return items;
  }

  return {
    cfg,
    listContentTypes: () => listAll('/content_types', 'content_types', { include_global_field_schema: false }),
    listGlobalFields: () => listAll('/global_fields', 'global_fields', {}, gfHeaders),
    listExtensions: () => listAll('/extensions', 'extensions'),
    createContentType: (body) => request('POST', '/content_types', { body: { content_type: body } }),
    updateContentType: (uid, body) => request('PUT', `/content_types/${uid}`, { body: { content_type: body } }),
    createGlobalField: (body) => request('POST', '/global_fields', { body: { global_field: body }, headers: gfHeaders }),
    updateGlobalField: (uid, body) => request('PUT', `/global_fields/${uid}`, { body: { global_field: body }, headers: gfHeaders }),
    listLocales: () => listAll('/locales', 'locales'),
    listAssets: (query = {}) => listAll('/assets', 'assets', query),
    assetReferences: (uid) => request('GET', `/assets/${uid}/references`).then((d) => d.references || []),
    deleteAsset: (uid) => request('DELETE', `/assets/${uid}`),
    createFolder: (name, parentUid) => request('POST', '/assets/folders', {
      body: { asset: { name, ...(parentUid ? { parent_uid: parentUid } : {}) } },
    }).then((d) => d.asset),
    uploadAsset: (blob, { filename, title, description, parentUid, tags }) => {
      const form = new FormData();
      form.append('asset[upload]', blob, filename);
      if (title) form.append('asset[title]', title);
      if (description) form.append('asset[description]', description);
      if (parentUid) form.append('asset[parent_uid]', parentUid);
      if (tags?.length) form.append('asset[tags]', tags.join(','));
      return request('POST', '/assets', { body: form }).then((d) => d.asset);
    },
    getStack: () => request('GET', '/stacks').then((d) => d.stack),
    listEntries: (ct, query = {}) => listAll(`/content_types/${ct}/entries`, 'entries', query),
    getEntry: (ct, uid, query = {}) => request('GET', `/content_types/${ct}/entries/${uid}`, { query }).then((d) => d.entry),
    createEntry: (ct, entry, query = {}) => request('POST', `/content_types/${ct}/entries`, { query, body: { entry } }).then((d) => d.entry),
    updateEntry: (ct, uid, entry, query = {}) => request('PUT', `/content_types/${ct}/entries/${uid}`, { query, body: { entry } }),
    deleteEntry: (ct, uid, query = {}) => request('DELETE', `/content_types/${ct}/entries/${uid}`, { query }),
  };
}
