# Déploiement — Cloud Functions RepCore

Ce dossier contient 4 Cloud Functions :
- **RCACCESS** (3 fonctions) — signature/vérification serveur des codes d'accès élève (HMAC)
- **verifyPaypalSubscription** (1 fonction) — v��rifie l'abonnement PayPal côté serveur avant
  d'activer le statut `AUTONOMIE_PREMIUM`

Avant de publier le nouveau `index.html`, ces fonctions doivent être déployées.

## Prérequis

- **Plan Firebase Blaze (pay-as-you-go) obligatoire.** Les Cloud Functions ne fonctionnent pas
  sur le plan gratuit Spark. Le quota gratuit inclus dans Blaze (2 millions d'appels/mois) couvre
  très largement l'usage de RepCore — le coût réel attendu est proche de 0��/mois, mais il faut
  activer la facturation sur le projet Firebase pour pouvoir déployer.
- Node.js 20 installé en local (déjà le cas ici).

## 1. Activer Firebase Storage (obligatoire pour les PDF)

Les PDF sont maintenant stockés dans **Firebase Storage** (plus en base64 dans la base de données).
Cela supprime la limite de 4 Mo et les erreurs "stockage plein".

1. Va dans la **Console Firebase → Storage → Démarrer** et active Storage pour le projet `repcore-sync`.
2. Quand Firebase te demande les règles, accepte les règles sécurisées par défaut, puis remplace-les
   dans l'onglet **Règles** par :

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pdfs/{emailKey}/{fileName} {
      allow read, write: if request.auth != null;
    }
  }
}
```

3. Publie les règles (bouton **Publier**). Les PDF peuvent maintenant aller jusqu'à **20 Mo**.

> **Note :** Si le bucket par défaut n'est pas `repcore-sync.appspot.com`, mets à jour
> `CLOUD._storageBucket` dans `index.html` (recherche `_storageBucket`).

## 2. Configurer les secrets

```bash
# Secret pour les codes d'accès élève (HMAC) — à faire une seule fois
# Génère une chaîne aléatoire longue, ex. :
openssl rand -base64 32
# Puis enregistre-la (elle ne sera JAMAIS visible côté client) :
firebase functions:secrets:set RCACCESS_TOKEN_SECRET

# Secret PayPal (Client Secret de ton app PayPal Live)
# Récupère-le sur developer.paypal.com → Apps & Credentials → ton app Live → Client Secret
firebase functions:secrets:set PAYPAL_CLIENT_SECRET
```

## 3. Déployer les fonctions

```bash
# 1. Se connecter (ouvre un navigateur pour l'authentification Google)
firebase login

# 2. Vérifier que le bon projet est sélectionné (le fichier .firebaserc pointe vers "repcore-sync"
#    — à corriger si l'ID réel du projet est différent, visible dans la console Firebase)
firebase use --add

# 3. Installer les d��pendances des fonctions
cd functions && npm install && cd ..

# 4. Déployer uniquement les fonctions (ne touche pas aux règles de la base ni à l'hébergement)
firebase deploy --only functions
```

Après le déploiement, vérifie dans la sortie du terminal l'URL exacte des fonctions
(`generateAccessToken`, `extendAccessToken`, `verifyAccessToken`, `verifyPaypalSubscription`).
Si la région ou le nom du projet diffère de `europe-west1-repcore-sync`, mets à jour
`CLOUD._functionsBase` dans `index.html` (recherche `_functionsBase`) avant de publier.

## Ce que ça corrige

- Les codes d'accès élève (RCACCESS) sont maintenant signés avec une clé secrète connue
  uniquement du serveur — impossible d'en fabriquer un valide à la main, contrairement à avant
  (simple `base64(JSON)` que n'importe qui pouvait décoder et reconstruire).
- Un code désactiv�� par le coach est maintenant réellement bloqué à la saisie (v��rifié
  côté serveur), plus seulement cosmétique côté interface coach.
- Un même code ne peut plus être utilisé par deux personnes différentes (marqué consommé
  après la première utilisation réussie).
- Le bouton « +3 mois » applique maintenant la prolongation directement sur le compte de
  l'élève déjà inscrit, en une seule action côté serveur.
- Le statut `AUTONOMIE_PREMIUM` ne peut être attribué que par le serveur après vérification
  réelle auprès de l'API PayPal — impossible à falsifier côté client.
- Les PDF sont stockés dans Firebase Storage (plus en base64 dans localStorage/RTDB) —
  limite portée à 20 Mo, plus d'erreurs "stockage plein".

## Limite connue

`verifyAccessToken` retrouve le coach via `orderByChild('id').equalTo(...)` sur le nœud
`users` de la Realtime Database. Avec beaucoup d'utilisateurs, ça devient plus lent sans un
index dédié. Si besoin, ajoute manuellement dans la console Firebase (Realtime Database →
Règles) une entrée `".indexOn": ["id"]` sur le nœud `users` — non inclus automatiquement ici
pour ne pas risquer d'écraser les règles de sécurité déjà en place.
