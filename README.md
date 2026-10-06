# LinkedIn Profile Extractor

Extension Chrome (Manifest V3) qui extrait, depuis une page de profil LinkedIn :
photo, nom, titre, localisation, poste et entreprise actuels, historique complet
des postes (avec dates) et formations. Export JSON / CSV.

## Installation

1. Ouvre `chrome://extensions`
2. Active **Mode développeur** (en haut à droite)
3. **Charger l'extension non empaquetée** → sélectionne ce dossier
4. Épingle l'icône dans la barre d'outils

Chrome 111 minimum (l'extension utilise `world: "MAIN"` dans le manifest).

## Utilisation

**Un profil** — ouvre `linkedin.com/in/…`, clique l'icône, puis *Extraire ce profil*.

**En cas de problème** — le bouton *Diagnostic* produit un rapport JSON (sources
JSON disponibles, types d'entités, structure DOM réellement trouvée, statut des
pages `/details/`) et le copie dans le presse-papier.

**Plusieurs profils** — onglet *Liste*, colle une URL par ligne, choisis la pause,
*Lancer*. L'extension ouvre chaque profil dans un onglet d'arrière-plan, extrait,
ferme l'onglet, attend, passe au suivant.

Les résultats s'accumulent dans `chrome.storage.local` et sont dédupliqués par
slug (ré-extraire un profil met à jour sa fiche).

## Prospection (dashboard)

Bouton **Dashboard** dans le popup : une page de l'extension ouverte dans un onglet.

**Campagnes** — une campagne = des *titres visés* (CFO, DAF, Directeur administratif et
financier…), des *exclusions* (ex-CFO, assistant…) et des filtres LinkedIn :

- **Relations** 1er / 2e / 3e et + (2e par défaut). Hors réseau, LinkedIn masque le nom
  (« Utilisateur LinkedIn ») et le lien du profil : ces cartes sont comptées, pas enregistrées.
- **Villes / régions** (texte libre, une par ligne) : seules les personnes dont la
  localisation affichée contient un de ces noms sont gardées. Par défaut ils sont aussi
  ajoutés aux mots-clés de la recherche LinkedIn, pour ne pas parcourir tout le pays.
- **Récupérer depuis mon onglet LinkedIn** : reprend tous les filtres de la recherche de
  personnes faite à la main dans LinkedIn (lieux, relations, entreprises, secteurs, filtres
  Premium). Les suggestions à la saisie ont été retirées : l'API de suggestions de LinkedIn
  répond 400 depuis la nouvelle version du site.
- **Filtre Titre** : envoie les titres visés dans le champ « Titre » de LinkedIn plutôt que
  dans les mots-clés libres — seul l'intitulé du poste compte.
- **Poste actuel obligatoire** (par défaut) : écarte les résultats où LinkedIn indique
  « Postes précédents », c'est-à-dire que le titre recherché n'est plus leur poste.
- **Importer les filtres** d'une URL de recherche faite à la main : les filtres connus
  deviennent des étiquettes, les autres restent tels quels dans « Autres filtres ».

*Lancer la recherche* ouvre la recherche de personnes dans un onglet d'arrière-plan,
lit chaque page de résultats (10 personnes), passe à la suivante après une pause
aléatoire, et s'arrête à la dernière page, au nombre de pages max, ou si LinkedIn
affiche la limite d'utilisation commerciale. Un résultat n'est gardé que si son titre
contient un des titres visés (mot entier, sans tenir compte des accents ni des
majuscules) et aucune exclusion.

**Prospects** — table filtrable (texte, campagne, statut), statut modifiable en ligne,
fiche détaillée (notes, dernier contact, prochaine relance), actions groupées, export
CSV. *Extraire le profil complet* lance l'extraction existante (historique des postes,
formations) sur les prospects choisis — chaque profil consomme une consultation.

Retrouver quelqu'un met à jour sa carte sans toucher à son statut, ses notes ni sa
campagne d'origine.

**Messages** — pour chaque campagne, une séquence : *note d'invitation* (200 caractères
maximum), *Message 1* (après acceptation), puis des relances avec leur délai en jours.
Variables : `{{prenom}}`, `{{nom}}`, `{{entreprise}}`, `{{poste}}`, `{{ville}}`. Aperçu avec
un vrai prospect ; une variable vide est signalée avant l'envoi.

**Aujourd'hui** — la file du jour : relances arrivées à échéance, messages aux relations
acceptées, invitations (dans la limite du quota quotidien réglé dans *Paramètres*, 20 par
défaut), invitations en attente d'acceptation. Chaque texte est modifiable avant l'envoi.

L'envoi est **semi-automatique** : *Préparer* ouvre le profil dans un onglet, clique
« Se connecter » → « Ajouter une note » et remplit la note (ou ouvre la conversation et
remplit le message), puis s'arrête. Tu relis et cliques « Envoyer » : l'extension le détecte,
met le statut à jour (Invité, Message envoyé, Relancé), calcule la prochaine relance, ferme
l'onglet et te ramène au dashboard. Le texte est aussi copié dans le presse-papier ; si la
page n'a pas pu être préparée, colle-le à la main puis *Marquer comme envoyé*.

**Panneau sur LinkedIn** — sur chaque profil, un panneau en bas à droite indique si la
personne est dans tes prospects (statut, campagne, prochaine étape) et propose
*Préparer l'invitation*, *Préparer le message* et *Corriger le statut*, même pour un profil
ouvert à la main (il est alors ajouté aux prospects). Pendant une préparation :
*Réessayer*, *Marquer comme envoyé*, *Annuler*, *Copier le diagnostic*. Le panneau se
réduit en pastille.

Une relation existante n'est reconnue qu'au badge « 1er » du profil : en Premium, le
bouton « Message » s'affiche aussi pour des non-relations (InMail). Si « Préparer le
message » tombe sur quelqu'un qui n'est pas en relation, l'invitation avec note est
préparée à la place.

L'acceptation d'une invitation n'est pas encore détectée : dans *En attente d'acceptation*,
clique *Invitation acceptée* (ou passe le statut à « Connecté ») pour que le message 1 entre
dans la file. Une relation déjà existante ou une invitation déjà en attente est reconnue
sur le profil et le statut est corrigé.

**Notion** (*Paramètres*) — colle le token d'une intégration interne, puis crée la base
dans une page (colonnes créées automatiquement) ou charge une base existante et
choisis quelle colonne reçoit chaque champ. La base locale reste la copie de travail :

- tout champ associé est envoyé vers Notion ;
- *Statut*, *Notes*, *Dernier contact* et *Prochaine relance* sont aussi relus depuis
  Notion : une modification faite dans Notion revient dans le dashboard ;
- une ligne ajoutée à la main dans Notion (avec une URL LinkedIn) est importée ;
- en cas de modification des deux côtés, la plus récente gagne.

La synchro tourne après chaque recherche, toutes les 15 min, et sur le bouton
*Synchroniser Notion*. La clé de rapprochement est l'URL LinkedIn.

## Comment ça marche

| Fichier | Rôle |
|---|---|
| `injected.js` | Monde **MAIN**, `document_start`. Patche `fetch` et `XMLHttpRequest` pour copier chaque réponse `/voyager/api/…` vers le content script via `postMessage`. |
| `content.js` | Monde **ISOLATED**. Collecte les payloads, lit aussi les blocs `<code id="bpr-guid-…">` du rendu initial, normalise, et retombe sur le DOM si besoin. |
| `background.js` | Service worker. Cycle de vie des onglets en mode liste, stockage, anti-éviction du worker pendant un batch. |
| `search.js` | Monde **ISOLATED**, après `content.js` (dont il réutilise les helpers). Lit une page de résultats de recherche : entités Voyager `EntityResultViewModel` si présentes, sinon le DOM. |
| `db.js` | IndexedDB partagée par le service worker et le dashboard : `prospects` (clé = slug) et `campaigns`. |
| `notion.js` | Client Notion (débit limité à ~3 req/s, `Retry-After` respecté) et synchro dans les deux sens. |
| `outreach.js` | Monde **ISOLATED**. Sur l'onglet ouvert par *Préparer* : ouvre l'invitation ou la conversation, remplit le texte, détecte le clic sur « Envoyer ». |
| `sequence.js` | Séquence partagée dashboard / service worker : modèles, variables, prochaine étape de chaque prospect, changement d'état après un envoi. |
| `dashboard.*` | Page de l'extension : file du jour, prospects, campagnes, séquences, paramètres. |
| `popup.*` | UI : extraction, liste des résultats, export, accès au dashboard. |

LinkedIn sert aujourd'hui deux interfaces différentes à la même URL, et
l'extension gère les deux.

**Interface React (actuelle)** — classes CSS hachées, aucun appel `/voyager/api/`,
aucun bloc `<code>` embarqué. Deux sources :

1. **Pages `/details/experience/` et `/details/education/`** récupérées en `fetch`
   same-origin (option *Historique complet*, activée par défaut). LinkedIn y rend la
   liste **complète** côté serveur ; le HTML est parsé sans rien afficher ni scroller.
   C'est la voie principale, et elle marche aussi dans un onglet en arrière-plan.
2. **La page de profil elle-même**, en secours. Les sections n'y sont montées qu'au
   scroll, et c'est `<main>` qui défile, pas le document : l'extension repère le vrai
   conteneur et le fait défiler jusqu'à l'apparition de la section Expérience.

Le parseur s'appuie sur ce qui survit aux déploiements, jamais sur les classes :
les entrées `[componentkey^="entity-collection-item"]`, les `<p>` de texte, la
description `[data-testid="expandable-text-box"]`, les liens `/company/…` et les
libellés de logo (`Logo de …`). Les postes groupés (plusieurs rôles chez un même
employeur, en `<ul>` imbriquée) donnent une entrée par rôle.

**Interface Ember (ancienne)** — JSON Voyager intercepté ou embarqué dans des
blocs `<code>`, avec dates typées ; repli DOM sur les classes `t-bold` / `t-14`.

Le champ `dataSource` de chaque profil indique `voyager` ou `dom`.

## Format de sortie

```json
{
  "slug": "exemple",
  "url": "https://www.linkedin.com/in/exemple/",
  "name": "Prénom Nom",
  "headline": "…",
  "location": "Paris, Île-de-France",
  "photo": "https://media.licdn.com/dms/image/…",
  "currentTitle": "Head of Engineering",
  "currentCompany": "ACME",
  "positions": [
    {
      "title": "Head of Engineering",
      "company": "ACME",
      "companyUrl": "https://www.linkedin.com/company/1234/",
      "companyUrn": "urn:li:fsd_company:1234",
      "location": "Paris · Hybride",
      "employmentType": "CDI",
      "description": "Texte complet, retours à la ligne conservés",
      "start": { "month": 3, "year": 2022, "label": "03/2022" },
      "end": null,
      "current": true,
      "rawDates": "mars 2022 - aujourd’hui · 3 ans 7 mois",
      "source": "dom"
    }
  ],
  "education": [ { "school": "…", "degree": "…", "field": "…", "start": …, "end": … } ],
  "extractedAt": "2026-09-27T10:00:00.000Z",
  "dataSource": "voyager"
}
```

## Limites connues

- **Le schéma bouge.** Sur les profils servis par la nouvelle interface React,
  LinkedIn n'embarque plus de blocs `<code>` et ne passe plus par `/voyager/api/` :
  les deux sources JSON rendent zéro et seul le parseur DOM travaille. Le champ
  `dataSource` vaut alors `dom`. Les dates y sont reconstruites depuis le texte
  affiché (mois FR et EN), ce qui reste moins sûr qu'un `dateRange` typé.
- **Chargement paresseux.** Les sections ne sont montées qu'à l'approche du
  viewport. L'extension déroule la page et attend l'apparition de la section
  Expérience (jusqu'à 25 s) avant de lire — c'est la partie la plus lente.
- **Postes groupés** (plusieurs rôles chez le même employeur) : gérés par les deux
  voies. Chaque rôle devient une entrée, l'employeur et le lieu du groupe étant
  reportés sur chacune.
- **Profils hors réseau** : LinkedIn masque une partie des informations selon ton
  degré de connexion. L'extension ne voit que ce que ta session voit.
- **Résultats de recherche** : le parseur DOM de la recherche a été écrit sans accès
  à LinkedIn et validé sur des pages de test. Si une recherche rend 0 résultat alors que
  LinkedIn en affiche, ouvre la page de recherche, clique *Diagnostic* dans le popup et
  partage le rapport.
- **Photos** : les URL d'images LinkedIn sont signées et expirent au bout de quelques
  semaines ; une nouvelle recherche ou extraction les rafraîchit.
- **Quota de consultations** : LinkedIn limite le nombre de profils consultés par
  jour, plus strictement sur un compte gratuit.

## À savoir avant de t'en servir

- L'article 8.2 des CGU LinkedIn interdit le scraping et les bots. *hiQ v. LinkedIn*
  a écarté le volet pénal (CFAA) pour les données publiques, mais la violation
  contractuelle demeure : le risque concret est la restriction ou la suppression du
  compte.
- Un usage manuel ou semi-manuel passe inaperçu. Une boucle sur des centaines de
  profils déclenche les protections anti-automatisation — d'où la pause aléatoire
  entre chaque profil, à ne pas descendre trop bas.
- Si tu stockes ces données depuis l'UE, tu es responsable de traitement au sens du
  RGPD : base légale, information des personnes, durée de conservation, droit
  d'opposition.
