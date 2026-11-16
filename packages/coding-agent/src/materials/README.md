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
| `material_collections` | Collection attempts, status, source references, image manifests, and missing-content flags |
| `material_image_texts` | Immutable machine transcriptions linked to the original image asset and extractor version |

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
| `collect_material` | Collect one saved X or Xiaohongshu link, or save and collect a supplied URL |
| `search_materials` | Search titles, body snapshots, and image transcriptions with bounded evidence excerpts |
| `extract_material_image_text` | Transcribe one saved image locally with macOS Vision; reuse existing output |

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

`save_material` does not fetch pages. Use `collect_material` for supported social
sources. Image transcription is a separate tool. This version does not call models or execute Dreaming.
Processors use `MaterialRepository` and `MaterialService` without an interactive session.

## Keyword retrieval and image text

`search_materials` searches titles, original body snapshots, and derived image text.
Use short keywords, for example `{ "query": "Agent Memory", "limit": 5 }`.
All whitespace-separated terms must match the title or body of the same evidence
record. Matching is case-insensitive and accent-sensitive. Punctuation, `%`, `_`,
and backslashes are literal characters, not wildcards. Chinese terms work without
an external tokenizer. This is substring search, not semantic or vector search.

Filters accept `sourceType`, `project`, and `materialId`. Project filtering follows
the material's debt relations. It also finds resolved or archived debt; those
states do not hide evidence. Unlinked reply materials do not inherit a project's
debt relation. Searches return at most 20 records. The default is 10 records with
400 UTF-16 code units per excerpt; the maximum excerpt length is 1000.

Each result identifies its kind: `snapshot`, `image_text`, or `metadata`.
Snapshot results carry `materialId`, `snapshotId`, the original URL when available,
and excerpt offsets into the immutable body. Image-text results carry
`materialId`, `imageTextId`, and `assetId` instead. Metadata-only results identify
saved sources without body evidence; they must not support factual answers.
Read a selected result with `get_material`, passing either its `snapshotId` or
its `imageTextId`. Both read modes accept `offset` and `length`.

By default, retrieval uses the current body snapshot and the latest transcription
of each image asset. `includeHistory: true` also searches older evidence. Historical
image attachments remain searchable until an explicit retention policy is added;
use the collection image manifest to identify images from a particular capture.
Results sort by evidence ingestion time, then IDs. There is no relevance model yet.

New snapshots and image text become searchable in the same database commit.
Existing snapshots need no re-import or model processing. This first implementation
scans matching text in MySQL and has no separate search index. It suits a personal
development collection; evaluate query latency before adding a larger index.
Search and image transcription spend no model tokens. Only the selected excerpts
and source reads enter the agent's context.

`extract_material_image_text` accepts one `materialId` and one `assetId` from
`get_material` or the collection image manifest. It requires macOS and Xcode
Command Line Tools (`xcode-select --install` if missing). Vision recognizes Chinese
and English locally. It does not send images to DeepSeek or interpret diagrams.
Recognition can contain errors; inspect the image before relying on exact wording.
GIF processing reads a still frame; it does not transcribe an entire animation.

The service checks the immutable asset hash, recognizes a private copy, and removes
temporary files. It stores the result in `material_image_texts`, never in an original
snapshot. Empty results are also cached to avoid repeating work on a text-free image.
The same asset and extractor version reuse the stored result. Changed image bytes
produce another asset; a changed extractor version produces another derived record.
Schema version 3 adds the table without rewriting body snapshots. The agent can
choose which images to process; collecting a post does not automatically transcribe
all its images. Old collection flags describe what was missing at capture time.

## X and Xiaohongshu collection

Install and configure [Agent-Reach](https://github.com/Panniantong/Agent-Reach/blob/main/docs/install.md)
before collecting. Enable its `twitter` and `xiaohongshu` channels. Complete any
required login in its dedicated browser. The collector does not install tools,
read credentials, open login flows, or copy cookies into MySQL.

`PI_AGENT_REACH_BIN` selects the Agent-Reach executable. The default is
`agent-reach` on PATH. The adapter requires its version-1 JSON result envelope.
X uses `twitter thread <url>`. Xiaohongshu uses `xiaohongshu read <url>`.
Use a direct X status URL or a Xiaohongshu note URL. Keep signed URL parameters.
XHS short links on `xhslink.com` are also accepted.

Call the tool with exactly one source selector:

```json
{ "materialId": "full-material-id" }
```

Or save and collect a source in one call:

```json
{ "url": "https://x.com/alice/status/123", "title": "Memory design discussion" }
```

This first version runs collection within the tool call. It does not provide a
scheduled worker. Browser capture still saves a link without starting collection.
After capturing social debt, use `list_materials` with its full debt ID, then
collect the returned material. Debt status remains unchanged.

X results must contain the requested tweet. Replies use separate materials and
snapshots, with their author, returned publication date, and source URL recorded
in the attempt. The adapter preserves returned text without summarizing it.
X thread completeness is unknown. X media is not imported in this version.
The result reports these limits instead of claiming a complete thread.

Xiaohongshu image collection requires OpenCLI. `PI_OPENCLI_BIN` selects its executable.
The adapter also checks Agent-Reach's private npm bin directory, then PATH.
It reads `agent-reach browser status` and binds OpenCLI to that exact connected
profile. It never selects a different browser as a fallback.

The adapter uses OpenCLI's `xiaohongshu download <url> --output <temporary-dir> -f json`.
It supports the returned `index/type/status` rows and current note-ID file names.
It checks image signatures because downloads can use `.jpg` for other image formats.
Images retain the order returned by OpenCLI. The upstream downloader can infer order
from page elements when structured data is missing, so original order is not guaranteed.
Videos can be downloaded temporarily by OpenCLI but are not imported. Staging files
are removed after the command and imports finish.

The attempt's `images` manifest maps returned image positions to immutable asset IDs.
Repeated captures reuse matching images. Changed images append to material attachments.
Use the attempt manifest to identify images from that capture. The flat attachment
list also includes historical images. Images are saved without OCR or interpretation.

Each attempt records `running`, then a terminal status:

| Status | Meaning |
| --- | --- |
| `success` | The requested collection completed without a reported gap |
| `partial` | Evidence was saved, but another step failed or content remains unprocessed |
| `needs_login` | No evidence was saved and the platform requires login |
| `needs_setup` | No evidence was saved and a required tool or browser connection is missing |
| `blocked` | No evidence was saved and platform verification is required |
| `rate_limited` | No evidence was saved and the platform limited requests |
| `failed` | No evidence was saved for another reason |
| `cancelled` | The request was cancelled before evidence was saved |

`issues` describes gaps such as `THREAD_COMPLETENESS_UNKNOWN`, `MEDIA_NOT_IMPORTED`,
`IMAGES_NOT_ANALYZED`, `TEXT_NOT_RETURNED`, or `IMAGE_DOWNLOAD_FAILED`.
An image-only post can produce partial success without a text snapshot.
An authentication failure after a saved body also produces partial success.
The result retains `NEED_LOGIN` to identify the required action.
Raw command stderr and upstream error messages are not persisted or returned.

Commands use argument arrays without a shell. Each command has a 120-second limit
and a 4 MiB output limit. The collector makes no automatic retries. Interrupted
processes can leave an attempt marked `running`; crash recovery is not implemented.
Schema version 2 adds the attempt table without rewriting existing sources.

Protocol references:

- [Agent-Reach result envelope](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/result.py)
- [Agent-Reach browser binding](https://github.com/Panniantong/Agent-Reach/blob/c70ae6da5d39bc90e09ad2ae0575ccc89f31e284/agent_reach/runtime/browser_binding.py)
- [OpenCLI media output](https://github.com/jackwener/opencli/blob/9bc5f5ca132ec4d4e48d7ee517d4303bf159e8e8/src/download/media-download.ts)
