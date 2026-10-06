// Dashboard page (extension origin): reads and edits IndexedDB directly, and
// asks the service worker for anything that drives LinkedIn tabs or Notion.

import * as db from './db.js';
import { FIELDS, COMPATIBLE } from './notion.js';
import * as seq from './sequence.js';

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);
const PAGE_SIZE = 100;

// Statuses that mean "we just reached out": setting one stamps the date.
const CONTACT_STATUSES = new Set(['Invité', 'Message envoyé', 'Relancé']);

const state = {
  prospects: [],
  campaigns: [],
  selected: new Set(),
  limit: PAGE_SIZE,
  openSlug: null,
  notion: null,
  outreach: null,
  job: null,
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

// Every scraped field is text and must never be parsed as markup: build nodes.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    // `value` must be a property: as an attribute a <textarea> ignores it.
    else if (key in node && (typeof value !== 'string' || key === 'value')) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// replaceChildren() stringifies arrays; flatten and drop empty slots first.
function fill(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

function notify(text, isError = false) {
  const box = $('message');
  box.textContent = text;
  box.classList.toggle('is-error', isError);
  box.classList.toggle('is-hidden', !text);
}

async function ask(message) {
  const result = await send(message);
  if (!result?.ok) throw new Error(result?.error ?? 'Échec.');
  return result;
}

const initials = (name) =>
  (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

function avatar(prospect) {
  return prospect.photo
    ? h('img', { class: 'avatar', src: prospect.photo, alt: '', referrerpolicy: 'no-referrer' })
    : h('div', { class: 'avatar' }, initials(prospect.name));
}

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '');
const today = () => new Date().toISOString().slice(0, 10);

const normalize = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const lines = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function relative(iso) {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  if (minutes < 1440) return `il y a ${Math.round(minutes / 60)} h`;
  return `il y a ${Math.round(minutes / 1440)} j`;
}

function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  h('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function statusSelect(value, onChange, { placeholder } = {}) {
  const select = h(
    'select',
    { onchange: (e) => onChange(e.target.value) },
    placeholder ? h('option', { value: '' }, placeholder) : null,
    db.STATUSES.map((s) => h('option', { value: s, selected: s === value }, s))
  );
  return select;
}

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

async function load() {
  const [prospects, campaigns, stored] = await Promise.all([
    db.getAll('prospects'),
    db.getAll('campaigns'),
    chrome.storage.local.get(['notion', 'outreach']),
  ]);
  state.prospects = prospects.sort((a, b) => String(b.foundAt).localeCompare(String(a.foundAt)));
  state.campaigns = campaigns.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  state.notion = stored.notion ?? null;
  state.outreach = stored.outreach ?? null;
  for (const slug of state.selected) {
    if (!prospects.some((p) => p.slug === slug)) state.selected.delete(slug);
  }
}

const campaignName = (id) => state.campaigns.find((c) => c.id === id)?.name ?? '—';

async function setStatus(slugs, status) {
  const patch = { status };
  if (CONTACT_STATUSES.has(status)) patch.lastContactAt = today();
  if (status === 'Connecté') patch.connectedAt = today();
  await Promise.all(
    slugs.map((slug) => {
      const current = state.prospects.find((p) => p.slug === slug);
      // A wrong "1er" would keep sending this person to the message queue.
      const fix =
        current?.degree === '1er' && (status === 'Nouveau' || status === 'Invité') ? { degree: '' } : {};
      return db.editProspect(slug, { ...patch, ...fix });
    })
  );
  await refresh();
}

let refreshing = null;
async function refresh() {
  // Collapse bursts of change notifications (one per search page) into one render.
  refreshing ??= (async () => {
    await load();
    renderAll();
    refreshing = null;
  })();
  return refreshing;
}

/* ------------------------------------------------------------------ *
 * Prospects
 * ------------------------------------------------------------------ */

// LinkedIn locations read "Ville, Région, Pays", "Région, Pays" or a single
// label ("Région de Paris", "France"): the region is the part before the country.
function regionOf(p) {
  const parts = String(p.location ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  return parts.length >= 3 ? parts[parts.length - 2] : parts[0];
}

function filtered() {
  const text = normalize($('filter-text').value.trim());
  const campaign = $('filter-campaign').value;
  const region = $('filter-region').value;
  const status = $('filter-status').value;
  return state.prospects.filter((p) => {
    if (campaign && (p.campaignId ?? 'none') !== campaign) return false;
    if (region && (normalize(regionOf(p)) || 'none') !== region) return false;
    if (status && p.status !== status) return false;
    if (!text) return true;
    return normalize(`${p.name} ${p.headline} ${p.company} ${p.location}`).includes(text);
  });
}

function renderFilters() {
  const campaign = $('filter-campaign');
  const current = campaign.value;
  fill(
    campaign,
    h('option', { value: '' }, 'Toutes les campagnes'),
    state.campaigns.map((c) => h('option', { value: c.id }, c.name)),
    h('option', { value: 'none' }, 'Sans campagne')
  );
  campaign.value = current;

  // Group spellings that differ only by accents or case under one entry.
  const regions = new Map();
  let unlocated = 0;
  for (const p of state.prospects) {
    const label = regionOf(p);
    if (!label) {
      unlocated++;
      continue;
    }
    const key = normalize(label);
    const entry = regions.get(key) ?? { label, count: 0 };
    entry.count++;
    regions.set(key, entry);
  }
  const region = $('filter-region');
  const currentRegion = region.value;
  fill(
    region,
    h('option', { value: '' }, 'Toutes les régions'),
    [...regions]
      .sort(([, a], [, b]) => b.count - a.count || a.label.localeCompare(b.label, 'fr'))
      .map(([key, r]) => h('option', { value: key }, `${r.label} (${r.count})`)),
    unlocated ? h('option', { value: 'none' }, `Sans localisation (${unlocated})`) : null
  );
  region.value = currentRegion;
  // The chosen region may have disappeared (prospects deleted or edited).
  if (region.value !== currentRegion) region.value = '';

  const status = $('filter-status');
  if (!status.options.length) {
    fill(
      status,
      h('option', { value: '' }, 'Tous les statuts'),
      db.STATUSES.map((s) => h('option', { value: s }, s))
    );
  }

  const bulk = $('bulk-status');
  if (!bulk.options.length) {
    fill(
      bulk,
      h('option', { value: '' }, 'Changer le statut…'),
      db.STATUSES.map((s) => h('option', { value: s }, s))
    );
  }
}

function renderChips() {
  const counts = Object.fromEntries(db.STATUSES.map((s) => [s, 0]));
  for (const p of state.prospects) counts[p.status] = (counts[p.status] ?? 0) + 1;
  const active = $('filter-status').value;

  const chip = (label, value, count) =>
    h(
      'button',
      {
        class: `chip${active === value ? ' is-active' : ''}`,
        onclick: () => {
          $('filter-status').value = value;
          state.limit = PAGE_SIZE;
          renderProspects();
        },
      },
      label,
      h('b', {}, String(count))
    );

  fill(
    $('status-chips'),
    chip('Tous', '', state.prospects.length),
    db.STATUSES.filter((s) => counts[s]).map((s) => chip(s, s, counts[s]))
  );
}

function row(p) {
  const checked = state.selected.has(p.slug);
  return h(
    'tr',
    {},
    h(
      'td',
      { class: 'col-check' },
      h('input', {
        type: 'checkbox',
        checked,
        onchange: (e) => {
          if (e.target.checked) state.selected.add(p.slug);
          else state.selected.delete(p.slug);
          renderBulk();
        },
      })
    ),
    h(
      'td',
      {},
      h(
        'div',
        { class: 'person', onclick: () => openDrawer(p.slug), title: 'Ouvrir la fiche' },
        avatar(p),
        h(
          'div',
          {},
          h(
            'div',
            { class: 'person-name' },
            p.name || p.slug,
            p.degree ? h('span', { class: 'badge' }, p.degree) : null,
            p.enrichedAt ? h('span', { class: 'badge', title: 'Profil complet extrait' }, 'complet') : null
          ),
          h('div', { class: 'person-sub' }, p.headline)
        )
      )
    ),
    h('td', {}, p.company),
    h('td', {}, p.location),
    h('td', {}, campaignName(p.campaignId)),
    h('td', {}, statusSelect(p.status, (value) => setStatus([p.slug], value))),
    h('td', { class: 'muted' }, formatDate(p.foundAt))
  );
}

function renderProspects() {
  renderChips();
  const list = filtered();
  const shown = list.slice(0, state.limit);
  $('rows').replaceChildren(...shown.map(row));

  const empty = $('empty');
  empty.classList.toggle('is-hidden', list.length > 0);
  empty.textContent = state.prospects.length
    ? 'Aucun prospect ne correspond aux filtres.'
    : 'Aucun prospect pour l’instant. Crée une campagne et lance une recherche.';

  $('more').classList.toggle('is-hidden', list.length <= shown.length);
  $('more').textContent = `Afficher plus (${list.length - shown.length} restants)`;
  $('check-all').checked = shown.length > 0 && list.every((p) => state.selected.has(p.slug));
  renderBulk();
}

function renderBulk() {
  const count = state.selected.size;
  $('bulk').classList.toggle('is-hidden', count === 0);
  $('selected-count').textContent = `${count} sélectionné(s)`;
}

/* ------------------------------------------------------------------ *
 * Drawer
 * ------------------------------------------------------------------ */

function periodOf(position) {
  if (position.rawDates) return position.rawDates;
  const from = position.start?.label ?? '?';
  const to = position.current ? "aujourd'hui" : (position.end?.label ?? '?');
  return position.start || position.end ? `${from} – ${to}` : '';
}

// Next step of the sequence with its prepare button, then what was sent.
function sequenceBlock(p) {
  const campaign = state.campaigns.find((c) => c.id === p.campaignId);
  const next = seq.nextAction(p, campaign);
  const history = [...(p.history ?? [])].reverse();

  let nextNode;
  if (next) {
    const { text } = seq.render(next.template, p);
    nextNode = h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { class: 'primary', disabled: inFlight.has(p.slug), onclick: () => prepare(p, next, drafts.get(draftKey(p, next)) ?? text) },
        `Préparer : ${next.label}`
      ),
      h('span', { class: next.dueOn > seq.today() ? 'muted' : 'late' }, `prévu le ${formatDate(next.dueOn)}`)
    );
  } else {
    nextNode = h(
      'p',
      { class: 'muted' },
      p.status === 'Invité'
        ? 'En attente d’acceptation de l’invitation.'
        : seq.FINAL_STATUSES.has(p.status)
          ? 'Séquence arrêtée.'
          : 'Séquence terminée.'
    );
  }

  return [
    h('h3', {}, 'Séquence'),
    nextNode,
    history.length
      ? h(
          'ul',
          { class: 'timeline' },
          history.map((x) => h('li', {}, `${x.label ?? x.action} — ${formatDate(x.at)}`, x.text ? h('small', {}, x.text) : null))
        )
      : null,
  ];
}

function openDrawer(slug) {
  state.openSlug = slug;
  renderDrawer();
}

function closeDrawer() {
  state.openSlug = null;
  $('drawer').classList.add('is-hidden');
}

function renderDrawer({ force = true } = {}) {
  const p = state.prospects.find((x) => x.slug === state.openSlug);
  const drawer = $('drawer');
  if (!p) return closeDrawer();
  // Do not rebuild under the user's cursor while they type a note.
  if (!force && drawer.contains(document.activeElement)) return;

  const save = (patch) => db.editProspect(p.slug, patch).then(refresh);

  const positions = p.profile?.positions ?? [];
  const education = p.profile?.education ?? [];

  fill(
    $('drawer-body'),
    h(
      'div',
      { class: 'drawer-head' },
      avatar(p),
      h(
        'div',
        {},
        h('h2', {}, p.name || p.slug),
        h('div', { class: 'muted' }, p.headline),
        h('a', { href: p.profileUrl || p.url, target: '_blank', rel: 'noopener' }, 'Ouvrir sur LinkedIn ↗')
      ),
      h('button', { class: 'link drawer-close', onclick: closeDrawer, title: 'Fermer' }, '✕')
    ),
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'Entreprise'),
      h('dd', {}, p.company || '—'),
      h('dt', {}, 'Localisation'),
      h('dd', {}, p.location || '—'),
      h('dt', {}, 'Relation'),
      h('dd', {}, p.degree || '—'),
      h('dt', {}, 'Campagne'),
      h('dd', {}, campaignName(p.campaignId)),
      h('dt', {}, 'Titre reconnu'),
      h('dd', {}, p.matchedTerm || '—'),
      h('dt', {}, 'Trouvé le'),
      h('dd', {}, formatDate(p.foundAt)),
      h('dt', {}, 'Notion'),
      h('dd', {}, p.notionPageId ? (p.dirty ? 'modifié, en attente de synchro' : 'synchronisé') : 'pas encore envoyé')
    ),
    h(
      'div',
      { class: 'form' },
      h('label', {}, 'Statut', statusSelect(p.status, (status) => setStatus([p.slug], status))),
      h(
        'div',
        { class: 'row' },
        h(
          'label',
          {},
          'Dernier contact',
          h('input', {
            type: 'date',
            value: p.lastContactAt?.slice(0, 10) ?? '',
            onchange: (e) => save({ lastContactAt: e.target.value || null }),
          })
        ),
        h(
          'label',
          {},
          'Prochaine relance',
          h('input', {
            type: 'date',
            value: p.nextFollowUpAt?.slice(0, 10) ?? '',
            onchange: (e) => save({ nextFollowUpAt: e.target.value || null }),
          })
        )
      ),
      h(
        'label',
        {},
        'Notes',
        h('textarea', {
          rows: 5,
          value: p.notes ?? '',
          onchange: (e) => save({ notes: e.target.value }),
        })
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { onclick: () => enrich([p.slug]) },
          p.enrichedAt ? 'Ré-extraire le profil complet' : 'Extraire le profil complet'
        ),
        p.enrichedAt ? h('span', { class: 'muted' }, `extrait ${relative(p.enrichedAt)}`) : null
      )
    ),
    sequenceBlock(p),
    positions.length
      ? [
          h('h3', {}, `Expérience (${positions.length})`),
          h(
            'ul',
            { class: 'timeline' },
            positions.map((x) =>
              h('li', {}, `${x.title}${x.company ? ` · ${x.company}` : ''}`, h('small', {}, periodOf(x)))
            )
          ),
        ]
      : null,
    education.length
      ? [
          h('h3', {}, 'Formation'),
          h(
            'ul',
            { class: 'timeline' },
            education.map((x) =>
              h('li', {}, x.school, h('small', {}, [x.degree, x.field].filter(Boolean).join(', ')))
            )
          ),
        ]
      : null
  );
  drawer.classList.remove('is-hidden');
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

async function enrich(slugs) {
  if (slugs.length > 25 && !confirm(`Extraire ${slugs.length} profils complets ? Chaque profil consomme une consultation LinkedIn.`)) return;
  // Fire and forget: progress arrives through LPE_STATUS.
  send({ type: 'LPE_ENRICH', slugs, options: { delayMs: 12_000 } }).then((result) => {
    if (result && !result.ok) notify(result.error, true);
  });
}

function renderJob(status = state.job) {
  state.job = status;
  const bar = $('job');
  if (!status) return bar.classList.add('is-hidden');

  bar.classList.remove('is-hidden');
  $('job-label').textContent = status.label ?? 'Traitement';
  $('job-progress').max = status.total || 1;
  $('job-progress').value = status.done ?? 0;
  $('job-stop').classList.toggle('is-hidden', !status.running);

  const s = status.stats;
  const parts = [];
  if (status.kind === 'search') {
    parts.push(`page ${Math.min((status.done ?? 0) + (status.running ? 1 : 0), status.total)}/${status.total}`);
    if (s) parts.push(`${s.added} nouveaux`, `${s.known} déjà connus`, `${s.skipped} ignorés`);
    if (s?.past) parts.push(`${s.past} en poste passé`);
    if (s?.place) parts.push(`${s.place} hors zone`);
    if (s?.hidden) parts.push(`${s.hidden} masqués (hors réseau)`);
    if (s?.total) parts.push(`~${s.total} résultats LinkedIn`);
  } else {
    parts.push(`${status.done}/${status.total}`);
  }
  if (!status.running) parts.push(s?.stoppedBy ? `⚠ ${s.stoppedBy}` : s?.end || 'terminé');
  if (status.errors?.length) parts.push(`⚠ ${status.errors.length} erreur(s) : ${status.errors[0].error}`);
  $('job-detail').textContent = parts.join(' · ');

  for (const button of document.querySelectorAll('[data-run], #c-save-run, #bulk-enrich')) {
    button.disabled = Boolean(status.running);
  }
}

/* ------------------------------------------------------------------ *
 * Campaigns
 * ------------------------------------------------------------------ */

function campaignCard(c) {
  const mine = state.prospects.filter((p) => p.campaignId === c.id);
  const fresh = mine.filter((p) => p.status === 'Nouveau').length;
  const run = c.lastRun;

  return h(
    'div',
    { class: 'card campaign-card' },
    h('h3', {}, c.name),
    h(
      'div',
      { class: 'meta' },
      (c.terms ?? []).join(', ') || c.keywords || 'Aucun titre',
      ` · ${filterSummary(c)}`
    ),
    h(
      'div',
      { class: 'stats' },
      h('span', {}, h('b', {}, String(mine.length)), ' prospects'),
      h('span', {}, h('b', {}, String(fresh)), ' nouveaux'),
      run
        ? h(
            'span',
            { class: 'muted' },
            `Dernière recherche ${relative(run.at)} : ${run.pages} page(s), +${run.added}, ${run.skipped} ignorés` +
              (run.past ? ` (dont ${run.past} postes passés)` : '') +
              (run.place ? ` (dont ${run.place} hors zone)` : '') +
              (run.hidden ? `, ${run.hidden} masqués` : '')
          )
        : h('span', { class: 'muted' }, 'Jamais lancée')
    ),
    run?.stoppedBy
      ? h(
          'p',
          { class: 'warn' },
          run.stoppedBy,
          run.debug
            ? h(
                'button',
                {
                  class: 'link',
                  onclick: async () => {
                    await navigator.clipboard.writeText(JSON.stringify(run.debug, null, 2));
                    notify('Diagnostic de la page copié dans le presse-papier.');
                  },
                },
                'Copier le diagnostic'
              )
            : null
        )
      : run?.end
        ? h('p', { class: 'meta' }, run.end)
        : null,
    run?.error ? h('p', { class: 'warn' }, run.error) : null,
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', 'data-run': c.id, onclick: () => runCampaign(c.id) }, 'Lancer la recherche'),
      h('button', { onclick: () => editCampaign(c) }, 'Modifier'),
      h(
        'button',
        {
          onclick: () => {
            $('filter-campaign').value = c.id;
            switchTab('prospects');
          },
        },
        'Voir les prospects'
      ),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link danger', onclick: () => deleteCampaign(c) }, 'Supprimer')
    )
  );
}

function renderCampaigns() {
  const list = $('campaign-list');
  list.replaceChildren(
    ...(state.campaigns.length
      ? state.campaigns.map(campaignCard)
      : [h('p', { class: 'empty card' }, 'Aucune campagne. Commence par en créer une.')])
  );
}

const NETWORK_LABELS = { F: '1er', S: '2e', O: '3e+' };

// Campaigns saved before the place picker only kept bare geoUrn codes.
const geoOf = (c) =>
  c?.geo ?? (c?.geoUrns ?? []).map((id) => ({ id, label: id === '105015875' ? 'France' : `Lieu ${id}` }));

function filterSummary(c) {
  const parts = [];
  const geo = geoOf(c);
  const where = [...(c.places ?? []), ...geo.map((g) => g.label)];
  parts.push(where.length ? `lieu : ${where.join(', ')}` : 'sans filtre de lieu');
  if (c.network?.length) parts.push(`relations ${c.network.map((n) => NETWORK_LABELS[n] ?? n).join(', ')}`);
  if (c.currentCompanies?.length) parts.push(`chez ${c.currentCompanies.map((x) => x.label).join(', ')}`);
  if (c.pastCompanies?.length) parts.push(`anciens de ${c.pastCompanies.map((x) => x.label).join(', ')}`);
  if (c.industries?.length) parts.push(c.industries.map((x) => x.label).join(', '));
  if (c.titleFilter) parts.push('filtre Titre');
  if (c.requireCurrent) parts.push('poste actuel');
  return parts.join(' · ');
}

function editCampaign(c = null) {
  $('campaign-form').classList.remove('is-hidden');
  $('campaign-form-title').textContent = c ? `Modifier « ${c.name} »` : 'Nouvelle campagne';
  $('c-id').value = c?.id ?? '';
  $('c-name').value = c?.name ?? '';
  $('c-terms').value = (c?.terms ?? []).join('\n');
  $('c-exclusions').value = (c?.exclusions ?? []).join('\n');
  $('c-import-url').value = '';
  $('c-keywords').value = c?.keywords ?? '';
  $('c-places').value = (c?.places ?? []).join('\n');
  $('c-places-kw').checked = c?.placesInKeywords !== false;
  $('c-from-tab-status').classList.add('is-hidden');
  $('c-extra').value = c?.extraParams ?? '';
  $('c-pages').value = c?.maxPages ?? 10;
  $('c-delay').value = String(c?.delayMs ?? 15000);
  // New campaigns default to the stricter, more useful settings.
  $('c-require-current').checked = c ? Boolean(c.requireCurrent) : true;
  $('c-title-filter').checked = Boolean(c?.titleFilter);
  const network = c ? (c.network ?? []) : ['S'];
  for (const box of document.getElementsByName('c-network')) box.checked = network.includes(box.value);
  pickers.geo.set(geoOf(c));
  pickers.current.set(c?.currentCompanies ?? []);
  pickers.past.set(c?.pastCompanies ?? []);
  pickers.industry.set(c?.industries ?? []);
  updateKeywordsHint();
  updatePreview();
  $('c-name').focus();
}

function formCampaign() {
  const id = $('c-id').value || crypto.randomUUID();
  const existing = state.campaigns.find((c) => c.id === id);
  const geo = pickers.geo.get();
  return {
    ...existing,
    id,
    name: $('c-name').value.trim() || 'Sans nom',
    terms: lines($('c-terms').value),
    exclusions: lines($('c-exclusions').value),
    geo,
    geoUrns: geo.map((g) => g.id),
    currentCompanies: pickers.current.get(),
    pastCompanies: pickers.past.get(),
    industries: pickers.industry.get(),
    network: [...document.getElementsByName('c-network')].filter((b) => b.checked).map((b) => b.value),
    titleFilter: $('c-title-filter').checked,
    requireCurrent: $('c-require-current').checked,
    keywords: $('c-keywords').value.trim(),
    places: lines($('c-places').value),
    placesInKeywords: $('c-places-kw').checked,
    extraParams: $('c-extra').value.trim().replace(/^[?&]/, ''),
    maxPages: Math.min(Math.max(Number($('c-pages').value) || 10, 1), 1000),
    delayMs: Number($('c-delay').value) || 15000,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

function updateKeywordsHint() {
  $('c-keywords-hint').textContent = $('c-title-filter').checked
    ? 'vide = aucun mot-clé, seul le filtre Titre s’applique'
    : 'vide = générés depuis les titres';
}

async function saveCampaign({ run = false } = {}) {
  const campaign = formCampaign();
  const anyFilter =
    campaign.places.length ||
    campaign.geo.length || campaign.currentCompanies.length || campaign.pastCompanies.length || campaign.industries.length;
  if (!campaign.terms.length && !campaign.keywords && !anyFilter) {
    notify('Indique au moins un titre visé, des mots-clés ou un filtre.', true);
    return;
  }
  await db.put('campaigns', campaign);
  $('campaign-form').classList.add('is-hidden');
  notify(`Campagne « ${campaign.name} » enregistrée.`);
  await refresh();
  if (run) runCampaign(campaign.id);
}

async function deleteCampaign(c) {
  if (!confirm(`Supprimer la campagne « ${c.name} » ? Ses prospects sont conservés.`)) return;
  await db.remove('campaigns', c.id);
  await refresh();
}

function runCampaign(id) {
  notify('');
  send({ type: 'LPE_SEARCH_RUN', campaignId: id }).then((result) => {
    if (result && !result.ok) notify(result.error, true);
  });
}

/* ------------------------------------------------------------------ *
 * Filter pickers (LinkedIn typeahead)
 * ------------------------------------------------------------------ */

// A text box that asks LinkedIn for matching places / companies / industries
// and keeps the chosen ones as removable tags.
function makePicker(root) {
  const kind = root.dataset.kind;
  let items = [];
  let timer = null;
  let sequence = 0;

  const tags = h('div', { class: 'tags' });
  const menu = h('div', { class: 'suggest is-hidden' });
  const input = h('input', { type: 'text', placeholder: root.dataset.placeholder ?? '', autocomplete: 'off' });
  // No typing box: LinkedIn's suggestion API answers 400 to the current site.
  // Values come from « Récupérer depuis mon onglet LinkedIn » (or a pasted URL)
  // and can be removed here.
  const empty = h('span', { class: 'muted' }, '—');
  root.append(tags, empty);

  const hide = () => menu.classList.add('is-hidden');

  function render() {
    empty.hidden = items.length > 0;
    fill(
      tags,
      items.map((item) =>
        h(
          'span',
          { class: 'tag', title: `code ${item.id}` },
          item.label,
          h(
            'button',
            {
              type: 'button',
              class: 'tag-remove',
              title: 'Retirer',
              onclick: () => {
                items = items.filter((x) => x.id !== item.id);
                render();
                updatePreview();
              },
            },
            '×'
          )
        )
      )
    );
  }

  function choose(hit) {
    if (!items.some((x) => x.id === hit.id)) items.push({ id: hit.id, label: hit.label });
    input.value = '';
    hide();
    render();
    updatePreview();
    input.focus();
  }

  function show(children) {
    fill(menu, children);
    menu.classList.remove('is-hidden');
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 2) return hide();
    timer = setTimeout(async () => {
      const mine = ++sequence;
      show([h('div', { class: 'suggest-note' }, 'Recherche sur LinkedIn…')]);
      const result = await send({ type: 'LPE_TYPEAHEAD', kind, query });
      if (mine !== sequence) return; // a newer keystroke already asked
      if (!result?.ok) return show([h('div', { class: 'suggest-note is-error' }, result?.error ?? 'Échec.')]);
      if (!result.hits.length) return show([h('div', { class: 'suggest-note' }, 'Aucune suggestion.')]);
      show(
        result.hits.map((hit) =>
          h(
            'button',
            // mousedown fires before the input's blur hides the menu.
            {
              type: 'button',
              class: 'suggest-item',
              onmousedown: (e) => {
                e.preventDefault();
                choose(hit);
              },
            },
            hit.label
          )
        )
      );
    }, 350);
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
    if (e.key === 'Enter') {
      e.preventDefault(); // never submit the campaign form from here
      menu.querySelector('.suggest-item')?.dispatchEvent(new MouseEvent('mousedown'));
    }
  });

  return {
    get: () => items.map((x) => ({ ...x })),
    set: (list) => {
      items = (list ?? []).map((x) => ({ id: String(x.id), label: x.label ?? `code ${x.id}` }));
      input.value = '';
      hide();
      render();
    },
  };
}

const pickers = {
  geo: makePicker($('p-geo')),
  current: makePicker($('p-current')),
  past: makePicker($('p-past')),
  industry: makePicker($('p-industry')),
};

// Filter bar entries that name a filter rather than a chosen value.
const GENERIC_PILL =
  /^(personnes|people|1er|2e|3e( et)? ?\+?|tous les filtres|all filters|réinitialiser|reset|lieux|locations?|entreprises? actuelles?|current compan(y|ies)|anciennes entreprises|past compan(y|ies)|secteurs?|industr(y|ies)|recrutement actif|actively hiring|écoles?|schools?|relations?|connections?|abonnés? de|followers? of|services|langue.*|profile language|afficher les résultats|show results|annuler|cancel)(\s*\(?\d+\)?)?$/i;

// Takes filters from a search the user built by hand on LinkedIn: from a
// pasted URL, or read from their open search tab. Facets this form knows
// become tags; the rest stays in "Autres filtres". `pills` are the filter
// bar's texts, where LinkedIn shows the name of a single chosen value.
function importSearchUrl(text = $('c-import-url').value.trim(), pills = []) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return notify('URL LinkedIn invalide.', true);
  }
  if (!/linkedin\.com$/.test(url.hostname) || !url.pathname.startsWith('/search/results/')) {
    return notify('Colle une URL de recherche de personnes LinkedIn (/search/results/people/…).', true);
  }

  const params = new URLSearchParams(url.search);
  const list = (name) => {
    const raw = params.get(name);
    if (!raw) return null;
    params.delete(name);
    try {
      return JSON.parse(raw).map(String);
    } catch {
      return raw.split(',').map((x) => x.replace(/[^\w]/g, '')).filter(Boolean);
    }
  };

  const keywords = params.get('keywords');
  if (keywords) $('c-keywords').value = keywords;

  // Names shown in the filter bar, in its order: "Lieux" comes before
  // "Entreprises actuelles", and a single chosen value replaces the filter's
  // name. Past companies and industries live in "Tous les filtres" only, so
  // the bar never names them.
  const named = pills.filter((t) => !GENERIC_PILL.test(t) && !/^\d+$/.test(t));
  const geoCodes = params.get('geoUrn');
  let placeName = null;
  if (geoCodes && !/,/.test(geoCodes.replace(/^\[|\]$/g, ''))) {
    placeName = named.find((t) => t.includes(',')) ?? named[0] ?? null;
  }
  const otherNames = named.filter((t) => t !== placeName);

  // Keep the readable label of a code that is already picked; otherwise use
  // the filter bar's name when the facet has a single value.
  const assign = (picker, codes, fallback, name) => {
    if (!codes) return;
    const known = new Map(picker.get().map((x) => [x.id, x.label]));
    picker.set(
      codes.map((id) => ({
        id,
        label: known.get(id) ?? (codes.length === 1 && name ? name : fallback(id)),
      }))
    );
  };
  assign(pickers.geo, list('geoUrn'), (id) => geoOf({ geoUrns: [id] })[0].label, placeName);
  const current = list('currentCompany');
  const past = list('pastCompany');
  const industry = list('industry');
  const names = [...otherNames];
  assign(pickers.current, current, (id) => `Entreprise ${id}`, current?.length === 1 ? names.shift() : null);
  assign(pickers.past, past, (id) => `Entreprise ${id}`, null);
  assign(pickers.industry, industry, (id) => `Secteur ${id}`, null);
  const network = list('network');
  if (network) for (const box of document.getElementsByName('c-network')) box.checked = network.includes(box.value);

  for (const key of ['keywords', 'page', 'origin', 'sid', 'spellCorrectionEnabled', 'prevSearch']) {
    params.delete(key);
  }
  $('c-extra').value = params.toString();
  $('c-import-url').value = text;
  updatePreview();

  const unnamed = [...pickers.geo.get(), ...pickers.current.get(), ...pickers.past.get(), ...pickers.industry.get()].some(
    (x) => /^(Lieu|Entreprise|Secteur) \d+$/.test(x.label)
  );
  notify(
    'Filtres importés.' +
      (unnamed ? ' Les valeurs multiples sont nommées par leur code LinkedIn : la recherche les applique quand même.' : '') +
      (params.toString() ? ' Les filtres non gérés par le formulaire sont conservés dans « Autres filtres ».' : '')
  );
}

// The outcome is written under the button too: the page-level message sits
// at the top, out of sight while the campaign form is scrolled into view.
async function importFromTab() {
  const line = $('c-from-tab-status');
  line.classList.remove('is-hidden');
  line.textContent = 'Lecture de ton onglet LinkedIn…';
  try {
    const result = await ask({ type: 'LPE_TAB_FILTERS' });
    importSearchUrl(result.url, result.pills ?? []);
    const geo = pickers.geo.get().map((g) => g.label);
    line.textContent = `Repris : ${geo.length ? geo.join(', ') : 'aucun lieu'} · ${$('message').textContent}`;
  } catch (error) {
    line.textContent = `⚠ ${error.message ?? error}`;
  }
}

let previewTimer = null;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const result = await send({ type: 'LPE_SEARCH_URL', campaign: formCampaign() });
    const link = $('c-preview');
    link.href = result?.url ?? '#';
    link.textContent = result?.url ?? '';
  }, 200);
}

/* ------------------------------------------------------------------ *
 * Settings (Notion)
 * ------------------------------------------------------------------ */

// Draft edited by the settings form; persisted on "Enregistrer". Only the
// configuration keys: the sync bookkeeping (lastPullAt...) belongs to the worker.
const CONFIG_KEYS = ['token', 'databaseId', 'databaseTitle', 'schema', 'mapping', 'autoSync'];
let draft = null;

function renderSettings() {
  const n = state.notion ?? {};
  draft = Object.fromEntries(CONFIG_KEYS.map((k) => [k, structuredClone(n[k])]));
  draft.mapping ??= {};
  draft.schema ??= {};
  $('n-token').value = draft.token ?? '';
  $('o-quota').value = String(inviteQuota());
  $('n-auto').checked = draft.autoSync !== false;
  renderMapping();
  renderSyncInfo();
}

function renderMapping() {
  const block = $('n-mapping-block');
  block.classList.toggle('is-hidden', !draft?.databaseId);
  if (!draft?.databaseId) return;

  $('n-db-title').textContent = draft.databaseTitle || draft.databaseId;
  const properties = Object.entries(draft.schema ?? {});

  fill(
    $('n-mapping'),
    FIELDS.map((field) => {
      const options = properties.filter(([, type]) => COMPATIBLE[field.type].includes(type));
      const select = h(
        'select',
        {
          onchange: (e) => {
            draft.mapping[field.key] = e.target.value;
          },
        },
        field.type === 'title' ? null : h('option', { value: '' }, '—'),
        options.map(([name, type]) =>
          h('option', { value: name, selected: draft.mapping?.[field.key] === name }, `${name} (${type})`)
        )
      );
      return h('tr', {}, h('td', {}, field.label, field.pull ? ' ⇄' : ''), h('td', {}, select));
    })
  );
}

function renderSyncInfo() {
  const n = state.notion;
  const info = $('sync-info');
  const pending = state.prospects.filter((p) => p.dirty).length;
  $('sync-now').classList.toggle('is-hidden', !n?.databaseId);

  if (!n?.databaseId) {
    info.textContent = 'Notion non configuré';
  } else if (n.lastError) {
    info.textContent = `⚠ ${n.lastError}`;
  } else {
    info.textContent = [
      n.lastSyncAt ? `Notion : synchro ${relative(n.lastSyncAt)}` : 'Notion : jamais synchronisé',
      pending ? `${pending} en attente` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  $('n-state').textContent = info.textContent;
}

async function withButton(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    notify(String(error.message ?? error), true);
  } finally {
    button.disabled = false;
  }
}

function adoptDatabase(result) {
  draft = {
    ...draft,
    token: $('n-token').value.trim(),
    databaseId: result.databaseId,
    databaseTitle: result.databaseTitle,
    schema: result.schema,
    mapping: result.mapping,
  };
  renderMapping();
}

async function saveSettings() {
  draft.token = $('n-token').value.trim();
  draft.autoSync = $('n-auto').checked;
  if (draft.databaseId && !draft.mapping?.url) throw new Error('Associe le champ LinkedIn à une colonne : c’est la clé de synchronisation.');
  if (draft.databaseId && !draft.mapping?.name) throw new Error('Associe le champ Nom à la colonne titre.');

  const { notion: latest } = await chrome.storage.local.get('notion');
  const changedBase = latest?.databaseId !== draft.databaseId;
  const next = { ...latest, ...draft, lastError: null };
  // A different base: its edit history starts from zero.
  if (changedBase) next.lastPullAt = null;
  await chrome.storage.local.set({ notion: next });

  // Rows linked to another base must be pushed again, as new pages.
  if (changedBase && latest?.databaseId) {
    for (const p of state.prospects) await db.update('prospects', p.slug, (x) => ({ ...x, notionPageId: null, dirty: true }));
  } else if (changedBase) {
    for (const p of state.prospects.filter((x) => !x.dirty)) await db.update('prospects', p.slug, (x) => ({ ...x, dirty: true }));
  }

  await refresh();
  renderSettings();
  notify('Paramètres Notion enregistrés.');
}

async function syncNow() {
  notify('Synchronisation Notion…');
  const { result } = await ask({ type: 'LPE_NOTION_SYNC' });
  const parts = [`${result.pushed} envoyé(s)`, `${result.updated} mis à jour depuis Notion`];
  if (result.imported) parts.push(`${result.imported} importé(s) depuis Notion`);
  if (result.errors.length) parts.push(`${result.errors.length} erreur(s) : ${result.errors[0].error}`);
  notify(`Notion : ${parts.join(', ')}.`, result.errors.length > 0);
  await refresh();
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function toCsv(prospects) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const columns = [
    ['Nom', (p) => p.name],
    ['Prénom', (p) => p.firstName],
    ['LinkedIn', (p) => p.profileUrl || p.url],
    ['Titre', (p) => p.headline],
    ['Entreprise', (p) => p.company],
    ['Localisation', (p) => p.location],
    ['Relation', (p) => p.degree],
    ['Campagne', (p) => (p.campaignId ? campaignName(p.campaignId) : '')],
    ['Statut', (p) => p.status],
    ['Trouvé le', (p) => p.foundAt?.slice(0, 10)],
    ['Dernier contact', (p) => p.lastContactAt?.slice(0, 10)],
    ['Prochaine relance', (p) => p.nextFollowUpAt?.slice(0, 10)],
    ['Notes', (p) => p.notes],
  ];
  const head = columns.map(([name]) => escape(name)).join(',');
  const body = prospects.map((p) => columns.map(([, get]) => escape(get(p))).join(','));
  // BOM so Excel opens the accented characters correctly.
  return `﻿${head}\n${body.join('\n')}`;
}

/* ------------------------------------------------------------------ *
 * Today (outreach queue)
 * ------------------------------------------------------------------ */

// Texts edited in the queue, by prospect and step, so a re-render (a search
// page landing, a sync) never throws away what the user typed.
const drafts = new Map();
// Prospects whose LinkedIn tab is open and waiting for the user to send.
const inFlight = new Set();
let lastSnapshot = null;

const draftKey = (p, next) => `${p.slug}:${next.step}`;

function outreachQueue() {
  const filter = $('today-campaign').value;
  const campaigns = new Map(state.campaigns.map((c) => [c.id, c]));
  const day = seq.today();
  const queue = { followups: [], messages: [], invites: [], waiting: [], upcoming: [] };

  for (const p of state.prospects) {
    if (filter && (p.campaignId ?? 'none') !== filter) continue;
    if (p.status === 'Invité') {
      queue.waiting.push(p);
      continue;
    }
    const c = campaigns.get(p.campaignId);
    const next = seq.nextAction(p, c);
    if (!next) continue;
    const item = { p, c, next };
    if (next.dueOn > day) queue.upcoming.push(item);
    else if (next.action === 'invite') queue.invites.push(item);
    else if (next.step === 0) queue.messages.push(item);
    else queue.followups.push(item);
  }

  const byDue = (a, b) => a.next.dueOn.localeCompare(b.next.dueOn);
  queue.followups.sort(byDue);
  queue.messages.sort(byDue);
  queue.upcoming.sort(byDue);
  // Oldest finds first: the queue drains in the order people were found.
  queue.invites.sort((a, b) => String(a.p.foundAt).localeCompare(String(b.p.foundAt)));
  queue.waiting.sort((a, b) => String(a.invitedAt).localeCompare(String(b.invitedAt)));
  return queue;
}

const invitedToday = () => state.prospects.filter((p) => p.invitedAt?.slice(0, 10) === seq.today()).length;
const inviteQuota = () => Number(state.outreach?.inviteQuota) || 20;

async function prepare(p, next, text) {
  if (next.action === 'invite' && text.length > seq.NOTE_LIMIT) {
    return notify(`La note fait ${text.length} caractères : LinkedIn en accepte ${seq.NOTE_LIMIT} au maximum.`, true);
  }
  // Clipboard needs this click's user gesture: copy before leaving the page.
  await navigator.clipboard.writeText(text).catch(() => {});
  inFlight.add(p.slug);
  renderToday();
  const result = await send({ type: 'LPE_OUTREACH_START', slug: p.slug, action: next.action, step: next.step, text });
  if (!result?.ok) {
    inFlight.delete(p.slug);
    notify(result?.error ?? 'Impossible d’ouvrir LinkedIn.', true);
    renderToday();
  }
}

async function markSent(p, next, text) {
  await ask({ type: 'LPE_OUTREACH_MARK', slug: p.slug, action: next.action, step: next.step, text, withNote: true });
  drafts.delete(draftKey(p, next));
  notify(`${next.label} noté comme envoyé pour ${p.name}.`);
  await refresh();
}

function outreachRow({ p, c, next }) {
  const key = draftKey(p, next);
  const rendered = seq.render(next.template, p);
  const isInvite = next.action === 'invite';

  const counter = h('span', { class: 'counter' });
  const area = h('textarea', {
    rows: isInvite ? 3 : 5,
    value: drafts.get(key) ?? rendered.text,
    oninput: (e) => {
      drafts.set(key, e.target.value);
      count();
    },
  });
  function count() {
    if (!isInvite) return;
    counter.textContent = `${area.value.length}/${seq.NOTE_LIMIT}`;
    counter.classList.toggle('over', area.value.length > seq.NOTE_LIMIT);
  }
  count();

  const busy = inFlight.has(p.slug);
  const late = next.dueOn < seq.today();

  return h(
    'div',
    { class: 'card outreach-row' },
    h(
      'div',
      { class: 'outreach-head' },
      h(
        'div',
        { class: 'person', onclick: () => openDrawer(p.slug), title: 'Ouvrir la fiche' },
        avatar(p),
        h(
          'div',
          {},
          h('div', { class: 'person-name' }, p.name || p.slug, p.degree ? h('span', { class: 'badge' }, p.degree) : null),
          h('div', { class: 'person-sub' }, [p.headline, p.company].filter(Boolean).join(' · '))
        )
      ),
      h(
        'div',
        { class: 'outreach-meta' },
        h('b', {}, next.label),
        h('span', { class: 'muted' }, c?.name ?? 'Sans campagne'),
        late ? h('span', { class: 'late' }, `prévu le ${formatDate(next.dueOn)}`) : null
      )
    ),
    area,
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { class: 'primary', disabled: busy, onclick: () => prepare(p, next, area.value) },
        busy ? 'Ouvert sur LinkedIn…' : isInvite ? 'Préparer l’invitation' : `Préparer ${next.step === 0 ? 'le message' : 'la relance'}`
      ),
      h('button', { onclick: () => markSent(p, next, area.value) }, 'Marquer comme envoyé'),
      counter,
      rendered.missing.length ? h('span', { class: 'warn-inline' }, `variable vide : ${rendered.missing.join(', ')}`) : null
    )
  );
}

function waitingRow(p) {
  const days = p.invitedAt ? Math.floor((Date.now() - Date.parse(p.invitedAt)) / 86_400_000) : null;
  return h(
    'div',
    { class: 'waiting-row' },
    h(
      'div',
      { class: 'person', onclick: () => openDrawer(p.slug) },
      avatar(p),
      h('div', {}, h('div', { class: 'person-name' }, p.name), h('div', { class: 'person-sub' }, p.headline))
    ),
    h('span', { class: 'muted' }, days === null ? 'invité' : days === 0 ? "invité aujourd'hui" : `invité il y a ${days} j`),
    h('a', { href: p.profileUrl || p.url, target: '_blank', rel: 'noopener' }, 'Profil ↗'),
    h(
      'button',
      {
        onclick: async () => {
          await db.editProspect(p.slug, { status: 'Connecté', connectedAt: seq.today() });
          notify(`${p.name} passe en « Connecté » : le message 1 arrive dans la file.`);
          await refresh();
        },
      },
      'Invitation acceptée'
    )
  );
}

function section(title, hint, children, { empty } = {}) {
  return h(
    'section',
    { class: 'today-section' },
    h('h2', {}, title, hint ? h('span', { class: 'muted' }, ` ${hint}`) : null),
    children.length ? children : h('p', { class: 'muted' }, empty ?? 'Rien pour l’instant.')
  );
}

function renderToday() {
  const select = $('today-campaign');
  const current = select.value;
  fill(
    select,
    h('option', { value: '' }, 'Toutes les campagnes'),
    state.campaigns.map((c) => h('option', { value: c.id }, c.name))
  );
  select.value = current;

  const queue = outreachQueue();
  const quota = inviteQuota();
  const used = invitedToday();
  const remaining = Math.max(0, quota - used);
  const invites = queue.invites.slice(0, remaining);

  fill(
    $('today-summary'),
    h('span', { class: 'chip' }, 'Relances', h('b', {}, String(queue.followups.length))),
    h('span', { class: 'chip' }, 'Messages', h('b', {}, String(queue.messages.length))),
    h('span', { class: 'chip' }, 'Invitations du jour', h('b', {}, `${used}/${quota}`)),
    h('span', { class: 'chip' }, 'En attente d’acceptation', h('b', {}, String(queue.waiting.length)))
  );
  $('today-diagnostic').classList.toggle('is-hidden', !lastSnapshot);

  fill(
    $('today-sections'),
    section('Relances', `(${queue.followups.length})`, queue.followups.map(outreachRow), {
      empty: 'Aucune relance à envoyer aujourd’hui.',
    }),
    section('Messages', `(${queue.messages.length}) — relations acceptées`, queue.messages.map(outreachRow), {
      empty: 'Aucun nouveau contact : marque les invitations acceptées plus bas.',
    }),
    section(
      'Invitations',
      remaining
        ? `(${invites.length} sur ${queue.invites.length} en file · quota restant ${remaining})`
        : `(quota du jour atteint · ${queue.invites.length} en file)`,
      invites.map(outreachRow),
      { empty: remaining ? 'Aucun nouveau prospect à inviter.' : 'Reviens demain, ou augmente le quota dans Paramètres.' }
    ),
    section('En attente d’acceptation', `(${queue.waiting.length})`, queue.waiting.slice(0, 50).map(waitingRow), {
      empty: 'Aucune invitation en attente.',
    }),
    queue.upcoming.length
      ? section(
          'À venir',
          `(${queue.upcoming.length})`,
          queue.upcoming.slice(0, 20).map(({ p, next }) =>
            h('div', { class: 'waiting-row' }, h('span', {}, p.name), h('span', { class: 'muted' }, `${next.label} le ${formatDate(next.dueOn)}`))
          )
        )
      : null
  );
}

function onOutreachStatus(message) {
  const who = message.name ?? '';
  switch (message.kind) {
    case 'sent':
      inFlight.delete(message.slug);
      for (const key of [...drafts.keys()]) if (key.startsWith(`${message.slug}:`)) drafts.delete(key);
      notify(
        message.action === 'invite'
          ? `✓ Invitation envoyée à ${who}${message.withNote === false ? ' (sans note)' : ''}.`
          : `✓ Message envoyé à ${who}.`
      );
      refresh();
      break;
    case 'cancel':
      inFlight.delete(message.slug);
      renderToday();
      break;
    case 'no-note':
      notify(`${who} : LinkedIn ne propose plus de note (quota mensuel atteint). Tu peux envoyer l’invitation sans note.`, true);
      break;
    case 'already-connected':
      inFlight.delete(message.slug);
      notify(`${who} est déjà dans tes relations : passé en « Connecté », le message 1 est dans la file.`);
      refresh();
      break;
    case 'already-invited':
      inFlight.delete(message.slug);
      notify(`${who} a déjà une invitation en attente : passé en « Invité ».`);
      refresh();
      break;
    case 'not-connected':
      notify(`${who} n’est pas dans tes relations : l’invitation avec note est préparée à la place du message.`);
      refresh();
      break;
    case 'inmail':
      notify(
        `${who} n’est pas (encore) dans tes relations : LinkedIn propose un InMail payant au lieu d’une ` +
          'conversation. Si l’invitation n’a pas vraiment été acceptée, repasse ce prospect en « Invité ».',
        true
      );
      break;
    case 'failed':
      lastSnapshot = message.snapshot ?? null;
      notify(
        `${who} : je n’ai pas trouvé où écrire sur LinkedIn. Clique « Réessayer » dans l’encadré de la page ` +
          'LinkedIn, ou envoie le texte à la main (il est dans ton presse-papier) puis « Marquer comme envoyé ».',
        true
      );
      renderToday();
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Messages (sequence editor)
 * ------------------------------------------------------------------ */

let seqDraft = null;
let seqCampaignId = null;

function renderSequenceEditor({ reload = false } = {}) {
  const select = $('seq-campaign');
  fill(select, state.campaigns.map((c) => h('option', { value: c.id }, c.name)));
  if (!state.campaigns.length) {
    fill($('seq-editor'), h('p', { class: 'muted' }, 'Crée d’abord une campagne : chaque campagne a sa propre séquence.'));
    fill($('seq-preview'));
    return;
  }
  if (!state.campaigns.some((c) => c.id === seqCampaignId)) {
    seqCampaignId = state.campaigns[0].id;
    reload = true;
  }
  select.value = seqCampaignId;
  const campaign = state.campaigns.find((c) => c.id === seqCampaignId);
  if (reload || !seqDraft) seqDraft = structuredClone(seq.sequenceOf(campaign));

  const noteCount = h('span', { class: 'counter' });
  const countNote = () => {
    const n = seqDraft.invite.note.length;
    noteCount.textContent = `${n}/${seq.NOTE_LIMIT} caractères (avant remplacement des variables)`;
    noteCount.classList.toggle('over', n > seq.NOTE_LIMIT);
  };
  countNote();

  fill(
    $('seq-editor'),
    h('h3', {}, 'Note d’invitation'),
    h('textarea', {
      rows: 4,
      value: seqDraft.invite.note,
      oninput: (e) => {
        seqDraft.invite.note = e.target.value;
        countNote();
        renderSequencePreview();
      },
    }),
    noteCount,
    seqDraft.steps.map((step, i) =>
      h(
        'div',
        { class: 'seq-step' },
        h(
          'div',
          { class: 'row' },
          h(
            'label',
            {},
            'Étape',
            h('input', {
              value: step.label,
              oninput: (e) => {
                step.label = e.target.value;
                renderSequencePreview();
              },
            })
          ),
          h(
            'label',
            {},
            i === 0 ? 'Jours après acceptation' : 'Jours après l’étape précédente',
            h('input', {
              type: 'number',
              min: 0,
              max: 90,
              value: String(step.delayDays ?? 0),
              oninput: (e) => {
                step.delayDays = Math.max(0, Number(e.target.value) || 0);
              },
            })
          ),
          i > 0
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'link danger',
                  onclick: () => {
                    seqDraft.steps.splice(i, 1);
                    renderSequenceEditor();
                  },
                },
                'Retirer'
              )
            : null
        ),
        h('textarea', {
          rows: 6,
          value: step.body,
          oninput: (e) => {
            step.body = e.target.value;
            renderSequencePreview();
          },
        })
      )
    )
  );

  const prospects = state.prospects.filter((p) => p.campaignId === seqCampaignId).slice(0, 50);
  const previewSelect = $('seq-preview-prospect');
  const chosen = previewSelect.value;
  fill(
    previewSelect,
    prospects.length
      ? prospects.map((p) => h('option', { value: p.slug }, p.name || p.slug))
      : h('option', { value: '' }, 'Exemple (aucun prospect dans cette campagne)')
  );
  if (prospects.some((p) => p.slug === chosen)) previewSelect.value = chosen;

  fill(
    $('seq-variables'),
    seq.VARIABLES.map(([key, label]) => h('li', {}, h('code', {}, `{{${key}}}`), ` — ${label}`))
  );
  renderSequencePreview();
}

const SAMPLE = {
  name: 'Camille Martin',
  firstName: 'Camille',
  company: 'Acme',
  headline: 'Directrice administrative et financière',
  location: 'Lille, Hauts-de-France, France',
};

function renderSequencePreview() {
  if (!seqDraft) return;
  const slug = $('seq-preview-prospect').value;
  const p = state.prospects.find((x) => x.slug === slug) ?? SAMPLE;
  const block = (title, template, limit) => {
    const { text, missing } = seq.render(template, p);
    return h(
      'div',
      { class: 'preview-block' },
      h('h3', {}, title, limit ? h('span', { class: text.length > limit ? 'counter over' : 'counter' }, ` ${text.length}/${limit}`) : null),
      h('div', { class: 'preview-text' }, text || '—'),
      missing.length ? h('p', { class: 'warn-inline' }, `Variable vide pour ce prospect : ${missing.join(', ')}`) : null
    );
  };
  fill(
    $('seq-preview'),
    block('Note d’invitation', seqDraft.invite.note, seq.NOTE_LIMIT),
    seqDraft.steps.map((step) => block(`${step.label} (J+${step.delayDays ?? 0})`, step.body))
  );
}

async function saveSequence() {
  const campaign = state.campaigns.find((c) => c.id === seqCampaignId);
  if (!campaign) return;
  if (seqDraft.invite.note.length > seq.NOTE_LIMIT + 60) {
    notify('La note d’invitation est bien trop longue pour LinkedIn (200 caractères une fois les variables remplies).', true);
    return;
  }
  await db.put('campaigns', { ...campaign, sequence: structuredClone(seqDraft) });
  drafts.clear(); // queue texts were rendered from the old templates
  notify(`Séquence de « ${campaign.name} » enregistrée.`);
  await refresh();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function switchTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  for (const panel of ['today', 'prospects', 'campaigns', 'messages', 'settings']) {
    $(`panel-${panel}`).classList.toggle('is-hidden', panel !== name);
  }
  if (name !== 'prospects') closeDrawer();
  if (name === 'settings') renderSettings();
  if (name === 'messages') renderSequenceEditor({ reload: true });
  try {
    localStorage.setItem('lpe-tab', name);
  } catch {
    /* storage blocked */
  }
  renderAll();
}

function renderAll() {
  renderFilters();
  renderProspects();
  renderCampaigns();
  // Never rebuild the queue under a textarea the user is typing in.
  if (!$('today-sections').contains(document.activeElement)) renderToday();
  renderSyncInfo();
  renderJob();
  if (state.openSlug) renderDrawer({ force: false });
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
}

for (const id of ['filter-text', 'filter-campaign', 'filter-region', 'filter-status']) {
  $(id).addEventListener('input', () => {
    state.limit = PAGE_SIZE;
    renderProspects();
  });
}

$('more').addEventListener('click', () => {
  state.limit += PAGE_SIZE;
  renderProspects();
});

$('check-all').addEventListener('change', (e) => {
  for (const p of filtered()) {
    if (e.target.checked) state.selected.add(p.slug);
    else state.selected.delete(p.slug);
  }
  renderProspects();
});

$('bulk-status').addEventListener('change', async (e) => {
  const status = e.target.value;
  e.target.value = '';
  if (status) await setStatus([...state.selected], status);
});

$('bulk-enrich').addEventListener('click', () => enrich([...state.selected]));

$('bulk-delete').addEventListener('click', async () => {
  const slugs = [...state.selected];
  if (!confirm(`Supprimer ${slugs.length} prospect(s) de la base locale ? Leurs lignes Notion ne sont pas supprimées.`)) return;
  await db.remove('prospects', slugs);
  state.selected.clear();
  await refresh();
});

$('bulk-clear').addEventListener('click', () => {
  state.selected.clear();
  renderProspects();
});

$('export-csv').addEventListener('click', () => {
  const list = filtered();
  if (list.length) download(`prospects-${today()}.csv`, toCsv(list), 'text/csv');
});

$('campaign-new').addEventListener('click', () => editCampaign());
$('campaign-form').addEventListener('submit', (e) => {
  e.preventDefault();
  saveCampaign();
});
$('c-save-run').addEventListener('click', () => saveCampaign({ run: true }));
$('c-cancel').addEventListener('click', () => $('campaign-form').classList.add('is-hidden'));
$('c-import').addEventListener('click', () => importSearchUrl());
$('c-from-tab').addEventListener('click', (e) => withButton(e.target, importFromTab));
for (const id of ['c-terms', 'c-keywords', 'c-extra', 'c-places']) $(id).addEventListener('input', updatePreview);
$('c-places-kw').addEventListener('change', updatePreview);
for (const box of document.getElementsByName('c-network')) box.addEventListener('change', updatePreview);
$('c-title-filter').addEventListener('change', () => {
  updateKeywordsHint();
  updatePreview();
});

$('today-campaign').addEventListener('change', renderToday);
$('today-diagnostic').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(lastSnapshot, null, 2)).catch(() => {});
  notify('Diagnostic copié dans le presse-papier.');
});

$('seq-campaign').addEventListener('change', (e) => {
  seqCampaignId = e.target.value;
  renderSequenceEditor({ reload: true });
});
$('seq-preview-prospect').addEventListener('change', renderSequencePreview);
$('seq-add').addEventListener('click', () => {
  if (!seqDraft) return;
  seqDraft.steps.push({ label: `Relance ${seqDraft.steps.length}`, delayDays: 7, body: '' });
  renderSequenceEditor();
});
$('seq-defaults').addEventListener('click', () => {
  if (!seqDraft || !confirm('Remplacer les textes de cette séquence par les modèles par défaut ?')) return;
  seqDraft = structuredClone(seq.DEFAULT_SEQUENCE);
  renderSequenceEditor();
});
$('seq-save').addEventListener('click', (e) => withButton(e.target, saveSequence));

$('o-save').addEventListener('click', async () => {
  const inviteQuota = Math.min(Math.max(Number($('o-quota').value) || 20, 1), 100);
  const { outreach } = await chrome.storage.local.get('outreach');
  await chrome.storage.local.set({ outreach: { ...outreach, inviteQuota } });
  notify(`Quota : ${inviteQuota} invitations par jour.`);
  await refresh();
});

$('job-stop').addEventListener('click', () => {
  send({ type: 'LPE_JOB_STOP' });
  $('job-detail').textContent = 'Arrêt après la page en cours…';
});

$('n-test').addEventListener('click', (e) =>
  withButton(e.target, async () => {
    const { bot } = await ask({ type: 'LPE_NOTION_TEST', token: $('n-token').value.trim() });
    notify(`Token valide : intégration « ${bot} ».`);
  })
);

$('n-load').addEventListener('click', (e) =>
  withButton(e.target, async () => {
    const result = await ask({
      type: 'LPE_NOTION_LOAD',
      token: $('n-token').value.trim(),
      databaseUrl: $('n-database').value.trim(),
    });
    adoptDatabase(result);
    notify(`Base « ${result.databaseTitle} » chargée. Vérifie les colonnes puis enregistre.`);
  })
);

$('n-create').addEventListener('click', (e) =>
  withButton(e.target, async () => {
    const result = await ask({
      type: 'LPE_NOTION_CREATE',
      token: $('n-token').value.trim(),
      pageUrl: $('n-page').value.trim(),
    });
    adoptDatabase(result);
    await saveSettings();
    notify('Base « Prospects LinkedIn » créée dans Notion et enregistrée.');
  })
);

$('n-save').addEventListener('click', (e) => withButton(e.target, saveSettings));
$('sync-now').addEventListener('click', (e) => withButton(e.target, syncNow));

$('d-export').addEventListener('click', () => {
  download(
    `prospects-${today()}.json`,
    JSON.stringify({ campaigns: state.campaigns, prospects: state.prospects }, null, 2),
    'application/json'
  );
});

$('d-wipe').addEventListener('click', async () => {
  if (!confirm(`Supprimer les ${state.prospects.length} prospects de la base locale ? Notion n'est pas modifié.`)) return;
  await db.remove('prospects', state.prospects.map((p) => p.slug));
  state.selected.clear();
  await refresh();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'LPE_STATUS') {
    renderJob(message.status);
    if (!message.status.running) refresh();
  }
  if (message?.type === 'LPE_DATA_CHANGED' || message?.type === 'LPE_SYNC_DONE') refresh();
  if (message?.type === 'LPE_OUTREACH_STATUS') onOutreachStatus(message);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.notion) {
    state.notion = changes.notion.newValue ?? null;
    renderSyncInfo();
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

await load();
let initialTab = 'today';
try {
  initialTab = localStorage.getItem('lpe-tab') || 'today';
} catch {
  /* storage blocked */
}
switchTab(initialTab);
const { status } = await chrome.storage.local.get('status');
if (status?.running) renderJob(status);
setInterval(renderSyncInfo, 60_000);
