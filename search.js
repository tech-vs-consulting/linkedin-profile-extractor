// People search results page. Loaded right after content.js in the same
// isolated world, so it reuses its helpers: clean, sleep, captured,
// embeddedPayloads, flattenIncluded, typeIs, largestArtifact, scrollers.

const IN_HREF = /linkedin\.com\/in\/([^/?#]+)/;

const slugOfHref = (href) => {
  const match = String(href ?? '').match(IN_HREF);
  return match ? decodeURIComponent(match[1]) : null;
};

const DEGREE_TEXT = /(?:^|[\s•·])(1er|2e|3e\+?|1st|2nd|3rd\+?)(?=\s|$)/i;
const RESULT_NOISE =
  /^(se connecter|connect|message|suivre|follow|s'abonner|en attente|pending|envoyer|send|voir le profil|view .*profile|statut|status is|relation de|degree connection|•|·)/i;
// "… et 28 autres relations en commun", "… sont des relations que vous avez en commun".
const MUTUAL = /(en commun|mutual connection|abonnés?|followers)/i;
// The snippet LinkedIn adds under a hit, saying which position matched:
// "Poste actuel : … chez X" or "Postes précédents : … chez Y".
const SUMMARY = /^(postes?\s+)?(actuels?|current|passés?|précédents?|past|previous)\s*:/i;
const PAST_SUMMARY = /^(postes?\s+)?(passés?|précédents?|past|previous)\b/i;

const summaryKind = (summary) => (!summary ? '' : PAST_SUMMARY.test(summary) ? 'past' : 'current');

function degreeOf(text) {
  const raw = text?.match(DEGREE_TEXT)?.[1]?.toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('1')) return '1er';
  if (raw.startsWith('2')) return '2e';
  return '3e+';
}

// A past-position snippet names a former employer: only trust a current one.
function companyFrom(summary, headline) {
  const pattern = /(?:^|\s)(?:(?:chez|at)\s+|@\s*)([^|,·•–—(]+)/i;
  const fromSummary =
    summaryKind(summary) === 'current' ? clean(summary.replace(SUMMARY, '')).match(pattern)?.[1] : '';
  const fromHeadline = headline.match(pattern)?.[1];
  return clean(fromSummary || fromHeadline || '');
}

function card({ slug, name, headline = '', location = '', summary = '', photo = null, degree = '' }) {
  const cleanName = clean(name);
  const cleanSummary = clean(summary);
  return {
    slug,
    url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
    name: cleanName,
    firstName: cleanName.split(',')[0].trim().split(/\s+/)[0] ?? '',
    headline: clean(headline),
    location: clean(location),
    summary: cleanSummary,
    summaryKind: summaryKind(cleanSummary),
    company: companyFrom(cleanSummary, headline),
    photo,
    degree,
  };
}

/* ------------------------------------------------------------------ *
 * Voyager (Ember app): typed EntityResultViewModel entities
 * ------------------------------------------------------------------ */

function voyagerResults() {
  const { entities } = flattenIncluded([...captured, ...embeddedPayloads()]);
  const out = [];
  for (const entity of entities) {
    if (!typeIs(entity, 'EntityResultViewModel')) continue;
    const slug = slugOfHref(entity.navigationUrl);
    if (!slug) continue;
    const attribute = entity.image?.attributes?.[0]?.detailData;
    const picture =
      attribute?.nonEntityProfilePicture?.vectorImage ??
      attribute?.profilePicture?.profilePicture?.displayImageReference?.vectorImage;
    out.push(
      card({
        slug,
        name: entity.title?.text,
        headline: entity.primarySubtitle?.text,
        location: entity.secondarySubtitle?.text,
        summary: entity.summary?.text ?? '',
        photo: largestArtifact(picture),
        degree:
          degreeOf(entity.badgeText?.text) ||
          degreeOf(entity.entityCustomTrackingInfo?.memberDistance?.replace('DISTANCE_', '') + 'e'),
      })
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * DOM (React app): classes are hashed, so read structure and text only
 * ------------------------------------------------------------------ */

// A result is the ancestor of its profile link that sits in a list of
// siblings each holding their own /in/ link. That shape survives redesigns
// better than any class or data attribute.
function resultItem(link, root) {
  const tagged = link.closest(
    'li, [role="listitem"], [data-chameleon-result-urn], [data-view-name="search-entity-result-universal-template"]'
  );
  if (tagged && root.contains(tagged)) return tagged;

  let node = link;
  while (node.parentElement && node.parentElement !== root) {
    const siblings = [...node.parentElement.children];
    const withLinks = siblings.filter((el) => el.querySelector('a[href*="/in/"]'));
    if (siblings.length >= 3 && withLinks.length >= 3) return node;
    node = node.parentElement;
  }
  return null;
}

// Text grouped by its nearest block, in document order. Works on a laid-out
// page and on a DOMParser document alike (innerText needs layout).
function itemLines(item) {
  const lines = [];
  let lastBlock = null;
  // LinkedIn keeps hidden text next to what is shown (a "· 1er" beside the
  // visible "· 2e" badge): on a laid-out page, skip what has no box at all.
  const laidOut = (document.body?.getClientRects().length ?? 0) > 0;
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('.visually-hidden, .a11y-text, [hidden], button, svg')) continue;
    if (laidOut && parent.getClientRects().length === 0) continue;
    const text = clean(node.textContent);
    if (!text) continue;
    const block = parent.closest('p, div, li, h1, h2, h3, h4, a') ?? parent;
    if (block === lastBlock && lines.length) lines[lines.length - 1] += ` ${text}`;
    else lines.push(text);
    lastBlock = block;
  }
  return lines.map(clean).filter(Boolean);
}

function nameFromLinks(item, slug) {
  for (const a of item.querySelectorAll('a[href*="/in/"]')) {
    if (slugOfHref(a.href) !== slug) continue;
    const visible = a.querySelector('span[aria-hidden="true"]');
    const text = clean(visible?.textContent ?? '') || itemLines(a)[0] || '';
    const name = clean(text.replace(DEGREE_TEXT, ' ').replace(/[•·].*$/, ''));
    if (name && !/voir le profil|view .*profile/i.test(name)) return name;
  }
  return '';
}

function parseItem(item, slug) {
  const name = nameFromLinks(item, slug);
  const lines = itemLines(item);
  const degree = degreeOf(lines.join(' '));

  const summary = lines.find((line) => SUMMARY.test(line)) ?? '';
  const rest = lines
    .map((line) => (name && line.startsWith(name) ? clean(line.slice(name.length)) : line))
    .map((line) => clean(line.replace(/^[•·\s]*(1er|2e|3e\+?|1st|2nd|3rd\+?)\b\s*/i, '')))
    .filter(
      (line) =>
        line &&
        line !== name &&
        line.length > 1 &&
        !RESULT_NOISE.test(line) &&
        !MUTUAL.test(line) &&
        !SUMMARY.test(line)
    );

  return card({ slug, name, headline: rest[0] ?? '', location: rest[1] ?? '', summary, photo: photoOf(item, slug), degree });
}

const photoSrc = (img) => img.currentSrc || img.getAttribute('src') || img.getAttribute('data-delayed-url') || '';
const isPortrait = (src) => /media\.licdn\.com\/.*profile-displayphoto/.test(src);

// The person's own photo sits inside their own profile link. The card also
// shows the faces of mutual connections ("Julien et Guillaume sont des
// relations en commun"), linked elsewhere: taking the first portrait of the
// card gave someone else's face whenever the person's own had not loaded yet
// or did not exist. No photo beats a wrong one.
function photoOf(item, slug) {
  const own = [...item.querySelectorAll('a[href*="/in/"]')].filter((a) => slugOfHref(a.href) === slug);
  const portraits = own
    .flatMap((a) => [...a.querySelectorAll('img')])
    .filter((img) => isPortrait(photoSrc(img)))
    .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
  return portraits.length ? photoSrc(portraits[0]) : null;
}

function domResults(root = document.querySelector('main') ?? document.body) {
  const seenItems = new Set();
  const out = new Map();
  for (const link of root.querySelectorAll('a[href*="/in/"]')) {
    const slug = slugOfHref(link.href);
    if (!slug || out.has(slug)) continue;
    // Links inside an already-read result are mutual connections, not hits.
    if ([...seenItems].some((item) => item.contains(link))) continue;
    const item = resultItem(link, root);
    if (!item) continue;
    seenItems.add(item);
    out.set(slug, parseItem(item, slug));
  }
  return [...out.values()].filter((c) => c.name);
}

/* ------------------------------------------------------------------ *
 * Page state
 * ------------------------------------------------------------------ */

function pageState() {
  const text = document.body?.innerText ?? '';
  if (/\/(login|authwall|checkpoint)/.test(location.pathname)) return 'login';
  if (/limite d.utilisation commerciale|commercial use limit/i.test(text)) return 'commercial-limit';
  if (/aucun résultat|no results found/i.test(text)) return 'empty';
  return 'ok';
}

function totalResults() {
  const text = document.body?.innerText ?? '';
  const match =
    text.match(/(?:environ\s+)?([\d\s  .,]+)\s+résultats?/i) ?? text.match(/about\s+([\d,.]+)\s+results/i);
  const number = Number(match?.[1]?.replace(/[^\d]/g, ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

const pageNumber = () => Number(new URLSearchParams(location.search).get('page')) || 1;

// LinkedIn lists 10 people per results page.
const FULL_PAGE = 10;

// Out-of-network members: LinkedIn replaces the name with "Utilisateur
// LinkedIn" and gives the card no /in/ link at all (it points back to the
// search). They cannot be invited or messaged, so they are counted, not kept.
const ANONYMOUS = /^(utilisateur linkedin|linkedin member|membre linkedin)\b/i;

function hiddenProfiles(root = document.querySelector('main') ?? document.body) {
  let count = 0;
  for (const item of root.querySelectorAll('li, [role="listitem"]')) {
    if (item.querySelector('a[href*="/in/"]')) continue;
    if (item.parentElement?.closest('li, [role="listitem"]')) continue; // nested
    if (ANONYMOUS.test(itemLines(item)[0] ?? '')) count += 1;
  }
  return count;
}

// `page` is the page the worker navigated to: answering from the previous
// document (navigation not committed yet) would re-read the wrong results.
async function readSearchPage({ timeoutMs = 25_000, page } = {}) {
  if (page && pageNumber() !== Number(page)) {
    return { ok: true, state: 'stale', results: [], total: null, url: location.href };
  }

  const started = Date.now();
  const deadline = started + timeoutMs;
  let results = [];

  // Cards first, verdicts second: "Aucun résultat" can also appear in a filter
  // dropdown of a page that does list people.
  while (Date.now() < deadline) {
    // LinkedIn's data holds a full page at once, photos included: no need to
    // wait for the cards to render or to scroll for lazy images.
    const fromVoyager = voyagerResults();
    if (fromVoyager.length >= FULL_PAGE) {
      return {
        ok: true,
        state: 'ok',
        results: fromVoyager,
        hidden: hiddenProfiles(),
        total: totalResults(),
        source: 'voyager',
        url: location.href,
      };
    }

    results = fromVoyager.length ? fromVoyager : domResults();
    if (results.length + hiddenProfiles() >= 3) break;

    const state = pageState();
    if (state === 'login' || state === 'commercial-limit') {
      return { ok: true, state, results: [], total: null, url: location.href };
    }
    if (state === 'empty' && !results.length && !hiddenProfiles() && Date.now() - started > 6000) break;

    for (const target of scrollers()) target.scrollTop += 500;
    await sleep(800);
  }

  // One more pass to the bottom so lazy photos and the last cards mount.
  for (const target of scrollers()) target.scrollTop = target.scrollHeight;
  await sleep(1200);
  const fromVoyager = voyagerResults();
  const final = fromVoyager.length ? fromVoyager : domResults();
  if (final.length >= results.length) results = final;

  const hidden = hiddenProfiles();
  return {
    ok: true,
    state: results.length || hidden ? 'ok' : pageState(),
    results,
    hidden,
    total: totalResults(),
    source: fromVoyager.length ? 'voyager' : 'dom',
    url: location.href,
    // A page with no readable card is exactly the case we cannot debug
    // blind: ship what the page looked like back to the worker.
    debug: results.length || hidden ? undefined : pageSnapshot(),
  };
}

// What the reader saw: enough to tell an unrendered page, an interstitial and
// a layout change apart.
function pageSnapshot() {
  const main = document.querySelector('main');
  const root = main ?? document.body;
  const links = [...root.querySelectorAll('a[href*="/in/"]')];
  const firstItem = links[0] && resultItem(links[0], root);
  const text = clean(root?.innerText ?? '');
  return {
    url: location.href,
    title: document.title,
    visibility: document.visibilityState,
    readyState: document.readyState,
    state: pageState(),
    hasMain: Boolean(main),
    bodyTextLength: document.body?.innerText?.length ?? 0,
    mainText: text.slice(0, 800),
    profileLinks: links.length,
    distinctProfiles: new Set(links.map((a) => slugOfHref(a.href))).size,
    listItems: root.querySelectorAll('li, [role="listitem"]').length,
    hiddenProfiles: hiddenProfiles(root),
    capturedPayloads: captured.length,
    embeddedBlocks: embeddedPayloads().length,
    voyagerEntities: voyagerResults().length,
    firstItemFound: Boolean(firstItem),
    firstItemLines: firstItem ? itemLines(firstItem).slice(0, 15) : null,
    html: compactHtml(firstItem ?? root, 8000),
  };
}

async function diagnoseSearch() {
  const page = await readSearchPage({ timeoutMs: 10_000 });
  return {
    ok: true,
    report: {
      count: page.results.length,
      source: page.source,
      total: page.total,
      sample: page.results.slice(0, 3),
      ...pageSnapshot(),
    },
  };
}

// The filters set by hand in this search tab: its URL carries the codes, the
// filter bar shows readable names (a selected place reads "Lille,
// Hauts-de-France, France"), so hand both to the campaign form.
async function searchFilters() {
  const pills = [];
  for (const el of document.querySelectorAll('button, [role="button"], label')) {
    if (!el.getClientRects().length) continue;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const text = clean(el.innerText || el.textContent);
    if (top > 320 || !text || text.length > 80) continue; // the filter bar only
    if (!pills.includes(text)) pills.push(text);
  }
  return { ok: true, url: location.href, pills };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = {
    LPE_SEARCH_PAGE: readSearchPage,
    LPE_DIAGNOSE_SEARCH: diagnoseSearch,
    LPE_SEARCH_FILTERS: searchFilters,
  }[
    message?.type
  ];
  if (!handler) return false;
  handler(message.options ?? {})
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});
