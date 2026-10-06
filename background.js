// Service worker: owns every long-running job (URL batch, campaign search,
// enrichment, Notion sync), the tabs they drive, and the stores they fill.

import * as db from './db.js';
import * as notion from './notion.js';
import * as sequence from './sequence.js';

const PROFILE_URL = /^https:\/\/www\.linkedin\.com\/in\//;
const SEARCH_URL = /^https:\/\/www\.linkedin\.com\/search\/results\//;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorText = (error) => String(error?.message ?? error);

let keepAliveTimer = null;

// An MV3 worker can be evicted while it waits between pages; touching a
// chrome API on a timer keeps it resident for the duration of a job.
function keepAlive(on) {
  clearInterval(keepAliveTimer);
  keepAliveTimer = on ? setInterval(() => chrome.runtime.getPlatformInfo(), 20_000) : null;
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

// One LinkedIn job at a time: two of them would double the request rate that
// LinkedIn watches. Notion sync touches no LinkedIn page and has its own lock.
let job = null;
let syncing = false;

async function exclusive(kind, fn) {
  await recovered;
  if (job) throw new Error('Un traitement est déjà en cours.');
  job = { kind, stop: false };
  keepAlive(true);
  try {
    return await fn(job);
  } finally {
    job = null;
    keepAlive(false);
  }
}

async function setStatus(status) {
  await chrome.storage.local.set({ status });
  // The popup and dashboard are often closed; a failed broadcast is expected.
  chrome.runtime.sendMessage({ type: 'LPE_STATUS', status }).catch(() => {});
}

const dataChanged = () => chrome.runtime.sendMessage({ type: 'LPE_DATA_CHANGED' }).catch(() => {});

// A job lives in this worker's memory only. If the browser slept, crashed or
// reloaded the extension mid-job, a fresh worker finds a "running" status that
// nothing will ever finish: settle it, and record where a search can resume.
const recovered = (async () => {
  const { status } = await chrome.storage.local.get('status');
  if (!status?.running) return;

  const page = (status.done ?? 0) + 1;
  const end =
    status.kind === 'search'
      ? `Interrompue pendant la page ${page} (navigateur fermé, mis en veille ou extension rechargée).`
      : 'Interrompu (navigateur fermé, mis en veille ou extension rechargée).';
  const stats = status.stats
    ? { ...status.stats, pages: status.done ?? 0, stoppedBy: end, end, resumePage: page }
    : status.stats;

  if (status.kind === 'search' && status.campaignId) {
    await db
      .update('campaigns', status.campaignId, (c) =>
        c ? { ...c, lastRun: { at: new Date().toISOString(), ...stats, error: null, debug: null } } : null
      )
      .catch(() => {});
  }
  // A search shows `stats.stoppedBy`; other jobs only have an error list.
  const errors = status.kind === 'search' ? status.errors ?? [] : [...(status.errors ?? []), { url: '', error: end }];
  await setStatus({ ...status, running: false, stats, errors });
})().catch(() => {});

// A constant interval is exactly what rate limiters look for; slow beats
// getting the account restricted.
const jitter = (base) => sleep(base + Math.random() * base * 0.5);

/* ------------------------------------------------------------------ *
 * Profiles (popup store)
 * ------------------------------------------------------------------ */

async function saveProfile(profile) {
  const { profiles = [] } = await chrome.storage.local.get('profiles');
  const index = profiles.findIndex((p) => p.slug === profile.slug);
  if (index >= 0) profiles[index] = profile;
  else profiles.unshift(profile);
  await chrome.storage.local.set({ profiles });
  // A profile extracted from the popup that is also a prospect enriches it.
  await db.attachProfile(profile.slug, profile);
  return profiles;
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

// A tab loaded before the extension was installed or reloaded has no content
// script; inject both worlds on demand rather than asking the user to refresh.
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'LPE_PING' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['injected.js'],
        world: 'MAIN',
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js', 'search.js', 'outreach.js'],
        world: 'ISOLATED',
      });
    } catch {
      // Already present but slow to answer the ping: re-running the file
      // throws on the redeclared top-level bindings, which is harmless here.
    }
    await sleep(300);
  }
}

function waitForLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timeout de chargement.'));
    }, timeoutMs);

    const listener = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function extractFromTab(tabId, options) {
  await ensureContentScript(tabId);
  const result = await chrome.tabs.sendMessage(tabId, { type: 'LPE_EXTRACT', options });
  if (!result?.ok) throw new Error(result?.error ?? 'Extraction sans reponse.');
  await saveProfile(result.profile);
  return result.profile;
}

async function extractFromUrl(url, options) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id);
    await sleep(2000); // let the SPA hydrate before reading
    return await extractFromTab(tab.id, options);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * URL batch (popup) and enrichment (dashboard)
 * ------------------------------------------------------------------ */

// `items` are { url, slug? }: with a slug, the extraction is attached to that
// prospect even when LinkedIn redirected an opaque /in/ACoA... URL to the
// vanity one.
function runBatch(kind, items, options) {
  return exclusive(kind, async (current) => {
    const errors = [];
    let done = 0;
    const label = kind === 'enrich' ? 'Enrichissement' : 'Profils';

    try {
      for (const item of items) {
        if (current.stop) break;
        await setStatus({ running: true, kind, label, done, total: items.length, current: item.url });
        try {
          const profile = await extractFromUrl(item.url, options);
          if (item.slug && item.slug !== profile.slug) await db.attachProfile(item.slug, profile);
          dataChanged();
        } catch (error) {
          errors.push({ url: item.url, error: errorText(error) });
        }
        done += 1;
        if (done < items.length && !current.stop) await jitter(options?.delayMs ?? 12_000);
      }
    } finally {
      await setStatus({ running: false, kind, label, done, total: items.length, errors });
    }

    autoSync();
    return { done, errors };
  });
}

/* ------------------------------------------------------------------ *
 * Campaign search
 * ------------------------------------------------------------------ */

const normalize = (s) =>
  ` ${String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+&]+/g, ' ')
    .trim()} `;

// A hit must name one of the campaign's titles as a whole word and none of its
// exclusions. The headline is what people write about their current job.
// "Postes précédents : …" means LinkedIn matched a past position only: with
// requireCurrent, that person no longer holds the role.
function matchCampaign(card, campaign) {
  const past = card.summaryKind === 'past';
  if (past && campaign.requireCurrent) return { ok: false, reason: 'past' };

  // Places typed by hand ("Lille", "Hauts-de-France"): the card's location
  // must name one of them. Read from each result, it needs no LinkedIn code.
  if (campaign.places?.length) {
    const location = normalize(card.location);
    if (!campaign.places.some((place) => location.includes(normalize(place)))) return { ok: false, reason: 'place' };
  }

  const haystack = normalize(`${card.headline} ${past ? '' : (card.summary ?? '')}`);
  const excluded = (campaign.exclusions ?? []).find((term) => haystack.includes(normalize(term)));
  if (excluded) return { ok: false, reason: 'exclusion' };
  if (!campaign.terms?.length) return { ok: true, term: '' };
  const term = campaign.terms.find((t) => haystack.includes(normalize(t)));
  return term ? { ok: true, term } : { ok: false, reason: 'titre' };
}

const termsQuery = (campaign) =>
  (campaign.terms ?? []).map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' OR ');

const ids = (list) => (list ?? []).map((item) => String(item?.id ?? item)).filter(Boolean);

function searchUrl(campaign, page) {
  const params = new URLSearchParams(campaign.extraParams ?? '');
  const terms = termsQuery(campaign);

  // With the title filter, the titles go to LinkedIn's "Titre" field (matched
  // against the position title only) instead of the free-text keywords.
  let keywords = campaign.keywords?.trim() || (campaign.titleFilter ? '' : terms);

  // Typed places also narrow LinkedIn's own search, so it does not return the
  // whole country page after page; the location check above keeps it exact.
  if (campaign.places?.length && campaign.placesInKeywords !== false && !campaign.keywords?.trim()) {
    const places = campaign.places.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' OR ');
    keywords = keywords ? `(${keywords}) AND (${places})` : places;
  }
  if (keywords) params.set('keywords', keywords);
  if (campaign.titleFilter && terms) params.set('titleFreeText', terms);

  const facets = {
    geoUrn: campaign.geo?.length ? campaign.geo : campaign.geoUrns,
    currentCompany: campaign.currentCompanies,
    pastCompany: campaign.pastCompanies,
    industry: campaign.industries,
    // F = 1st, S = 2nd, O = 3rd and beyond.
    network: campaign.network,
  };
  for (const [name, list] of Object.entries(facets)) {
    const values = ids(list);
    if (values.length) params.set(name, JSON.stringify(values));
  }

  params.set('origin', 'FACETED_SEARCH');
  if (page > 1) params.set('page', String(page));
  return `https://www.linkedin.com/search/results/people/?${params}`;
}

/* ------------------------------------------------------------------ *
 * Typeahead (places, companies, industries)
 * ------------------------------------------------------------------ */

// LinkedIn's own filter autocomplete. It needs the session's CSRF token, which
// only a linkedin.com page can read, so the call runs inside a LinkedIn tab.
const TYPEAHEAD = {
  geo: {
    type: 'GEO',
    extra:
      '&queryContext=List(geoVersion->3,bingGeoSubTypeFilters->MARKET_AREA|COUNTRY_REGION|ADMIN_DIVISION_1|CITY)',
    urn: /urn:li:(?:fs_|fsd_)?geo:(\d+)/,
  },
  company: {
    type: 'COMPANY',
    extra: '',
    urn: /urn:li:(?:fs_normalized_company|fsd_company|fs_miniCompany|company|organization):(\d+)/,
  },
  industry: { type: 'INDUSTRY', extra: '', urn: /urn:li:(?:fs_industry|fsd_industry|industry):(\d+)/ },
};

// Runs in the LinkedIn page (serialized by executeScript: no outer scope).
async function typeaheadInPage(type, keywords, extra) {
  const csrf = document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1];
  if (!csrf) return { ok: false, error: 'session LinkedIn introuvable, connecte-toi à LinkedIn.' };
  const url =
    `/voyager/api/typeahead/hitsV2?keywords=${encodeURIComponent(keywords)}` +
    `&origin=OTHER&q=type&type=${type}${extra}`;
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'csrf-token': csrf,
        accept: 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang': 'fr_FR',
      },
    });
    if (!response.ok) return { ok: false, error: `LinkedIn a répondu ${response.status}.` };
    return { ok: true, json: await response.json() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// The payload shape varies (normalized or not): take any node carrying a urn
// of the wanted kind together with a label.
function hitsFrom(json, pattern) {
  const found = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const urn = [node.targetUrn, node.objectUrn, node.entityUrn, node.urn, node.dashTargetUrn].find(
      (u) => typeof u === 'string' && pattern.test(u)
    );
    const label = [
      node.text?.text,
      node.title?.text,
      node.displayName,
      node.defaultLocalizedName,
      node.localizedName,
      node.name,
    ].find((l) => typeof l === 'string' && l.trim());
    if (urn && label) {
      const id = urn.match(pattern)[1];
      if (!found.has(id)) found.set(id, { id, label: label.trim() });
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(json);
  return [...found.values()].slice(0, 10);
}

let helperTab = null;
let helperTimer = null;

async function linkedinTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  const usable = tabs.find((t) => t.status === 'complete' && !t.discarded);
  if (usable) return usable.id;
  if (helperTab && (await chrome.tabs.get(helperTab).catch(() => null))) return helperTab;
  const tab = await chrome.tabs.create({ url: 'https://www.linkedin.com/search/results/people/', active: false });
  await waitForLoad(tab.id).catch(() => {});
  helperTab = tab.id;
  return tab.id;
}

async function typeahead(kind, query) {
  const config = TYPEAHEAD[kind];
  if (!config) throw new Error(`Type de recherche inconnu : ${kind}`);
  const tabId = await linkedinTabId();

  // A tab we opened only for this closes itself once typing stops.
  clearTimeout(helperTimer);
  helperTimer = setTimeout(() => {
    if (helperTab) chrome.tabs.remove(helperTab).catch(() => {});
    helperTab = null;
  }, 120_000);

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: typeaheadInPage,
    args: [config.type, query, config.extra],
  });
  const result = injection?.result;
  if (!result?.ok) {
    throw new Error(
      `Suggestions LinkedIn indisponibles (${result?.error ?? 'pas de réponse'}). ` +
        'Utilise « Récupérer depuis mon onglet LinkedIn ».'
    );
  }
  return hitsFrom(result.json, config.urn);
}

const STOP_REASONS = {
  login: 'LinkedIn demande de se connecter.',
  'commercial-limit': 'Limite d’utilisation commerciale de la recherche atteinte.',
};

const HIDDEN_STREAK_MAX = 3;

// LinkedIn never serves people results past page 100 (about 1,000 people),
// whatever total it announces: asking for page 101 only burns a request.
const LINKEDIN_MAX_PAGES = 100;

const pageOf = (url) => {
  try {
    return Number(new URL(url).searchParams.get('page')) || 1;
  } catch {
    return 0;
  }
};

// Resolves once the tab has committed to results page `page`. A bare
// status === 'complete' is not enough: it can belong to the previous document,
// and LinkedIn pages sometimes never reach 'complete' in a background tab.
async function openSearchPage(tab, url, page, timeoutMs = 45_000) {
  const onPage = (t) => SEARCH_URL.test(t?.url ?? '') && pageOf(t.url) === page;

  const settled = new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info, updated) {
      if (id === tab?.id && info.status === 'complete' && onPage(updated)) done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  if (tab) await chrome.tabs.update(tab.id, { url });
  else tab = await chrome.tabs.create({ url, active: false });
  await settled;

  const current = await chrome.tabs.get(tab.id);
  if (!onPage(current)) {
    const where = current.url ? new URL(current.url).pathname : '?';
    throw new Error(`la page ${page} ne s'est pas chargée (onglet sur ${where}).`);
  }
  return tab;
}

// `startPage` resumes a run that was cut short (stopped, interrupted, failed
// page): results shift over time, so it is only offered for a recent run.
function runSearch(campaignId, startPage = 1) {
  return exclusive('search', async (current) => {
    const campaign = await db.get('campaigns', campaignId);
    if (!campaign) throw new Error('Campagne introuvable.');

    const maxPages = Math.min(Math.max(Number(campaign.maxPages) || 10, 1), LINKEDIN_MAX_PAGES);
    const firstPage = Math.min(Math.max(Number(startPage) || 1, 1), maxPages);
    const stats = {
      pages: 0,
      seen: 0,
      added: 0,
      known: 0,
      skipped: 0,
      past: 0, // skipped because the title only matched a past position
      place: 0, // skipped because located outside the typed places
      hidden: 0, // anonymised out-of-network members, not stored
      total: null,
      startPage: firstPage,
      stoppedBy: null, // abnormal stop, shown as a warning
      end: null, // why the run ended, always set
      resumePage: null, // first unread page when the run was cut short
    };
    const errors = [];
    const label = `Recherche « ${campaign.name} »`;
    // campaignId lets a worker restart record where a dead run stopped.
    const status = (running) => ({ running, kind: 'search', campaignId, label, total: maxPages, stats });
    let tab = null;
    let debug = null; // snapshot of the last page that yielded no card
    let hiddenStreak = 0;
    let page = firstPage;

    // One page, up to two attempts: a page that has not rendered yet or a
    // slow navigation must not be mistaken for the end of the results.
    async function readPage(page) {
      let problem = null;
      let empty = null;
      debug = null;
      for (let attempt = 1; attempt <= 2 && !current.stop; attempt += 1) {
        try {
          tab = await openSearchPage(tab, searchUrl(campaign, page), page);
          // The reader polls until the cards are there: no long fixed wait.
          await sleep(500);
          await ensureContentScript(tab.id);
          const result = await chrome.tabs.sendMessage(tab.id, { type: 'LPE_SEARCH_PAGE', options: { page } });
          if (!result?.ok) throw new Error(result?.error ?? 'pas de réponse du content script.');
          if (result.state === 'stale') throw new Error('la page lue n’était pas encore la bonne.');
          if (result.results.length || result.hidden || STOP_REASONS[result.state]) return { result };
          if (result.state === 'empty') empty = result;
          debug = result.debug ?? null;
          problem = 'aucune carte de résultat lisible.';
        } catch (error) {
          problem = errorText(error);
          // The user may have closed the background tab: start a fresh one.
          if (tab && !(await chrome.tabs.get(tab.id).catch(() => null))) tab = null;
        }
        if (attempt < 2) await sleep(6000);
      }
      // Twice "no results" with no card at all: that is the real end.
      return empty ? { result: empty } : { problem };
    }

    const stopHere = () => {
      stats.end = 'Arrêtée à la demande.';
      stats.resumePage = page;
    };

    try {
      for (; page <= maxPages; page += 1) {
        if (current.stop) {
          stopHere();
          break;
        }
        await setStatus({ ...status(true), done: page - 1 });

        const { result, problem } = await readPage(page);
        if (current.stop && !result) {
          stopHere();
          break;
        }

        stats.total ??= result?.total ?? null;
        const pastTheEnd = stats.total && (page - 1) * 10 >= stats.total;

        if (!result) {
          if (pastTheEnd) {
            stats.end = `Fin des résultats (${stats.total} selon LinkedIn).`;
          } else {
            stats.stoppedBy = `Page ${page} : ${problem}`;
            stats.end = stats.stoppedBy;
            stats.resumePage = page;
          }
          break;
        }
        if (STOP_REASONS[result.state]) {
          stats.stoppedBy = STOP_REASONS[result.state];
          stats.end = stats.stoppedBy;
          stats.resumePage = page;
          break;
        }
        if (!result.results.length && !result.hidden) {
          stats.end = `Fin des résultats : LinkedIn n’affiche rien en page ${page}.`;
          break;
        }

        stats.pages = page;
        stats.hidden += result.hidden ?? 0;

        // Past a few pages of nothing but anonymised members, the rest of the
        // results are almost surely the same: stop before burning search quota.
        hiddenStreak = result.results.length ? 0 : hiddenStreak + 1;
        if (hiddenStreak >= HIDDEN_STREAK_MAX) {
          stats.end = `Arrêt : ${HIDDEN_STREAK_MAX} pages de suite sans profil visible (membres hors réseau masqués par LinkedIn).`;
          break;
        }

        for (const card of result.results) {
          stats.seen += 1;
          const match = matchCampaign(card, campaign);
          if (!match.ok) {
            stats.skipped += 1;
            if (match.reason === 'past') stats.past += 1;
            if (match.reason === 'place') stats.place += 1;
            continue;
          }
          const added = await db.upsertFound({ ...card, matchedTerm: match.term }, campaign.id);
          if (added) stats.added += 1;
          else stats.known += 1;
        }
        dataChanged();

        if (page === maxPages) {
          const moreOnLinkedIn = maxPages === LINKEDIN_MAX_PAGES && (!stats.total || stats.total > maxPages * 10);
          stats.end = moreOnLinkedIn
            ? `Limite LinkedIn atteinte : ${LINKEDIN_MAX_PAGES} pages (≈ 1 000 résultats) au maximum par recherche. ` +
              'Pour aller plus loin, découpe la campagne (par lieu, titre, secteur…).'
            : `Nombre de pages max atteint (${maxPages}).`;
        } else if (!current.stop) await jitter(Number(campaign.delayMs) || 15_000);
      }
    } catch (error) {
      errors.push({ url: '', error: errorText(error) });
      stats.end = `Erreur : ${errorText(error)}`;
      stats.resumePage = page;
    } finally {
      if (tab) chrome.tabs.remove(tab.id).catch(() => {});
      await db.update('campaigns', campaign.id, (c) =>
        c
          ? {
              ...c,
              lastRun: {
                at: new Date().toISOString(),
                ...stats,
                error: errors[0]?.error ?? null,
                debug: stats.stoppedBy ? debug : null,
              },
            }
          : null
      );
      await setStatus({ ...status(false), done: stats.pages, errors });
      dataChanged();
    }

    autoSync();
    return { stats, errors };
  });
}

/* ------------------------------------------------------------------ *
 * Notion
 * ------------------------------------------------------------------ */

async function runSync() {
  if (syncing) throw new Error('Synchronisation déjà en cours.');
  syncing = true;
  try {
    const result = await notion.sync();
    dataChanged();
    chrome.runtime.sendMessage({ type: 'LPE_SYNC_DONE', result }).catch(() => {});
    return result;
  } catch (error) {
    const { notion: settings } = await chrome.storage.local.get('notion');
    if (settings) await chrome.storage.local.set({ notion: { ...settings, lastError: errorText(error) } });
    throw error;
  } finally {
    syncing = false;
  }
}

async function autoSync() {
  const { notion: settings } = await chrome.storage.local.get('notion');
  if (!settings?.autoSync || !settings.token || !settings.databaseId) return;
  runSync().catch(() => {}); // the error is stored in settings.lastError
}

// Recreating the alarm on every worker start would keep pushing it back.
chrome.alarms.get('lpe-sync').then((alarm) => {
  if (!alarm) chrome.alarms.create('lpe-sync', { periodInMinutes: 15 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'lpe-sync' && !syncing) autoSync();
});

/* ------------------------------------------------------------------ *
 * Outreach (semi-automatic: the page is prepared, the user sends)
 * ------------------------------------------------------------------ */

// Jobs by tab id, mirrored to session storage: the worker can be evicted while
// the user reads the note, and the send event must still find its job.
const outreachJobs = new Map();

async function loadJobs() {
  if (outreachJobs.size) return;
  const { outreachJobs: saved = {} } = await chrome.storage.session.get('outreachJobs');
  for (const [tabId, job] of Object.entries(saved)) outreachJobs.set(Number(tabId), job);
}

const saveJobs = () =>
  chrome.storage.session.set({ outreachJobs: Object.fromEntries(outreachJobs) }).catch(() => {});

const outreachStatus = (status) =>
  chrome.runtime.sendMessage({ type: 'LPE_OUTREACH_STATUS', ...status }).catch(() => {});

async function applySent(job, { withNote = true } = {}) {
  const prospect = await db.get('prospects', job.slug);
  if (!prospect) return;
  const campaign = prospect.campaignId ? await db.get('campaigns', prospect.campaignId) : null;
  const patch = sequence.sentPatch(prospect, campaign, { ...job, withNote });
  await db.editProspect(job.slug, patch);
  dataChanged();
}

async function startOutreach({ slug, action, step, text }, sender) {
  const prospect = await db.get('prospects', slug);
  if (!prospect) throw new Error('Prospect introuvable.');
  await loadJobs();

  const url = prospect.profileUrl || prospect.url;
  const vanity = String(url).match(/\/in\/([^/?#]+)/)?.[1] ?? null;
  const tab = await chrome.tabs.create({
    url,
    active: true,
    index: sender?.tab ? sender.tab.index + 1 : undefined,
    openerTabId: sender?.tab?.id,
  });

  outreachJobs.set(tab.id, {
    slug,
    action,
    step,
    text,
    name: prospect.name,
    vanity: vanity ? decodeURIComponent(vanity) : null,
    returnTabId: sender?.tab?.id ?? null,
    triedPreload: false,
    startedAt: Date.now(),
  });
  await saveJobs();
  return { tabId: tab.id };
}

// "Envoyer" was pressed and this tab then loaded a new page before the old one
// could confirm: the send went through.
const SENDING_WINDOW_MS = 30_000;

async function finishSent(tabId, job, withNote) {
  if (!outreachJobs.has(tabId)) return; // already finished by the other path
  outreachJobs.delete(tabId);
  await saveJobs();
  await applySent(job, { withNote });
  outreachStatus({ slug: job.slug, name: job.name, action: job.action, kind: 'sent', withNote });
  // Opened from the dashboard: close the LinkedIn tab and go back to the
  // queue. Started from the panel on the page: the user stays where they are.
  if (job.fromPage) return;
  setTimeout(async () => {
    await chrome.tabs.remove(tabId).catch(() => {});
    if (job.returnTabId) chrome.tabs.update(job.returnTabId, { active: true }).catch(() => {});
  }, 1200);
}

/* ---- panel on LinkedIn profiles ---- */

// The page's vanity slug first, then member ids (ACoA...) seen in the page:
// people found through search are often keyed by the latter.
async function findProspect(candidates = []) {
  for (const key of candidates) {
    const prospect = await db.get('prospects', key);
    if (prospect) return prospect;
  }
  const vanity = candidates[0];
  if (!vanity) return null;
  const all = await db.getAll('prospects');
  return all.find((p) => (p.profileUrl ?? '').includes(`/in/${vanity}/`)) ?? null;
}

// Texts ready to send for this person: the campaign's note, and the message
// step that is due (or the next one in the sequence).
function textsFor(prospect, campaign) {
  const plan = sequence.sequenceOf(campaign);
  const invite = sequence.render(plan.invite?.note ?? '', prospect).text.slice(0, sequence.NOTE_LIMIT);
  const next = sequence.nextAction(prospect, campaign);
  let step = next?.action === 'message' ? next.step : Math.max(0, (prospect.sequenceStep ?? -1) + 1);
  step = Math.min(step, plan.steps.length - 1);
  const body = plan.steps[step];
  return {
    invite,
    message: body ? { step, label: body.label, text: sequence.render(body.body, prospect).text } : null,
    next: next ? { action: next.action, label: next.label, dueOn: next.dueOn } : null,
  };
}

const vanityOf = (candidates) => candidates?.find((c) => c && !/^ACoA/.test(c)) ?? null;

// Remember the vanity URL of someone keyed by a member id, so the dashboard
// opens the right page next time.
async function linkVanity(prospect, candidates) {
  const vanity = vanityOf(candidates);
  if (!prospect || !vanity || prospect.profileUrl) return;
  await db.editProspect(prospect.slug, { profileUrl: `https://www.linkedin.com/in/${vanity}/` });
}

async function pageInfo({ candidates, name, photo }) {
  const prospect = await findProspect(candidates);
  await linkVanity(prospect, candidates);
  // The profile page shows the right face: fix one taken from a search card.
  if (prospect && photo && photo !== prospect.photo) {
    await db.editProspect(prospect.slug, { photo });
    dataChanged();
  }
  const campaign = prospect?.campaignId ? await db.get('campaigns', prospect.campaignId) : null;
  const subject = prospect ?? { name, firstName: db.firstNameOf(name) };
  return {
    prospect: prospect
      ? { slug: prospect.slug, name: prospect.name, status: prospect.status, degree: prospect.degree, campaign: campaign?.name ?? null }
      : null,
    statuses: db.STATUSES,
    ...textsFor(subject, campaign),
  };
}

// Someone met on LinkedIn without a search: add them as a prospect.
async function ensureProspect({ candidates, name, headline }) {
  const existing = await findProspect(candidates);
  if (existing) return existing;
  const slug = vanityOf(candidates) ?? candidates?.[0];
  if (!slug) throw new Error('Profil LinkedIn introuvable sur cette page.');
  await db.upsertFound(
    {
      slug,
      url: `https://www.linkedin.com/in/${slug}/`,
      name: name ?? '',
      firstName: db.firstNameOf(name),
      headline: headline ?? '',
      company: '',
      location: '',
      photo: null,
      degree: '',
    },
    null
  );
  dataChanged();
  return db.get('prospects', slug);
}

async function pageStart({ action, candidates, name, headline }, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) throw new Error('Onglet introuvable.');
  await loadJobs();
  const prospect = await ensureProspect({ candidates, name, headline });
  await linkVanity(prospect, candidates);
  const campaign = prospect.campaignId ? await db.get('campaigns', prospect.campaignId) : null;
  const texts = textsFor(prospect, campaign);
  if (action === 'message' && !texts.message) throw new Error('La séquence de cette campagne n’a aucun message.');

  const job = {
    slug: prospect.slug,
    action,
    step: action === 'invite' ? -1 : texts.message.step,
    text: action === 'invite' ? texts.invite : texts.message.text,
    name: prospect.name || name,
    vanity: vanityOf(candidates),
    returnTabId: null,
    fromPage: true,
    triedPreload: false,
    startedAt: Date.now(),
  };
  outreachJobs.set(tabId, job);
  await saveJobs();
  return { job };
}

async function pageSetStatus({ candidates, name, headline, status }) {
  if (!db.STATUSES.includes(status)) throw new Error('Statut inconnu.');
  const prospect = await ensureProspect({ candidates, name, headline });
  const patch = { status };
  if (status === 'Connecté') Object.assign(patch, { degree: '1er', connectedAt: new Date().toISOString().slice(0, 10) });
  // A wrong "1er" would keep sending this person to the message queue.
  else if (prospect.degree === '1er' && (status === 'Nouveau' || status === 'Invité')) patch.degree = '';
  await db.editProspect(prospect.slug, patch);
  dataChanged();
  return {};
}

async function outreachEvent({ kind, withNote, patch, snapshot, truncated }, sender) {
  await loadJobs();
  const tabId = sender?.tab?.id;
  const job = outreachJobs.get(tabId);
  if (!job) return {};

  const base = { slug: job.slug, name: job.name, action: job.action };

  if (kind === 'progress') {
    Object.assign(job, patch);
    await saveJobs();
    return {};
  }

  // A message was prepared for someone who is not a relation (accepted by
  // mistake, or a wrong degree): turn it into an invitation with the note.
  if (kind === 'not-connected') {
    const prospect = await db.get('prospects', job.slug);
    const campaign = prospect?.campaignId ? await db.get('campaigns', prospect.campaignId) : null;
    const note = sequence.render(sequence.sequenceOf(campaign).invite?.note ?? '', prospect ?? {}).text;
    Object.assign(job, { action: 'invite', step: -1, text: note.slice(0, sequence.NOTE_LIMIT) });
    await saveJobs();
    await db.editProspect(job.slug, {
      status: 'Nouveau',
      degree: prospect?.degree === '1er' ? '' : prospect?.degree,
      connectedAt: null,
    });
    dataChanged();
    outreachStatus({ ...base, kind: 'not-connected' });
    return { job };
  }

  if (kind === 'sending') {
    job.sendingAt = Date.now();
    job.withNote = withNote;
    await saveJobs();
    return {};
  }

  if (kind === 'not-sent') {
    delete job.sendingAt;
    await saveJobs();
    return {};
  }

  if (kind === 'sent') {
    await finishSent(tabId, job, withNote);
    return {};
  }

  if (kind === 'already-connected' || kind === 'already-invited') {
    outreachJobs.delete(tabId);
    await saveJobs();
    const status = kind === 'already-connected' ? 'Connecté' : 'Invité';
    const today = new Date().toISOString().slice(0, 10);
    await db.editProspect(job.slug, kind === 'already-connected' ? { status, degree: '1er', connectedAt: today } : { status });
    dataChanged();
  }

  if (kind === 'cancel') {
    outreachJobs.delete(tabId);
    await saveJobs();
  }

  outreachStatus({ ...base, kind, truncated, snapshot });
  return {};
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadJobs();
  if (outreachJobs.delete(tabId)) saveJobs();
});

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

async function activeTab(pattern, message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !pattern.test(tab.url)) throw new Error(message);
  return tab;
}

const handlers = {
  async LPE_EXTRACT_ACTIVE({ options }) {
    const tab = await activeTab(PROFILE_URL, 'Ouvre un profil linkedin.com/in/... dans cet onglet.');
    return { profile: await extractFromTab(tab.id, options) };
  },

  async LPE_DIAGNOSE_ACTIVE() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onSearch = SEARCH_URL.test(tab?.url ?? '');
    if (!onSearch && !PROFILE_URL.test(tab?.url ?? '')) {
      throw new Error('Ouvre un profil ou une page de recherche LinkedIn dans cet onglet.');
    }
    await ensureContentScript(tab.id);
    const type = onSearch ? 'LPE_DIAGNOSE_SEARCH' : 'LPE_DIAGNOSE';
    const result = await chrome.tabs.sendMessage(tab.id, { type });
    if (!result?.ok) throw new Error(result?.error ?? 'Diagnostic sans reponse.');
    return { report: result.report };
  },

  async LPE_RUN_BATCH({ urls, options }) {
    const cleaned = [...new Set(urls.map((u) => u.trim()).filter((u) => PROFILE_URL.test(u)))];
    if (!cleaned.length) throw new Error('Aucune URL de profil valide.');
    return runBatch('batch', cleaned.map((url) => ({ url })), options);
  },

  async LPE_ENRICH({ slugs, options }) {
    const prospects = (await Promise.all(slugs.map((slug) => db.get('prospects', slug)))).filter(Boolean);
    if (!prospects.length) throw new Error('Aucun prospect sélectionné.');
    return runBatch(
      'enrich',
      prospects.map((p) => ({ url: p.url, slug: p.slug })),
      { deep: true, ...options }
    );
  },

  async LPE_SEARCH_RUN({ campaignId, startPage }) {
    return runSearch(campaignId, startPage);
  },

  async LPE_JOB_STOP() {
    await recovered;
    if (job) job.stop = true;
    return { stopping: Boolean(job) };
  },

  // Sent by the dashboard when it finds a "running" status: waking the worker
  // is enough to settle a run that died with the previous worker.
  async LPE_JOB_CHECK() {
    await recovered;
    return { running: Boolean(job) };
  },

  async LPE_OUTREACH_START(message, sender) {
    return startOutreach(message, sender);
  },

  async LPE_OUTREACH_PENDING(_message, sender) {
    await loadJobs();
    const tabId = sender?.tab?.id;
    const job = outreachJobs.get(tabId);
    if (job?.sendingAt && Date.now() - job.sendingAt < SENDING_WINDOW_MS) {
      await finishSent(tabId, job, job.withNote ?? true);
      return { job: null };
    }
    return { job: job ?? null };
  },

  async LPE_PAGE_INFO(message) {
    return pageInfo(message);
  },

  async LPE_PAGE_START(message, sender) {
    return pageStart(message, sender);
  },

  async LPE_PAGE_SET_STATUS(message) {
    return pageSetStatus(message);
  },

  async LPE_OUTREACH_EVENT(message, sender) {
    return outreachEvent(message, sender);
  },

  // "Marquer comme envoyé" from the dashboard, without going through LinkedIn.
  async LPE_OUTREACH_MARK({ slug, action, step, text, withNote }) {
    await applySent({ slug, action, step, text }, { withNote });
    return {};
  },

  // Filters of the people search the user set up by hand in a LinkedIn tab
  // (the most recently used one).
  async LPE_TAB_FILTERS() {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/search/results/*' });
    const tab = tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (!tab) {
      throw new Error(
        'Aucun onglet de recherche LinkedIn ouvert. Fais ta recherche de personnes sur LinkedIn avec ses filtres, puis réessaie.'
      );
    }
    await ensureContentScript(tab.id);
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'LPE_SEARCH_FILTERS' });
    if (!result?.ok) throw new Error('Impossible de lire les filtres de l’onglet LinkedIn : recharge-le et réessaie.');
    return { url: result.url, pills: result.pills };
  },

  async LPE_TYPEAHEAD({ kind, query }) {
    return { hits: await typeahead(kind, query) };
  },

  async LPE_SEARCH_URL({ campaign }) {
    return { url: searchUrl(campaign, 1) };
  },

  async LPE_NOTION_TEST({ token }) {
    return notion.testToken(token);
  },

  async LPE_NOTION_LOAD({ token, databaseUrl }) {
    return notion.loadDatabase(token, databaseUrl);
  },

  async LPE_NOTION_CREATE({ token, pageUrl }) {
    return notion.createDatabase(token, pageUrl);
  },

  async LPE_NOTION_SYNC() {
    return { result: await runSync() };
  },

  async LPE_CLEAR() {
    await chrome.storage.local.set({ profiles: [] });
    return { cleared: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: errorText(error) }));
  return true;
});
