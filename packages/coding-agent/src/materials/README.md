# Material storage

Materials hold saved sources. Information Debt holds the user's reasons and actions.
Resolving or archiving debt does not change its materials.

The design follows Karakeep's separation of common bookmark metadata, typed
content, and attachment metadata. This implementation uses the project's MySQL
connection and local files. It does not require a Karakeep instance or API.

Design references:

- [Karakeep schema](https://github.com/karakeep-app/karakeep/blob/bcc4b90a2ae89f4b96ec23ce395ee9d3d1df6a72/packages/db/schema.ts)
- [Karakeep filesystem store](https://github.com/karakeep-app/karakeep/blob/bcc4b90a2ae89f4b96ec23ce395ee9d3d1df6a72/packages/plugins/assetstore-filesystem/src/index.ts)

## Persistence

| Table | Contents |
| --- | --- |
| `materials` | Common identity, kind, title, source type, timestamps, current snapshot ID |
| `material_links` | Original HTTP or HTTPS URL |
| `material_texts` | Original plain text |
| `material_assets` | File hash, size, MIME type, label, role, position, original URL |
| `material_snapshots` | Immutable body text, format, hash, extractor version, ingestion time |
| `material_debts` | Relations between debt and materials |
| `material_meta` | Independent material schema version |

The first database operation creates the tables. Migrations hold a MySQL advisory
lock on one connection. The version advances only after all statements succeed.
MySQL DDL commits implicitly, so interrupted migrations repeat idempotent statements.
A newer schema version stops initialization.

New debt captures save their source and relation in the debt transaction.
HTTP browser capture uses this path without changing its request format.
Debt without a URL or captured text does not create an empty material.
Non-web references remain in debt; captured text can still become a text material.

Existing debt rows are not rewritten. Call `import_debt_material` with a full debt
ID to import an existing source. Repeat imports reuse its material and snapshots.
Changes to debt metadata do not rewrite saved evidence. Import again to capture
changed source fields. The old source relations remain available.

## Identity and snapshots

Link identity uses the URL parsed by `URL`. It preserves query parameters and
fragments, including signed social-media links. Different signed URLs can create
separate materials. Platform-specific identity rules are not implemented yet.

Text identity uses its exact UTF-8 content. File identity uses its hash and MIME type.
Duplicate imports retain the first material title and source type.

A snapshot is unique within a material by its content hash, format, and extractor.
Different content creates another snapshot. Existing content is never overwritten.
Saving a snapshot makes it current. Repeating the current snapshot does not change
the material timestamp. Historical snapshots remain readable by ID.

Use `material ID + snapshot ID + text offsets` for evidence references.
Tool offsets use JavaScript UTF-16 code units. A snapshot records when this system
saved the content. It does not claim when the author published or modified it.
AI summaries must not be saved as original-source evidence.

## Files

`PI_MATERIAL_ASSET_DIR` overrides the default `<agent-dir>/materials/assets` directory.
`<agent-dir>` is usually `~/.pi/agent`, or the configured `PI_CODING_AGENT_DIR`.
The file path is `<asset-dir>/<first-two-hash-characters>/<sha256>`.
Original file names are labels and never determine storage paths.

Files are immutable and shared by hash. Imports publish a complete temporary file
without replacing an existing blob. Reads check its hash. Source files remain intact.
Imports accept non-empty regular files of at most 20 MiB.
The supplied MIME type describes the file. This version does not inspect file signatures.

Attachment roles distinguish originals, images, screenshots, and archives.
The position preserves order within a role. A different file cannot overwrite an
occupied position. Use a new position or material for another attachment.

File storage and MySQL cannot commit together. A database failure can leave an
unreferenced blob. The importer retains it because another material can use it.
Automatic garbage collection is not implemented. Back up both MySQL and the asset
directory, with writes paused for a consistent backup.

## Tools

| Tool | Action |
| --- | --- |
| `save_material` | Save a link or text without creating debt |
| `list_materials` | List metadata, or find sources for a debt ID |
| `get_material` | Read metadata, attachment paths, and a bounded snapshot excerpt |
| `save_material_snapshot` | Save supplied source text with an extractor version |
| `save_material_file` | Import a local file or attach it to a material |
| `import_debt_material` | Import a source from an existing debt |

Example in Pi:

1. Save a link with `save_material`, using kind `link`, its title, and URL.
2. Save acquired article text with `save_material_snapshot`, using the returned
   material ID, format `text/plain`, and extractor `manual-v1`.
3. Import an image with `save_material_file`, the same material ID, role `image`,
   and position `0`. Use the file's MIME type, such as `image/png`.
4. Read the material with `get_material`. Its result includes the snapshot ID,
   excerpt offsets, and local attachment paths for Pi's existing file tools.
5. Save changed article text as another snapshot. Read the previous snapshot by ID
   to check that its evidence remains unchanged.

Material creation does not fetch pages, run OCR, call models, or execute Dreaming.
These processors can use this storage through `MaterialRepository` and
`MaterialService`. They do not need an interactive Pi session.
