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
- One extension per app: `.tnote` here. A saved JSON starts with `{"app": "Thistle Notebook", "format": 1,
  "appVersion", "kind": "notebook"}` (`fileHeader()` in `js/version.js`). Bump `FILE_FORMAT` when the structure changes,
  and keep opening older files.
- Other Thistle files opened as a notebook get a plain message (`identifyFile` in `js/store.js`); `.tplot` and `.tflow`
  can be added as sources instead.
- Favicon written as `<link rel="icon" href="data:image/svg+xml,...">` with every character escaped, no `type`
  attribute (Safari/iPad). iPad: drop `accept` on file inputs (`IS_IOS`).

## Architecture map
- `js/elm.js` ELM client (`classify` model metadata, streaming SSE chat, embeddings, Responses web search,
  transcription, `/costs`; drops unsupported optional params and retries).
- `js/ingest.js` parsers (pdf.js, mammoth, own zip-based pptx/xlsx readers, PapaParse, vision for images/scans, audio)
  and `profileTable` (data summary given to the model). `js/zip.js` unzip/zip (DecompressionStream).
- `js/retrieval.js` chunking, BM25 + embedding RRF, `buildContext` (full text if within budget, else retrieval; rubric
  and question pinned) producing numbered citations.
- `js/prompts.js` modes, tones, Studio templates, TP test catalogue, system prompt.
- `js/thistle.js` spec parsing, `buildG`, `.tplot` writer (TP format 2), `ThistlePlot` / `ThistleFlow` iframe bridges
  (TP globals: `applyG`, `#asel`, `runAnalysis`, `statTabs`/`plotTabs` via `w.eval`, `_saveBlob` capture; TF: Statistics
  tab `#statsTable`). If TP/TF rename these, update the bridge and the tests.
- `js/md.js` Markdown rendering with citation chips and analysis-card slots; Markdown → .docx.
- `js/app.js` controller and UI.

## Release checklist
1. Bump the version in `js/version.js`, `<title>` and `#app-version` in `index.html`, `package.json`, README
   ("current vX.Y.Z", "Known limitations of vX.Y.Z").
2. `npm test` must pass (serve the parent folder with TP checked out beside this repo). New feature means new test.
3. Commit as `vX.Y.Z: <summary>`.
