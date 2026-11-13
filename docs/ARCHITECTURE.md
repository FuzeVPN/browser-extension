# Architecture de la base commune

La version 1.0.0 possède un seul contrôleur (`src/core/background/state-machine.ts`),
un seul modèle d'état, une interface popup et assistance partagée, ainsi que soixante-dix
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

Le statut `blocked` est déduit à la lecture de l'état publié, sans remplacer le statut
enregistré : il disparaît dès que la garde du trafic est relâchée. `retryAfterSeconds`
indique le délai restant depuis sa réception, et non le délai reçu à l'origine.

## Compatibilité des données

Les clés existantes `fuzevpnState`, `fuzevpnProxySession`, `fuzevpnSecurityState`,
`fuzevpnLanguage`, les exclusions et leurs journaux, les favoris et la base IndexedDB
`fuzevpn-device-identity` sont conservés. Les identifiants du proxy restent en stockage de
session. Aucun profil, jeton ou clé d'appareil n'est importé depuis une autre identité.

Deux ajouts restent compatibles avec les données existantes. `fuzevpnSecurityState` peut
porter un champ facultatif `suspensionCause` (abonnement, vérification de l'e-mail ou
limite d'appareils) : la cause d'une protection suspendue reste affichée après un
redémarrage du worker. La clé `fuzevpnTemporaryGuard` indique que la garde du trafic a été
posée pour des données illisibles au démarrage, et non pour une protection demandée : le
worker suivant la relâche au lieu de se connecter. Cette clé est distincte parce qu'un
démarrage aux données illisibles n'écrit ni le compte ni l'état de sécurité.

Un enregistrement `fuzevpnPendingProxyRevocations` illisible est remplacé lors d'une
déconnexion ou d'une fermeture de session explicite, une fois le nettoyage inconnu
enregistré durablement ; une simple erreur de lecture ne le remplace jamais.

La clé `fuzevpnVpnAddresses` conserve, par emplacement, la dernière adresse IPv4 mesurée
à travers le VPN. Elle est affichée dès la reconnexion à cet emplacement, pendant que la
mesure de la nouvelle route s'effectue. Elle n'est jamais enregistrée ni exportée comme
une mesure, une mesure qui échoue l'efface, et elle ne contient ni adresse personnelle ni
IPv6. Elle est liée à l'emplacement et non au compte : une déconnexion du compte ne
l'efface pas. Une adresse de plus de trente jours est retirée de la clé dès la lecture
suivante par le worker. La notice de confidentialité embarquée décrit cette conservation
dans les soixante-dix langues.

## Sessions de compte renouvelables

Le serveur convertit une session classique en session renouvelable : un jeton d'accès
d'une heure et un jeton de renouvellement. `AccountSessions`
(`src/core/background/account-sessions.ts`) demande cette conversion au premier appel
authentifié, renouvelle le jeton d'accès cinq minutes avant son expiration ou après un
refus `401`, et déconnecte avec le jeton de renouvellement. Le contrôleur garde le jeton
de connexion comme identité du compte ; `RenewingApi` présente à sa place le jeton
d'accès courant sur chaque route de compte, et l'envoi des diagnostics passe par le même
remplacement.

Chaque conversion ou renouvellement est enregistré avant son envoi, avec sa route, son
jeton et son identifiant de demande, puis renvoyé à l'identique tant que le serveur n'a
pas répondu, y compris par le worker suivant. Les nouveaux jetons et le retrait de la
demande sont écrits ensemble. Seul un refus du serveur met fin au compte : une panne du
renouvellement le conserve et s'affiche comme une erreur réseau, sans laisser de création
de session proxy dans le doute. Un serveur qui ne connaît pas la conversion répond
`404` : la session classique continue et la conversion est redemandée un jour plus tard.

La clé `fuzevpnAccountSessions` contient ces jetons et la demande en attente. Elle ne
conserve que la session du compte présent dans `fuzevpnState` : celle d'un compte qui
quitte le stockage en est retirée aussitôt, et une session restée sans compte est
terminée auprès du serveur au démarrage suivant. Ces valeurs n'apparaissent ni dans
l'état publié, ni dans les journaux, ni dans les rapports de diagnostic. Une version
antérieure de l'extension ne sait pas utiliser une session convertie : elle demande une
nouvelle connexion.

## Contrats du serveur

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
