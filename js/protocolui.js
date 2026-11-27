// Protocol library UI (v0.8): browse, create, import, edit (new version), history and restore, duplicate, public /
// private, delete and restore, library files, copy for the wiki, and inserting a protocol into a lab-note entry.
import {
  newProtocol, saveVersion, setVisibility, duplicate, snapshot, referenceMd, curV, isDeleted, visibleTo, canEdit, searchText,
  libraryFile, mergeLibrary,
} from './protocols.js';
import { mdToWiki, fmtTime } from './labnote.js';

export function createProtocols(ctx) {
  const { h, $, db, toast, modal, closeModal, saveText } = ctx;
  const P = { all: [], filter: 'visible', q: '' };
  const me = () => ctx.userId();
  async function load() { P.all = await db.all('protocols'); return P.all; }
  async function store(p) { await db.put('protocols', p); const i = P.all.findIndex(x => x.id === p.id); if (i >= 0) P.all[i] = p; else P.all.push(p); }
  const visible = () => P.all.filter(p => !isDeleted(p) && visibleTo(p, me()));
  const md = text => { const el = h('div', { class: 'md lab-md' }); el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(String(text || ''), { gfm: true, breaks: true })); el.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; }); return el; };
  const badge = p => h('span', { class: 'badge-hdr ' + (p.visibility === 'public' ? 'campus' : 'cloud'), title: p.visibility === 'public' ? 'Public: every user of this browser sees it; included in shared library files' : 'Private: only its owner sees it here' }, p.visibility === 'public' ? '👥 public' : '🔒 private');

  // ---------- library ----------
  async function openLibrary(view = null) {
    await load();
    const body = h('div', { class: 'proto-lib' });
    const draw = () => {
      const q = P.q.toLowerCase();
      let list = P.filter === 'deleted' ? P.all.filter(p => isDeleted(p) && p.owner === me())
        : visible().filter(p => P.filter === 'visible' || (P.filter === 'mine' && p.owner === me()) || (P.filter === 'public' && p.visibility === 'public') || (P.filter === 'private' && p.visibility === 'private'));
      if (q) list = list.filter(p => searchText(p).includes(q));
      list.sort((a, b) => curV(a).title.localeCompare(curV(b).title));
      const search = h('input', { type: 'search', placeholder: 'Search title, tags, wiki page, owner', value: P.q, oninput: e => { P.q = e.target.value; draw(); setTimeout(() => body.querySelector('input[type=search]')?.focus(), 0); } });
      body.replaceChildren(
        h('div', { class: 'proto-tools' }, search,
          h('select', { onchange: e => { P.filter = e.target.value; draw(); } }, [['visible', 'All I can see'], ['mine', 'Mine'], ['public', 'Public'], ['private', 'My private'], ['deleted', 'My deleted']].map(([v, l]) => h('option', { value: v, selected: P.filter === v }, l)))),
        h('div', { class: 'proto-tools' },
          h('button', { class: 'btn small primary', onclick: () => editDialog(null) }, '＋ New protocol'),
          h('button', { class: 'btn small', title: 'Word, PDF, Markdown or text files: one protocol each', onclick: importFiles }, '⬆ From files'),
          h('button', { class: 'btn small', title: 'Paste a protocol, e.g. copied from its wiki page', onclick: () => editDialog(null, { paste: true }) }, '📋 Paste'),
          ctx.sources().length ? h('button', { class: 'btn small', title: 'Make a protocol from a source in this notebook', onclick: ev => fromSourceMenu(ev.currentTarget) }, '📄 From a source ▾') : null,
          h('span', { class: 'grow' }),
          h('button', { class: 'btn small', title: 'Save the library to share it (public protocols; your private ones only if you choose)', onclick: exportDialog }, '⤓ Save library'),
          h('label', { class: 'btn small', title: 'Add protocols from a library file (.tnote with protocols)' }, '📂 Open library', h('input', { type: 'file', accept: ctx.isIOS ? undefined : '.tnote,.json', class: 'file-input', onchange: async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await importLibrary(f); draw(); } }))),
        list.length ? h('table', { class: 'diag proto-table' }, h('tr', {}, h('th', {}, 'Protocol'), h('th', {}, 'Version'), h('th', {}, 'Owner'), h('th', {}, ''), h('th', {}, 'Last change')),
          list.map(p => { const c = curV(p); return h('tr', { class: 'proto-row', onclick: () => viewDialog(p) },
            h('td', {}, h('b', {}, c.title), c.wiki ? h('div', { class: 'hint' }, `📘 ${c.wiki}`) : null, c.tags ? h('div', { class: 'hint' }, c.tags) : null),
            h('td', {}, `v${c.v}`), h('td', {}, p.ownerName || '?'), h('td', {}, badge(p)), h('td', { class: 'hint' }, `${c.author}, ${fmtTime(c.t)}`)); }))
          : h('p', { class: 'hint' }, P.all.length ? 'No protocols match.' : 'No protocols yet. Add one with ＋ New protocol, from files, by pasting, or from a source.'),
        h('p', { class: 'hint' }, `Signed in as ${ctx.userName() || '(no name)'}. Public protocols are visible to every user of this browser and go into shared library files; private ones only to you. This organises sharing; it does not protect secrets from someone using this device.`));
    };
    draw();
    modal('📚 Protocol library', body);
    if (view) viewDialog(view);
  }
  P.redraw = () => openLibrary();

  function viewDialog(p) {
    const c = curV(p), mine = canEdit(p, me()), entry = ctx.activeEntry();
    const back = h('button', { class: 'btn small', onclick: () => openLibrary() }, '← Library');
    modal(`📚 ${c.title}`, h('div', {},
      h('div', { class: 'proto-tools' }, back, badge(p), h('span', { class: 'hint' }, `version ${c.v} · owner ${p.ownerName} · last change ${c.author}, ${fmtTime(c.t)}`)),
      c.wiki ? h('p', {}, '📘 Wiki page: ', ctx.wikiUrl(c.wiki) ? h('a', { href: ctx.wikiUrl(c.wiki), target: '_blank', rel: 'noopener noreferrer' }, c.wiki) : h('b', {}, c.wiki)) : null,
      c.tags ? h('p', { class: 'hint' }, `Tags: ${c.tags}`) : null,
      isDeleted(p) ? h('div', { class: 'warn-box' }, 'This protocol is deleted (kept in the library and restorable).') : null,
      h('div', { class: 'proto-body' }, c.body.trim() ? md(c.body) : h('p', { class: 'hint' }, '(no steps written)')),
      h('div', { class: 'proto-tools' },
        !isDeleted(p) && entry ? h('button', { class: 'btn small primary', title: 'Add a reference (and optionally a copy of the steps) to the current lab-note entry', onclick: () => insertDialog(entry, null, p) }, '📓 Insert into current entry') : null,
        mine && !isDeleted(p) ? h('button', { class: 'btn small', onclick: () => editDialog(p) }, '✎ Edit (new version)') : null,
        !isDeleted(p) ? h('button', { class: 'btn small', title: 'Make your own private copy', onclick: async () => { const who = await ctx.author(); if (!who) return; const d = duplicate(p, me(), who); await store(d); toast('Copied to your private protocols'); viewDialog(d); } }, '⎘ Duplicate') : null,
        mine && !isDeleted(p) ? h('button', { class: 'btn small', onclick: async () => { const who = await ctx.author(); if (!who) return; setVisibility(p, p.visibility === 'public' ? 'private' : 'public', who); await store(p); viewDialog(p); } }, p.visibility === 'public' ? '🔒 Make private' : '👥 Make public') : null,
        h('button', { class: 'btn small', title: 'Confluence wiki markup for a protocol page (Insert → Markup)', onclick: async () => { try { await navigator.clipboard.writeText(mdToWiki(c.body, { headingBase: 0 }) + '\n'); toast('Protocol wiki markup copied'); } catch { toast('Copying was blocked by the browser', true); } } }, '📋 Copy for wiki'),
        h('button', { class: 'btn small', onclick: () => historyDialog(p) }, `🕘 Versions (${p.versions.length})`),
        mine ? h('button', { class: 'btn small danger', onclick: async () => {
          const who = await ctx.author(); if (!who) return;
          if (!isDeleted(p) && !confirm(`Delete “${c.title}”? It is hidden but kept, and can be restored (My deleted).`)) return;
          p.events.push({ t: Date.now(), author: who, what: isDeleted(p) ? 'restored' : 'deleted' }); await store(p); toast(isDeleted(p) ? 'Protocol deleted (kept)' : 'Protocol restored'); if (!isDeleted(p) && P.filter === 'deleted') P.filter = 'visible'; openLibrary();
        } }, isDeleted(p) ? '↺ Restore' : '🗑 Delete') : null)));
  }

  function historyDialog(p) {
    const mine = canEdit(p, me()), cur = curV(p);
    const rows = [...p.versions].reverse();
    const ev = (p.events || []).map(e => `${fmtTime(e.t)} ${e.author}: ${e.what}${e.visibility ? ' (' + e.visibility + ')' : ''}`);
    modal(`Versions of “${cur.title}”`, h('div', {},
      h('div', { class: 'proto-tools' }, h('button', { class: 'btn small', onclick: () => viewDialog(p) }, '← Back'), h('span', { class: 'hint' }, 'Every version is kept. Restoring adds the old one as a new version.')),
      rows.map(v => h('div', { class: 'lab-rev' + (v.v === cur.v ? ' current' : '') },
        h('div', { class: 'lab-rev-head' }, h('b', {}, `Version ${v.v}`), ` · ${v.author} · ${fmtTime(v.t)} · ${v.note || ''}`,
          v.v === cur.v ? h('span', { class: 'status ok' }, 'current') : mine ? h('button', { class: 'btn small', onclick: async () => {
            const who = await ctx.author(); if (!who) return;
            saveVersion(p, v, who, `restored version ${v.v} (${v.author}, ${fmtTime(v.t)})`); await store(p); historyDialog(p);
          } }, '↺ Restore this version') : null),
        h('div', { class: 'hint' }, `${v.title}${v.wiki ? ' · 📘 ' + v.wiki : ''}`), md(v.body))),
      ev.length ? h('details', {}, h('summary', {}, 'Events'), h('ul', {}, ev.map(x => h('li', {}, x)))) : null));
  }

  async function editDialog(p, { paste = false, prefill = null } = {}) {
    const who = await ctx.author(); if (!who) return;
    const c = p ? curV(p) : { title: prefill?.title || '', body: prefill?.body || '', wiki: '', tags: '' };
    const title = h('input', { type: 'text', value: c.title, placeholder: 'e.g. Kirby-Bauer Disk Diffusion Susceptibility Test Protocol' });
    const wiki = h('input', { type: 'text', value: c.wiki, placeholder: 'Exact title of its wiki page (optional), e.g. Kirby-Bauer Disk Diffusion Susceptibility Test Protocol' });
    const tags = h('input', { type: 'text', value: c.tags, placeholder: 'e.g. microbiology, antibiotics' });
    const vis = h('select', {}, h('option', { value: 'private' }, '🔒 Private (only me)'), h('option', { value: 'public' }, '👥 Public (everyone using this browser; shared library files)'));
    const body = h('textarea', { class: 'lab-ta', rows: 16, placeholder: paste ? 'Paste the protocol here (e.g. copied from its wiki page). Markdown is fine: ## headings, 1. steps, | tables |.' : 'Materials, then numbered steps. Markdown: ## Materials, 1. step, | tables |.' }); body.value = c.body;
    const note = h('input', { type: 'text', placeholder: p ? 'What changed? (kept with the version)' : '' });
    modal(p ? `Edit “${c.title}” (new version)` : 'New protocol', h('div', {},
      h('div', { class: 'form-grid' }, h('label', {}, 'Title'), title, h('label', {}, 'Wiki page'), wiki, h('label', {}, 'Tags'), tags,
        p ? null : h('label', {}, 'Visibility'), p ? null : vis, p ? h('label', {}, 'Change note') : null, p ? note : null),
      body,
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => (p ? viewDialog(p) : openLibrary()) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          if (!title.value.trim()) { title.focus(); return toast('Give the protocol a title', true); }
          if (p) { const v = saveVersion(p, { title: title.value, body: body.value, wiki: wiki.value, tags: tags.value }, who, note.value.trim()); if (!v) return toast('Nothing changed'); await store(p); toast(`Saved as version ${v.v}`); viewDialog(p); }
          else { const q = newProtocol({ title: title.value, body: body.value, wiki: wiki.value, tags: tags.value, visibility: vis.value, owner: me(), ownerName: who, note: prefill?.note || 'created' }); await store(q); toast('Protocol saved'); viewDialog(q); }
        } }, p ? 'Save new version' : 'Save'))));
    setTimeout(() => (paste ? body : title).focus(), 50);
  }

  async function importFiles() {
    const files = await ctx.pickFiles({ multiple: true, accept: '.docx,.pdf,.md,.markdown,.txt,.html,.htm' });
    if (!files.length) return;
    const who = await ctx.author(); if (!who) return;
    let n = 0;
    for (const f of files) {
      try {
        const r = await ctx.parseFile(f);
        const text = r.segments.map(s => s.text).join('\n\n').trim();
        const title = (/^#+\s*(.+)$/m.exec(text)?.[1] || f.name.replace(/\.[^.]+$/, '')).trim().slice(0, 150);
        await store(newProtocol({ title, body: text, visibility: 'private', owner: me(), ownerName: who, note: `imported from ${f.name}` })); n++;
      } catch (e) { toast(`Could not read ${f.name}: ${e.message}`, true); }
    }
    if (n) toast(`${n} protocol(s) imported as private: open one to check it, add its wiki page, or make it public`);
    openLibrary();
  }
  function fromSourceMenu(anchor) {
    const pop = $('#popover'); pop.innerHTML = '';
    pop.append(h('div', { class: 'menu' }, h('div', { class: 'menu-head' }, 'Make a protocol from a source'),
      ...ctx.sources().map(s => h('button', { class: 'menu-item', onclick: () => { pop.hidden = true; editDialog(null, { prefill: { title: s.name.replace(/\.[^.]+$/, ''), body: (s.segments || []).map(x => x.text).join('\n\n').trim(), note: `from source ${s.name}` } }); } }, h('span', {}, s.name)))));
    pop.hidden = false; const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 10)) + 'px'; pop.style.top = (r.bottom + 4) + 'px';
  }
  function exportDialog() {
    const mine = P.all.filter(p => p.owner === me() && p.visibility === 'private' && !isDeleted(p));
    const pub = P.all.filter(p => p.visibility === 'public' && !isDeleted(p));
    const inclPriv = h('input', { type: 'checkbox' });
    modal('Save the protocol library', h('div', {},
      h('p', {}, `${pub.length} public protocol(s) will be saved, with all their versions.`),
      mine.length ? h('label', { class: 'check-row' }, inclPriv, `Also include my ${mine.length} private protocol(s) (only in this file)`) : null,
      h('p', { class: 'hint' }, 'Share the file with your lab; they open it with 📂 Open library. Protocols they already have gain any new versions; nothing is removed or overwritten.'),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: () => {
        const list = [...pub, ...(inclPriv.checked ? mine : [])];
        saveText(libraryFile(list), `protocols ${new Date().toISOString().slice(0, 10)}.tnote`, 'application/json'); closeModal();
      } }, '⤓ Save library file'))));
  }
  async function importLibrary(file) {
    let d; try { d = JSON.parse(await file.text()); } catch { return toast(`“${file.name}” is not a protocol library file`, true); }
    if (String(d?.app || '').replace(/\s+/g, '').toLowerCase() !== 'thistlenotebook' || d.kind !== 'protocols') return toast(d?.kind === 'notebook' ? `“${file.name}” is a notebook: open it with 📂 Open in the header` : `“${file.name}” is not a protocol library file`, true);
    await load();
    const { added, updated, merged } = mergeLibrary(P.all, d.protocols);
    for (const p of merged) await store(p);
    toast(`Library opened: ${added} new, ${updated} updated, ${(d.protocols || []).length - added - updated} already up to date`);
  }

  // ---------- inserting into a lab-note entry ----------
  /** onInsert(md, snap): when given (editor open), the text goes into the editor; otherwise appended to the Protocol section. */
  async function insertDialog(entry, onInsert = null, preselect = null) {
    await load();
    let chosen = preselect;
    const body = h('div');
    const draw = () => {
      const list = visible().sort((a, b) => curV(a).title.localeCompare(curV(b).title));
      if (!chosen) {
        body.replaceChildren(list.length ? h('div', {}, h('p', { class: 'hint' }, 'Choose the protocol you followed:'),
          h('ul', { class: 'proto-pick' }, list.map(p => h('li', {}, h('button', { class: 'menu-item', onclick: () => { chosen = p; draw(); } }, h('span', {}, `${curV(p).title} (v${curV(p).v})`), h('small', {}, `${p.ownerName} · ${p.visibility}${curV(p).wiki ? ' · 📘 wiki page' : ''}`))))))
          : h('p', {}, 'The library is empty. ', h('button', { class: 'btn small', onclick: () => openLibrary() }, '📚 Open the library')));
        return;
      }
      const c = curV(chosen), dev = h('textarea', { class: 'lab-ta', rows: 3, placeholder: 'Any deviation from the protocol (e.g. used the lab agar recipe instead of Mueller-Hinton agar). Leave empty if none.' });
      const copy = h('input', { type: 'checkbox', checked: !c.wiki });
      body.replaceChildren(
        h('p', {}, h('b', {}, c.title), ` · version ${c.v} · ${chosen.ownerName}`, c.wiki ? ` · 📘 ${c.wiki}` : ' · no wiki page'),
        h('label', {}, 'Deviations'), dev,
        h('label', { class: 'check-row' }, copy, c.wiki ? 'Also copy the steps into the entry (the wiki page already has them)' : 'Copy the steps into the entry (recommended: this protocol has no wiki page)'),
        h('p', { class: 'hint' }, `The entry keeps a frozen copy of version ${c.v}, so later edits to the protocol do not change this record.`),
        h('div', { class: 'modal-foot' }, preselect ? null : h('button', { class: 'btn', onclick: () => { chosen = null; draw(); } }, '← Other protocol'),
          h('button', { class: 'btn primary', onclick: async () => {
            const who = await ctx.author(); if (!who) return;
            const snap = snapshot(chosen, who), text = referenceMd(snap, { deviations: dev.value, copySteps: copy.checked });
            closeModal();
            if (onInsert) onInsert(text, snap); else await ctx.insertIntoEntry(entry, text, snap);
          } }, onInsert ? 'Insert into the text' : 'Add to the Protocol section')));
    };
    draw();
    modal(`📚 Insert a protocol into “${entry ? ctx.entryTitle(entry) : ''}”`, body);
  }

  /** Short list for the model in Lab notebook mode. */
  const promptList = () => visible().slice(0, 60).map(p => { const c = curV(p); return { title: c.title, v: c.v, wiki: c.wiki }; });
  return { load, openLibrary, insertDialog, promptList, _P: P };
}
