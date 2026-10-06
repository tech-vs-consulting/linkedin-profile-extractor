// Notion client and two-way sync. Runs in the service worker: the
// api.notion.com host permission is what lets it past Notion's CORS block.
//
// Local IndexedDB stays the working copy; Notion mirrors it. Every mapped
// field is pushed; the fields a person edits by hand (status, notes, dates)
// are also pulled back, so a change made in Notion reaches the dashboard.

import * as db from './db.js';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const FIELDS = [
  { key: 'name', label: 'Nom', type: 'title' },
  { key: 'url', label: 'LinkedIn', type: 'url' },
  { key: 'headline', label: 'Titre', type: 'rich_text' },
  { key: 'company', label: 'Entreprise', type: 'rich_text' },
  { key: 'location', label: 'Localisation', type: 'rich_text' },
  { key: 'campaign', label: 'Campagne', type: 'select' },
  { key: 'status', label: 'Statut', type: 'select', pull: true },
  { key: 'degree', label: 'Degré', type: 'select', pull: true },
  { key: 'foundAt', label: 'Trouvé le', type: 'date' },
  { key: 'lastContactAt', label: 'Dernier contact', type: 'date', pull: true },
  { key: 'nextFollowUpAt', label: 'Prochaine relance', type: 'date', pull: true },
  { key: 'notes', label: 'Notes', type: 'rich_text', pull: true },
  { key: 'photo', label: 'Photo', type: 'url' },
];

// Which Notion property types can hold each of our field types.
export const COMPATIBLE = {
  title: ['title'],
  url: ['url', 'rich_text'],
  rich_text: ['rich_text'],
  select: ['select', 'rich_text'],
  date: ['date'],
};

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

let lastCall = 0;

// Notion allows about three requests per second on average; stay under it and
// honour Retry-After when it pushes back anyway.
async function call(token, method, path, body) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wait = lastCall + 350 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const response = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429 || response.status >= 500) {
      const retry = Number(response.headers.get('Retry-After')) || 1;
      await sleep(retry * 1000 * (attempt + 1));
      continue;
    }

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Notion ${response.status} : ${json.message ?? response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }
  throw new Error('Notion ne répond pas (trop de requêtes).');
}

async function queryAll(token, databaseId, body = {}) {
  const pages = [];
  let cursor;
  do {
    const result = await call(token, 'POST', `/databases/${databaseId}/query`, {
      ...body,
      page_size: 100,
      start_cursor: cursor,
    });
    pages.push(...result.results);
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// Accepts a raw id or any notion.so URL (page or database, with ?v=... views).
export function notionId(input) {
  const path = String(input ?? '').split('?')[0];
  const match = path.match(/([0-9a-f]{32})$/i) ?? path.match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i);
  return match ? match[1].replace(/-/g, '') : null;
}

const plainTitle = (items) => (items ?? []).map((t) => t.plain_text).join('');

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

export async function testToken(token) {
  const me = await call(token, 'GET', '/users/me');
  return { bot: me.name ?? me.bot?.owner?.workspace_name ?? 'intégration' };
}

function describe(database) {
  const schema = Object.fromEntries(
    Object.entries(database.properties).map(([name, prop]) => [name, prop.type])
  );
  return { databaseId: database.id.replace(/-/g, ''), databaseTitle: plainTitle(database.title), schema };
}

// Maps each field to a same-named (case-insensitive) compatible property.
export function autoMapping(schema) {
  const mapping = {};
  for (const field of FIELDS) {
    const match = Object.keys(schema).find(
      (name) =>
        name.toLowerCase() === field.label.toLowerCase() &&
        COMPATIBLE[field.type].includes(schema[name])
    );
    mapping[field.key] =
      match ?? (field.type === 'title' ? Object.keys(schema).find((n) => schema[n] === 'title') : '') ?? '';
  }
  return mapping;
}

export async function loadDatabase(token, databaseUrl) {
  const id = notionId(databaseUrl);
  if (!id) throw new Error('URL ou identifiant de base Notion invalide.');
  const info = describe(await call(token, 'GET', `/databases/${id}`));
  return { ...info, mapping: autoMapping(info.schema) };
}

export async function createDatabase(token, pageUrl) {
  const pageId = notionId(pageUrl);
  if (!pageId) throw new Error('URL de page Notion invalide.');

  const properties = {};
  for (const field of FIELDS) {
    properties[field.label] =
      field.key === 'status'
        ? { select: { options: db.STATUSES.map((name) => ({ name })) } }
        : { [field.type]: {} };
  }

  const database = await call(token, 'POST', '/databases', {
    parent: { type: 'page_id', page_id: pageId },
    title: [{ type: 'text', text: { content: 'Prospects LinkedIn' } }],
    properties,
  });
  const info = describe(database);
  return { ...info, mapping: autoMapping(info.schema) };
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

const text = (value) => String(value ?? '').slice(0, 2000);

function encode(type, value) {
  const empty = value === null || value === undefined || value === '';
  switch (type) {
    case 'title':
      return { title: [{ text: { content: text(value) || 'Sans nom' } }] };
    case 'rich_text':
      return { rich_text: empty ? [] : [{ text: { content: text(value) } }] };
    case 'url':
      return { url: empty ? null : text(value) };
    case 'select':
      // Commas are not allowed in select option names.
      return { select: empty ? null : { name: text(value).replace(/,/g, ' ').slice(0, 100) } };
    case 'date':
      return { date: empty ? null : { start: String(value).slice(0, 10) } };
    default:
      return null;
  }
}

function decode(prop) {
  switch (prop?.type) {
    case 'title':
      return plainTitle(prop.title);
    case 'rich_text':
      return plainTitle(prop.rich_text);
    case 'url':
      return prop.url ?? '';
    case 'select':
      return prop.select?.name ?? '';
    case 'date':
      return prop.date?.start ?? null;
    default:
      return undefined;
  }
}

function valueOf(prospect, key, campaigns) {
  if (key === 'campaign') return campaigns.get(prospect.campaignId)?.name ?? '';
  return prospect[key];
}

function propertiesFor(prospect, settings, campaigns) {
  const properties = {};
  for (const field of FIELDS) {
    const name = settings.mapping?.[field.key];
    const type = name && settings.schema?.[name];
    if (!type) continue;
    const encoded = encode(type, valueOf(prospect, field.key, campaigns));
    if (encoded) properties[name] = encoded;
  }
  return properties;
}

// What a push would write, minus the photo's expiring token. Equal to the
// last successful push's → the Notion row already says exactly this.
function fingerprint(properties) {
  const text = JSON.stringify(properties, (_key, value) =>
    typeof value === 'string' && /media\.licdn\.com/.test(value) ? db.photoKey(value) : value
  );
  // FNV-1a: short, stable, plenty to tell two versions of one row apart.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// The profile part of a LinkedIn URL, decoded: search stores "maria-tébar",
// the URL written to Notion reads "maria-t%C3%A9bar".
function slugOfUrl(url) {
  const raw = String(url ?? '').match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// What makes two slugs the same person: decoding and case do not matter.
const sameKey = (slug) => String(slug ?? '').toLowerCase();

// Local prospects by that key, to match a Notion row to the row it came from.
async function localKeys() {
  return new Map((await db.getAll('prospects')).map((p) => [sameKey(p.slug), p.slug]));
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

// Notion rounds last_edited_time to the minute: re-read a little overlap
// rather than miss an edit made in the same minute as the last pull.
const OVERLAP_MS = 2 * 60_000;

// The fields a person maintains by hand in Notion (status, notes, dates,
// degree), as found on a page; empty ones are left out.
function followUpOf(page, settings) {
  const out = {};
  for (const field of FIELDS) {
    const name = settings.mapping[field.key];
    if (!field.pull || !name || !page.properties[name]) continue;
    const value = decode(page.properties[name]);
    if (value) out[field.key] = value;
  }
  return out;
}

async function pull(settings) {
  const urlProp = settings.mapping.url;
  const body = settings.lastPullAt
    ? {
        filter: {
          timestamp: 'last_edited_time',
          last_edited_time: {
            on_or_after: new Date(Date.parse(settings.lastPullAt) - OVERLAP_MS).toISOString(),
          },
        },
      }
    : {};
  const pages = await queryAll(settings.token, settings.databaseId, body);

  let updated = 0;
  let imported = 0;
  const known = await localKeys();

  for (const page of pages) {
    const found = slugOfUrl(decode(page.properties[urlProp]));
    if (!found) continue;
    // The local row of this person whatever the URL's spelling; a new person
    // keeps the decoded slug, the form search uses.
    const slug = known.get(sameKey(found)) ?? found;
    known.set(sameKey(slug), slug);

    const remote = {};
    for (const field of FIELDS) {
      const name = settings.mapping[field.key];
      if (!name || !page.properties[name]) continue;
      remote[field.key] = decode(page.properties[name]);
    }

    await db.update('prospects', slug, (found) => {
      // Edited in Notion after our last push (or another page): the row no
      // longer holds what that push wrote, so the next push must not be skipped.
      const stale =
        found?.notionHash &&
        (found.notionPageId !== page.id || !(Date.parse(page.last_edited_time) <= Date.parse(found.syncedAt)));
      const local = stale ? { ...found, notionHash: null } : found;
      if (!local) {
        // Added by hand in Notion: import it so the dashboard sees it.
        imported += 1;
        return {
          slug,
          url: `https://www.linkedin.com/in/${slug}/`,
          name: remote.name ?? '',
          firstName: db.firstNameOf(remote.name),
          headline: remote.headline ?? '',
          company: remote.company ?? '',
          location: remote.location ?? '',
          photo: remote.photo || null,
          degree: remote.degree ?? '',
          campaignId: null,
          status: remote.status || 'Nouveau',
          notes: remote.notes ?? '',
          foundAt: page.created_time,
          lastContactAt: remote.lastContactAt ?? null,
          nextFollowUpAt: remote.nextFollowUpAt ?? null,
          profile: null,
          enrichedAt: null,
          notionPageId: page.id,
          updatedAt: page.last_edited_time,
          dirty: false,
        };
      }

      // A local edit newer than the Notion one wins; it is pushed next. Not on
      // the first link though: a row found again by a search is "Nouveau"
      // locally, while Notion holds the real follow-up (Invité, A répondu...).
      if (local.notionPageId && local.dirty && Date.parse(local.updatedAt) > Date.parse(page.last_edited_time)) {
        return local.notionPageId === page.id && !stale ? null : { ...local, notionPageId: page.id };
      }

      const next = { ...local, notionPageId: page.id };
      let changed = local.notionPageId !== page.id;
      for (const field of FIELDS) {
        if (!field.pull || !(field.key in remote)) continue;
        const value = remote[field.key] || (field.type === 'date' ? null : '');
        const current = local[field.key] ?? (field.type === 'date' ? null : '');
        const same =
          field.type === 'date' ? String(value ?? '').slice(0, 10) === String(current ?? '').slice(0, 10) : value === current;
        if (!same) {
          next[field.key] = value;
          changed = true;
        }
      }
      if (!changed) return stale ? next : null;
      updated += 1;
      return next;
    });
  }

  return { updated, imported };
}

async function push(settings, onProgress) {
  const campaigns = new Map((await db.getAll('campaigns')).map((c) => [c.id, c]));
  const dirty = (await db.getAll('prospects')).filter((p) => p.dirty);
  if (!dirty.length) return { pushed: 0, errors: [] };

  // One full scan beats a lookup per new row: 100 pages per request.
  let byUrlSlug = null;
  if (dirty.some((p) => !p.notionPageId)) {
    byUrlSlug = new Map();
    for (const page of await queryAll(settings.token, settings.databaseId)) {
      const slug = slugOfUrl(decode(page.properties[settings.mapping.url]));
      if (slug) byUrlSlug.set(sameKey(slug), page);
    }
  }

  let pushed = 0;
  let unchanged = 0; // dirty locally, already identical in Notion
  const errors = [];

  for (let prospect of dirty) {
    onProgress?.(pushed + unchanged, dirty.length);
    const existing = prospect.notionPageId ? null : byUrlSlug?.get(sameKey(prospect.slug));
    if (existing) {
      // Already in Notion: take its follow-up fields before pushing, so the
      // card refresh does not reset them to "Nouveau".
      prospect = await db.update('prospects', prospect.slug, (current) =>
        current ? { ...current, ...followUpOf(existing, settings) } : null
      );
      if (!prospect) continue;
    }
    const properties = propertiesFor(prospect, settings, campaigns);
    const hash = fingerprint(properties);
    let pageId = prospect.notionPageId ?? existing?.id ?? null;
    const snapshot = prospect.updatedAt;

    // Touched locally but nothing Notion shows changed (a field that is not
    // synced, a photo token): no request, just clear the flag.
    if (prospect.notionPageId && prospect.notionHash === hash) {
      await db.update('prospects', prospect.slug, (current) =>
        current && current.updatedAt === snapshot ? { ...current, dirty: false } : null
      );
      unchanged += 1;
      continue;
    }

    try {
      if (pageId) {
        try {
          await call(settings.token, 'PATCH', `/pages/${pageId}`, { properties });
        } catch (error) {
          // Deleted or archived in Notion: recreate it rather than lose the row.
          if (error.status !== 404 && !/archived/i.test(error.message)) throw error;
          pageId = null;
        }
      }
      if (!pageId) {
        const page = await call(settings.token, 'POST', '/pages', {
          parent: { database_id: settings.databaseId },
          properties,
        });
        pageId = page.id;
      }

      await db.update('prospects', prospect.slug, (current) => {
        if (!current) return null;
        // Edited again while the request was in flight: keep it dirty.
        const stillSame = current.updatedAt === snapshot;
        return {
          ...current,
          notionPageId: pageId,
          notionHash: hash,
          dirty: !stillSame,
          syncedAt: new Date().toISOString(),
        };
      });
      pushed += 1;
    } catch (error) {
      errors.push({ slug: prospect.slug, error: String(error.message ?? error) });
      // A bad token or a missing property fails every row the same way.
      if (error.status === 401 || error.status === 400) break;
    }
  }

  return { pushed, unchanged, errors };
}

export async function sync(onProgress) {
  const { notion: settings } = await chrome.storage.local.get('notion');
  if (!settings?.token || !settings?.databaseId) throw new Error('Notion n’est pas configuré.');
  if (!settings.mapping?.url) throw new Error('Associe le champ LinkedIn à une colonne Notion.');

  const startedAt = new Date().toISOString();
  const pulled = await pull(settings);
  const pushed = await push(settings, onProgress);

  const { notion: latest } = await chrome.storage.local.get('notion');
  await chrome.storage.local.set({
    notion: {
      ...latest,
      lastPullAt: startedAt,
      lastSyncAt: new Date().toISOString(),
      lastError: pushed.errors[0]?.error ?? null,
    },
  });

  return { ...pulled, ...pushed };
}
