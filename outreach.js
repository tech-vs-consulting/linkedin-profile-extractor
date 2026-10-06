// Outreach panel and driver, isolated world.
//
// On every LinkedIn profile a small panel (bottom right) shows whether the
// person is a prospect, their status, and buttons to prepare an invitation or
// a message by hand, or to correct the status. The dashboard's "Préparer"
// opens a profile with a job already attached.
//
// Preparing = Connect → (add a note) → note text, or Message → text. It stops
// there: the user reviews and presses "Envoyer", and that send is reported,
// which is what moves the prospect along.
(() => {
  if (window.__lpeOutreach) return;
  window.__lpeOutreach = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) =>
    Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  // A control can carry its meaning in its text or only in its aria-label.
  const labelsOf = (el) => [norm(el.getAttribute('aria-label')), norm(el.innerText ?? el.textContent)].filter(Boolean);
  const labelOf = (el) => labelsOf(el)[0] ?? '';
  const matches = (el, patterns) => labelsOf(el).some((label) => patterns.some((p) => p.test(label)));

  const CONNECT = [
    /^se connecter$/i,
    /^connect$/i,
    /^invite[rz]? .* (à|a) rejoindre votre réseau/i, // "Inviter Antoine … à rejoindre votre réseau"
    /^invite .* to connect/i,
  ];
  const MORE = [/^plus$/i, /^more$/i, /^plus d.actions/i, /^more actions/i];
  const PENDING = [/^en attente$/i, /^pending$/i, /retirer l.invitation|withdraw invitation/i];
  const ADD_NOTE = [/^ajouter une note$/i, /^add a note$/i, /ajouter une note personnalisée/i];
  const SEND_NO_NOTE = [/envoyer sans (une )?note/i, /send without (a )?note/i];
  const MESSAGE = [/^message$/i, /^envoyer un message/i, /^message .+/i];
  const FOLLOW = [/^suivre$/i, /^follow$/i, /^s.abonner$/i];
  const YES = [/^oui$/i, /^yes$/i];
  const DISMISS = [
    /^(fermer|ignorer|plus tard|pas maintenant|non,? merci|passer|dismiss|close|not now|skip|no,? thanks|maybe later)\b/i,
  ];
  const SEND = /^(envoyer|send)\b/i;

  let job = null;
  let name = ''; // person on this page, kept after a job ends for the panel title
  let filled = false;
  let reported = new Set();
  let lastClick = 0;
  let startedAt = 0;
  let failed = false;
  let lastSnapshot = null;
  let dismissed = []; // popins closed on the way, for the diagnostic
  let lastConnectClick = 0;
  let moreTries = 0;
  let beforeMenu = new Set(); // Connect-like controls present before opening "Plus"
  let pageInfo = null; // what the worker knows about the person on this page

  const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

  function report(kind, detail = {}) {
    if (kind !== 'sent' && reported.has(kind)) return;
    reported.add(kind);
    send({ type: 'LPE_OUTREACH_EVENT', kind, ...detail });
  }

  /* ---------------------------------------------------------------- *
   * Finding things
   * ---------------------------------------------------------------- */

  const clickables = (root = document) =>
    [...root.querySelectorAll('button, a, [role="button"], [role="menuitem"]')].filter(
      (el) => visible(el) && !panel?.contains(el)
    );

  // A menu item often wraps the real button with the same label: take the
  // innermost match, the one that actually handles the click.
  function findAll(patterns, root = document) {
    const found = clickables(root).filter((el) => matches(el, patterns));
    return found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
  }
  const find = (patterns, root = document) => findAll(patterns, root)[0] ?? null;

  const onProfile = () => /^\/in\/[^/]+/.test(location.pathname);
  const onMessaging = () => location.pathname.startsWith('/messaging/');
  const pageSlug = () => {
    const match = location.pathname.match(/^\/in\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  function nameHeading() {
    const main = document.querySelector('main') ?? document.body;
    const headings = [...main.querySelectorAll('h1, h2')].filter(visible);
    const first = norm(name).split(' ')[0]?.toLowerCase();
    // No `first && …` here: with no name yet it yields '' and '' ?? x is ''.
    const byName = first ? headings.find((h) => norm(h.textContent).toLowerCase().startsWith(first)) : null;
    // The React profile titles the person with an h2 (there is no h1).
    return byName ?? main.querySelector('h1') ?? headings[0] ?? null;
  }

  // The profile's own card: the closest ancestor of the name heading that
  // holds action buttons. Climbing no further keeps the sidebar ("Autres
  // profils consultés", with Connect buttons of its own) out of it.
  const ACTIONS = [...CONNECT, ...MESSAGE, ...MORE, ...PENDING, ...FOLLOW];
  function topCard() {
    const heading = nameHeading();
    let node = heading;
    for (let depth = 0; node && depth < 10; depth += 1) {
      node = node.parentElement;
      if (node && clickables(node).some((el) => matches(el, ACTIONS))) return node;
    }
    return heading?.closest('section') ?? document.querySelector('main') ?? document.body;
  }

  // Degree badge of the card ("· 1er", "1st"): the only reliable sign of an
  // existing relation. Premium shows "Message" to non-relations too.
  // Read element by element: the badge is its own small text node, and the
  // card's text as a whole can glue it to the next word ("1erDirecteur").
  function degreeIn(card) {
    if (!card) return '';
    for (const el of card.querySelectorAll('*')) {
      // LinkedIn keeps a hidden "· 1er" next to the visible "· 2e" badge:
      // only what is actually displayed counts.
      if (el.childElementCount || panel?.contains(el) || !visible(el)) continue;
      const text = norm(el.textContent);
      if (!text || text.length > 40) continue;
      if (/(^|[\s•·])(1er|1st)(\s|$)/i.test(text)) return '1er';
      if (/(^|[\s•·])(2e|2nd)(\s|$)/i.test(text)) return '2e';
      if (/(^|[\s•·])(3e\+?|3rd\+?)(\s|$)/i.test(text)) return '3e+';
    }
    return '';
  }

  // Modals come marked in several ways; the new interface uses the native
  // <dialog> element, which carries no role attribute.
  const DIALOGS =
    '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], .artdeco-modal, [data-test-modal]';

  // Outermost visible modals only (a <dialog> can wrap a role="dialog" div).
  function dialogs() {
    const all = [...document.querySelectorAll(DIALOGS)].filter((box) => visible(box) && !panel?.contains(box));
    return all.filter((box) => !all.some((other) => other !== box && other.contains(box)));
  }

  // The messaging bubble docked at the bottom of every page is marked as a
  // dialog too: it is never the popin in the way.
  const isMessagingDock = (box) =>
    Boolean(box.closest('aside, [class*="msg-overlay"]')) || /messag/i.test(box.getAttribute('aria-label') ?? '');

  const dialog = () => dialogs().filter((box) => !isMessagingDock(box)).pop() ?? null;

  // Any writable box that looks like a message body: rich editors
  // (contenteditable in any of its forms) and plain textareas.
  function messageEditor() {
    const editors = [
      ...document.querySelectorAll('[contenteditable]:not([contenteditable="false"]), textarea'),
    ].filter((el) => {
      if (!visible(el) || el.disabled || el.readOnly || panel?.contains(el)) return false;
      const hints = `${el.className} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`;
      return (
        el.getAttribute('role') === 'textbox' ||
        /msg-form|message|compose|écrire|write/i.test(hints) ||
        Boolean(el.closest('[class*="msg-form"], form')) ||
        onMessaging()
      );
    });
    return editors.pop() ?? null;
  }

  const editorText = (el) => norm(el?.tagName === 'TEXTAREA' ? el.value : (el?.innerText ?? el?.textContent));

  // The InMail composer is the only one with a subject field.
  const SUBJECT =
    'input[name*="subject" i], input[placeholder*="objet" i], input[placeholder*="subject" i], input[aria-label*="objet" i]';
  const subjectField = () => [...document.querySelectorAll(SUBJECT)].find(visible) ?? null;

  const asksForNote = (box) => /note/i.test(norm(box.innerText ?? box.textContent)) && Boolean(find(YES, box));

  const isInviteDialog = (box) =>
    Boolean(box.querySelector('textarea') || find(ADD_NOTE, box) || find(SEND_NO_NOTE, box) || asksForNote(box));

  // The invitation dialog, whichever of the page's modals it is (the
  // messaging bubble is one too). Failing any modal marking, found from its
  // own "Ajouter une note" / "Envoyer sans note" controls.
  let knownInviteBox = null;

  function inviteBox() {
    const marked = dialogs().find(isInviteDialog);
    if (marked) return (knownInviteBox = marked);
    // Once "Ajouter une note" is clicked, its button is gone: keep the block
    // found before, as long as it is still on screen.
    if (knownInviteBox?.isConnected && visible(knownInviteBox) && noteField(knownInviteBox)) return knownInviteBox;
    knownInviteBox = null;
    const field = [...document.querySelectorAll('textarea')].find(
      (el) =>
        visible(el) &&
        !panel?.contains(el) &&
        /note|message|invitation/i.test(`${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''}`)
    );
    const control = field ?? find(ADD_NOTE) ?? find(SEND_NO_NOTE);
    if (!control || control.closest('aside')) return null;
    // Climb to the block that also holds the question or the note wording.
    let node = control.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (node.querySelectorAll('button').length >= 2 && /note|invitation/i.test(norm(node.textContent))) {
        return (knownInviteBox = node);
      }
    }
    return (knownInviteBox = control.parentElement);
  }

  // The note field: a textarea, or a rich editor in newer layouts.
  const noteField = (box) =>
    [...box.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"])')].find(visible) ?? null;

  const isInMail = (box) =>
    Boolean(box.querySelector(SUBJECT)) ||
    (/inmail/i.test(norm(box.innerText ?? box.textContent)) && Boolean(box.querySelector('textarea, [contenteditable]')));

  function click(el) {
    lastClick = Date.now();
    el.scrollIntoView?.({ block: 'center' });
    el.click();
  }

  // A popin LinkedIn put in front of the page (news, Premium offer...): close
  // it rather than work underneath it. A few tries at most.
  function dismissBlocking(box) {
    if (Date.now() - lastClick < 1500 || dismissed.length >= 4) return false;
    const close =
      find(DISMISS, box) ??
      box.querySelector(
        'button[aria-label*="fermer" i], button[aria-label*="close" i], button[aria-label*="dismiss" i], .artdeco-modal__dismiss'
      );
    if (!close || !visible(close)) return false;
    dismissed.push(labelOf(close) || '×');
    click(close);
    status('Fenêtre LinkedIn fermée, je continue…');
    return true;
  }

  /* ---------------------------------------------------------------- *
   * Filling
   * ---------------------------------------------------------------- */

  // React tracks the value through the native setter: assigning .value alone
  // leaves its state empty and "Envoyer" disabled.
  function fillTextarea(area, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    area.focus();
    setter.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Rich editors ignore .textContent; insertText goes through their input
  // pipeline, and insertParagraph gives real line breaks without a keypress
  // (Enter could send the message).
  function fillEditor(editor, text) {
    if (editor.tagName === 'TEXTAREA') return fillTextarea(editor, text);
    editor.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line) document.execCommand('insertText', false, line);
      if (i < lines.length - 1) document.execCommand('insertParagraph', false);
    });
    // Editor that refused focus or execCommand: set the text and announce it.
    if (!editorText(editor)) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return;
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ---------------------------------------------------------------- *
   * Invitation
   * ---------------------------------------------------------------- */

  function stepInvite() {
    const invite = inviteBox();
    if (invite) return inviteDialog(invite);

    const box = dialog();
    if (box) {
      // Right after "Se connecter" the invitation dialog can still be empty:
      // give it a moment before calling it a popin in the way.
      if (Date.now() - lastConnectClick < 5000) return;
      if (dismissBlocking(box)) return;
    }

    if (!onProfile()) return;
    const card = topCard();
    if (find(PENDING, card)) {
      status('Une invitation est déjà en attente pour cette personne.');
      report('already-invited');
      return endJob();
    }
    if (degreeIn(card) === '1er') {
      status('Vous êtes déjà en relation : le prospect passe en « Connecté ».');
      report('already-connected');
      return endJob();
    }

    // LinkedIn ignores script clicks on "Se connecter" (checked live: the
    // click lands, nothing opens). That control is only a link to the
    // invitation page, which opens the "Ajouter une note" dialog by itself:
    // go there directly, for the person on this page.
    const vanity = [pageSlug(), job.vanity].find((v) => v && !/^ACoA/.test(v));
    if (!job.triedPreload && vanity) {
      job.triedPreload = true;
      send({ type: 'LPE_OUTREACH_EVENT', kind: 'progress', patch: { triedPreload: true } });
      status('Ouverture de l’invitation…');
      location.assign(`https://www.linkedin.com/preload/custom-invite/?vanityName=${encodeURIComponent(vanity)}`);
      return;
    }

    // Fallbacks, for layouts where the controls do react to scripts.
    if (Date.now() - lastClick < 2500) return;
    const connect = find(CONNECT, card);
    if (connect) {
      lastConnectClick = Date.now();
      return click(connect);
    }
    // "Se connecter" hidden under "Plus": open it, then take the Connect
    // control that appeared (the menu can render anywhere in the page).
    const appeared = findAll(CONNECT).filter((el) => !beforeMenu.has(el) && !el.closest('aside'));
    if (moreTries > 0 && appeared.length) {
      lastConnectClick = Date.now();
      return click(appeared[0]);
    }
    const more = find(MORE, card);
    if (more && moreTries < 2) {
      beforeMenu = new Set(findAll(CONNECT));
      moreTries += 1;
      return click(more);
    }
  }

  function inviteDialog(box) {
    const area = noteField(box);
    if (area) {
      // The real limit is the dialog's counter ("54/200"), not its wording
      // ("limitez votre note à 300 caractères") nor a maxlength it lacks.
      const counter = norm(box.innerText ?? box.textContent).match(/(\d+)\s*\/\s*(\d{2,4})\b/);
      const max =
        area.tagName === 'TEXTAREA' && area.maxLength > 0 ? area.maxLength : counter ? Number(counter[2]) : Infinity;
      const quota = norm(box.innerText ?? box.textContent).match(/il vous reste (\d+) invitations? personnalisées?/i);
      const text = job.text.length > max ? job.text.slice(0, max) : job.text;
      fillEditor(area, text); // handles textareas and rich editors
      if (!editorText(area)) return; // not accepting input yet: next tick
      filled = true;
      status(
        (text.length < job.text.length
          ? `Note coupée à ${max} caractères (limite LinkedIn). Relis-la puis clique « Envoyer ».`
          : 'Note prête. Relis-la puis clique « Envoyer ».') +
          (quota ? ` Notes personnalisées restantes ce mois-ci : ${quota[1]}.` : '')
      );
      report('filled', { truncated: text.length < job.text.length });
      return;
    }
    const addNote = find(ADD_NOTE, box) ?? (asksForNote(box) ? find(YES, box) : null);
    if (addNote) {
      if (Date.now() - lastClick > 1500) click(addNote);
      return;
    }
    if (find(SEND_NO_NOTE, box) && Date.now() - lastClick > 2500) {
      // The dialog offers no note at all: the monthly quota of notes is used up.
      filled = true;
      status('LinkedIn ne propose plus d’ajouter une note (quota atteint). Tu peux envoyer l’invitation sans note.');
      report('no-note');
    }
  }

  /* ---------------------------------------------------------------- *
   * Message
   * ---------------------------------------------------------------- */

  function stepMessage() {
    const box = dialog();
    if ((box && isInMail(box)) || (onMessaging() && subjectField())) {
      // Not a relation: "Message" opened a paid InMail. Spending a credit is
      // the user's call, so fill nothing; still follow a manual send.
      filled = true;
      status(
        `Tu n’es pas en relation avec ${name || 'cette personne'} : LinkedIn propose un InMail (crédit ` +
          'Premium). Utilise plutôt « Préparer l’invitation », ou envoie l’InMail toi-même.'
      );
      report('inmail');
      return;
    }
    if (box && !box.querySelector('[contenteditable], textarea') && dismissBlocking(box)) return;

    const editor = messageEditor();
    if (editor) {
      fillEditor(editor, job.text);
      if (!editorText(editor)) return; // not ready yet (still loading): next tick
      filled = true;
      status('Message prêt. Relis-le puis clique « Envoyer ».');
      report('filled');
      return;
    }
    // On the compose page, just wait for its editor: there is no profile
    // button to click there.
    if (!onProfile() || Date.now() - lastClick < 3000) return;

    const card = topCard();
    if (find(PENDING, card)) {
      status(`L’invitation à ${name} n’a pas encore été acceptée : pas de message pour l’instant.`);
      report('already-invited');
      return endJob();
    }
    // Not a relation after all: "Message" would only open a paid InMail.
    if (degreeIn(card) !== '1er' && find(CONNECT, card)) return switchToInvite();

    const button = find(MESSAGE, card);
    if (!button) return;
    // "Message" is a link to the compose page: follow it rather than rely on
    // a script click, which LinkedIn may ignore (it does for "Se connecter").
    const href = button.closest('a')?.getAttribute('href');
    if (href && /\/messaging\//.test(href)) {
      lastClick = Date.now();
      location.assign(new URL(href, location.origin).href);
      return;
    }
    click(button);
  }

  // The worker turns the job into an invitation carrying the campaign's note.
  let switching = false;
  async function switchToInvite() {
    if (switching) return;
    switching = true;
    status(`Tu n’es pas en relation avec ${name} : je prépare plutôt une invitation avec note.`);
    const reply = await send({ type: 'LPE_OUTREACH_EVENT', kind: 'not-connected' });
    switching = false;
    if (!reply?.ok || !reply.job) return;
    job = reply.job;
    startedAt = Date.now(); // a fresh time budget for the invitation
  }

  /* ---------------------------------------------------------------- *
   * Job loop
   * ---------------------------------------------------------------- */

  let running = false;

  function begin(newJob) {
    job = newJob;
    name = job.name || name;
    filled = false;
    failed = false;
    reported = new Set();
    dismissed = [];
    lastClick = 0;
    moreTries = 0;
    beforeMenu = new Set();
    render();
    run();
  }

  async function run() {
    if (running) return;
    running = true;
    startedAt = Date.now();
    status(job.action === 'invite' ? 'Préparation de l’invitation…' : 'Ouverture de la conversation…');
    while (job && !filled) {
      if (Date.now() - startedAt > 30_000) {
        failed = true;
        lastSnapshot = snapshot();
        status(
          'Je n’ai pas trouvé où écrire. « Réessayer » relance la préparation ; sinon écris à la main ' +
            '(le texte est dans ton presse-papier) puis « Marquer comme envoyé ».'
        );
        report('failed', { snapshot: lastSnapshot });
        break;
      }
      try {
        if (job.action === 'invite') stepInvite();
        else stepMessage();
      } catch {
        /* the page re-rendered under us: next tick */
      }
      await sleep(700);
    }
    running = false;
    render();
  }

  // Same job, same tab, from the top: after closing a popin by hand, or once
  // the page has finished loading.
  function retry() {
    if (job) begin(job);
  }

  function endJob() {
    job = null;
    render();
    setTimeout(refreshInfo, 800); // the status just changed
  }

  function snapshot() {
    const card = topCard();
    return {
      url: location.href,
      title: document.title,
      action: job?.action,
      name,
      degree: degreeIn(card),
      cardButtons: clickables(card).map((el) => labelsOf(el).join(' | ')).slice(0, 20),
      connectAnywhere: findAll(CONNECT).map((el) => (el.closest('aside') ? 'aside' : 'main')).slice(0, 10),
      inviteBoxFound: Boolean(inviteBox()),
      noteControls: findAll([...ADD_NOTE, ...SEND_NO_NOTE, ...YES]).map((el) => labelsOf(el).join(' | ')),
      dialogs: dialogs()
        .map((box) => ({
          tag: `${box.tagName.toLowerCase()}${box.getAttribute('role') ? `[role=${box.getAttribute('role')}]` : ''}`,
          text: norm(box.innerText ?? box.textContent).slice(0, 300),
          buttons: clickables(box).map(labelOf).slice(0, 12),
        })),
      dismissed,
      editors: document.querySelectorAll('[contenteditable]').length,
      textareas: document.querySelectorAll('textarea').length,
    };
  }

  /* ---------------------------------------------------------------- *
   * Send detection
   * ---------------------------------------------------------------- */

  // After "Envoyer", LinkedIn may load another page (compose → thread) and
  // this script dies with the old one. So the worker hears "sending" at once:
  // if the next page of this tab asks for its job, it is told the send went
  // through instead of preparing the same message a second time.
  let confirming = false;

  async function confirmSent(withNote) {
    if (confirming || !job) return;
    confirming = true;
    send({ type: 'LPE_OUTREACH_EVENT', kind: 'sending', withNote });
    await sleep(1500);
    const done = job?.action === 'invite' ? !inviteBox() : !editorText(messageEditor());
    confirming = false;
    if (!job) return;
    if (!done) {
      send({ type: 'LPE_OUTREACH_EVENT', kind: 'not-sent' });
      return;
    }
    status('Envoyé ✓');
    report('sent', { withNote });
    endJob();
  }

  document.addEventListener(
    'click',
    (event) => {
      if (!job || !filled) return;
      const button = event.target.closest?.('button');
      if (!button || panel?.contains(button)) return;
      if (!labelsOf(button).some((label) => SEND.test(label))) return;
      confirmSent(!matches(button, SEND_NO_NOTE));
    },
    true
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (!job || !filled || job.action !== 'message') return;
      if (event.key === 'Enter' && !event.shiftKey && event.target.closest?.('[contenteditable], textarea')) {
        confirmSent(true);
      }
    },
    true
  );

  /* ---------------------------------------------------------------- *
   * Panel (shadow DOM: LinkedIn's CSS cannot reach it)
   * ---------------------------------------------------------------- */

  let panel = null;
  let ui = null;
  let statusText = '';
  let collapsed = false;
  try {
    collapsed = localStorage.getItem('lpe-panel-collapsed') === '1';
  } catch {
    /* storage blocked */
  }

  function status(text) {
    statusText = text;
    render();
  }

  function build() {
    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = panel.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .box { width: 330px; padding: 12px 14px; border-radius: 10px; background: #1b1d21; color: #e9eaec;
               font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgb(0 0 0 / 30%); }
        .head { display: flex; align-items: center; gap: 8px; }
        .title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .info { margin-top: 4px; color: #9aa1ab; font-size: 12px; }
        .text { margin-top: 6px; color: #c9ccd1; }
        .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
        button, select { padding: 6px 10px; border: 1px solid #383c43; border-radius: 7px; background: #24272c;
                         color: #e9eaec; font: inherit; cursor: pointer; }
        button.primary { border-color: transparent; background: #4a9eea; color: #fff; font-weight: 600; }
        button.link { padding: 0; border: 0; background: none; color: #9aa1ab; text-decoration: underline; }
        button.toggle { padding: 0 6px; border: 0; background: none; color: #9aa1ab; font-size: 16px; }
        select { width: 100%; }
        .pill { padding: 6px 12px; border-radius: 999px; background: #1b1d21; color: #e9eaec; border: 1px solid #383c43;
                font: 600 12px system-ui, sans-serif; box-shadow: 0 4px 14px rgb(0 0 0 / 30%); cursor: pointer; }
        [hidden] { display: none !important; }
      </style>
      <button class="pill" data-el="pill">Prospection</button>
      <div class="box" data-el="box">
        <div class="head">
          <div class="title" data-el="title"></div>
          <button class="toggle" data-el="collapse" title="Réduire">–</button>
        </div>
        <div class="info" data-el="info"></div>
        <div class="text" data-el="text"></div>
        <div class="row" data-el="idle">
          <button class="primary" data-act="invite">Préparer l’invitation</button>
          <button data-act="message">Préparer le message</button>
        </div>
        <div class="row" data-el="statusRow">
          <select data-el="status" title="Corriger le statut"></select>
        </div>
        <div class="row" data-el="busy">
          <button data-act="retry">Réessayer</button>
          <button class="primary" data-act="mark">Marquer comme envoyé</button>
          <button data-act="cancel">Annuler</button>
        </div>
        <div class="row"><button class="link" data-act="diagnostic">Copier le diagnostic</button></div>
      </div>`;
    const el = (key) => root.querySelector(`[data-el="${key}"]`);
    const act = (key) => root.querySelector(`[data-act="${key}"]`);
    ui = {
      root,
      pill: el('pill'),
      box: el('box'),
      title: el('title'),
      info: el('info'),
      text: el('text'),
      idle: el('idle'),
      statusRow: el('statusRow'),
      status: el('status'),
      busy: el('busy'),
      retry: act('retry'),
      diagnostic: act('diagnostic'),
      invite: act('invite'),
      message: act('message'),
    };

    ui.pill.addEventListener('click', () => setCollapsed(false));
    el('collapse').addEventListener('click', () => setCollapsed(true));
    // Any failure shows in the panel: a silent click is the worst outcome.
    const guarded = (action) => () =>
      startFromPage(action).catch((error) => status(`Erreur : ${error?.message ?? error}`));
    ui.invite.addEventListener('click', guarded('invite'));
    ui.message.addEventListener('click', guarded('message'));
    ui.status.addEventListener('change', async (e) => {
      const value = e.target.value;
      if (!value) return;
      await send({ type: 'LPE_PAGE_SET_STATUS', candidates: candidates(), name, headline: headline(), status: value });
      status(`Statut corrigé : ${value}.`);
      refreshInfo();
    });
    ui.retry.addEventListener('click', retry);
    act('mark').addEventListener('click', () => {
      report('sent', { withNote: job?.action !== 'invite' || !reported.has('no-note'), manual: true });
      status('Noté comme envoyé ✓');
      endJob();
    });
    act('cancel').addEventListener('click', () => {
      report('cancel');
      status('Annulé.');
      endJob();
    });
    ui.diagnostic.addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(lastSnapshot ?? snapshot(), null, 2)).catch(() => {});
      status('Diagnostic copié : colle-le à Claude.');
    });
    document.documentElement.append(panel);
  }

  function setCollapsed(value) {
    collapsed = value;
    try {
      localStorage.setItem('lpe-panel-collapsed', value ? '1' : '0');
    } catch {
      /* storage blocked */
    }
    render();
  }

  function render() {
    // Shown on profiles, and wherever a job is running (the compose page).
    const wanted = onProfile() || Boolean(job);
    if (!wanted) {
      panel?.remove();
      panel = null;
      return;
    }
    if (!panel || !panel.isConnected) build();

    ui.pill.hidden = !collapsed;
    ui.box.hidden = collapsed;

    const who = pageInfo?.prospect?.name || name || 'ce profil';
    ui.title.textContent = `Prospection · ${who}`;

    const p = pageInfo?.prospect;
    ui.info.textContent = p
      ? [`Statut : ${p.status}`, p.campaign ? `campagne ${p.campaign}` : null, pageInfo.next ? `prochaine étape : ${pageInfo.next.label}` : null]
          .filter(Boolean)
          .join(' · ')
      : pageInfo
        ? 'Pas encore dans tes prospects (il sera ajouté au premier envoi).'
        : '';
    ui.text.textContent = statusText;

    const busy = Boolean(job);
    const stuck = busy && (failed || reported.has('inmail'));
    ui.idle.hidden = busy || !onProfile();
    ui.statusRow.hidden = busy || !onProfile();
    ui.busy.hidden = !busy;
    ui.retry.hidden = !stuck;
    ui.diagnostic.hidden = !(stuck || failed);
    ui.message.textContent = pageInfo?.message ? `Préparer : ${pageInfo.message.label}` : 'Préparer le message';

    const statuses = pageInfo?.statuses ?? [];
    ui.status.replaceChildren(
      new Option(p ? `Corriger le statut (${p.status})…` : 'Définir le statut…', ''),
      ...statuses.map((s) => new Option(s, s))
    );
  }

  /* ---------------------------------------------------------------- *
   * Page ↔ worker
   * ---------------------------------------------------------------- */

  function headline() {
    const card = topCard();
    const lines = [...card.querySelectorAll('p, div')]
      .map((el) => norm(el.childElementCount ? '' : el.textContent))
      .filter((t) => t && t.length > 8 && !t.startsWith(norm(name)));
    return lines[0] ?? '';
  }

  // The page's own slug, then member ids (ACoA...) found in the page, which
  // is how people found through search are keyed.
  function candidates() {
    const list = [];
    const slug = pageSlug();
    if (slug) list.push(slug);
    const ids = document.documentElement.innerHTML.match(/ACoA[A-Za-z0-9_-]{20,}/g) ?? [];
    for (const id of ids) if (!list.includes(id)) list.push(id);
    return list.slice(0, 12);
  }

  async function refreshInfo(attempt = 0) {
    if (!onProfile()) return render();
    const heading = nameHeading();
    if (!name && heading) name = norm(heading.textContent);
    // The profile may not have rendered its name yet: look again shortly.
    if (!name && attempt < 5) return setTimeout(() => refreshInfo(attempt + 1), 1500);
    // The profile's own portrait, read by content.js (same isolated world):
    // it corrects a photo taken wrongly from a search card.
    const photo = typeof topCardPortrait === 'function' ? topCardPortrait(name) : null;
    const reply = await send({ type: 'LPE_PAGE_INFO', candidates: candidates(), name, photo });
    if (reply?.ok) {
      pageInfo = reply;
      if (reply.prospect?.name) name = reply.prospect.name;
    }
    render();
  }

  async function startFromPage(action) {
    const heading = nameHeading();
    if (heading) name = norm(heading.textContent);
    const reply = await send({
      type: 'LPE_PAGE_START',
      action,
      candidates: candidates(),
      name,
      headline: headline(),
    });
    if (!reply?.ok || !reply.job) {
      status(reply?.error ?? 'Impossible de préparer : recharge la page.');
      return;
    }
    await navigator.clipboard.writeText(reply.job.text).catch(() => {});
    statusText = '';
    begin(reply.job);
  }

  async function poll() {
    const reply = await send({ type: 'LPE_OUTREACH_PENDING' });
    if (reply?.ok && reply.job && !job) begin(reply.job);
  }

  async function boot() {
    // Let the profile render its name before reading it.
    await sleep(1200);
    await poll();
    await refreshInfo();
  }

  boot();

  // LinkedIn navigates in-page (profile → profile, profile → messaging).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (job) return render();
    name = '';
    pageInfo = null;
    statusText = '';
    boot();
  }, 1000);
})();
