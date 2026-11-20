# Architecture de la base commune

La version 1.1.2 possède un seul contrôleur (`src/core/background/state-machine.ts`),
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
Les navigateurs ne permettent ni de fermer ni de retrouver la fenêtre de connexion : le
popup peut abandonner une tentative qui attend cette fenêtre (message `cancel_web_login`).
Elle se termine alors comme une fenêtre fermée, et un retour tardif de cette fenêtre est
ignoré sans échanger son code. Une fois le code reçu, il n'y a plus rien à abandonner.
Sur Chromium, l'extension referme alors elle-même la fenêtre qu'elle a ouverte : laissée
ouverte, elle continue de proposer une connexion que plus rien n'attend, et le navigateur
peut refuser d'ouvrir celle de la tentative suivante à côté d'elle. L'onglet est reconnu
par l'adresse ouverte et par son `state`, tiré au hasard pour cette seule tentative. Seuls
les onglets créés pendant la tentative sont regardés, leur adresse n'est que comparée, et
aucune permission n'est ajoutée. C'est la seule exception, avec la lecture d'un onglet pour
l'authentification du proxy, à l'interdiction de l'API des onglets : les audits la limitent
à écouter les créations, relire un onglet et en fermer un. Firefox ne montre pas l'adresse de l'onglet de sa fenêtre d'identité : faute de
pouvoir la reconnaître avec certitude, l'extension la laisse ouverte, comme avant.
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

Un worker qui démarre retire d'abord l'autorisation de trafic, puis ne la rend qu'après
avoir tout vérifié. Sur Chromium, cette autorisation est restée en place pendant tout le
sommeil du worker : la retirer au réveil pour la rendre un instant plus tard ne protège rien
de plus, et fait échouer les requêtes que les pages envoient entre-temps. Au premier
démarrage d'un worker, le contrôleur lit donc d'abord, sans rien écrire, le compte, la
session non expirée, les exclusions enregistrées, la configuration du proxy et les règles.
Si tout est exactement en place, et si la plateforme l'atteste (`verifyAllowance` : les
règles sont celles que `block()` puis `allow()` laissent, autorisation comprise),
l'autorisation est conservée, les règles ne sont pas réécrites et aucun état intermédiaire
n'est publié ; la restauration la confirme ensuite en un seul remplacement. Au moindre
doute avant de commencer, ou au premier écart pendant la restauration (arrêt explicite,
compte expiré, récupération d'appareil, configuration à réécrire, erreur), la garde est
fermée comme elle l'était dès la première instruction, et la suite est inchangée. Une
restauration ultérieure du même worker ferme toujours la garde d'abord. Firefox atteste de
la même façon : ses règles doivent être exactement celles qu'une connexion laisse,
coupe-circuit compris, et son inspection doit donner une garde active et ouverte, sans
connexion spéculative que l'extension ne tiendrait plus désactivée.

Le même principe vaut quand il n'y a rien à protéger. Sans compte, ou sans protection
demandée, un worker qui trouve tout relâché (ni session, ni règle, ni réglage tenu par
l'extension, ce que la plateforme atteste par `verifyReleased`) ne repose pas la garde
pour la retirer aussitôt et ne réécrit rien.

Ces lectures préalables sont bornées par `STARTUP_PREFLIGHT_TIMEOUT_MS` : une lecture qui
ne répond pas vaut un doute, et l'autorisation ne reste pas en place sans avoir été
vérifiée. Si la garde refuse de se fermer lorsque l'autorisation conservée est retirée en
cours de restauration, ce refus est traité comme celui de la première instruction : le
compte et la session sont gardés, leurs identifiants ne sont plus prêtés, et le démarrage
suivant répare.

Sur Chromium, une demande d'identifiants du proxy n'est servie qu'à une requête partie par
une route que l'extension a vérifiée. Ces routes vérifiées sont conservées en stockage de
session (`fuzevpnVerifiedProxyRoutes`) : la requête qui réveille le worker, partie avant
lui, retrouve la sienne et reçoit ses identifiants au lieu d'être annulée. Tout changement
des réglages du proxy efface ces routes avant toute autre chose ; cela suppose que le
navigateur signale un changement de réglages avant les événements des requêtes qui le
suivent. Un stockage de session absent ramène au comportement précédent.

La connexion d'un démarrage est faite après la restauration, et non pendant : les commandes
et le popup obtiennent l'état restauré sans attendre qu'elle aboutisse (`ready()`). Ce qui
a besoin de la session l'attend : la lecture de la session active, la garde des routes de
Firefox (les onglets que le navigateur restaure ne sont pas refusés pour être arrivés un
instant trop tôt) et une action sur un emplacement tant qu'aucun catalogue n'est connu.
Une restauration que la garde du trafic refuse n'est relancée par un simple lecteur qu'au
plus toutes les `RESTORATION_RETRY_MS` ; un stockage illisible reste relu à chaque appel.

Les reprises automatiques s'espacent d'un palier à l'autre, et ce palier n'est remis à zéro
qu'après une connexion restée stable `STABLE_CONNECTION_MS` : une connexion qui tombe aussitôt
ne ramène pas au délai le plus court. Chaque délai est décalé au hasard de `RETRY_SPREAD`,
pour que des installations coupées ensemble ne reviennent pas ensemble. La cause d'une
reprise en attente (`retryCause`) est conservée avec son échéance : elle reste affichée
après un redémarrage du worker, et tant que la protection est demandée sans être établie,
un changement de préférence ou d'emplacement ne l'efface pas.

Sur Firefox, la décision de route d'une requête est lue une fois pour les requêtes qui
arrivent ensemble et gardée une seconde au plus, tant que rien de ce qui la fonde n'a
changé. Une requête à cheval sur un changement d'état est décidée à nouveau sur l'état
courant, trois fois au plus, au lieu d'être annulée. Accorder une permission relance la
connexion demandée, comme sur Chromium ; le seul consentement aux données ne relance rien.

L'expiration d'une session n'est pas une tentative échouée. Lorsque la protection reste
demandée, la reconnexion est faite aussitôt, après le retrait de la session expirée et la
pose de la garde, sans attendre le premier délai de reprise ni l'entamer. Son alarme reste
posée pour un worker qui s'arrêterait avant. Si cette reconnexion échoue, les délais
habituels s'appliquent. Une création sans réponse, un blocage de capacité ou un délai
imposé par le serveur gardent leur propre échéance.

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

`fuzevpnSecurityState` peut aussi porter trois champs facultatifs liés aux reprises :
`retryCause`, `backoffLevel` (le palier atteint) et `connectedSince` (le début de la
connexion en cours). Une version antérieure les ignore ; absents, le palier repart du
nombre de tentatives, comme avant. Une session de compte en échec de renouvellement porte
un champ facultatif `failures` : le délai entre deux tentatives continue de croître d'un
worker au suivant.

Deux ajouts restent compatibles avec les données existantes. `fuzevpnSecurityState` peut
porter un champ facultatif `suspensionCause` (abonnement, vérification de l'e-mail ou
limite d'appareils) : la cause d'une protection suspendue reste affichée après un
redémarrage du worker. La clé `fuzevpnTemporaryGuard` indique que la garde du trafic a été
posée pour des données illisibles au démarrage, et non pour une protection demandée : le
worker suivant la relâche au lieu de se connecter. Cette clé est distincte parce qu'un
démarrage aux données illisibles n'écrit ni le compte ni l'état de sécurité.

`fuzevpnSecurityState` peut aussi porter un champ facultatif `proxyCreationUncertainUntil` :
l'heure à laquelle une création de session restée sans réponse cesse de suspendre les
reprises automatiques, soit `PROXY_CREATION_UNCERTAINTY_MS` après son envoi. Cette durée
doit couvrir la durée de vie d'une session proxy : passé ce délai, la session que la demande
a pu créer a expiré et la reconnexion reprend seule. Avant ce délai, rien n'est rejoué. Un
marqueur enregistré sans ce champ, par une version antérieure ou après un refus qui suspend
les reprises pour sa propre cause, suspend jusqu'à son règlement, comme auparavant. Si la
fin de la suspension ne peut pas être enregistrée à l'alarme, une nouvelle alarme est posée
`REFRESH_RETRY_MS` plus tard.

Cette heure et celle du marqueur ci-dessous sont des heures de l'horloge du système. Une
heure lue au démarrage à plus de `PROXY_CREATION_UNCERTAINTY_MS` dans le futur a été écrite
par une horloge reculée depuis : elle est ramenée à cette durée à partir de maintenant,
puisqu'aucune session ne vit plus longtemps. Une horloge avancée depuis ne se distingue pas
du temps écoulé : l'échéance tombe alors plus tôt.

Le marqueur `proxyCleanupUncertain` signale qu'une session proxy a pu être créée sans que
son identifiant soit connu : elle ne peut pas être révoquée, et une fermeture de compte
indique alors des sessions non confirmées. Il porte un champ facultatif
`proxyCleanupUncertainUntil` : l'heure à laquelle toute session qu'il désigne a expiré, soit
`PROXY_CREATION_UNCERTAINTY_MS` après le dernier incident. Passé cette heure il ne reste rien
à révoquer : le worker qui démarre, ou la fermeture de compte, lève le marqueur. Une
connexion réussie ou un renouvellement ne repoussent pas cette heure ; une nouvelle session
restée inconnue la repousse. Un marqueur enregistré sans ce champ par une version antérieure
est daté par le premier worker qui le lit, puisque ses sessions existaient avant lui. Une
création sans réponse qui suspend encore les reprises jusqu'à une heure plus tardive garde
le marqueur jusque-là.

Une alarme de renouvellement peut être remise en retard, après une veille par exemple, à un
worker dont la restauration a déjà remplacé la session expirée. Elle ne renouvelle pas la
session créée depuis sa remise, qui a son propre renouvellement.

Les sites exclus et les préférences d'emplacement (favoris, récents, choix automatique)
restent dans le profil du navigateur après une fermeture de compte ou la fin d'une session,
pour que le même compte les retrouve. Ils appartiennent au compte qui les a définis : la clé
`fuzevpnPreferenceOwner` en conserve une empreinte SHA-256, jamais l'identifiant lui-même.
Lorsqu'un autre compte se connecte sur le même profil, ces préférences reviennent à leurs
valeurs par défaut avant que la nouvelle empreinte ne soit écrite ; il n'hérite donc ni des
destinations qui contournent le VPN, ni des emplacements utilisés par le compte précédent.
La nouvelle empreinte est enregistrée avant toute remise à zéro, avec ce qui reste à
remettre à zéro ; chaque étape est rayée une fois faite. Une remise à zéro interrompue ou
en échec reprend donc où elle s'est arrêtée, dans ce worker après trente secondes ou dans
le suivant, sans effacer une seconde fois ce que le nouveau compte a choisi entre-temps.
Aucune étape ne se fie à un compteur de modifications, qu'une tentative échouée de la remise
à zéro fait avancer comme un choix du nouveau compte. Pour les exclusions, ce qui reste à
faire porte une empreinte du contenu laissé par le compte précédent : elles sont remises à
zéro tant que leur contenu, une fois stable, est exactement celui-là, et laissées intactes
dès qu'il diffère. Tant qu'une modification des exclusions n'est pas appliquée ou annulée,
rien n'est décidé : ni remise à zéro, ni abandon, ni changement de propriétaire. Pour les
emplacements, chaque remise à zéro porte un nom, que les préférences conservent (champ
facultatif `reset`) : redemandée après avoir été faite, elle ne refait rien.
Sans empreinte enregistrée, par exemple après une mise à jour, rien n'est effacé : le
compte présent devient le propriétaire. L'emplacement sélectionné en dernier, conservé
avec l'état de sécurité, n'est pas concerné.

La clé `fuzevpnAccountCache`, en stockage de session, conserve le catalogue tel que l'API
l'a renvoyé en dernier et l'heure du dernier rechargement complet du compte (profil,
abonnement et catalogue). Un worker qui démarre affiche ce catalogue aussitôt, et ne relit
pas le compte auprès de l'API si ce rechargement date de moins de
`ACCOUNT_REFRESH_INTERVAL_MS` (une heure). L'ouverture du popup recharge le compte quel que
soit cet âge, et une connexion relit elle-même l'abonnement et le catalogue : ce délai ne
borne que ce que personne ne regarde. Le renouvellement de la session de compte n'en
dépend pas. L'enregistrement désigne son compte par la même empreinte SHA-256 que
`fuzevpnPreferenceOwner` et n'est jamais rendu à un autre compte ; il est retiré à la
fermeture du compte et disparaît avec la session du navigateur, dont le premier worker
relit donc toujours l'API. Un cache absent, illisible ou invalide revient au comportement
précédent : une lecture de l'API au démarrage.

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
demande sont écrits ensemble. Une panne du renouvellement conserve le compte et
s'affiche comme une erreur réseau, sans laisser de création de session proxy dans le
doute. Le compte ne prend fin que sur un refus du serveur, ou à l'échéance du droit de
renouveler. Un serveur qui ne connaît pas la conversion répond `404` : la session
classique continue et la conversion est redemandée un jour plus tard.

Une conversion dont la réponse s'est perdue reste en attente, même si une répétition
reçoit `404` ou `400` : pendant un déploiement, cette réponse peut venir d'une seule
instance du serveur. Si le serveur donne encore cette réponse un jour plus tard, sans en
avoir donné d'autre entre-temps, un refus du jeton de connexion met alors fin au compte,
et l'extension demande au serveur de terminer la session que la conversion a pu y
laisser.

La clé `fuzevpnAccountSessions` contient ces jetons et la demande en attente. Elle ne
conserve que la session du compte présent dans `fuzevpnState` : celle d'un compte qui
quitte le stockage en est retirée aussitôt. Si une session y reste sans son compte, le
worker suivant demande une fois au serveur de la terminer, puis l'oublie quelle que soit
la réponse. Ces valeurs n'apparaissent ni dans
l'état publié, ni dans les journaux, ni dans les rapports de diagnostic. Une version
antérieure de l'extension ne sait pas utiliser une session convertie : elle demande une
nouvelle connexion.

## Envoi des diagnostics après un refus de session

Un rapport refusé par le serveur avec `401` attend une autre session de son compte, et
retient les rapports suivants de ce compte. L'état des envois (`fuzevpnDiagnosticDelivery`)
conserve une empreinte SHA-256 de chaque jeton refusé, quatre au plus, jamais le jeton
lui-même. Un worker qui démarre reconnaît ainsi un jeton déjà refusé et continue
d'attendre ; avec tout autre jeton, que le refus ne concernait pas, il reprend les envois.
Un état enregistré par une version antérieure indique qu'une session est requise sans dire
quel jeton a été refusé : une tentative avec le jeton courant le tranche, et son éventuel
refus est alors enregistré avec son empreinte.

## Journal et rapports

Un worker démarre à la première requête après chaque pause et retrouve ce que le précédent
a laissé : ce n'est pas un événement. Un démarrage n'est donc inscrit dans l'historique que
si ce qu'il laisse diffère de ce que le démarrage précédent a laissé pour le même compte ;
ce dernier résultat est gardé pour la session du navigateur. La connexion d'un démarrage
est un événement à part. Les traces que le worker a écrites avant de connaître son compte
(la commande qui l'a réveillé) sont conservées quand ce compte est celui du journal.

Les rapports terminés restent un jour pour leur accusé de réception sans occuper la file :
le plus ancien cède sa place à un rapport à envoyer, et seuls vingt rapports encore à
envoyer la remplissent. Une panne qui dure produit un seul rapport automatique tant que
celui-ci est conservé. Dans une liste reçue de l'API, une entrée illisible est écartée et
la liste est gardée ; deux entrées de même identifiant font toujours rejeter la réponse. Un
champ inconnu dans un accusé de réception est ignoré.

Le délai qu'un fournisseur d'adresse IP impose (`429`) vaut pour l'adresse qui l'a reçu :
celle d'un emplacement VPN, ou celle de l'utilisateur. Il est plafonné à dix minutes.

## Interface du popup

Le popup redessine tout son état à chaque réponse du worker, qu'il interroge toutes les
quelques secondes. Ses écritures passent par `src/ui/popup/dom.ts` : un texte n'est écrit
que s'il change, et un contenu construit n'est remplacé que si ce qu'il montre change. Une
réponse qui ne change rien n'écrit donc rien dans la page : les lecteurs d'écran ne relisent
pas les zones annoncées, et le navigateur ne refait pas la mise en page.

Un contrôle désactivé pendant sa propre action perd le focus clavier, que le navigateur
donne à la page. `setDisabled` le lui rend lorsqu'il est réactivé, sauf si le focus est
allé ailleurs entre-temps. Dans les listes reconstruites, le bouton qui retire un site exclu
est indisponible (`aria-disabled`) plutôt que désactivé : il garde le focus jusqu'à la
réponse, puis le focus passe au site suivant, à défaut au précédent, à défaut au champ
d'ajout. Les refus de suppression d'appareil sont gardés par appareil : chacun reste signalé
tant que son appareil est listé.

Tant que le worker n'a pas dit si un compte est connecté, le popup ne montre aucune des
deux vues. Après `BOOT_REVEAL_MS` il montre qu'il attend ; après `BOOT_FAILURE_MS` sans
réponse, ou si la première lecture échoue, il montre l'échec et un bouton « Réessayer » qui
relit l'état, sans l'accueil ni le formulaire de connexion : rien ne dit alors que personne
n'est connecté. Après un échec de communication, ce bouton relit toujours l'état avant de
demander quoi que ce soit au worker.

Un navigateur donne au popup 600 px au plus, et moins lorsque la page est zoomée ou
l'écran petit. Rien ne l'indique à la page : elle constate que sa fenêtre a cessé de
grandir sous son contenu, et resserre sa mise en page à cette hauteur (`PopupFitter`),
jusqu'au prochain changement de zoom ou d'écran. L'ajustement est fait dès que le contenu
change, avant que le navigateur ne le mette en page. L'observateur de taille, qui voit le
reste (une police qui se charge), ne fait que demander un ajustement avant l'image
suivante : un observateur qui redimensionne ce qu'il observe est signalé par le navigateur
parmi les erreurs de l'extension.

L'écriture arabe lie ses lettres : dans ces langues (arabe, persan, ourdou, pachto), les
titres et les étiquettes gardent l'espacement du texte.

## Choix délibérés

Les réglages du proxy et l'accès aux fenêtres privées sont relus au navigateur à chaque
vérification, sans cache : une vérification de sécurité ne repose pas sur une réponse
antérieure. Les règles de blocage sont réécrites en entier à chaque changement : la
plateforme les remplace en une opération, ce qu'une modification partielle ne garantit
pas. Une publication d'état identique est toujours envoyée aux pages : son numéro de
version ordonne les messages, et une page a pu recevoir entre-temps une réponse plus
ancienne. Le bouton de la barre d'outils, lui, ne reçoit son icône et son titre que
lorsqu'ils changent.

La liste des suffixes publics est indexée à la première validation d'un site, et non à
chaque démarrage. Sa source non modifiée reste livrée avec l'extension, avec sa licence :
c'est la forme source des règles dérivées embarquées (MPL-2.0). Les drapeaux sont ceux de
`flag-icons`, copiés sans modification.

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
