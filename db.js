// IndexedDB store shared by the service worker and the dashboard (same
// extension origin). Prospects are keyed by the slug of the URL they were found
// under, so finding someone again updates their row instead of duplicating it.

const DB_NAME = 'lpe';
const DB_VERSION = 1;

export const STATUSES = [
  'Nouveau',
  'Invité',
  'Connecté',
  'Message envoyé',
  'Relancé',
  'A répondu',
  'Pas intéressé',
  'Ne plus contacter',
];

let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const prospects = db.createObjectStore('prospects', { keyPath: 'slug' });
      prospects.createIndex('campaignId', 'campaignId');
      db.createObjectStore('campaigns', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

function run(storeName, mode, body) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        let result;
        body(tx.objectStore(storeName), (value) => (result = value));
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const getAll = (storeName) =>
  run(storeName, 'readonly', (store, done) => {
    store.getAll().onsuccess = (e) => done(e.target.result);
  });

export const get = (storeName, key) =>
  run(storeName, 'readonly', (store, done) => {
    store.get(key).onsuccess = (e) => done(e.target.result);
  });

export const put = (storeName, value) =>
  run(storeName, 'readwrite', (store, done) => {
    store.put(value);
    done(value);
  });

export const remove = (storeName, keys) =>
  run(storeName, 'readwrite', (store) => {
    for (const key of [].concat(keys)) store.delete(key);
  });

// Read-modify-write inside a single transaction, so the dashboard and the
// service worker cannot overwrite each other's edits to the same row.
// `fn` receives the current value (or undefined) and returns the new one, or
// null to leave the row untouched.
export const update = (storeName, key, fn) =>
  run(storeName, 'readwrite', (store, done) => {
    store.get(key).onsuccess = (e) => {
      const next = fn(e.target.result);
      if (next) store.put(next);
      done(next ?? e.target.result);
    };
  });

/* ------------------------------------------------------------------ *
 * Prospects
 * ------------------------------------------------------------------ */

// Every local change goes through here: `dirty` is what the Notion sync pushes.
export const touch = (prospect) => ({
  ...prospect,
  updatedAt: new Date().toISOString(),
  dirty: true,
});

export function editProspect(slug, patch) {
  return update('prospects', slug, (current) => (current ? touch({ ...current, ...patch }) : null));
}

// LinkedIn photo URLs carry a signed, expiring token (?e=…&t=…) that changes
// from one search to the next: the same picture is the same path.
export const photoKey = (url) => String(url ?? '').split('?')[0];

// A search hit. A known person keeps their status, notes and campaign; only the
// card fields are refreshed, and only when they actually changed.
export function upsertFound(card, campaignId) {
  let added = false;
  return update('prospects', card.slug, (current) => {
    if (!current) {
      added = true;
      const now = new Date().toISOString();
      return touch({
        ...card,
        campaignId,
        status: 'Nouveau',
        notes: '',
        foundAt: now,
        lastContactAt: null,
        nextFollowUpAt: null,
        profile: null,
        enrichedAt: null,
        notionPageId: null,
      });
    }
    const fields = ['name', 'firstName', 'headline', 'company', 'location', 'photo', 'degree'];
    const same = (f) => (f === 'photo' ? photoKey(card[f]) === photoKey(current[f]) : card[f] === current[f]);
    const changed = fields.some((f) => card[f] && !same(f));
    const merged = { ...current };
    for (const f of fields) if (card[f]) merged[f] = card[f];
    if (changed) return touch(merged);
    // Only a fresher photo token: keep the picture loading in the dashboard,
    // without marking the row for a Notion push.
    return card.photo && card.photo !== current.photo ? merged : null;
  }).then(() => added);
}

// Attach a full profile extraction to its prospect.
export function attachProfile(slug, profile) {
  return update('prospects', slug, (current) => {
    if (!current) return null;
    return touch({
      ...current,
      name: profile.name || current.name,
      headline: profile.headline || current.headline,
      location: profile.location || current.location,
      photo: profile.photo || current.photo,
      company: profile.currentCompany || current.company,
      currentTitle: profile.currentTitle || current.currentTitle || '',
      profileUrl: profile.url,
      profile,
      enrichedAt: profile.extractedAt,
    });
  });
}

export const firstNameOf = (name) =>
  (name ?? '').split(',')[0].trim().split(/\s+/)[0] ?? '';
