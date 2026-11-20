# Thistle Notebook — beta

Part of the Thistle suite, together with [Thistle Plot](https://github.com/actinomycetes/thistle-plot) (TP) and
[Thistle Flow](https://github.com/actinomycetes/thistle-flow) (TF).

**Status:** beta (0.x; current v0.5.0). AI output can be wrong: check what matters, and treat suggested marks as suggestions.

A research notebook that answers from your own sources, similar in spirit to NotebookLM. It runs in your browser and uses
the University of Edinburgh's **ELM API** for its models. Add papers, rubrics and answers, datasets, drafts, images or
audio. Then ask questions with numbered citations, generate reports, and run statistics in **Thistle Plot** on your
original data.

## Where your data goes

| What | Where it goes |
|---|---|
| Your files | Read **in this browser** (PDF, Word, PowerPoint and Excel are parsed locally). Never uploaded as files. |
| Notebooks (sources' text, chat, notes) | This browser's IndexedDB. **💾 Save** writes a `.tnote` file you control. |
| Text needed for a question | **ELM only** (`https://elm.edina.ac.uk/api/v1`). 🏛 models run in University data centres; ☁ models are OpenAI under ELM's zero-data-retention terms. |
| Images, scanned PDF pages | ELM vision model (on-campus Qwen 3.5 / Mistral Small 4 by default). |
| Audio | ELM transcription (`whisper-1`, an OpenAI model, so it is blocked in on-campus-only notebooks). |
| Web search (optional) | Only your question, through ELM to an OpenAI model's web-search tool, **if ELM allows it for your key** (see below). Off in on-campus-only notebooks. |
| Statistics | Thistle Plot, running in the same browser tab. |
| 🔎 Suggested searches | Written by ELM, shown as links. A search site (PubMed, Europe PMC, Google Scholar, bioRxiv) receives **only the search words, only when you click** a link. The app never contacts these sites. |

The page's Content-Security-Policy (`connect-src 'self' https://elm.edina.ac.uk`) makes the **browser itself** refuse any
other connection, so a bug or a malicious file cannot send data anywhere else. Libraries are loaded from cdnjs with
Subresource Integrity hashes. Your API key stays in this browser: by default it is forgotten when the tab closes, or
kept on the device if you tick "Remember".

**On-campus-only notebooks** (tick it when creating the notebook, or use ✎ Notebook) can use only University-hosted
models, and web search is disabled. Use this for exam scripts, dissertations, unpublished or personal data.

## ELM policies
Using Thistle Notebook means using ELM, so the University's ELM policies and your School's rules on AI apply.
The app's **❓ Help** links to all of these:
- [Our AI principles](https://information-services.ed.ac.uk/computing/comms-and-collab/elm/our-ai-principles)
- [Responsible AI and safety](https://information-services.ed.ac.uk/computing/comms-and-collab/elm/responsible-ai-and-safety)
- [Use of Operational Data Policy (PDF)](https://edwebcontent.ed.ac.uk/sites/default/files/atoms/files/operational-data-policy.pdf)
- [Generative AI and data protection](https://data-protection.ed.ac.uk/guidance/generative-artificial-intelligence)
- Guidance for [staff](https://information-services.ed.ac.uk/computing/comms-and-collab/elm/generative-ai-guidance-for-staff), [students](https://information-services.ed.ac.uk/computing/comms-and-collab/elm/guidance-for-working-with-generative-ai) and [postgraduate researchers](https://information-services.ed.ac.uk/computing/comms-and-collab/elm/generative-ai-guidelines-for-students/generative-ai)
- [ELM FAQs](https://information-services.ed.ac.uk/computing/comms-and-collab/elm/elm-frequently-asked-questions-faqs)
- [API keys](https://elm.edina.ac.uk/documentation/docs/13-keys/)

## Getting started
1. Request an ELM API key: ELM → API keys → New Key Request.
2. Open Thistle Notebook → **⚙ Settings** → paste the key → **Test connection**.
3. **＋ Add sources**, set each source's **role** (Paper, Dataset, Rubric, Question, Answer/submission, My draft…), and
   tick the sources to use.
4. Pick a **Mode** and **Audience**, then ask, or use a **Studio** report.

## Working in a notebook
- **Source tabs.** Keep several sets of sources in one notebook, for example "Papers", "Marking: group A" and
  "Marking: group B". Click a tab to show its sources; **tick** a tab to use its sources in chat and Studio. Only ticked
  sources in ticked tabs are used. A source can belong to several tabs (📁 under the source), e.g. one rubric for every
  group. Double-click a tab to rename it; ＋ adds one.
- **One chat, traceable.** The chat continues across tab changes. Each answer shows the tabs it used (📁 …). Clicking that
  lists the exact sources, and **Use the same tabs now** restores that selection.
- **Delete and re-run.** 🗑 deletes an answer, or a question together with its answers. **↻ Re-run** asks a question
  again with the tabs and model selected now; **↻ Regenerate** gives a new answer and keeps the old one for comparison.
- **Reuse earlier questions.** **✎ Copy to box**, the **🕘 Earlier questions** menu, or **↑ / ↓** in the empty box put
  an earlier question in the box to adjust. Nothing is sent until you press Send.
- **Moved files: 📂 Find files.** The notebook keeps the text of every source, so chat works without the original files.
  To open an original, re-read a file you edited, or analyse a table too large to keep, choose the folder or the
  files again (as in Thistle Flow). Matching names are linked for the session, and a file whose content changed is
  flagged with **↻ Re-read**. Moved or copied files are recognised by a fingerprint of their content, not by date.
- **Resizable panes.** Drag the lines between the three panes; double-click a line to reset it. Widths are remembered.
- **✕ Close** removes a notebook from this browser. It first asks whether to save it as a `.tnote` file if there are
  unsaved changes. Saved files open again with 📂 Open; your original files on disk are never touched.

## What it does
- **Research papers**: briefing documents, literature comparison tables, gaps and contradictions, **hypothesis
  generation** (testable, with proposed experiments), study guides. Optional web search adds cited `[W1]` findings (if available, see below).
- **Marking**: rubric + question + answers. Studio marks **each submission separately** against the rubric, with a
  per-criterion table, quoted evidence, flags for the marker, and a summary table of suggested marks. It can also check
  marking consistency, draft a model answer and marking guide, and draft student feedback. Every decision is yours.
- **Data analysis**: describes the design, finds problems (outliers, pseudo-replication, confounding, multiple
  comparisons), proposes analyses and next experiments. The AI **never calculates p-values**: see below.
- **Scientific writing**: abstracts, lay summaries, introductions, discussions, or a rewrite of your draft for
  **lay public / scientists in general / field experts**.
- Answers cite numbered passages; click a number to see it in the source.
- **Export** any report, note or answer (⤓ Export): **Word** (wide tables on landscape pages), **Excel** (every table as
  a sheet, numbers as numbers, plus a "Sources cited" sheet), **CSV** per table, Markdown, a standalone **HTML** page, or
  **Print / PDF**. Every table also has its own ⤓ Excel, ⤓ CSV and 📋 Copy table buttons (pastes as a table into
  Excel or Word). Files are generated in the browser.
- When the selected sources fit, their full text is sent; otherwise the most relevant passages are found by keyword +
  embedding search (embeddings from ELM, on-campus model preferred).
- **Model switching**: any chat model ELM offers your institution, with optional reasoning effort and OpenAI flex tier.
  ELM spend is shown in the header.

## Web search and ELM
**Status (Nov 2026): ELM refused web search for our API key on every route.** ELM's API description lists OpenAI's
web-search features, but ELM's own help does not mention web search. Everything else (sources, Studio, Thistle Plot,
exports) works without it.

- **⚙ Settings → 🌐 Test web search** tries each route with your key: the Responses API `web_search_preview` and
  `web_search` tools, and chat completions with `*-search-preview` models. It shows the outcome of each.
- **ELM's error replies have no CORS header**, so browsers cannot read them and report them as network failures. The app
  shows these as "ELM refused this request". The test offers a Terminal command that shows ELM's actual reason. It reads
  the key without displaying it, and the key stays on your computer.
- **A search only counts if ELM's reply proves a web search happened.** If no route works, the 🌐 option is switched
  off with the reason.
- **If a question asks for a web search but none ran,** the answer says why. The model is told so too, and suggests
  specific searches (database + query) you can run yourself.
- **Web search never runs in on-campus-only notebooks.**

### 🔎 Suggest searches (instead of web search)
Click **🔎 Suggest searches**, or the button in an answer's "No web search" note. ELM writes 3–6 targeted searches for
the question and the current answer: PubMed (with MeSH terms and field tags), Europe PMC, Google Scholar and bioRxiv.
Each search has an **Open** link, a **Since <year>** link (last 3 years) and a copy button. Download the papers you want,
add them with ＋ Add sources, and ask again, so that updates come from papers you have read.

Only the question and an excerpt of the answer go to ELM, not your sources. The model is told never to put personal or
confidential details in a query, and on-campus-only notebooks remind you to check the words before opening a link.

## Thistle suite integration
- **Statistics run in Thistle Plot.** When a test is needed, the assistant writes a small analysis request: the test
  plus which columns hold groups, values and subjects. Thistle Notebook builds TP's table **deterministically from your
  original file**; the AI never copies numbers. TP then runs the test inside the notebook (🔬 Thistle apps), and the
  results go back to the assistant for interpretation (Auto-run, at most 2 rounds by default). Each analysis card offers
  **⤓ .tplot** (open it in Thistle Plot) and **👁 Open in Thistle Plot**. Supported: descriptive, normality, t-tests,
  one-/two-way ANOVA, Mann–Whitney, Wilcoxon, Kruskal–Wallis, KS, correlation, regression, dose–response, Fisher,
  chi-square, Kaplan–Meier, p-value adjustment, volcano, PCA, heatmap and Rank Product.
- **Checks on each analysis (v0.5.0):** a dataset named in the request must be loaded (it is never swapped for another
  file); a paired test needs a subject column, and repeated measurements of one subject are averaged so each subject
  counts once; a two-way design sets both factor sizes; Dunnett with a control runs "vs control"; an option TP does not
  offer for the design, or a TP error, fails the analysis instead of being shown as a result.
- **Thistle Flow**: in 🔬 Thistle apps → Thistle Flow, load FCS files and gate as usual, then **⬇ Add TF statistics as
  source**. The population statistics become a dataset the assistant can analyse and send on to Thistle Plot. `.tflow`
  files can also be added as sources (gating hierarchy and samples).
- `.tplot` files can be added as sources (their data table and results).
- Files follow the suite conventions: `.tnote`, with `{"app": "Thistle Notebook", "format": 2, "appVersion", "kind"}`
  first. A Thistle Plot or Flow file opened by mistake gets a plain message.

Running TP/TF inside the notebook needs them on the **same site**, e.g. all three on `actinomycetes.github.io`. This
is the default when hosted there; the addresses can be changed in ⚙ Settings. Otherwise use the downloaded `.tplot` files.

## Running it
GitHub Pages serves `index.html`, `js/` and `css/` as they are, with no build step. Locally, the app uses ES modules,
so serve the folder that contains `thistle-notebook/`, `thistle-plot/` and `thistle-flow/` side by side:
```bash
cd ..   # the folder containing the three repositories
python3 -m http.server 8765
```
Then open http://localhost:8765/thistle-notebook/ (ELM accepts browser requests from any origin, including localhost).

## Tests
```bash
npm install && npx playwright install chromium   # once; thistle-plot/ must be checked out beside this repo
npm test                                          # no web server needed (tests/serve.cjs serves the files)
```
`tests/app.e2e.cjs` mocks ELM at its real address, so the security policy still applies. It drives every source type,
chat with citations and web search, a Thistle Plot ANOVA (values checked against the CSV), marking, Word/Excel/CSV/HTML
exports (file structure checked),
`.tnote` round trip, the on-campus restrictions, and the rule that no other host can be contacted.
`tests/workspace.e2e.cjs` covers source tabs, deleting, re-running and recalling questions, finding moved files,
resizable panes and closing notebooks. `tests/layouts.e2e.cjs` runs each table layout through the real Thistle Plot; results agree with SciPy (paired t,
Fisher, Pearson, ANOVA).

## Known limitations of v0.5.0
- Not yet tried against the live ELM API with a real key (built from ELM's OpenAPI spec and help page). Things to
  check first: embeddings with the on-campus model and reasoning output from Qwen. Web search is refused by ELM (see above).
- ELM's error replies cannot be read by browsers. When ELM refuses a chat request, the app retries once without optional
  settings (thinking level, flex, length limit); otherwise it shows "ELM refused this request".
- Notebooks live in one browser profile; clearing site data deletes them, so save `.tnote` files for anything important.
- Browsers cannot remember where files are on disk: links made with 📂 Find files last until the page is closed.
- One request may not exceed ELM's 10 MiB limit; very large source sets are searched rather than sent whole.
- Scanned PDFs: the first 60 scanned pages are read. Excel dates appear as serial numbers. No web-page import (by design).
- The Thistle Flow import reads TF's Statistics table, so set up the statistics columns you need in TF first. Values are read at full precision (TF v0.21+); a blank cell (gate not measurable in that sample) stays missing, never 0.
