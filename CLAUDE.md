# Thistle Notebook (TN): project guide for Claude Code

TN is a **beta** (0.x) source-grounded research notebook (NotebookLM-like) for UoE scientists, the third app of the
Thistle suite with [Thistle Plot](https://github.com/actinomycetes/thistle-plot) (TP) and
[Thistle Flow](https://github.com/actinomycetes/thistle-flow) (TF). Plain JavaScript ES modules, no framework, no build.
GitHub Pages serves `index.html` + `js/` + `css/`. LLM calls go to the University's ELM API (OpenAI-compatible,
`https://elm.edina.ac.uk/api/v1`, Bearer key, CORS open) straight from the browser.

## Ground rules
- **Privacy is the top requirement: no user data may go anywhere except ELM.** The CSP meta tag in `index.html`
  (`connect-src 'self' https://elm.edina.ac.uk`) enforces it; never widen `connect-src`, never add analytics, fonts,
  or fetches to third parties (no PubMed/arXiv/URL import from the browser). cdnjs scripts carry SRI hashes; update the
  hash when changing a version.
- The one exception is **🔎 Suggest searches** (`js/search.js`): ELM writes database queries and the app shows them as
  plain links (PubMed, Europe PMC, Google Scholar, bioRxiv) that the user opens in a new tab (`noreferrer`). Only
  search words leave, only on the user's click, and the prompt forbids personal or confidential terms. Never fetch
  these sites or add them to `connect-src`; never put source text or notebook data in a link.
- On-campus-only notebooks (`nb.onCampusOnly`) must never use a non-local model (`classify(id).local` = id contains "/")
  for chat, embeddings, vision or transcription, and must disable web search. `allowed()` in `js/app.js` gates this.
- The AI never computes statistics. Analyses are ```` ```thistle-plot ```` JSON specs (protocol in `js/prompts.js`
  `tpProtocol`) turned into TP's table by `buildG` in `js/thistle.js` from the parsed original file, then run by TP
  itself in a same-origin iframe. Keep `buildG` deterministic and covered by `tests/layouts.e2e.cjs` (check new layouts
  against SciPy).
- Suite look and conventions as in TP/TF: slate palette, dark default, thistle icon with an app badge (TN: an open book
  on the dark disc), BETA + version badges, plain words for bench scientists, British spelling, colours AA in both themes.
- `localStorage` only for preferences (theme, settings, last notebook) and, if the user ticks Remember, the API key.
  Notebook data lives in IndexedDB (`js/store.js`) and `.tnote` files.

## Thistle suite conventions (shared)
- One extension per app: `.tnote` here. A saved JSON starts with `{"app": "Thistle Notebook", "format": 2,
  "appVersion", "kind": "notebook"}` (`fileHeader()` in `js/version.js`). Bump `FILE_FORMAT` when the structure changes,
  and keep opening older files.
- Other Thistle files opened as a notebook get a plain message (`identifyFile` in `js/store.js`); `.tplot` and `.tflow`
  can be added as sources instead.
- Favicon written as `<link rel="icon" href="data:image/svg+xml,...">` with every character escaped, no `type`
  attribute (Safari/iPad), and `document.title` set again from script in `js/app.js` (Orion 1.1 showed the icon only then,
  as in Thistle Flow; v0.5.1). iPad: drop `accept` on file inputs (`IS_IOS`).

## Architecture map
- `js/elm.js` ELM client (`classify` model metadata, streaming SSE chat, embeddings, web search over several routes
  (`webSearchRoutes`; a route only counts if the reply proves a search happened; ELM refused all routes in Nov 2026).
  ELM error replies lack CORS headers: fetch() rejects, `req` reports status -1 ("refused") once ELM has answered
  this page before, and `_withFallback` retries once without optional parameters,
  transcription, `/costs`; drops unsupported optional params and retries).
- `js/ingest.js` parsers (pdf.js, mammoth, own zip-based pptx/xlsx readers, PapaParse, vision for images/scans, audio)
  and `profileTable` (data summary given to the model). `js/zip.js` unzip/zip (DecompressionStream).
- `js/retrieval.js` chunking, BM25 + embedding RRF, `buildContext` (full text if within budget, else retrieval; rubric
  and question pinned) producing numbered citations.
- `js/prompts.js` modes, tones, Studio templates, TP test catalogue, system prompt.
- `js/thistle.js` spec parsing, `buildG`, `.tplot` writer (TP format 2), `ThistlePlot` / `ThistleFlow` iframe bridges
  (TP globals: `applyG`, `#asel`, `runAnalysis`, `statTabs`/`plotTabs` via `w.eval`, `_saveBlob` capture; TF: Statistics
  tab `#statsTable`). If TP/TF rename these, update the bridge and the tests.
- `js/md.js` Markdown rendering with citation chips, analysis-card slots and per-table tools; Markdown → .docx
  (tables need `<w:tblGrid>`; >5 columns → landscape).
- `js/export.js` `extractTables` (Markdown tables in document order), .xlsx writer (inline strings, numbers as
  numbers, frozen header, Sources sheet), CSV with BOM, TSV/HTML clipboard, standalone HTML report.
- `js/app.js` controller and UI. Source tabs: `nb.tabs [{id,name,active}]`, `nb.viewTab`, `source.tabs [ids]`;
  `ensureTabs()` migrates format-1 notebooks; `enabledSources()` = enabled + ready + in a ticked tab; answers record
  `meta.tabIds/tabNames/sourceIds/sourceNames`. Originals: `source.file {name,size,lastModified,path,sha256}`, session
  links in `S.files` (browsers cannot keep paths), `findFilesDialog` matches by name, `changedOnDisk` compares SHA-256.
  Dirty state: `nb.updated > nb.savedAt` (`saveTnote` sets `savedAt`; imported files count as saved).
- Format history: 1 = v0.1–0.3; 2 = v0.4 (tabs, file fingerprints). Format-1 files open (tabs created on open).
- Statistical review fixes (v0.5.0, `tests/review.e2e.cjs`, SciPy/statsmodels references in comments): `findTable` matches a
  named dataset exactly or by name without extension, never by substring or by being the only one (`spec._dataset`,
  `spec._datasetNote` when none was named); long-layout paired tests (`PAIRED_TESTS`) require `subject`, and repeated
  subject × group values are averaged (one value per subject); the bridge sets both `opt-nA` and `opt-nB` for anova2,
  applies "Comparisons" before other options, sets "vs control" when Dunnett is requested with a control, throws when a
  known option's choice is missing or disabled, and throws when TP's newest tab is an error (no `scard`); TF statistics
  are read with `readStatsTable` from `data-v` (full precision, blank = null).
- Re-review fixes (v0.6.0, `tests/review.e2e.cjs` "re-review" block): `findTable` matches a name with an extension
  exactly and a bare name only when unique (ambiguous → error); the wide layout refuses a control that is not a chosen
  column; the counts layout validates each source count (whole number ≥ 0; blank, text, fractional, negative → error)
  and requires an explicit zero policy for sparse pre-counted tables; a long two-way ANOVA needs two factor columns, and the bridge refuses nA/nB
  options that differ from the data; `typed()` in `js/ingest.js` keeps leading-zero integers (001) as text; rows with
  no subject ID are noted; an option label TP does not have throws (was a warning with defaults).

## Release checklist
1. Bump the version in `js/version.js`, `<title>` and `#app-version` in `index.html`, `package.json`, README
   ("current vX.Y.Z", "Known limitations of vX.Y.Z").
2. `npm test` must pass (TP checked out beside this repo; `tests/serve.cjs` serves the files, no server needed). New feature means new test.
3. Commit as `vX.Y.Z: <summary>`.
