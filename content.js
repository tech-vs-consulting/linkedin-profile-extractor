// Isolated-world content script: gathers Voyager payloads, normalizes them,
// and falls back to the DOM for anything the JSON did not cover.

const captured = [];

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.__lpe !== 'voyager') return;
  captured.push(event.data.payload);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/* ------------------------------------------------------------------ *
 * Payload collection
 * ------------------------------------------------------------------ */

// LinkedIn ships the first render's Voyager responses inline, inside <code>
// elements, so a cold page load has data before any request is intercepted.
function embeddedPayloads(root = document) {
  const out = [];
  const nodes = root.querySelectorAll('code[id^="bpr-guid-"], code[id^="datalet-bpr-guid-"]');
  for (const node of nodes) {
    const text = node.textContent?.trim();
    if (!text || text[0] !== '{') continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      /* partial or non-JSON blob */
    }
  }
  return out;
}

// The profile page only renders the first handful of positions; the full list
// lives on the /details/ sub-pages. Fetching them same-origin is cheaper and
// quieter than opening tabs. The old Ember app embeds <code> blobs there; the
// React app server-renders the complete list as HTML, so keep the parsed
// documents too.
async function fetchDetailPages(paths) {
  const base = location.pathname.replace(/\/+$/, '');
  const result = { payloads: [], docs: {} };
  for (const path of paths) {
    try {
      const res = await fetch(`${base}/details/${path}/`, { credentials: 'include' });
      if (!res.ok) continue;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      result.docs[path] = doc;
      result.payloads.push(...embeddedPayloads(doc));
    } catch {
      /* offline, redirected to login, or rate limited */
    }
    await sleep(600);
  }
  return result;
}

function flattenIncluded(payloads) {
  const byUrn = new Map();
  const all = [];
  for (const payload of payloads) {
    const included = payload?.included ?? payload?.data?.included;
    if (!Array.isArray(included)) continue;
    for (const entity of included) {
      const urn = entity?.entityUrn;
      if (urn && byUrn.has(urn)) continue;
      if (urn) byUrn.set(urn, entity);
      all.push(entity);
    }
  }
  return { entities: all, byUrn };
}

const typeIs = (entity, suffix) =>
  typeof entity?.$type === 'string' && entity.$type.endsWith(suffix);

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

function largestArtifact(vectorImage) {
  const artifacts = vectorImage?.artifacts;
  if (!vectorImage?.rootUrl || !Array.isArray(artifacts) || !artifacts.length) return null;
  const best = artifacts.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
  const segment = best?.fileIdentifyingUrlPathSegment;
  return segment ? vectorImage.rootUrl + segment : null;
}

function pictureUrl(profile, byUrn) {
  const pic = profile?.profilePicture;
  if (!pic) return null;

  // Dash (current) shape.
  const direct = largestArtifact(pic.displayImageReference?.vectorImage);
  if (direct) return direct;

  // Legacy shapes: either an inline union or an urn pointing into `included`.
  const union = pic.displayImage?.['com.linkedin.common.VectorImage'];
  if (union) {
    const url = largestArtifact(union);
    if (url) return url;
  }
  if (typeof pic.displayImage === 'string') {
    const resolved = byUrn.get(pic.displayImage);
    const url = largestArtifact(resolved) || largestArtifact(resolved?.vectorImage);
    if (url) return url;
  }
  return largestArtifact(pic);
}

function normalizeDate(node) {
  if (!node) return null;
  const { month, year } = node;
  if (!year) return null;
  return {
    month: month ?? null,
    year,
    label: month ? `${String(month).padStart(2, '0')}/${year}` : String(year),
  };
}

function normalizeRange(entity) {
  // Dash uses `dateRange`, the older identity models use `timePeriod`.
  const range = entity.dateRange ?? entity.timePeriod;
  const start = normalizeDate(range?.start ?? range?.startDate);
  const end = normalizeDate(range?.end ?? range?.endDate);
  return { start, end, current: Boolean(start) && !end };
}

function sortByRecency(items) {
  const weight = (item) => {
    if (item.current) return Number.MAX_SAFE_INTEGER;
    const d = item.end ?? item.start;
    return d ? d.year * 12 + (d.month ?? 12) : -1;
  };
  return items.sort((a, b) => weight(b) - weight(a));
}

function normalizePositions(entities) {
  const seen = new Set();
  const positions = [];

  for (const entity of entities) {
    if (!typeIs(entity, '.Position')) continue;

    const title = clean(entity.title);
    const company = clean(entity.companyName ?? entity.company?.name);
    if (!title && !company) continue;

    const { start, end, current } = normalizeRange(entity);
    const key = [title, company, start?.label, end?.label].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    positions.push({
      title,
      company,
      companyUrn: entity.companyUrn ?? entity.company?.entityUrn ?? null,
      location: clean(entity.locationName ?? entity.geoLocationName),
      description: clean(entity.description),
      start,
      end,
      current,
      source: 'voyager',
    });
  }

  return sortByRecency(positions);
}

function normalizeEducation(entities) {
  const seen = new Set();
  const schools = [];

  for (const entity of entities) {
    if (!typeIs(entity, '.Education')) continue;
    const school = clean(entity.schoolName ?? entity.school?.name);
    if (!school) continue;

    const { start, end } = normalizeRange(entity);
    const key = [school, entity.degreeName, start?.label].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    schools.push({
      school,
      degree: clean(entity.degreeName),
      field: clean(entity.fieldOfStudy),
      start,
      end,
    });
  }

  return sortByRecency(schools);
}

function pickProfile(entities, slug) {
  const candidates = entities.filter(
    (e) => (typeIs(e, '.Profile') || typeIs(e, 'MiniProfile')) && (e.firstName || e.lastName)
  );
  if (!candidates.length) return null;
  return (
    candidates.find((e) => e.publicIdentifier && e.publicIdentifier === slug) ??
    candidates.find((e) => e.headline) ??
    candidates[0]
  );
}

/* ------------------------------------------------------------------ *
 * DOM fallback
 * ------------------------------------------------------------------ */

// Hashed class names rotate, but LinkedIn's typography utilities (t-bold,
// t-14, t-black--light) and the aria-hidden/visually-hidden text pairing have
// been stable for years. Anchor on those, plus section headings as a backstop.
function findSection(anchorId, labelPattern) {
  const anchored = document.getElementById(anchorId)?.closest('section');
  if (anchored) return anchored;

  for (const section of document.querySelectorAll('section')) {
    const heading = section.querySelector('h2');
    if (heading && labelPattern.test(clean(heading.textContent))) return section;
  }

  // Layouts with hashed classes may drop <section> entirely. Find the short
  // heading that names the card, then climb to the first ancestor that holds
  // actual content.
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')].filter(
    (h) => {
      const text = undouble(clean(h.textContent));
      return text.length < 40 && labelPattern.test(text);
    }
  );
  for (const heading of headings) {
    let el = heading.parentElement;
    for (let depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
      if (el.querySelector('li') || clean(el.innerText).length > 300) return el;
    }
  }
  return null;
}

const directItems = (list) => [...(list?.children ?? [])].filter((el) => el.tagName === 'LI');

// The entries live in the outermost <ul> of the section; nested lists hold the
// sub-roles of a grouped entry and must not be mistaken for entries.
function sectionItems(anchorId, labelPattern) {
  const section = findSection(anchorId, labelPattern);
  if (!section) return [];

  const lists = [...section.querySelectorAll('ul')].filter(
    (ul) => !ul.parentElement?.closest('ul')
  );
  const best = lists
    .map((ul) => directItems(ul))
    .sort((a, b) => b.length - a.length)[0];

  return best ?? [];
}

// Each visible string is rendered twice: once aria-hidden for sighted users,
// once visually-hidden for screen readers. Reading textContent concatenates
// them, so prefer the aria-hidden child and un-double whatever slips through.
function undouble(text) {
  const half = text.length / 2;
  if (text.length > 6 && text.length % 2 === 0 && text.slice(0, half) === text.slice(half)) {
    return text.slice(0, half);
  }
  return text;
}

function fieldText(root, selector) {
  const el = root.querySelector(selector);
  if (!el) return '';
  const inner = el.querySelector('span[aria-hidden="true"]');
  return undouble(clean((inner ?? el).textContent));
}

function fieldTexts(root, selector) {
  return [...root.querySelectorAll(selector)]
    .map((el) => undouble(clean((el.querySelector('span[aria-hidden="true"]') ?? el).textContent)))
    .filter(Boolean);
}

const MONTHS = {
  jan: 1, janv: 1, feb: 2, fev: 2, fevr: 2, mar: 3, mars: 3, apr: 4, avr: 4,
  may: 5, mai: 5, jun: 6, juin: 6, jul: 7, juil: 7, aug: 8, aout: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, dech: 12,
};

// "juil. 2025 - aujourd'hui · 1 an 3 mois" -> start 07/2025, current
function parseDateRange(raw) {
  if (!raw) return { start: null, end: null, current: false };

  const [span] = raw.split('·'); // drop the computed duration
  const [from, to] = span.split(/\s+[-–—]\s+/).map((s) => clean(s));

  const parsePoint = (text) => {
    if (!text) return null;
    const year = text.match(/\b(19|20)\d{2}\b/);
    if (!year) return null;
    const token = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ.]/g, '')
      .match(/[a-z]+/);
    const month = token ? (MONTHS[token[0].slice(0, 4)] ?? MONTHS[token[0].slice(0, 3)]) : null;
    return normalizeDate({ month: month ?? null, year: Number(year[0]) });
  };

  const current = /present|aujourd|actuel|en cours|to date/i.test(to ?? '');
  return { start: parsePoint(from), end: current ? null : parsePoint(to), current };
}

// A grouped entry (several roles at one employer) puts the company in the
// header and each role in a nested list; a plain entry puts the role first.
function parseExperienceItem(li) {
  const nestedLists = [...li.querySelectorAll('ul')].filter((ul) => directItems(ul).length);
  const subItems = nestedLists.flatMap(directItems);

  const header = li.cloneNode(true);
  for (const ul of header.querySelectorAll('ul')) ul.remove();

  const headBold = fieldText(header, '.t-bold');
  const headSubtitle = fieldText(header, 'span.t-14.t-normal:not(.t-black--light)');
  const headLight = fieldTexts(header, '.t-black--light');

  const describe = (root) => {
    const text = fieldText(root, '.inline-show-more-text, .pvs-entity__description');
    return text.replace(/\s*…?\s*(plus|more)$/i, '');
  };

  if (subItems.length) {
    const company = headBold;
    const employment = clean(headSubtitle.split('·')[0]);
    const groupLocation = headLight.find((t) => !hasYear(t)) ?? '';

    return subItems.map((sub) => {
      const light = fieldTexts(sub, '.t-black--light');
      const dates = light.find(hasYear) ?? '';
      return {
        title: fieldText(sub, '.t-bold'),
        company,
        companyUrn: null,
        location: light.find((t) => !hasYear(t)) || groupLocation,
        employmentType: employment,
        description: describe(sub),
        ...parseDateRange(dates),
        rawDates: dates,
        source: 'dom',
      };
    });
  }

  const dates = headLight.find(hasYear) ?? '';
  const [company, employment] = headSubtitle.split('·').map((s) => clean(s));

  return [
    {
      title: headBold,
      company: company ?? '',
      companyUrn: null,
      location: headLight.find((t) => !hasYear(t)) ?? '',
      employmentType: employment ?? '',
      description: describe(header),
      ...parseDateRange(dates),
      rawDates: dates,
      source: 'dom',
    },
  ];
}

const EXPERIENCE_LABEL = /^exp[ée]rience/i;
const EDUCATION_LABEL = /^(formation|education)/i;

function legacyPositions() {
  const positions = sectionItems('experience', EXPERIENCE_LABEL)
    .flatMap(parseExperienceItem)
    .filter((p) => p.title || p.company);
  return sortByRecency(positions);
}

function legacyEducation() {
  return sectionItems('education', EDUCATION_LABEL)
    .map((li) => {
      const light = fieldTexts(li, '.t-black--light');
      const dates = light.find((t) => /\b(19|20)\d{2}\b/.test(t)) ?? '';
      const school = fieldText(li, '.t-bold');
      if (!school) return null;

      const [degree, field] = fieldText(li, 'span.t-14.t-normal:not(.t-black--light)')
        .split(',')
        .map((s) => clean(s));

      return {
        school,
        degree: degree ?? '',
        field: field ?? '',
        ...parseDateRange(dates),
        rawDates: dates,
      };
    })
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * React (SDUI) layout
 * ------------------------------------------------------------------ */

// The React profile has hashed classes and no <ul> per entry. What survives
// deploys are the SDUI component keys, the plain <p> text nodes, the
// data-testid on descriptions, and the company links and logo labels.
const ENTRY_KEY = '[componentkey^="entity-collection-item"]';
const hasYear = (t) => /\b(19|20)\d{2}\b/.test(t);
const isDuration = (t) => /^\d+\s*(an|ans|mois|yr|yrs|year|years|mo|mos|month|months)\b/i.test(t);

function sduiEntries(root) {
  if (!root) return [];
  return [...root.querySelectorAll(ENTRY_KEY)].filter(
    (el) => !el.parentElement?.closest(ENTRY_KEY)
  );
}

// On a /details/ page the whole screen is one section; scope to it so asides
// such as "people also viewed" cannot leak entries in.
function detailScreen(doc, pattern) {
  return (
    [...doc.querySelectorAll('[data-sdui-screen]')].find((el) =>
      pattern.test(el.getAttribute('data-sdui-screen'))
    ) ?? doc.body
  );
}

// Media attachments ("Join the Enky Adventure") are external links that also
// wrap a <p>; only links back into LinkedIn can hold the entry's own lines.
const isInternalLink = (a) => {
  const href = a.getAttribute('href') ?? '';
  return !/^https?:\/\//.test(href) || /^https?:\/\/([a-z]+\.)?linkedin\.com\//.test(href);
};

// The entry's own lines sit in the first link that wraps <p> elements (the
// logo link wraps only a <figure>). Description, skills and media come after
// that block and must not be read as header lines.
function textLines(scope) {
  const block =
    [...scope.querySelectorAll('a')].find((a) => isInternalLink(a) && a.querySelector('p')) ??
    scope;
  const lines = [];
  for (const p of block.querySelectorAll('p')) {
    if (p.querySelector('[data-testid="expandable-text-box"]')) break;
    const text = clean(p.textContent);
    if (text) lines.push(text);
  }
  return lines;
}

// Classify by content rather than position: the date line is the one with a
// year, whatever order the rest comes in.
function splitLines(lines) {
  const [first = '', ...rest] = lines;
  const dates = rest.find(hasYear) ?? '';
  return { first, dates, others: rest.filter((line) => line !== dates) };
}

// The full description is in the DOM even while clamped to three lines; the
// "… plus" button only toggles CSS. Keep the author's line breaks.
function descriptionOf(scope) {
  const box = scope.querySelector('[data-testid="expandable-text-box"]');
  if (!box) return '';
  const copy = box.cloneNode(true);
  for (const button of copy.querySelectorAll('button')) button.remove();
  for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
  return copy.textContent
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function companyRef(scope) {
  const href = scope.querySelector('a[href*="/company/"]')?.getAttribute('href') ?? '';
  const id = href.match(/\/company\/([^/?#]+)/)?.[1] ?? null;
  return {
    companyUrl: id ? `https://www.linkedin.com/company/${id}/` : null,
    companyUrn: id && /^\d+$/.test(id) ? `urn:li:fsd_company:${id}` : null,
  };
}

// "Logo de Enky | Furniture Solutions" / "Enky logo": an accessibility label
// that names the company outright, used when the text line is missing.
function logoCompany(scope) {
  const node = scope.querySelector('img[alt], svg[aria-label]');
  const label = node?.getAttribute('alt') || node?.getAttribute('aria-label') || '';
  return clean(label.replace(/^logo\s+(de\s+|d[’']\s*)?/i, '').replace(/\s+logo$/i, ''));
}

// Grouped entry (several roles at one employer): the header names the
// company and each <li> of the nested list is a role. Plain entry: the
// header is the role itself.
function parseSduiExperience(entry) {
  const roles = [...entry.querySelectorAll('ul > li')].filter((li) => li.querySelector('p'));
  const header = entry.cloneNode(true);
  for (const ul of header.querySelectorAll('ul')) ul.remove();

  const head = splitLines(textLines(header));
  const ref = companyRef(entry);

  if (roles.length) {
    const [employment = ''] = (head.others[0] ?? '').split('·').map(clean);
    const groupLocation = head.others[1] ?? '';

    return roles.map((li) => {
      const role = splitLines(textLines(li));
      return {
        title: role.first,
        company: head.first || logoCompany(entry),
        ...ref,
        location: role.others[0] ?? groupLocation,
        employmentType: isDuration(employment) ? '' : employment,
        description: descriptionOf(li),
        ...parseDateRange(role.dates),
        rawDates: role.dates,
        source: 'dom',
      };
    });
  }

  const [companyName = '', employment = ''] = (head.others[0] ?? '').split('·').map(clean);
  return [
    {
      title: head.first,
      company: companyName || logoCompany(entry),
      ...ref,
      location: head.others[1] ?? '',
      employmentType: employment,
      description: descriptionOf(header),
      ...parseDateRange(head.dates),
      rawDates: head.dates,
      source: 'dom',
    },
  ];
}

function parseSduiEducation(entry) {
  const { first, dates, others } = splitLines(textLines(entry));
  if (!first) return null;
  const [degree = '', field = ''] = (others[0] ?? '').split(',').map(clean);
  return { school: first, degree, field, ...parseDateRange(dates), rawDates: dates };
}

function sduiPositions(root) {
  return sortByRecency(
    sduiEntries(root)
      .flatMap(parseSduiExperience)
      .filter((p) => p.title || p.company)
  );
}

function sduiEducation(root) {
  return sortByRecency(sduiEntries(root).map(parseSduiEducation).filter(Boolean));
}

/* ------------------------------------------------------------------ *
 * DOM entry points (both layouts)
 * ------------------------------------------------------------------ */

function domPositions() {
  const section = findSection('experience', EXPERIENCE_LABEL);
  const fromReact = sduiPositions(section);
  return fromReact.length ? fromReact : legacyPositions();
}

function domEducation() {
  const section = findSection('education', EDUCATION_LABEL);
  const fromReact = sduiEducation(section);
  return fromReact.length ? fromReact : legacyEducation();
}

function detailPositions(doc) {
  return doc ? sduiPositions(detailScreen(doc, /experience/i)) : [];
}

function detailEducation(doc) {
  return doc ? sduiEducation(detailScreen(doc, /education/i)) : [];
}

function experienceMounted() {
  const section = findSection('experience', EXPERIENCE_LABEL);
  return sduiEntries(section).length > 0 || sectionItems('experience', EXPERIENCE_LABEL).length > 0;
}

// The tab title is the one place the name survives every layout change:
// "(12) Marie Dupont | LinkedIn", sometimes with a trailing role after a dash.
function nameFromTitle() {
  const title = document.title.replace(/^\(\d+\+?\)\s*/, '');
  const [head] = title.split(/\s+\|\s+LinkedIn/);
  return clean(head?.split(/\s+[-–]\s+/)[0]);
}

// The React top card is a <section> holding the name heading followed by a
// run of <p> lines: degree, headline, location, contact link, followers...
function topCardLines(name) {
  if (!name) return [];
  const heading = [...document.querySelectorAll('h1, h2')].find(
    (h) => clean(h.textContent) === name
  );
  if (!heading) return [];

  let card = heading.closest('section');
  if (!card) {
    card = heading;
    for (let depth = 0; card.parentElement && depth < 6; depth += 1) card = card.parentElement;
  }
  return [...card.querySelectorAll('p')]
    .map((p) => clean(p.textContent))
    .filter((line) => line && line !== name);
}

const CARD_NOISE =
  /abonn|followers|relations|connections|coordonn|contact info|rendez-vous|message|suivre|follow|premium|^·/i;
const DEGREE = /^[·\s]*\d+\s*(er|e|nd|rd|th|st)?\b/i;

function topCardInfo(name) {
  const lines = topCardLines(name).filter((line) => !DEGREE.test(line));
  const headline = lines.find((line) => line.length >= 10 && !CARD_NOISE.test(line)) ?? '';

  // Location reads "City, Region, Country". It sits just before the contact
  // link when that is a <p>, otherwise it is the first comma-separated line
  // that is not the headline.
  const contactAt = lines.findIndex((line) => /coordonn|contact info/i.test(line));
  const beforeContact = contactAt > 0 ? lines[contactAt - 1] : '';
  const looksLikePlace = (line) =>
    line !== headline && line.includes(',') && line.length < 90 && !/[|@]/.test(line) && !CARD_NOISE.test(line);

  // "Paris, Île-de-France, France · Coordonnées" on a single line.
  const contactPrefix = clean((lines[contactAt] ?? '').split('·')[0]);
  const fromContact = /coordonn|contact info/i.test(contactPrefix) ? '' : contactPrefix;

  const location =
    (looksLikePlace(beforeContact) && beforeContact) ||
    fromContact ||
    lines.find(looksLikePlace) ||
    '';

  return { headline, location };
}

function domBasics() {
  const name =
    clean(document.querySelector('main h1')?.textContent) ||
    clean(document.querySelector('h1')?.textContent) ||
    nameFromTitle();

  const card = topCardInfo(name);
  const headline =
    clean(document.querySelector('main .text-body-medium')?.textContent) ||
    clean(document.querySelector('.text-body-medium.break-words')?.textContent) ||
    card.headline;

  const photoSelectors = [
    'main img.pv-top-card-profile-picture__image--show',
    'img.pv-top-card-profile-picture__image--show',
    'img.profile-photo-edit__preview',
    'button[aria-label*="photo" i] img',
  ];

  let photo = null;
  for (const selector of photoSelectors) {
    const src = document.querySelector(selector)?.src;
    if (src) {
      photo = src;
      break;
    }
  }

  // Last resort: the first CDN-hosted portrait whose alt text is the name.
  if (!photo && name) {
    photo =
      [...document.querySelectorAll('img[src*="media.licdn.com"]')].find((img) =>
        img.alt?.includes(name)
      )?.src ?? null;
  }

  return { name, headline, photo, location: card.location };
}

/* ------------------------------------------------------------------ *
 * Page preparation
 * ------------------------------------------------------------------ */

// LinkedIn mounts the profile sections only as they approach the viewport, and
// the mount happens after a round trip. Stopping when the page stops growing
// is therefore wrong: it exits before the fetch that adds the section lands.
// Scroll to the bottom, then keep waiting until the sections we need appear
// and the height holds steady.
// The document is not always what scrolls: a layout can put the overflow on an
// inner container, and then window.scrollBy silently does nothing. Collect
// every plausible scroller and drive them all rather than betting on one.
function scrollers() {
  const found = [document.scrollingElement ?? document.documentElement];

  for (const el of document.querySelectorAll('body *')) {
    if (el.scrollHeight <= el.clientHeight + 200) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') found.push(el);
  }

  return found
    .sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))
    .slice(0, 4);
}

async function revealLazyContent({ timeoutMs = 25_000 } = {}) {
  const targets = scrollers();
  const main = targets[0];
  const origin = main.scrollTop;
  const deadline = Date.now() + timeoutMs;

  let lastHeight = -1;
  let stableRounds = 0;
  let idleAtBottom = 0;

  while (Date.now() < deadline) {
    const height = main.scrollHeight;
    const atBottom = main.clientHeight + main.scrollTop >= height - 120;

    stableRounds = height === lastHeight ? stableRounds + 1 : 0;
    lastHeight = height;

    if (atBottom) {
      idleAtBottom += 1;
      const loaded = experienceMounted();
      // Either the content we came for is in, or nothing more is coming.
      if (loaded && stableRounds >= 2) break;
      if (idleAtBottom >= 12) break;
    } else {
      idleAtBottom = 0;
    }

    // A hidden or background tab can report a zero-height viewport; a step
    // derived from it alone would never move the page.
    const step = Math.max(600, Math.round((main.clientHeight || window.innerHeight) * 0.75));
    for (const target of targets) target.scrollTop += step;
    await sleep(400);
  }

  // Expand truncated descriptions, but never follow "show all" links: those
  // navigate away and would kill the extraction mid-flight.
  for (const button of document.querySelectorAll('.inline-show-more-text__button')) {
    try {
      button.click();
    } catch {
      /* detached node */
    }
  }

  await sleep(400);
  main.scrollTop = origin;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function currentSlug() {
  const match = location.pathname.match(/\/in\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function extract({ deep = true } = {}) {
  const slug = currentSlug();
  if (!slug) {
    return { ok: false, error: 'Cette page nest pas un profil LinkedIn (/in/...).' };
  }

  const payloads = [...captured, ...embeddedPayloads()];
  const detail = deep
    ? await fetchDetailPages(['experience', 'education'])
    : { payloads: [], docs: {} };
  payloads.push(...detail.payloads);

  const { entities, byUrn } = flattenIncluded(payloads);
  const profile = pickProfile(entities, slug);

  // 1. Typed Voyager entities (Ember app).
  let positions = normalizePositions(entities);
  let education = normalizeEducation(entities);

  // 2. Server-rendered /details/ pages (React app): complete lists, no
  //    scrolling, and immune to how far the profile page has mounted.
  if (!positions.length) positions = detailPositions(detail.docs.experience);
  if (!education.length) education = detailEducation(detail.docs.education);

  // 3. The profile page itself, once its lazy sections are mounted. Slowest
  //    path and capped to what the page shows, so only when the others failed.
  if (!positions.length || (!education.length && !detail.docs.education)) {
    await revealLazyContent();
    if (!positions.length) positions = domPositions();
    if (!education.length) education = domEducation();
  }

  const basics = domBasics();

  const name =
    clean([profile?.firstName, profile?.lastName].filter(Boolean).join(' ')) || basics.name;

  if (!name && !positions.length) {
    // Report what was actually reachable: "nothing found" alone gives the user
    // no way to tell a logged-out page from a layout change.
    const diagnostic = [
      `payloads=${payloads.length}`,
      `entites=${entities.length}`,
      `h1=${document.querySelector('h1') ? 'oui' : 'non'}`,
      `section#experience=${document.getElementById('experience') ? 'oui' : 'non'}`,
      `titre=${JSON.stringify(document.title.slice(0, 40))}`,
    ].join(' ');
    return { ok: false, error: `Aucune donnee lisible. [${diagnostic}]` };
  }

  const currentPosition = positions.find((p) => p.current) ?? positions[0] ?? null;

  return {
    ok: true,
    profile: {
      slug,
      url: `https://www.linkedin.com/in/${slug}/`,
      name,
      headline: clean(profile?.headline) || basics.headline,
      location: clean(profile?.locationName ?? profile?.geoLocationName) || basics.location,
      photo: pictureUrl(profile, byUrn) ?? basics.photo,
      currentTitle: currentPosition?.title ?? '',
      currentCompany: currentPosition?.company ?? '',
      positions,
      education,
      extractedAt: new Date().toISOString(),
      dataSource: positions[0]?.source ?? 'dom',
    },
  };
}

/* ------------------------------------------------------------------ *
 * Diagnostic
 * ------------------------------------------------------------------ */

// Strips what carries no structure (svg paths, inline styles, image sources)
// so the markup sample stays small enough to paste.
function compactHtml(el, limit) {
  if (!el) return null;
  const copy = el.cloneNode(true);
  for (const svg of copy.querySelectorAll('svg')) svg.replaceChildren();
  for (const node of copy.querySelectorAll('[style]')) node.removeAttribute('style');
  for (const img of copy.querySelectorAll('img')) {
    img.setAttribute('src', '');
    img.removeAttribute('srcset');
  }
  return copy.outerHTML.replace(/\s{2,}/g, ' ').slice(0, limit);
}

// Which application shell is serving this page: the authenticated Ember app
// (Voyager payloads available) or the logged-out guest page (ld+json only).
function probeShell() {
  const markup = document.documentElement.innerHTML;
  const main = document.querySelector('main');

  return {
    // The guest page has no notification counter; the class-based check only
    // recognises the old Ember navigation.
    signedIn:
      Boolean(document.querySelector('.global-nav__me, img.global-nav__me-photo')) ||
      [...document.querySelectorAll('h2')].some((h) => /notification/i.test(h.textContent)),
    scrollers: scrollers().map((el) => ({
      el: el === document.scrollingElement ? 'document' : el.tagName.toLowerCase(),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })),
    guestChrome: Boolean(
      document.querySelector('.nav__button-secondary, a[href*="/signup"], .authwall, .join-form')
    ),
    emberElements: document.querySelectorAll('[id^="ember"]').length,
    reactIdElements: [...document.querySelectorAll('[id]')].filter((el) =>
      el.id.startsWith('«')
    ).length,
    ldJsonSample: [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => s.textContent.slice(0, 500))
      .slice(0, 2),
    voyagerInMarkup: markup.includes('voyager/api'),
    pageMentionsExperience: /exp[ée]rience/i.test(document.body.innerText),
    allH2: [...document.querySelectorAll('h2')]
      .map((h) => clean(h.textContent).slice(0, 40))
      .filter(Boolean)
      .slice(0, 25),
    mainChildren: [...(main?.children ?? [])]
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className ?? '').slice(0, 50),
        text: clean(el.innerText).slice(0, 70),
      }))
      .slice(0, 15),
  };
}

// Reports what each source can actually see on this page, so a failure can be
// pinned on a specific layer instead of guessed at.
async function diagnose() {
  const intercepted = captured.length;
  const embedded = embeddedPayloads();
  const detail = await fetchDetailPages(['experience', 'education']);
  const { entities } = flattenIncluded([...captured, ...embedded, ...detail.payloads]);

  const typeCounts = {};
  for (const entity of entities) {
    const short = entity?.$type?.split('.').slice(-2).join('.');
    if (short) typeCounts[short] = (typeCounts[short] ?? 0) + 1;
  }

  const fromDetail = detailPositions(detail.docs.experience);
  const educationFromDetail = detailEducation(detail.docs.education);

  await revealLazyContent();
  const section = findSection('experience', EXPERIENCE_LABEL);
  const onPage = domPositions();

  const basics = domBasics();
  const needsTopCard = !basics.headline || !basics.location;
  const heading = [...document.querySelectorAll('h1, h2')].find(
    (h) => clean(h.textContent) === basics.name
  );

  return {
    ok: true,
    report: {
      url: location.href,
      shell: probeShell(),
      sources: {
        interceptedResponses: intercepted,
        embeddedCodeBlocks: embedded.length,
        totalEntities: entities.length,
        topTypes: Object.fromEntries(
          Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
        ),
      },
      detailPages: {
        experienceFetched: Boolean(detail.docs.experience),
        educationFetched: Boolean(detail.docs.education),
        experienceEntries: sduiEntries(
          detail.docs.experience && detailScreen(detail.docs.experience, /experience/i)
        ).length,
        positions: fromDetail.length,
        education: educationFromDetail.length,
        sample: fromDetail.slice(0, 3).map(summarize),
      },
      profilePage: {
        sectionFound: Boolean(section),
        entries: sduiEntries(section).length,
        positions: onPage.length,
        sample: onPage.slice(0, 3).map(summarize),
      },
      topCard: {
        name: basics.name,
        headline: basics.headline,
        location: basics.location,
        photo: Boolean(basics.photo),
        lines: topCardLines(basics.name).slice(0, 12),
      },
      // Raw markup only for the parts that failed, to keep the report short.
      experienceCardHtml:
        fromDetail.length || onPage.length ? undefined : compactHtml(section, 7000),
      topCardHtml: needsTopCard ? compactHtml(heading?.closest('section'), 5000) : undefined,
    },
  };
}

function summarize(position) {
  return {
    title: position.title,
    company: position.company,
    location: position.location,
    employmentType: position.employmentType,
    start: position.start?.label ?? null,
    end: position.current ? 'en cours' : (position.end?.label ?? null),
    companyUrl: position.companyUrl,
    description: position.description ? `${position.description.slice(0, 60)}...` : '',
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'LPE_PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'LPE_DIAGNOSE') {
    diagnose()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type !== 'LPE_EXTRACT') return false;
  extract(message.options ?? {})
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true; // keep the channel open for the async reply
});
