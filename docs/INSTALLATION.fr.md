# Installer FuzeVPN 0.9.8 localement

Construire les trois versions avec `npm ci`, puis `npm run build`, ou extraire le ZIP du
navigateur choisi. Les ressources et le manifeste doivent se trouver à la racine du
dossier chargé. Les ZIP sont des paquets compilés, pas des extensions signées.

## Firefox de bureau, version 140 minimum

1. Ouvrir `about:debugging`, choisir **Ce Firefox**, puis **Charger un module complémentaire temporaire**.
2. Sélectionner `dist/firefox/manifest.json` ou le manifeste du ZIP extrait.
3. Dans `about:addons` → **FuzeVPN**, autoriser l'exécution dans les fenêtres privées.
4. Accorder l'accès aux sites demandé, puis utiliser **Se connecter** dans le popup.

Firefox exige l'autorisation des fenêtres privées pour modifier ses paramètres proxy,
même lorsqu'on utilise une fenêtre normale. L'extension signale les permissions manquantes
avant la connexion. Le chargement temporaire est perdu au redémarrage de Firefox et doit
être renouvelé. Un ZIP non signé ne s'installe pas comme un module permanent dans Firefox
standard. Une installation permanente nécessite un paquet signé par Mozilla.

Les diagnostics sont facultatifs : un consentement dans l'interface et l'autorisation
native Mozilla correspondante sont nécessaires. Le VPN ne dépend pas de cette option.

## Google Chrome et Microsoft Edge, version Chromium 116 minimum

1. Ouvrir `chrome://extensions` ou `edge://extensions` et activer **Mode développeur**.
2. Choisir **Charger l'extension non empaquetée**.
3. Sélectionner respectivement `dist/chrome` ou `dist/edge`, ou le ZIP correspondant extrait.
4. Ouvrir le popup et utiliser **Se connecter**.

Les manifestes fixent les identités Chrome `jpapficcimnolfmdjbcfpdpfjljjaofb` et Edge
`mghdgfihlgpgnmpnacedchgbkgmbkchn`. Chaque identité possède son propre stockage et
nécessite sa propre connexion.

## Connexion et périmètre

Le bouton ouvre l'espace client à `https://app.fuzevpn.com/extension/connect` via
l'identité native du navigateur. Le code unique et PKCE sont échangés avec
`https://api.fuzevpn.com`. L'extension protège le trafic Web du navigateur selon le
proxy et les exclusions choisis ; elle ne protège pas les autres applications.

Pour vérifier les empreintes sous PowerShell :

```powershell
Get-FileHash -Algorithm SHA256 .\releases\fuzevpn-firefox-v0.9.8.zip
```

Références : [chargement temporaire Mozilla](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)
et [réglages proxy Firefox](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/settings).
