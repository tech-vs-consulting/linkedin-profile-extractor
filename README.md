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

## Comment ça marche

| Fichier | Rôle |
|---|---|
| `injected.js` | Monde **MAIN**, `document_start`. Patche `fetch` et `XMLHttpRequest` pour copier chaque réponse `/voyager/api/…` vers le content script via `postMessage`. |
| `content.js` | Monde **ISOLATED**. Collecte les payloads, lit aussi les blocs `<code id="bpr-guid-…">` du rendu initial, normalise, et retombe sur le DOM si besoin. |
| `background.js` | Service worker. Cycle de vie des onglets en mode liste, stockage, anti-éviction du worker pendant un batch. |
| `popup.*` | UI : extraction, liste des résultats, export. |

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
