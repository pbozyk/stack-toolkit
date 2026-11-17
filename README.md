# Stack Toolkit for Contentstack

A simple web panel for moving **content types** and **global fields** between two Contentstack stacks,
plus a tool for bulk-deleting entries. No dependencies – Node 18+ is all you need.

## Getting started

1. Fill in `.env` (template: `.env.example`) with the API key and **management token** of both stacks, and the region.
   The target stack's token needs write access.
2. Run `npm start` (or `npm run dev` to restart automatically on code changes), then open http://localhost:3000

The home page lists the tools: Schema Migration (`/migrations`), Entry Cleanup (`/entries`), Asset Cleanup (`/assets`)
and Stacks (`/stacks`). A tool whose required stack isn't connected shows a “stack is required” screen with a link to Stacks.

The server only listens on `127.0.0.1`, and tokens never reach the browser.

## Connecting stacks

Credentials can come from two places:

- **`.env`** – handy on your own machine. They are shared by everyone who can open the panel, so on a shared server keep them empty.
- **The Stacks page** (http://localhost:3000/stacks, key icon in the header) – each person enters their own API key and
  management token. They override `.env` for that browser session only.

Only the source stack is required. The target is needed just for Schema Migration – if it's missing, that page asks for it
right there. The cleanups run on the source stack; the Source/Target switch appears only when both stacks are connected.

How credentials entered in the panel are protected:

- kept only in the server's memory – never written to disk and never sent back to the browser (only a masked API key is shown),
- the browser holds just a random 256-bit session id in an `HttpOnly`, `SameSite=Strict` cookie; every session has its own
  credentials and caches, so users of a shared server can't see each other's stacks,
- verified against Contentstack before they are accepted; regions are limited to the known Contentstack hosts,
- forgotten after `SESSION_IDLE_HOURS` of inactivity (default 8), at the latest after `SESSION_MAX_HOURS` (default 24),
  on server restart, or right away with **Disconnect** / **Forget all credentials**,
- requests are checked for the `Host` header (DNS rebinding), same `Origin` and JSON body (cross-site requests), and pages
  are served with a strict Content Security Policy.

Running it for a team: set `HOST`, `ALLOWED_HOSTS` and put it behind HTTPS (`TRUST_PROXY=1` behind a reverse proxy, or
`COOKIE_SECURE=1`). Without HTTPS credentials would travel over the network in plain text.

The app needs one long-running Node process (sessions and running jobs live in memory), so serverless hosts such as
Vercel don't fit. On [Render](https://render.com): **New → Blueprint**, pick this repository and `render.yaml` sets
everything up – the `*.onrender.com` hostname is allowed automatically; leave `ALLOWED_HOSTS` empty or add a custom
domain. On the free plan the service sleeps after 15 minutes without traffic, which also forgets all sessions.

## Schema Migration

- The panel fetches content types, global fields and extensions from both stacks and shows, for each item:
  - **status**: new / changed / identical / target only,
  - **depends on**: global fields (also in modular blocks and nested ones), references and entries embedded in RTE,
  - **used by**: the reverse relation,
  - **details (▸)**: field diff, extensions, taxonomies and a JSON comparison.
- Dependency chip colors: purple = selected, green = in target, yellow = in target but differs,
  red = missing in target (blocks the migration until you select it).
- **Preview migration plan** shows the order of operations before anything is written:
  1. placeholders for new content types (`title`/`url` only), so references, including circular ones, have a target,
  2. global fields in topological order,
  3. full content type schemas.
- Before a definition is overwritten in the target stack, a copy is saved to `backups/<timestamp>/`.
- Extension UIDs (custom fields, JSON RTE plugins) are mapped by title and type, because they differ between stacks.

### Limitations (for now)

- Entries, assets, taxonomies, extensions and workflows are not migrated. The panel only warns when a schema needs them.
- Overwriting a content type removes fields from the target that don't exist in the source, together with their data.
  The diff in the details view shows this.

## Entry Migration

In the panel: **Entry Migration** (http://localhost:3000/entry-migration). Copies entries from the source to the target stack:

- pick a content type and entries; they are matched with the target by a field you choose (title, or better a unique
  field like an external id) and shown as **New** or **Exists**; existing ones are skipped or updated,
- **Include referenced entries** brings along everything the selected entries reference (recursively); when it's off,
  references are linked to matching target entries and dropped when there is no match,
- assets used by the entries are uploaded into the same folder path, or reused when the target already has a file with
  the same name and size; asset UIDs and URLs (also in RTE) are remapped,
- all locales are copied (locales missing in the target are skipped), and **Preview migration** shows the full plan –
  counts per content type, assets, warnings such as fields missing in the target – before anything is written.

The content types must exist in the target first (Schema Migration). Entries are written unpublished; nothing is deleted.

## Entry Cleanup

In the panel: the **Entry Cleanup** tab (http://localhost:3000/entries). Pick a stack and a content type,
then click "Delete all" or select specific entries. Deletion must be confirmed by typing the content type UID.

**Backup (optional):** the delete dialog has a “Download a backup first” option. When ticked, the panel first downloads a
JSON file with the full content of the selected entries (in all their languages, or just the chosen one) – deletion only starts
once the file has fully arrived, and nothing is deleted if the backup fails. Nothing is stored on the server.

**Restore backup** (button at the top of the page) uploads such a file: entries that no longer exist are created again
(Contentstack assigns new UIDs; references between restored entries are updated), entries that still exist only get their
missing languages back – no duplicates. Restored entries are unpublished, and references from entries outside the backup
still point to the old UIDs.
This tab only needs one configured stack.

With **All languages**, entries from every language are listed (also ones that don't exist in the master locale) and each
is deleted in all its localizations, the master version last. With a single language, only entries actually localized in
that language are listed and only that localization is deleted. Deletion runs 5 entries at a time and retries on API rate
limits (429).

## Asset Cleanup

In the panel: the **Asset Cleanup** tab (http://localhost:3000/assets). **Scan stack** finds assets that no entry uses:

1. every entry of every content type, in every locale, is scanned for asset UIDs (file fields, JSON RTE, asset URLs in HTML RTE),
2. assets the scan did not find are confirmed with Contentstack's references API (`GET /assets/{uid}/references`).

Results can be filtered by usage (unused / used) and type, with sizes. Only unused assets can be selected for deletion;
each one is checked with the references API again right before it is deleted. Deletion must be confirmed by typing `delete`.
The last scan is kept in server memory, and a page opened during a running scan picks up its progress.

Not covered: assets used outside entries (e.g. hardcoded URLs in your frontend, extensions, other branches).

## Broken References

In the panel: **Broken References** (http://localhost:3000/broken-refs). **Scan stack** reads every entry in every locale
and lists references that lead nowhere:

- reference fields and entries embedded in JSON RTE pointing at deleted entries or content types,
- file fields and assets embedded in JSON RTE pointing at deleted assets,
- asset URLs inside HTML RTE / text pointing at deleted assets (reported only – fix these by hand).

Results are grouped by entry version and can be filtered by problem and content type. **Remove broken references** reads
each selected version fresh and saves it without the broken references; everything else stays. Contentstack rejects the
save when a mandatory field would end up empty – those show up as errors. Fixed versions are saved as drafts, so publish
them again if needed.

## Changelog

Release notes live in [`CHANGELOG.md`](CHANGELOG.md) and are shown in the app at `/changelog` (the version badge in the
header). The current version comes from `package.json`; add a new `## <version> — <title>` section there when releasing.

## Credits

Icons: [Lucide](https://lucide.dev) (lucide-static v0.460.0, ISC License), inlined in `public/icons.js`.
License text: `public/vendor/LUCIDE-LICENSE.txt`.
