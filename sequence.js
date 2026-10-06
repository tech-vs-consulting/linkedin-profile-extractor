// Outreach sequence shared by the dashboard and the service worker: templates,
// variables, what each prospect is due for next, and the state change once a
// step has been sent.

// The invitation dialog counts to 200 (checked live), whatever its wording says.
export const NOTE_LIMIT = 200;

// Statuses that end the sequence: nothing more is ever proposed.
export const FINAL_STATUSES = new Set(['A répondu', 'Pas intéressé', 'Ne plus contacter']);

export const DEFAULT_SEQUENCE = {
  invite: {
    note:
      'Bonjour {{prenom}}, j’échange régulièrement avec des directions financières ' +
      'et votre parcours chez {{entreprise}} a retenu mon attention. Au plaisir d’être en relation !',
  },
  steps: [
    {
      label: 'Message 1',
      delayDays: 0,
      body:
        'Merci pour la mise en relation, {{prenom}}.\n\n' +
        '[Présente ici ton offre en deux phrases.]\n\n' +
        'Seriez-vous ouvert à un échange de 15 minutes dans les prochains jours ?',
    },
    {
      label: 'Relance 1',
      delayDays: 5,
      body: 'Bonjour {{prenom}}, je me permets de revenir vers vous au sujet de mon précédent message. Qu’en pensez-vous ?',
    },
    {
      label: 'Relance 2',
      delayDays: 7,
      body: 'Dernier message de ma part, {{prenom}} : si le sujet n’est pas d’actualité chez {{entreprise}}, je ne vous relancerai plus. Belle journée !',
    },
  ],
};

export const VARIABLES = [
  ['prenom', 'Prénom'],
  ['nom', 'Nom complet'],
  ['entreprise', 'Entreprise'],
  ['poste', 'Poste (ou titre du profil)'],
  ['ville', 'Ville'],
];

export const sequenceOf = (campaign) => campaign?.sequence ?? DEFAULT_SEQUENCE;

function valuesFor(prospect) {
  return {
    prenom: prospect.firstName || (prospect.name ?? '').split(/\s+/)[0] || '',
    nom: prospect.name ?? '',
    entreprise: prospect.company ?? '',
    poste: prospect.currentTitle || prospect.headline || '',
    ville: (prospect.location ?? '').split(',')[0].trim(),
  };
}

// Fills {{variables}}; `missing` lists the ones that had no value, so the UI
// can warn before "chez ," goes out.
export function render(template, prospect) {
  const values = valuesFor(prospect);
  const missing = new Set();
  // An empty variable takes its little lead-in word with it: "votre parcours
  // chez {{entreprise}} a retenu" must not become "chez a retenu".
  const text = String(template ?? '').replace(
    /(\s(?:chez|at|de|d’|d'|à|au|pour|in)\s+)?\{\{\s*(\w+)\s*\}\}/gi,
    (all, lead, key) => {
      const name = key.toLowerCase();
      if (!(name in values)) return all;
      if (!values[name]) {
        missing.add(name);
        return lead ? ' ' : '';
      }
      return `${lead ?? ''}${values[name]}`;
    }
  );
  // An empty variable leaves "chez ," behind: drop the space before , and .
  // only — French keeps it before ! and ?.
  return { text: text.replace(/[ \t]+([,.])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim(), missing: [...missing] };
}

export const today = () => new Date().toISOString().slice(0, 10);

export function addDays(dateText, days) {
  const date = new Date(`${String(dateText).slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

const isConnected = (p) => p.status === 'Connecté' || (p.status === 'Nouveau' && p.degree === '1er');

// The next step for a prospect: { action: 'invite' | 'message', step, label,
// template, dueOn } or null when nothing is to be sent (waiting, finished...).
export function nextAction(prospect, campaign) {
  if (FINAL_STATUSES.has(prospect.status)) return null;
  const sequence = sequenceOf(campaign);

  if (prospect.status === 'Nouveau' && !isConnected(prospect)) {
    return { action: 'invite', step: -1, label: 'Invitation', template: sequence.invite?.note ?? '', dueOn: today() };
  }

  if (isConnected(prospect) && (prospect.sequenceStep ?? -1) < 0) {
    const first = sequence.steps[0];
    if (!first) return null;
    const since = prospect.connectedAt ?? today();
    return { action: 'message', step: 0, label: first.label, template: first.body, dueOn: addDays(since, first.delayDays) };
  }

  if (prospect.status === 'Message envoyé' || prospect.status === 'Relancé') {
    // A status set by hand before the sequence existed counts as message 1.
    const step = (prospect.sequenceStep ?? 0) + 1;
    const next = sequence.steps[step];
    if (!next) return null;
    const dueOn =
      prospect.nextFollowUpAt?.slice(0, 10) ?? addDays(prospect.lastContactAt ?? today(), next.delayDays);
    return { action: 'message', step, label: next.label, template: next.body, dueOn };
  }

  return null; // 'Invité': waiting for the acceptance
}

// Field changes once a step has been sent (applied on top of the prospect).
export function sentPatch(prospect, campaign, { action, step, text, withNote = true }) {
  const now = new Date().toISOString();
  const history = [...(prospect.history ?? []), { at: now, action, step, label: action === 'invite' ? 'Invitation' : sequenceOf(campaign).steps[step]?.label, text: withNote ? text : '' }];

  if (action === 'invite') {
    return { status: 'Invité', invitedAt: now, lastContactAt: today(), history };
  }

  const next = sequenceOf(campaign).steps[step + 1];
  return {
    status: step === 0 ? 'Message envoyé' : 'Relancé',
    sequenceStep: step,
    connectedAt: prospect.connectedAt ?? (step === 0 ? today() : null),
    lastContactAt: today(),
    nextFollowUpAt: next ? addDays(today(), next.delayDays) : null,
    history,
  };
}
