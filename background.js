// Service worker: owns the tab lifecycle for batch runs and the result store.

const PROFILE_URL = /^https:\/\/www\.linkedin\.com\/in\//;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let batchRunning = false;
let keepAliveTimer = null;

// An MV3 worker can be evicted while it waits between profiles; touching a
// chrome API on a timer keeps it resident for the duration of a batch.
function keepAlive(on) {
  clearInterval(keepAliveTimer);
  keepAliveTimer = on ? setInterval(() => chrome.runtime.getPlatformInfo(), 20_000) : null;
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

async function saveProfile(profile) {
  const { profiles = [] } = await chrome.storage.local.get('profiles');
  const index = profiles.findIndex((p) => p.slug === profile.slug);
  if (index >= 0) profiles[index] = profile;
  else profiles.unshift(profile);
  await chrome.storage.local.set({ profiles });
  return profiles;
}

async function setStatus(status) {
  await chrome.storage.local.set({ status });
  // The popup is often closed; a failed broadcast is expected, not an error.
  chrome.runtime.sendMessage({ type: 'LPE_STATUS', status }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Extraction
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
        files: ['content.js'],
        world: 'ISOLATED',
      });
    } catch {
      // Already present but slow to answer the ping: re-running the file
      // throws on the redeclared top-level bindings, which is harmless here.
    }
    await sleep(300);
  }
}

async function extractFromTab(tabId, options) {
  await ensureContentScript(tabId);
  const result = await chrome.tabs.sendMessage(tabId, { type: 'LPE_EXTRACT', options });
  if (!result?.ok) throw new Error(result?.error ?? 'Extraction sans reponse.');
  await saveProfile(result.profile);
  return result.profile;
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
 * Batch
 * ------------------------------------------------------------------ */

async function runBatch(urls, options) {
  if (batchRunning) throw new Error('Un traitement est deja en cours.');
  batchRunning = true;
  keepAlive(true);

  const errors = [];
  let done = 0;

  try {
    for (const url of urls) {
      await setStatus({ running: true, done, total: urls.length, current: url });
      try {
        await extractFromUrl(url, options);
      } catch (error) {
        errors.push({ url, error: String(error?.message ?? error) });
      }
      done += 1;

      if (done < urls.length) {
        // Jittered pause: a constant interval is exactly what rate limiters
        // look for, and slow beats getting the account restricted.
        const base = options?.delayMs ?? 12_000;
        await sleep(base + Math.random() * base * 0.5);
      }
    }
  } finally {
    batchRunning = false;
    keepAlive(false);
    await setStatus({ running: false, done, total: urls.length, errors });
  }

  return { done, errors };
}

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

const handlers = {
  async LPE_EXTRACT_ACTIVE({ options }) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !PROFILE_URL.test(tab.url)) {
      throw new Error('Ouvre un profil linkedin.com/in/... dans cet onglet.');
    }
    return { profile: await extractFromTab(tab.id, options) };
  },

  async LPE_DIAGNOSE_ACTIVE() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !PROFILE_URL.test(tab.url)) {
      throw new Error('Ouvre un profil linkedin.com/in/... dans cet onglet.');
    }
    await ensureContentScript(tab.id);
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'LPE_DIAGNOSE' });
    if (!result?.ok) throw new Error(result?.error ?? 'Diagnostic sans reponse.');
    return { report: result.report };
  },

  async LPE_RUN_BATCH({ urls, options }) {
    const cleaned = [...new Set(urls.map((u) => u.trim()).filter((u) => PROFILE_URL.test(u)))];
    if (!cleaned.length) throw new Error('Aucune URL de profil valide.');
    return runBatch(cleaned, options);
  },

  async LPE_CLEAR() {
    await chrome.storage.local.set({ profiles: [] });
    return { cleared: true };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message)
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});
