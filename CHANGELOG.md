# Changelog

Shown in the app at `/changelog`. Format: `## <version> — <title>`, an optional `Label: …` line, then bullet points.

## 1.1.7 — Lorem Ipsum
- New tool: fills a content type with generated test entries that follow its schema – every common field type, nested groups, global fields and modular blocks.
- References point at existing entries. The Assets option picks what goes into file fields: random existing assets, placeholder images uploaded into a “Lorem Ipsum” folder, or nothing.
- Optional localized versions in the chosen languages and a sample entry preview before anything is written.
- Generated entries are tagged, and Entry Cleanup opens straight on them for deletion.

## 1.1.6 — Public version
- Ready to run as a shared, public instance: no credentials need to be stored in `.env`.
- Every user connects their own source and target stacks on the Stacks page; credentials stay in server memory for their browser session only.
- Sessions expire after inactivity, on server restart or with “Forget all credentials”.
- Paste a `.env` file into any field on the Stacks page to fill both forms at once.
- Ready to deploy on Render (`render.yaml`).

## 1.1.5 — Broken References
- New tool: scans every entry in every locale for references to deleted entries, content types and assets.
- Covers reference fields, file fields, entries and assets embedded in JSON RTE, and asset URLs in HTML RTE.
- Results grouped by entry version, filterable by problem and content type.
- “Remove broken references” saves the selected entry versions without the broken references.

## 1.1.4 — Entry Migration
- New tool: copies entries with all their languages from the source to the target stack.
- Entries are matched with the target by a chosen field; existing ones are skipped or updated.
- Optionally brings along referenced entries, recursively.
- Assets are uploaded into the same folder path or reused; asset UIDs and URLs are remapped, also in RTE.
- Migration plan preview with counts and warnings before anything is written.

## 1.1.3 — Backup & restore in Entry Cleanup
- Optional “Download a backup first” when deleting entries – a JSON file with their full content in all languages.
- “Restore backup” brings entries back from such a file, fixing references between restored entries.
- Entries that still exist aren't duplicated – only missing languages are added back.

## 1.1.2 — Asset Cleanup
- New tool: finds assets no entry uses – every entry in every locale is scanned, then confirmed with the references API.
- Filters by usage and type, with sizes and thumbnails.
- Unused assets can be deleted; each one is re-checked right before deletion.
- Animated scan progress; a page opened during a running scan follows it.

## 1.1.1 — Entry Cleanup
- New tool: bulk-deletes entries of a content type – no 10-entry selection limit.
- Language dropdown with “All languages” – also finds entries that exist only in a non-master locale.
- Deletion confirmed by typing the content type UID, with live progress.

## 1.1.0 — Beta: Contentstack look
Label: Beta
- Interface restyled to match Contentstack: header navigation, stack › branch bar, Views panel, Inter font, purple accents.
- Lucide icons inlined, custom select arrows, tool tiles on the home page.
- Everything translated to English, including docs and code comments.

## 1.0.0 — Alpha: Schema Migration
Label: Alpha
- First version: compares content types and global fields between two stacks.
- Shows dependencies between schemas, diffs and a migration plan, then migrates in the right order.
- Backs up overwritten definitions before writing.
