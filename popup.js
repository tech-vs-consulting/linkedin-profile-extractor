const $ = (id) => document.getElementById(id);

const els = {
  count: $('count'),
  extract: $('extract'),
  deep: $('deep'),
  urls: $('urls'),
  delay: $('delay'),
  runBatch: $('run-batch'),
  message: $('message'),
  list: $('list'),
};

const send = (message) => chrome.runtime.sendMessage(message);

function notify(text, isError = false) {
  els.message.textContent = text;
  els.message.classList.toggle('is-error', isError);
  els.message.classList.toggle('is-hidden', !text);
}

/* ---------------------------------------------------------------- *
 * Rendering
 * ---------------------------------------------------------------- */

function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function periodLabel(position) {
  if (position.rawDates) return position.rawDates;
  const from = position.start?.label ?? '?';
  const to = position.current ? "aujourd'hui" : (position.end?.label ?? '?');
  return position.start || position.end ? `${from} - ${to}` : '';
}

function card(profile) {
  const node = document.createElement('div');
  node.className = 'card';

  // Build via DOM nodes rather than innerHTML: every field here is scraped
  // text and must never be parsed as markup.
  if (profile.photo) {
    const img = document.createElement('img');
    img.src = profile.photo;
    img.alt = '';
    node.append(img);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(profile.name);
    node.append(avatar);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = profile.name || profile.slug;

  const role = document.createElement('div');
  role.className = 'card-role';
  role.textContent =
    [profile.currentTitle, profile.currentCompany].filter(Boolean).join(' @ ') ||
    profile.headline ||
    '';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${profile.positions.length} poste(s) - ${periodLabel(profile.positions[0] ?? {})}`;

  body.append(name, role, meta);
  node.append(body);
  return node;
}

async function render() {
  const { profiles = [] } = await chrome.storage.local.get('profiles');
  els.count.textContent = String(profiles.length);
  els.list.replaceChildren();

  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Aucun profil extrait.';
    els.list.append(empty);
    return profiles;
  }

  for (const profile of profiles) els.list.append(card(profile));
  return profiles;
}

/* ---------------------------------------------------------------- *
 * Export
 * ---------------------------------------------------------------- */

function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toCsv(profiles) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const headers = [
    'name',
    'url',
    'headline',
    'location',
    'currentTitle',
    'currentCompany',
    'photo',
    'positions',
    'education',
    'extractedAt',
  ];

  const rows = profiles.map((p) =>
    [
      p.name,
      p.url,
      p.headline,
      p.location,
      p.currentTitle,
      p.currentCompany,
      p.photo,
      p.positions
        .map((x) => `${x.title} @ ${x.company} (${periodLabel(x)})`)
        .join(' | '),
      p.education.map((x) => `${x.degree || ''} ${x.school}`.trim()).join(' | '),
      p.extractedAt,
    ]
      .map(escape)
      .join(',')
  );

  // BOM so Excel opens the accented characters correctly.
  return `﻿${headers.join(',')}\n${rows.join('\n')}`;
}

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      other.classList.toggle('is-active', other === tab);
    }
    $('panel-single').classList.toggle('is-hidden', tab.dataset.tab !== 'single');
    $('panel-batch').classList.toggle('is-hidden', tab.dataset.tab !== 'batch');
  });
}

els.extract.addEventListener('click', async () => {
  els.extract.disabled = true;
  notify('Extraction en cours...');
  try {
    const result = await send({
      type: 'LPE_EXTRACT_ACTIVE',
      options: { deep: els.deep.checked },
    });
    if (!result?.ok) throw new Error(result?.error ?? 'Echec.');
    notify(`${result.profile.name} - ${result.profile.positions.length} poste(s).`);
    await render();
  } catch (error) {
    notify(String(error.message ?? error), true);
  } finally {
    els.extract.disabled = false;
  }
});

$('diagnose').addEventListener('click', async () => {
  const button = $('diagnose');
  const box = $('report');
  button.disabled = true;
  notify('Analyse de la page...');
  try {
    const result = await send({ type: 'LPE_DIAGNOSE_ACTIVE' });
    if (!result?.ok) throw new Error(result?.error ?? 'Echec.');
    const text = JSON.stringify(result.report, null, 2);
    box.value = text;
    box.classList.remove('is-hidden');
    await navigator.clipboard.writeText(text).catch(() => {});
    notify('Rapport copie dans le presse-papier.');
  } catch (error) {
    notify(String(error.message ?? error), true);
  } finally {
    button.disabled = false;
  }
});

els.runBatch.addEventListener('click', async () => {
  const urls = els.urls.value.split(/\s+/).filter(Boolean);
  if (!urls.length) return notify('Colle au moins une URL.', true);

  els.runBatch.disabled = true;
  notify(`Traitement de ${urls.length} profil(s)...`);
  try {
    const result = await send({
      type: 'LPE_RUN_BATCH',
      urls,
      options: { deep: els.deep.checked, delayMs: Number(els.delay.value) },
    });
    if (!result?.ok) throw new Error(result?.error ?? 'Echec.');
    const failed = result.errors?.length ?? 0;
    notify(`Termine : ${result.done - failed} reussite(s), ${failed} echec(s).`, failed > 0);
    await render();
  } catch (error) {
    notify(String(error.message ?? error), true);
  } finally {
    els.runBatch.disabled = false;
  }
});

$('copy-json').addEventListener('click', async () => {
  const profiles = await render();
  if (!profiles.length) return notify('Aucun profil a copier.', true);
  try {
    await navigator.clipboard.writeText(JSON.stringify(profiles, null, 2));
    notify(`${profiles.length} profil(s) copie(s) dans le presse-papier.`);
  } catch (error) {
    notify(`Copie impossible : ${error.message ?? error}`, true);
  }
});

$('export-json').addEventListener('click', async () => {
  const profiles = await render();
  if (profiles.length) download('linkedin-profiles.json', JSON.stringify(profiles, null, 2), 'application/json');
});

$('export-csv').addEventListener('click', async () => {
  const profiles = await render();
  if (profiles.length) download('linkedin-profiles.csv', toCsv(profiles), 'text/csv');
});

$('clear').addEventListener('click', async () => {
  await send({ type: 'LPE_CLEAR' });
  notify('');
  await render();
});

// A batch keeps running after the popup closes; pick the progress back up.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'LPE_STATUS') return;
  const { running, done, total } = message.status;
  if (running) notify(`Profil ${done + 1}/${total}...`);
  render();
});

chrome.storage.local.get('status').then(({ status }) => {
  if (status?.running) {
    els.runBatch.disabled = true;
    notify(`Traitement en cours : ${status.done}/${status.total}...`);
  }
});

render();
