# Architecture de la base commune

La version 0.9.10 possède un seul contrôleur (`src/core/background/state-machine.ts`),
un seul modèle d'état, une interface popup et assistance partagée, ainsi que trente
catalogues dans `assets/_locales`. Le projet contient toutes les sources et ressources
nécessaires aux trois constructions.

## Frontière entre le cœur et les navigateurs

Les contrats sous `src/platform/contracts` exposent les promesses de stockage,
alarmes, identité Web, messagerie, proxy, authentification du proxy, protections et
informations du navigateur. Les appels natifs `chrome.*` et `browser.*` sont réservés
aux adaptateurs et aux tests. ESLint et les audits vérifient cette séparation.

Vite résout `@platform/*` vers `chromium` ou `firefox`. Il ne détecte pas le navigateur
pour choisir le code métier à l'exécution. Chrome et Edge utilisent le même adaptateur,
les mêmes entrées et les mêmes ressources ; seules leurs clés de manifeste diffèrent.
Leur identité produit réelle, pour les appareils et diagnostics, est lue par l'adaptateur.

Le moteur PKCE reste commun. Le lancement natif et le domaine de callback autorisé sont
propres à chaque plateforme. Un retour expiré, annulé ou remplacé ne crée aucune session.
Le formulaire public de connexion par mot de passe n'existe plus ; le message accepté
est `web_login`. L'origine réelle de l'extension et l'identité de l'émetteur sont contrôlées.

## Protections conservées

Firefox configure un PAC embarqué sans identifiants et inspecte le proxy effectivement
sélectionné avant une requête protégée. Son adaptateur enregistre la garde avant
l'initialisation asynchrone. Les permissions d'hôtes et de navigation privée conditionnent
la connexion. Le consentement Mozilla des diagnostics reste indépendant de celui de
l'interface. Chromium conserve son proxy fixe, ses règles DNR et la restriction du stockage
aux contextes de confiance. Les deux plateformes conservent les transactions d'exclusion,
le coupe-circuit, WebRTC, le renouvellement et la restauration.

`locationsStatus` et `locationsError` font partie du modèle partagé. L'interface différencie
un chargement ou une erreur d'un catalogue chargé réellement vide. La suppression d'un
appareil ne peut pas publier une réponse obsolète dans un compte remplacé.

## Compatibilité des données

Les clés existantes `fuzevpnState`, `fuzevpnProxySession`, `fuzevpnSecurityState`,
`fuzevpnLanguage`, les exclusions et leurs journaux, les favoris et la base IndexedDB
`fuzevpn-device-identity` sont conservés. Les identifiants du proxy restent en stockage de
session. Aucun profil, jeton ou clé d'appareil n'est importé depuis une autre identité.

Le serveur reçoit les contrats existants. Les diagnostics gardent notamment les champs
historiques `platform: "chrome_extension"` et `chrome`, même sur Firefox. Firefox envoie
`browser_name: "unknown"` et sa version numérique réelle ; aucun nouveau format serveur
n'est introduit.

## Responsabilités des dossiers

`src` contient la logique commune, l'interface et les adaptateurs ; `assets` contient
les ressources embarquées ; `manifests` définit les trois cibles. `scripts` et `tests`
assurent la construction et la validation ; `docs` décrit l'architecture, l'installation,
les tests et les licences tierces. Les sorties `dist`, `releases`, `audit/local` et les
dépendances installées sont exclues de Git. Les documents internes et les renseignements
confidentiels restent hors du dépôt. Les archives sources utilisent une sélection explicite
des fichiers publics ; une extraction neuve doit reproduire les trois distributions.
