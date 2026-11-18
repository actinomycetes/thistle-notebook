// "Suggest searches": ELM writes literature-database queries; the app only builds links.
// Nothing is fetched from these sites: a site receives the search words only when the user clicks its link
// (a normal browser navigation in a new tab, without referrer). connect-src stays limited to ELM.

export const SEARCH_DBS = {
  pubmed: { label: 'PubMed', url: (q, since) => `https://pubmed.ncbi.nlm.nih.gov/?term=${enc(q)}${since ? `&filter=years.${since}-${YEAR()}&sort=date` : ''}` },
  europepmc: { label: 'Europe PMC', url: (q, since) => `https://europepmc.org/search?query=${enc(since ? `(${q}) AND (PUB_YEAR:[${since} TO ${YEAR()}])` : q)}` },
  scholar: { label: 'Google Scholar', url: (q, since) => `https://scholar.google.com/scholar?q=${enc(q)}${since ? `&as_ylo=${since}` : ''}` },
  biorxiv: { label: 'bioRxiv / medRxiv', url: q => `https://www.biorxiv.org/search/${encodeURIComponent(q).replace(/%20/g, '+')}` },
};
const enc = s => encodeURIComponent(s).replace(/%20/g, '+');
const YEAR = () => new Date().getFullYear();
export const recentSince = () => YEAR() - 3;

/** Read the model's reply: a JSON array of {db, query, why}. Unknown databases and odd entries are dropped. */
export function parseSuggestions(text) {
  const t = String(text || ''), a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('The model did not return a list of searches.');
  let arr; try { arr = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error('Could not read the suggested searches: ' + e.message); }
  const out = (Array.isArray(arr) ? arr : []).map(x => ({ db: String(x?.db || '').toLowerCase().replace(/[^a-z]/g, ''), query: String(x?.query || '').trim().slice(0, 400), why: String(x?.why || '').trim().slice(0, 300) }))
    .map(x => ({ ...x, db: x.db === 'googlescholar' ? 'scholar' : x.db === 'medrxiv' ? 'biorxiv' : x.db }))
    .filter(x => SEARCH_DBS[x.db] && x.query);
  if (!out.length) throw new Error('The model did not suggest any usable searches.');
  return out.slice(0, 8);
}
