# Wikibench paste test

These files are what Thistle Notebook's **📋 Copy for wiki…** produces for a copy of the Wikibench example assay
[2017-09-10 Assay Antibiotics resistance](https://www.wiki.ed.ac.uk/spaces/WIKB/pages/351070733/2017-09-10+Assay+Antibiotics+resistance).
`tests/labnote.e2e.cjs` builds the entry in the app and checks that the app still produces exactly these files.

| File | What it is |
|---|---|
| `assay.wiki.txt` | Confluence wiki markup: the main route. Gives page links, attachment images and links, and the attachments macro |
| `assay-formatted.html` | Formatted text for pasting straight into the page body (the alternative route) |
| `antibiotic_plate_labelled.png` | The attachment: an illustrative plate, with zone sizes as in the example |

## Test 1: wiki markup (recommended)
1. In your Wikibench lab book, open a **Study** page and click **Create assay**. Title: `2017-09-10 Assay Antibiotics resistance`.
2. In the editor, put the cursor in the main (left) column, then click **＋ (Insert more content) → Markup**.
3. Choose **Confluence wiki**, paste the whole of `assay.wiki.txt`, and click **Insert**.
4. Drag `antibiotic_plate_labelled.png` onto the page. It becomes an attachment, and the image and the
   attachments list should show it.
5. **Publish**, then check:
   - the protocol links (they point to pages titled *Kirby-Bauer Disk Diffusion Susceptibility Test Protocol*
     and *Agar recipe*, so they work only in a space that has those pages);
   - the table;
   - the image;
   - the attachments list at the bottom.

## Test 2: formatted text
Open `assay-formatted.html` in a browser, select from "An assay…" to the end, copy, and paste into the body of a
new assay page. Headings, the table, italics and links should survive. Attachments must be added and linked by hand
in this route; that is why the markup route is recommended.

Please report what did and did not survive. Confluence versions differ, and these routes have not yet been tried on
wiki.ed.ac.uk.
