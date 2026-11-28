// Lab note pane: Study header, assay entries (menu), Markdown sections with full version history, attachments,
// lab-note updates proposed in the chat (Accept / Edit / Reject or automatic), and export for the wiki.
// Nothing is ever removed: edits, accepted updates, restores and deletions all add to the record.
import {
  SECTIONS, TYPES, TEMPLATES, STUDY_FIELDS, cur, revise, appendText, newLabNote, newEntry, isDeleted, entrySections,
  pageTitle, changeLog, fmtTime, parseLabUpdates, entryToWiki, studyToWiki, entryToHtml, entryToMarkdown,
  isFinal, finalEvent, witnesses, sealPayload, legacySealPayload, sha256Hex, sealShort, fixTargets,
} from './labnote.js';
import { createRichEditor } from './labeditor.js';
import { zip } from './zip.js';

export function createLab(ctx) {
  const { h, $, db, toast, modal, closeModal, uid, saveBlob, saveText, safeName } = ctx;
  const L = { note: null, files: [], urls: new Map(), showDeleted: false, editing: null, studyOpen: false };
  const panel = () => $('#labPanel');
  const nbId = () => ctx.nb()?.id;

  // ---------- loading and saving ----------
  async function load() {
    for (const u of L.urls.values()) URL.revokeObjectURL(u);
    L.urls.clear(); L.editing = null;
    const id = nbId();
    const [note, files] = await Promise.all([db.get('labnotes', id), db.byNb('files', id)]);
    if (id !== nbId()) return; // another notebook was opened meanwhile
    L.note = note || null; L.files = files || [];
    render();
  }
  async function ensureNote() {
    if (L.note) return L.note;
    const who = await ctx.author(); if (!who) return null;
    L.note = newLabNote(nbId(), ctx.nb().name, who);
    await save(); return L.note;
  }
  async function save() { await db.put('labnotes', L.note); await ctx.touch(); }
  const liveEntries = () => (L.note?.entries || []).filter(e => !isDeleted(e));
  function activeEntry() {
    const es = liveEntries();
    return es.find(e => e.id === L.note?.activeEntry) || es[es.length - 1] || null;
  }
  // The entry shown: a deleted one can be shown (read-only, to restore it) while "deleted entries" are listed
  function shownEntry() {
    if (L.showDeleted) { const d = (L.note?.entries || []).find(e => e.id === L.note?.activeEntry); if (d) return d; }
    return activeEntry();
  }
  const entryById = id => L.note?.entries.find(e => e.id === id) || null;
  const filesOf = entryId => L.files.filter(f => f.entry === entryId && !isDeleted(f));
  const fileUrl = f => { if (!L.urls.has(f.id)) L.urls.set(f.id, URL.createObjectURL(f.blob)); return L.urls.get(f.id); };
  const findFile = (entryId, name) => filesOf(entryId).find(f => f.name === name) || L.files.find(f => f.name === name && !isDeleted(f));

  // ---------- Markdown with attachment / wiki references ----------
  function renderLabMd(md, entryId) {
    const src = fixTargets(md, '#tn-');
    const el = h('div', { class: 'md lab-md' });
    el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(src, { gfm: true, breaks: true }));
    el.querySelectorAll('img').forEach(img => {
      const m = /^#tn-attachment:(.+)$/.exec(img.getAttribute('src') || ''); if (!m) return;
      const f = findFile(entryId, decodeURIComponent(m[1]));
      if (f) { img.src = fileUrl(f); img.title = f.name; } else img.replaceWith(h('span', { class: 'missing-att', title: 'No attachment with this name' }, `🖼 ${decodeURIComponent(m[1])} (not attached)`));
    });
    el.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href'), m = /^#tn-(attachment|wiki):(.+)$/.exec(href);
      if (!m) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
      const name = decodeURIComponent(m[2]);
      if (m[1] === 'attachment') {
        const f = findFile(entryId, name);
        if (f) { a.href = fileUrl(f); a.download = f.name; a.title = `Attachment ${f.name}`; a.prepend('📎 '); }
        else { a.removeAttribute('href'); a.classList.add('missing-att'); a.title = 'No attachment with this name'; }
      } else {
        const url = ctx.wikiUrl(name);
        if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; } else a.removeAttribute('href');
        a.classList.add('wiki-link'); a.title = `Wiki page: ${name}`; a.prepend('📘 ');
      }
    });
    return el;
  }

  // ---------- rendering ----------
  function render() {
    const p = panel(); if (!p) return;
    p.innerHTML = '';
    const note = L.note, e = shownEntry(), gone = (note?.entries || []).filter(isDeleted);
    // study header
    const studyTitle = note ? cur(note.study.fields.title) || '(untitled study)' : ctx.nb()?.name || '';
    p.append(h('div', { class: 'lab-study' },
      h('button', { class: 'link-btn', title: 'Study page: title, investigation, purpose and description', onclick: () => { L.studyOpen = !L.studyOpen; render(); } }, `📘 Study: ${studyTitle} ${L.studyOpen ? '▾' : '▸'}`)));
    if (L.studyOpen) {
      if (!note) p.append(h('div', { class: 'hint' }, 'The study page starts with the first assay entry.'));
      else p.append(h('div', { class: 'lab-study-fields' }, Object.entries(STUDY_FIELDS).map(([k, d]) => sectionEl(note.study.fields[k], `study:${k}`, d.label, d.hint, null, true))));
    }
    // entry chooser
    const sel = h('select', { id: 'labEntry', title: 'Assay entries in this study', onchange: async ev => { L.note.activeEntry = ev.target.value; L.editing = null; await db.put('labnotes', L.note); render(); } },
      (note?.entries || []).filter(x => L.showDeleted || !isDeleted(x)).map(x => h('option', { value: x.id, selected: e && x.id === e.id }, `${pageTitle(x)}${isDeleted(x) ? ' (deleted)' : ''}`)));
    p.append(h('div', { class: 'lab-bar' },
      note?.entries.length ? sel : h('span', { class: 'hint' }, 'No assay entries yet.'),
      h('button', { class: 'btn small primary', title: 'New assay entry (one Wikibench assay page)', onclick: newEntryDialog }, '＋ New assay'),
      h('button', { class: 'btn small', title: 'Protocol library: public and private protocols, shared by all notebooks', onclick: () => ctx.protocols().openLibrary() }, '📚 Protocols'),
      e ? h('button', { class: 'btn small lab-menu-btn', title: 'Type, change log, delete…', onclick: ev => entryMenu(ev.currentTarget, e) }, '⋯') : null,
      gone.length ? h('button', { class: 'btn small lab-deleted-btn', title: 'Deleted entries are kept in the record and can be restored', onclick: () => { L.showDeleted = !L.showDeleted; if (L.showDeleted && !liveEntries().length) L.note.activeEntry = gone[gone.length - 1].id; render(); } }, `${L.showDeleted ? 'Hide' : '🗑'} deleted (${gone.length})`) : null));
    if (!e) {
      if (gone.length) p.append(h('div', { class: 'hint' }, `All entries are deleted (kept in the record): use “🗑 deleted (${gone.length})” to see and restore them.`));
      p.append(h('div', { class: 'empty lab-empty' },
        h('p', {}, h('b', {}, 'Write your lab notebook here as you work.')),
        h('p', {}, 'Create an assay entry (one experiment = one Wikibench assay page). Edit its sections directly, or choose the ', h('b', {}, 'Lab notebook'), ' mode in the chat and describe what you did in your own words: the assistant proposes formal notebook text for you to accept.'),
        h('p', { class: 'hint' }, 'Every change is kept with its time and author; nothing is ever removed.')));
      return;
    }
    // entry header
    const meta = h('div', { class: 'lab-entry-head' },
      h('span', { class: 'badge-hdr' }, TYPES[e.type] || e.type), ' ',
      h('b', {}, pageTitle(e)), ' ',
      isFinal(e) ? h('span', { class: 'badge-hdr campus', title: 'Finalised: locked; changes are added as amendments' }, '🔏 finalised') : h('button', { class: 'icon', title: 'Edit the title and date', onclick: () => { L.editing = 'meta'; render(); } }, '✎'));
    p.append(meta);
    if (isFinal(e) && !isDeleted(e)) {
      const f = finalEvent(e), w = witnesses(e);
      p.append(h('div', { class: 'hint-box lab-final' }, `🔏 Finalised by ${f.author} on ${fmtTime(f.t)} · seal ${sealShort(f.seal)}…`,
        w.length ? ` · ✍ witnessed by ${w.map(x => `${x.author} (${fmtTime(x.t)})`).join(', ')}` : ' · not witnessed yet', '. The entry is locked: add changes as amendments. ',
        h('button', { class: 'btn small primary', onclick: () => amendmentDialog(e) }, '＋ Amendment'), ' ',
        h('button', { class: 'btn small', onclick: () => checkSeal(e) }, '🔍 Check seal'),
        ctx.userName() && ctx.userName() !== f.author && !w.some(x => x.author === ctx.userName()) ? [' ', h('button', { class: 'btn small', onclick: () => witness(e) }, '✍ Witness')] : null));
    }
    if (isDeleted(e)) {
      const ev = [...e.events].reverse().find(x => x.what === 'deleted');
      p.append(h('div', { class: 'warn-box' }, `This entry was deleted by ${ev.author} on ${fmtTime(ev.t)}. It is kept in the record and shown read-only. `,
        h('button', { class: 'btn small primary', onclick: async () => { const who = await ctx.author(); if (!who) return; e.events.push({ t: Date.now(), author: who, what: 'restored' }); L.note.activeEntry = e.id; await save(); render(); toast('Entry restored'); } }, '↺ Restore')));
    }
    if (L.editing === 'meta' && !isDeleted(e) && !isFinal(e)) p.append(metaEditor(e));
    const secs = h('div', { class: 'lab-sections' });
    for (const k of entrySections(e)) secs.append(sectionEl(e.fields[k], k, SECTIONS[k].label, SECTIONS[k].hint, e));
    p.append(secs);
    if (e.amendments?.length) p.append(h('div', { class: 'lab-sec lab-amend' }, h('div', { class: 'lab-sec-head' }, h('b', {}, `Amendments (${e.amendments.length})`)),
      e.amendments.map(a => h('div', { class: 'lab-rev' }, h('div', { class: 'lab-rev-head' }, h('b', {}, fmtTime(a.t)), ` · ${a.author}${a.section ? ' · ' + (SECTIONS[a.section]?.label || a.section) : ''} · reason: ${a.reason}`), renderLabMd(a.text, e.id)))));
    if (!isDeleted(e)) p.append(attachmentsEl(e), footerEl(e));
  }

  function metaEditor(e) {
    const t = h('input', { type: 'text', value: cur(e.fields.title) }), d = h('input', { type: 'date', value: cur(e.fields.date) });
    return h('div', { class: 'lab-edit' }, h('div', { class: 'form-grid' }, h('label', {}, 'Date'), d, h('label', {}, 'Title'), t),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn small', onclick: () => { L.editing = null; render(); } }, 'Cancel'),
        h('button', { class: 'btn small primary', onclick: async () => {
          const who = await ctx.author(); if (!who) return;
          revise(e.fields.title, t.value.trim(), who, 'edit'); revise(e.fields.date, d.value, who, 'edit');
          L.editing = null; await save(); render();
        } }, 'Save')));
  }

  function lastRevLine(f) {
    const r = f?.revs?.[f.revs.length - 1];
    return r ? `${f.revs.length} version${f.revs.length > 1 ? 's' : ''} · ${r.author}, ${fmtTime(r.t)}${r.via === 'chat' ? ' (from chat)' : r.via === 'restore' ? ' (restored)' : ''}` : '';
  }
  function sectionEl(field, key, label, hint, entry, study = false) {
    const box = h('div', { class: 'lab-sec', 'data-key': key });
    const locked = !!(entry && (isDeleted(entry) || isFinal(entry)));
    const editing = !locked && L.editing === key;
    box.append(h('div', { class: 'lab-sec-head' }, h('b', {}, label), h('small', { class: 'hint' }, lastRevLine(field)), h('span', { class: 'grow' }),
      editing || locked ? null : h('button', { class: 'icon', title: 'Edit this section', onclick: () => { L.editing = key; render(); setTimeout(() => panel().querySelector(`.lab-sec[data-key="${key}"] .lab-rich:not([hidden]), .lab-sec[data-key="${key}"] textarea:not([hidden])`)?.focus(), 30); } }, '✎'),
      field?.revs?.length ? h('button', { class: 'icon', title: 'All versions of this section', onclick: () => historyDialog(field, label, entry) }, '🕘') : null));
    if (editing) box.append(editorEl(field, key, entry, study));
    else {
      const md = cur(field);
      box.append(md.trim() ? renderLabMd(md, entry?.id)
        : locked ? h('div', { class: 'lab-hint', style: 'cursor:default' }, '(empty)')
          : h('div', { class: 'lab-hint', onclick: () => { L.editing = key; render(); } }, hint || 'Click ✎ to write.'));
    }
    if (key === 'protocol' && entry?.protocolsUsed?.length) box.append(h('div', { class: 'lab-protos hint' }, 'Protocols recorded: ',
      entry.protocolsUsed.map(s => h('button', { class: 'link-btn', title: 'Show the frozen copy kept in this entry', onclick: () => snapshotDialog(s) }, `📚 ${s.title} v${s.v}`)).flatMap((b, i) => (i ? [' · ', b] : [b]))));
    if (key === 'protocol' && entry && !locked && !editing) box.append(h('button', { class: 'btn small lab-proto-add', onclick: () => ctx.protocols().insertDialog(entry) }, '📚 Add a protocol'));
    return box;
  }
  function editorEl(field, key, entry) {
    const saveIt = async (mdText, pending) => {
      if (entry && (isDeleted(entry) || isFinal(entry))) { L.editing = null; render(); return toast('This entry is locked and cannot be edited directly', true); }
      const who = await ctx.author(); if (!who) return;
      const r = revise(field, mdText, who, 'edit');
      if (r && entry) for (const snap of pending) if (mdText.includes(snap.title)) recordProtocol(entry, snap, who);
      L.editing = null; if (r) await save(); render();
      if (r) toast('Saved (earlier versions are kept: 🕘)');
    };
    const ed = createRichEditor({
      h, $, initialMd: cur(field), entry,
      placeholder: SECTIONS[key]?.hint || STUDY_FIELDS[key.replace(/^study:/, '')]?.hint || '',
      findFile, fileUrl, wikiUrl: ctx.wikiUrl, filesOf,
      pickFiles: ctx.pickFiles, isIOS: !!ctx.isIOS, addAttachments, toast,
      openProtocolPicker: entry ? cb => ctx.protocols().insertDialog(entry, cb) : null,
      onSave: saveIt,
      onCancel: () => { L.editing = null; render(); },
    });
    return ed.el;
  }

  function recordProtocol(e, snap, who) {
    (e.protocolsUsed ||= []).push(snap);
    (e.events ||= []).push({ t: Date.now(), author: who, what: 'protocol recorded', name: `${snap.title} v${snap.v}` });
  }
  /** From the library: append the reference to the Protocol section and keep the frozen copy. */
  async function insertIntoEntry(e, text, snap) {
    if (!e || isDeleted(e)) { toast('Open an assay entry first', true); return false; }
    if (isFinal(e)) { toast('This entry is finalised: add protocol notes as an amendment instead', true); return false; }
    const who = await ctx.author(); if (!who) return false;
    revise(e.fields.protocol, appendText(cur(e.fields.protocol), text), who, 'protocol', `inserted ${snap.title} v${snap.v}`);
    recordProtocol(e, snap, who); await save(); render(); toast(`${snap.title} (v${snap.v}) added to the Protocol section`);
    return true;
  }
  // ---------- finalise, witness, seal, amendments ----------
  async function entryFileHashes(e) {
    return Promise.all(filesOf(e.id).map(async f => ({ name: f.name, sha256: await sha256Hex(await f.blob.arrayBuffer()) })));
  }
  async function sealOf(e) {
    return sha256Hex(sealPayload(e, await entryFileHashes(e)));
  }
  async function verifySeal(e) {
    const f = finalEvent(e), hashes = await entryFileHashes(e);
    const now = await sha256Hex(sealPayload(e, hashes));
    if (now === f.seal) return { ok: true, now, matched: now };
    const legacy = await sha256Hex(legacySealPayload(e, hashes));
    if (legacy === f.seal) return { ok: true, now: legacy, matched: legacy };
    return { ok: false, now, matched: null };
  }
  function finaliseDialog(e) {
    if (!e || isFinal(e) || isDeleted(e)) return;
    if (L.editing) { toast('Save or cancel the open section edit before finalising', true); return; }
    modal(`🔏 Finalise “${pageTitle(e)}”`, h('div', {},
      h('p', {}, 'Finalising signs the entry as complete. It is sealed with a fingerprint (SHA-256) of its sections, recorded protocols and attachments, and locked. Later changes are added as dated ', h('b', {}, 'amendments'), ' with a reason. Another person can then ', h('b', {}, 'witness'), ' it.'),
      h('p', { class: 'hint' }, 'Finalising cannot be undone (it is part of the record), but amendments can always be added.'),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
        if (isFinal(e) || isDeleted(e)) { closeModal(); return; }
        const who = await ctx.author(); if (!who) return;
        const seal = await sealOf(e);
        e.events.push({ t: Date.now(), author: who, what: 'finalised', seal }); L.editing = null; await save(); closeModal(); render(); toast(`Finalised (seal ${sealShort(seal)}…)`);
      } }, '🔏 Finalise'))));
  }
  async function witness(e) {
    if (!e || isDeleted(e) || !isFinal(e)) return;
    const f = finalEvent(e), who = await ctx.author(); if (!who) return;
    if (who === f.author) { toast('The person who finalised an entry cannot witness their own entry', true); return; }
    if (witnesses(e).some(x => x.author === who)) { toast(`${who} has already witnessed this entry`, true); return; }
    const v = await verifySeal(e);
    if (!v.ok) { toast('The entry no longer matches its seal: it cannot be witnessed (🔍 Check seal)', true); return; }
    if (!confirm(`Witness “${pageTitle(e)}” as ${who}? This records that you have read the finalised entry.`)) return;
    e.events.push({ t: Date.now(), author: who, what: 'witnessed', seal: v.matched }); await save(); render(); toast('Witnessed');
  }
  async function checkSeal(e) {
    const f = finalEvent(e), v = await verifySeal(e), ok = v.ok;
    modal('🔍 Seal check', h('div', {},
      h('div', { class: ok ? 'hint-box' : 'err-box' }, ok ? `✅ The entry matches the seal made when ${f.author} finalised it on ${fmtTime(f.t)}.` : `⚠ The entry does NOT match its seal (finalised by ${f.author} on ${fmtTime(f.t)}). Its content or attachments were changed outside Thistle Notebook.`),
      h('p', { class: 'hint' }, `Seal: ${f.seal}`), ok ? null : h('p', { class: 'hint' }, `Now:  ${v.now}`),
      h('p', { class: 'hint' }, 'Amendments are not part of the seal: they are added after finalising, each with its author, time and reason.')));
  }
  /** Amendment to a finalised entry: dated, signed, with a reason; never changes the sealed text. */
  async function amendmentDialog(e, { section = '', text = '', onSaved = null } = {}) {
    const sec = h('select', {}, h('option', { value: '' }, '(whole entry)'), entrySections(e).map(k => h('option', { value: k, selected: k === section }, SECTIONS[k].label)));
    const ed = createRichEditor({ h, $, initialMd: text, placeholder: 'The correction or addition', wikiUrl: ctx.wikiUrl, compact: true });
    const why = h('input', { type: 'text', placeholder: 'Reason, e.g. transcription error in zone size for plate B' });
    modal(`＋ Amendment to “${pageTitle(e)}”`, h('div', {},
      h('div', { class: 'form-grid' }, h('label', {}, 'Section'), sec, h('label', {}, 'Reason'), why), ed.el,
      h('p', { class: 'hint' }, 'The finalised text stays as it was; the amendment is added below it with your name, the time and the reason.'),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
        const mdText = ed.getMarkdown().trim();
        if (!mdText) { ed.focus(); return; }
        if (!why.value.trim()) { why.focus(); return toast('Give a reason for the amendment', true); }
        const who = await ctx.author(); if (!who) return;
        (e.amendments ||= []).push({ t: Date.now(), author: who, section: sec.value, text: mdText, reason: why.value.trim() });
        e.events.push({ t: Date.now(), author: who, what: 'amendment added' });
        await save(); closeModal(); render(); toast('Amendment added');
        if (onSaved) await onSaved();
      } }, 'Add amendment'))));
    setTimeout(() => (text ? why : ed).focus(), 50);
    return true;
  }
  async function wordExport(e) {
    const images = new Map();
    for (const f of filesOf(e.id)) if (/^image\//.test(f.type)) {
      let w = 600, hgt = 400, data = null, type = f.type;
      const native = /^image\/(png|jpe?g|gif|bmp)$/.test(type);
      try {
        const b = await createImageBitmap(f.blob);
        w = b.width || w; hgt = b.height || hgt;
        if (!native) {
          const c = document.createElement('canvas'); c.width = w; c.height = hgt;
          c.getContext('2d').drawImage(b, 0, 0);
          const pngBlob = await new Promise(res => c.toBlob(res, 'image/png'));
          if (pngBlob) { data = new Uint8Array(await pngBlob.arrayBuffer()); type = 'image/png'; }
        }
        b.close?.();
      } catch { }
      if (native) data = new Uint8Array(await f.blob.arrayBuffer());
      if (data) images.set(f.name, { data, type, w, h: hgt });
    }
    saveBlob(ctx.markdownToDocx(entryToMarkdown(e), '', { images }), `${safeName(pageTitle(e))}.docx`);
  }
  function snapshotDialog(s) {
    modal(`📚 ${s.title} — version ${s.v} (as recorded)`, h('div', {},
      h('p', { class: 'hint' }, `Recorded by ${s.author} on ${fmtTime(s.t)} from ${s.owner}'s protocol${s.wiki ? ' · wiki page ' + s.wiki : ''}. This copy does not change when the protocol is edited later.`),
      renderLabMd(s.body || '(no steps)', null)));
  }
  function historyDialog(field, label, entry) {
    const revs = [...field.revs].map((r, i) => ({ ...r, n: i + 1 })).reverse();
    const locked = !!(entry && (isDeleted(entry) || isFinal(entry)));
    modal(`Versions of “${label}”`, h('div', {},
      h('p', { class: 'hint' }, locked ? 'Every version is kept. This entry is locked, so versions are read-only.' : 'Every version is kept. Restoring adds the old text as a new version; nothing is removed.'),
      revs.map(r => h('div', { class: 'lab-rev' + (r.n === field.revs.length ? ' current' : '') },
        h('div', { class: 'lab-rev-head' }, h('b', {}, `Version ${r.n}`), ` · ${r.author} · ${fmtTime(r.t)} · ${viaLabel(r.via)}${r.note ? ' · ' + r.note : ''}`,
          r.n === field.revs.length ? h('span', { class: 'status ok' }, 'current') : locked ? null : h('button', { class: 'btn small', onclick: async () => {
            if (entry && (isDeleted(entry) || isFinal(entry))) return toast('This entry is locked', true);
            const who = await ctx.author(); if (!who) return;
            revise(field, r.text, who, 'restore', `restored version ${r.n} (${r.author}, ${fmtTime(r.t)})`);
            await save(); closeModal(); render(); toast(`Version ${r.n} restored as a new version`);
          } }, '↺ Restore this version')),
        r.text.trim() ? renderLabMd(r.text, entry?.id) : h('div', { class: 'hint' }, '(empty)')))));
  }
  const viaLabel = v => ({ edit: 'edited', chat: 'from chat', restore: 'restored', created: 'created', add: 'added from chat/analysis', protocol: 'protocol inserted' }[v] || v || '');

  function attachmentsEl(e) {
    const fs = filesOf(e.id), locked = isFinal(e);
    const zone = h('div', { class: 'lab-att', title: 'Drop files here to attach them to this entry' },
      h('div', { class: 'lab-sec-head' }, h('b', {}, `Attachments (${fs.length})`), h('span', { class: 'grow' }),
        locked ? h('span', { class: 'hint' }, 'sealed with the entry') : h('button', { class: 'btn small', onclick: async () => { const files = await ctx.pickFiles({ multiple: true }); if (files.length) await addAttachments(e, files); } }, '＋ Attach files')),
      fs.length ? h('ul', { class: 'lab-att-list' }, fs.map(f => h('li', {},
        /^image\//.test(f.type) ? h('img', { src: fileUrl(f), alt: '', class: 'lab-thumb' }) : h('span', { class: 'lab-file-ico' }, '📎'),
        h('a', { href: fileUrl(f), download: f.name, title: 'Download' }, f.name),
        h('small', { class: 'hint' }, ` ${ctx.fmtBytes(f.size)} · ${f.author}, ${fmtTime(f.t)}`),
        h('span', { class: 'grow' }),
        locked ? null : h('button', { class: 'icon', title: 'Remove from this entry (kept in the record; shown in the change log)', onclick: async () => {
          if (!confirm(`Remove “${f.name}” from this entry? It stays in the notebook's record and the change log.`)) return;
          const who = await ctx.author(); if (!who) return;
          (f.events ||= []).push({ t: Date.now(), author: who, what: 'deleted' }); await db.put('files', f);
          (e.events ||= []).push({ t: Date.now(), author: who, what: 'attachment removed', name: f.name }); await save(); render();
        } }, '🗑')))) : h('div', { class: 'lab-hint' }, 'Drop files here (images, data, gels, plots…) or use ＋ Attach files. Refer to them in a section with 📎 Attachment ▾.'));
    if (locked) return zone;
    zone.addEventListener('dragover', ev => { ev.preventDefault(); ev.stopPropagation(); zone.classList.add('drop'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop'));
    zone.addEventListener('drop', async ev => { ev.preventDefault(); ev.stopPropagation(); zone.classList.remove('drop'); document.body.classList.remove('dragging'); if (ev.dataTransfer.files.length) await addAttachments(e, [...ev.dataTransfer.files]); });
    return zone;
  }
  function uniqueName(entryId, name) {
    const taken = new Set(filesOf(entryId).map(f => f.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const m = /^(.*?)(\.[^.]*)?$/.exec(name);
    for (let i = 2; ; i++) { const n = `${m[1]} (${i})${m[2] || ''}`; if (!taken.has(n.toLowerCase())) return n; }
  }
  /** files: File or {blob, name, type}. Returns the stored names (renamed if the name was taken: nothing is overwritten). */
  async function addAttachments(e, files, { quiet = false, skipRender = false } = {}) {
    if (!e || isDeleted(e)) return [];
    if (isFinal(e)) { toast('This entry is finalised: new attachments cannot be added to a sealed entry', true); return []; }
    const who = await ctx.author(); if (!who) return [];
    const names = [];
    for (const f of files) {
      const blob = f.blob || f, name = uniqueName(e.id, (f.name || 'file').replace(/[\\/:*?"<>|]+/g, '_'));
      const rec = { id: uid(), nb: nbId(), entry: e.id, name, type: f.type || blob.type || 'application/octet-stream', size: blob.size, t: Date.now(), author: who, blob, events: [{ t: Date.now(), author: who, what: 'attached' }] };
      await db.put('files', rec); L.files.push(rec); names.push(name);
      (e.events ||= []).push({ t: Date.now(), author: who, what: 'attachment added', name });
    }
    await save();
    if (skipRender) { const oldAtt = panel()?.querySelector('.lab-att'); if (oldAtt) oldAtt.replaceWith(attachmentsEl(e)); }
    else render();
    if (!quiet) toast(`Attached ${names.length} file(s)`);
    return names;
  }

  function footerEl(e) {
    const auto = h('select', { title: 'What happens to lab-note updates the assistant proposes in the chat', onchange: ev => { ctx.setAutoApply(ev.target.value === 'auto'); toast(ev.target.value === 'auto' ? 'Chat updates will be applied automatically (still versioned)' : 'You will accept each chat update'); } },
      h('option', { value: 'ask', selected: !ctx.autoApply() }, 'Ask me (Accept / Edit / Reject)'), h('option', { value: 'auto', selected: ctx.autoApply() }, 'Apply automatically'));
    return h('div', { class: 'lab-foot' },
      h('button', { class: 'btn primary', title: 'Copy this entry for a Wikibench assay page', onclick: () => wikiDialog(e) }, '📋 Copy for wiki…'),
      h('button', { class: 'btn', title: 'All attachments of this entry, to drag onto the wiki page', onclick: () => downloadAttachments(e) }, '⤓ Attachments'),
      h('label', { class: 'inline' }, 'Chat updates', auto));
  }

  function entryMenu(anchor, e) {
    const pop = $('#popover'); pop.innerHTML = '';
    const item = (label, fn) => h('button', { class: 'menu-item', onclick: () => { pop.hidden = true; fn(); } }, h('span', {}, label));
    const deleted = (L.note.entries || []).filter(isDeleted);
    const locked = isFinal(e) || isDeleted(e);
    pop.append(h('div', { class: 'menu' }, h('div', { class: 'menu-head' }, pageTitle(e)),
      ...(locked ? [] : Object.entries(TYPES).filter(([k]) => k !== e.type).map(([k, v]) => item(`Change type to ${v}`, async () => {
        if (isFinal(e) || isDeleted(e)) return toast('This entry is locked', true);
        const who = await ctx.author(); if (!who) return;
        e.type = k; e.events.push({ t: Date.now(), author: who, what: 'type changed', type: k }); await save(); render();
      }))),
      item('🕘 Change log of this entry', () => changeLogDialog(e)),
      item('⤓ Markdown of this entry', () => saveText(entryToMarkdown(e), `${safeName(pageTitle(e))}.md`, 'text/markdown')),
      item('⤓ Word (.docx) with figures', () => wordExport(e)),
      !locked ? item('🔏 Finalise this entry…', () => finaliseDialog(e)) : null,
      isFinal(e) ? item('🔍 Check seal', () => checkSeal(e)) : null,
      item('🗑 Delete this entry (kept in the record)', async () => {
        if (!confirm(`Delete “${pageTitle(e)}”? It is hidden but kept in the record and can be restored.`)) return;
        const who = await ctx.author(); if (!who) return;
        e.events.push({ t: Date.now(), author: who, what: 'deleted' }); L.note.activeEntry = liveEntries()[0]?.id || null; await save(); render();
      }),
      deleted.length ? item(`${L.showDeleted ? 'Hide' : 'Show'} deleted entries (${deleted.length})`, () => { L.showDeleted = !L.showDeleted; render(); }) : null,
      isDeleted(e) ? item('↺ Restore this entry', async () => { const who = await ctx.author(); if (!who) return; e.events.push({ t: Date.now(), author: who, what: 'restored' }); await save(); render(); }) : null,
    ));
    pop.hidden = false; const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 10)) + 'px'; pop.style.top = (r.bottom + 4) + 'px';
  }
  function changeLogDialog(e) {
    const rows = changeLog(e, { title: 'Title', date: 'Date' }).reverse();
    const csv = () => saveText('﻿' + [['time', 'author', 'section', 'what', 'how', 'note', 'text'], ...rows.map(r => [fmtTime(r.t), r.author, r.label, r.what, viaLabel(r.via), r.note, r.text])]
      .map(r => r.map(c => /[",\r\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\r\n'), `${safeName(pageTitle(e))} change log.csv`, 'text/csv');
    modal(`Change log: ${pageTitle(e)}`, h('div', {},
      h('p', { class: 'hint' }, `${rows.length} changes. Nothing is ever removed; each section's versions are under 🕘.`),
      h('table', { class: 'diag' }, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Author'), h('th', {}, 'Section'), h('th', {}, 'Change')),
        rows.map(r => h('tr', {}, h('td', {}, fmtTime(r.t)), h('td', {}, r.author), h('td', {}, r.label), h('td', {}, `${r.what}${r.via ? ' (' + viaLabel(r.via) + ')' : ''}${r.note ? ' — ' + r.note : ''}`)))),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: csv }, '⤓ Change log (CSV)'))));
  }

  async function newEntryDialog() {
    const note = await ensureNote(); if (!note) return;
    const d = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }), t = h('input', { type: 'text', placeholder: 'e.g. Antibiotics resistance' });
    const ty = h('select', {}, Object.entries(TYPES).map(([k, v]) => h('option', { value: k }, v)));
    modal('New assay entry', h('div', {},
      h('div', { class: 'form-grid' }, h('label', {}, 'Date'), d, h('label', {}, 'Title'), t, h('label', {}, 'Type'), ty),
      h('p', { class: 'hint' }, 'One entry = one Wikibench assay page, titled “date Assay title”. The type only chooses the starting sections; you can change it later.'),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: async () => {
        if (!t.value.trim()) { t.focus(); return toast('Give the entry a title', true); }
        const who = await ctx.author(); if (!who) return;
        const e = newEntry({ id: uid(), date: d.value, title: t.value.trim(), type: ty.value, author: who });
        note.entries.push(e); note.activeEntry = e.id; await save(); closeModal(); render();
      } }, 'Create'))));
    setTimeout(() => t.focus(), 50);
  }

  // ---------- export for the wiki ----------
  async function downloadAttachments(e) {
    const fs = filesOf(e.id);
    if (!fs.length) return toast('This entry has no attachments', true);
    if (fs.length === 1) return saveBlob(fs[0].blob, fs[0].name);
    const files = await Promise.all(fs.map(async f => ({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) })));
    saveBlob(zip(files), `${safeName(pageTitle(e))} attachments.zip`);
  }
  function wikiDialog(e) {
    const macro = ctx.attachmentsMacro(), w = entryToWiki(e, { attachmentsMacro: macro }), html = entryToHtml(e, { wikiUrl: ctx.wikiUrl }), fs = filesOf(e.id);
    const missing = w.files.filter(n => !fs.some(f => f.name === n));
    const copy = async (text, what, htmlText) => {
      try {
        if (htmlText) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([htmlText], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
        else await navigator.clipboard.writeText(text);
        toast(`${what} copied`);
      } catch { toast('Copying was blocked by the browser: select the text below and copy it', true); }
    };
    const study = L.note ? studyToWiki(L.note) : null;
    modal('Copy for the wiki (Wikibench)', h('div', { class: 'wiki-steps' },
      h('ol', {},
        h('li', {}, 'On your ', h('b', {}, 'Study'), ' page in the wiki, click ', h('b', {}, 'Create assay'), '. Page title: ', h('code', {}, w.title), ' ',
          h('button', { class: 'btn small', onclick: () => copy(w.title, 'Page title') }, '📋 Copy title')),
        h('li', {}, 'In the editor, click ', h('b', {}, '＋ (Insert more content) → Markup'), ', choose ', h('b', {}, 'Confluence wiki'), ', paste, then ', h('b', {}, 'Insert'), '. ',
          h('button', { class: 'btn small primary', onclick: () => copy(w.markup, 'Wiki markup') }, '📋 Copy wiki markup')),
        h('li', {}, fs.length ? [`Drag these files onto the page: they become its attachments, and the images and 📎 links in the text find them by name${macro ? '; the Attachments list at the bottom shows them' : ''}. `,
          h('button', { class: 'btn small', onclick: () => downloadAttachments(e) }, fs.length > 1 ? '⤓ Download all (.zip)' : '⤓ Download'),
          h('ul', {}, fs.map(f => h('li', {}, h('a', { href: fileUrl(f), download: f.name }, f.name))))] : 'No attachments to add.'),
        h('li', {}, h('b', {}, 'Save'), ' (Publish).')),
      missing.length ? h('div', { class: 'warn-box' }, `The text refers to ${missing.length} file(s) that are not attached: ${missing.join(', ')}.`) : null,
      h('details', {}, h('summary', {}, 'Show the wiki markup'), h('pre', { class: 'cmd wiki-pre' }, w.markup)),
      h('div', { class: 'hint-box' }, h('b', {}, 'Alternative: '), 'paste formatted text straight into the page body. Headings, lists, tables and links are kept, but links to attachments and the attachments list are not (use the markup for those). ',
        h('button', { class: 'btn small', onclick: () => copy(w.markup, 'Formatted text', html) }, '📋 Copy as formatted text')),
      L.note && (cur(L.note.study.fields.purpose).trim() || cur(L.note.study.fields.description).trim()) ? h('div', { class: 'hint-box' }, h('b', {}, 'Study page: '), `“${study.title}” purpose and description, for the Study page (Insert → Markup). `,
        h('button', { class: 'btn small', onclick: () => copy(study.markup, 'Study page markup') }, '📋 Copy study markup')) : null));
  }

  // ---------- chat integration ----------
  /** Context for the system prompt in Lab notebook mode. */
  function promptContext() {
    const e = activeEntry(), f = L.note?.study.fields;
    return {
      study: { title: f ? cur(f.title) : ctx.nb()?.name, purpose: f ? cur(f.purpose) : '' },
      entry: e ? { title: cur(e.fields.title), date: cur(e.fields.date), type: e.type, sections: Object.fromEntries(entrySections(e).map(k => [k, cur(e.fields[k])])) } : null,
      protocolsUsed: e?.protocolsUsed || [], library: ctx.protocols().promptList(), final: e ? isFinal(e) : false,
      sectionLabels: Object.fromEntries(Object.entries(SECTIONS).map(([k, v]) => [k, v.label])),
    };
  }
  const statusText = st => st ? ({ amended: `added as an amendment by ${st.author}`, accepted: `accepted by ${st.author}`, edited: `edited and accepted by ${st.author}`, auto: `applied automatically (${st.author})`, rejected: `rejected by ${st.author}` }[st.status] + `, ${fmtTime(st.t)}`) : 'proposed';
  /** Card for the k-th ```lab-note block of a chat message. */
  function card(m, k) {
    const p = parseLabUpdates(m.content)[k], box = h('div', { class: 'lab-card' });
    if (!p) return box;
    if (!p.ok) { box.append(h('div', { class: 'err-box' }, p.error)); return box; }
    const u = p.u, st = m.meta?.lab?.[k];
    const e = u.target === 'study' ? null : entryById(st?.entry || m.meta?.labEntry) || activeEntry();
    const label = u.target === 'study' ? `Study · ${STUDY_FIELDS[u.section].label}` : `${e ? pageTitle(e) : '(no entry)'} · ${SECTIONS[u.section]?.label || u.section}`;
    box.append(h('div', { class: 'lab-card-head' }, '📓 ', h('b', {}, label), h('small', {}, ` · ${u.op === 'replace' ? 'replace the section' : 'add to the section'}`), h('span', { class: 'grow' }),
      h('span', { class: 'status' + (st ? (st.status === 'rejected' ? ' err' : ' ok') : '') }, statusText(st))));
    const body = h('div', { class: 'lab-card-body' }, renderLabMd(st?.text ?? u.text, e?.id));
    box.append(body);
    if (u.op === 'replace' && !st) {
      const f = u.target === 'study' ? L.note?.study.fields[u.section] : e?.fields[u.section];
      if (cur(f).trim()) box.append(h('details', {}, h('summary', {}, 'Current text (kept as an earlier version if you accept)'), renderLabMd(cur(f), e?.id)));
    }
    if (!st) {
      const btns = h('div', { class: 'tp-btns' },
        h('button', { class: 'btn small primary', onclick: () => apply(m, k, u.text, 'accepted') }, '✓ Accept'),
        h('button', { class: 'btn small', onclick: () => {
          const ta = h('textarea', { class: 'lab-ta', rows: Math.max(4, u.text.split('\n').length + 1) }); ta.value = u.text;
          body.replaceWith(ta); btns.replaceWith(h('div', { class: 'tp-btns' }, h('button', { class: 'btn small primary', onclick: () => apply(m, k, ta.value, 'edited') }, '✓ Accept edited text'), h('button', { class: 'btn small', onclick: () => ctx.rerenderMessage(m) }, 'Cancel')));
          ta.focus();
        } }, '✎ Edit'),
        h('button', { class: 'btn small', onclick: () => decide(m, k, { status: 'rejected' }) }, '✕ Reject'));
      box.append(btns);
    }
    return box;
  }
  async function decide(m, k, st) {
    const who = await ctx.author(); if (!who) return false;
    (m.meta.lab ||= {})[k] = { ...st, t: Date.now(), author: who };
    await ctx.saveMessage(m); ctx.rerenderMessage(m); return true;
  }
  async function apply(m, k, text, how) {
    const p = parseLabUpdates(m.content)[k]; if (!p?.ok) return false;
    const u = p.u, note = await ensureNote(); if (!note) return false;
    const who = await ctx.author(); if (!who) return false;
    let field, e = null;
    if (u.target === 'study') field = note.study.fields[u.section];
    else {
      e = entryById(m.meta?.labEntry) || activeEntry();
      if (!e || isDeleted(e)) { toast('Create an assay entry first (＋ New assay in the Lab note pane)', true); return false; }
      if (isFinal(e)) {
        if (how === 'auto') { toast(`“${pageTitle(e)}” is finalised: accept the chat update as an amendment`, true); return false; }
        return amendmentDialog(e, { section: u.section, text, onSaved: async () => { (m.meta.lab ||= {})[k] = { status: 'amended', t: Date.now(), author: who, entry: e.id, section: u.section }; await ctx.saveMessage(m); ctx.rerenderMessage(m); } });
      }
      field = e.fields[u.section];
    }
    const next = u.op === 'append' ? appendText(cur(field), text) : text;
    revise(field, next, who, 'chat', `${how === 'auto' ? 'applied automatically' : how} from chat${m.meta?.model ? ' (' + m.meta.model + ')' : ''}`);
    (m.meta.lab ||= {})[k] = { status: how, t: Date.now(), author: who, entry: e?.id || null, section: u.section, ...(how === 'edited' ? { text } : {}) };
    await save(); await ctx.saveMessage(m); ctx.rerenderMessage(m); render();
    return true;
  }
  /** After an answer: apply its updates automatically if that option is on. */
  async function autoApply(m) {
    if (!ctx.autoApply()) return 0;
    const ups = parseLabUpdates(m.content); let n = 0;
    for (let k = 0; k < ups.length; k++) if (ups[k].ok && !m.meta?.lab?.[k]) n += (await apply(m, k, ups[k].u.text, 'auto')) ? 1 : 0;
    if (n) toast(`${n} lab note update(s) applied (versions kept: 🕘)`);
    return n;
  }
  /** Append Markdown to a section of the current entry (from a chat answer or a Thistle Plot result). */
  async function addToSection(section, md, note = '') {
    const e = activeEntry();
    if (!e || isDeleted(e)) { toast('Create an assay entry first (＋ New assay in the Lab note pane)', true); return false; }
    if (isFinal(e)) { await amendmentDialog(e, { section, text: md }); return true; }
    const who = await ctx.author(); if (!who) return false;
    revise(e.fields[section], appendText(cur(e.fields[section]), md), who, 'add', note);
    await save(); render(); toast(`Added to ${SECTIONS[section].label} (${pageTitle(e)})`);
    return true;
  }

  return { load, render, activeEntry, card, insertIntoEntry, autoApply, addToSection, addAttachments, promptContext, sections: () => (activeEntry() ? entrySections(activeEntry()) : Object.keys(TEMPLATES.wet)), _L: L };
}
