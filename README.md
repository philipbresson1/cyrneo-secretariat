# Secrétariat CYRNEO

Un démon qui tourne en continu sur le PC du bureau et fait le travail de tri du secrétariat.

Toutes les 2 minutes, il :

1. lit **tous** les nouveaux mails de chaque boîte (IMAP Gmail ou OVH, en lecture seule : rien n'est marqué lu ni déplacé) ;
2. les fait trier par Claude : demande d'intervention, devis, facture reçue, relance, administratif, pub… et la société concernée ;
3. agit :
   - **demande d'intervention ou de devis** → fiche créée (`INT-2026-0042` / `DEV-…`), message dans la bulle Rainbow de la société, puis mail automatique au client :
     - téléphone présent → « votre demande est bien enregistrée, on vous rappelle » ;
     - téléphone ou adresse manquant → « merci de nous indiquer… ». Quand le client répond, sa réponse est reliée à la fiche, l'équipe est prévenue sur Rainbow et le client reçoit l'accusé ;
   - **relance client** → message Rainbow « à rappeler » ;
   - **facture reçue** → PDF copiés dans `Factures a saisir/<société>/<AAAA-MM>/` pour la saisie Dolibarr ;
   - **règles de transfert** → mail transféré aux bonnes personnes (voir `transferts`) ;
4. note tout dans le journal : chaque mail lu, ce qui a été fait, quand, sur quelle boîte. Y compris les mails pour lesquels il n'y avait rien à faire.

Chaque soir (19 h par défaut), il écrit un **Excel** : interventions demandées, devis, factures reçues, suivi de tout ce qui est ouvert, journal complet. Il peut l'envoyer par mail.

Sur le réseau du bureau, il sert :

| Adresse | Pour qui | Contenu |
|---|---|---|
| `http://<PC>:3939/ecran` | écran de la salle d'accueil | interventions à planifier et planifiées, agendas du jour et du lendemain |
| `http://<PC>:3939/interventions` | bureau (clé) | changer un statut, fixer une date, un intervenant |
| `http://<PC>:3939/journal` | bureau (clé) | historique complet, recherche par nom, sujet, boîte |

La clé (`SECRETARIAT_CLE`) se donne une seule fois : `http://<PC>:3939/journal?cle=…`.

## Garde-fous

- **3 modes** dans `config.json` :
  - `simulation` : rien ne part (ni mail, ni Rainbow). Tout est trié, journalisé, visible à l'écran. **Mode par défaut.**
  - `test` : tout part, mais uniquement vers `test.bulleRainbow` et `test.adresse`.
  - `reel` : production.
- Jamais de réponse automatique à un robot, une liste de diffusion, un répondeur, un retour de non-remise, un collègue du groupe. Et une seule par client toutes les 12 h.
- Les mails envoyés portent `Auto-Submitted: auto-replied` : les répondeurs d'en face ne répondent pas.
- Le numéro de téléphone retenu doit figurer dans le mail : on ne promet pas de rappeler un numéro inventé. Les numéros du groupe (signatures, citations) sont ignorés.
- Client qui répond sans donner ce qui manque → pas de deuxième relance automatique, l'équipe reprend la main.
- Rainbow en panne → la demande part par mail aux adresses `alerteSecours` de la société.
- Claude indisponible → le mail est retenté au passage suivant (3 essais, puis journalisé en erreur pour ne pas bloquer la boîte).

## Installation sur le PC

Prérequis : [Node.js 22](https://nodejs.org) et Git.

```powershell
cd C:\Cyrneo
git clone https://github.com/philipbresson1/cyrneo-secretariat.git
cd cyrneo-secretariat
npm install
copy .env.example .env.local
copy config.exemple.json config.json
```

1. **Supabase** : exécuter `supabase/schema.sql` dans le SQL Editor du projet Supabase « Secretariat » (une seule fois).
2. **Boîtes Gmail** : sur chaque compte, activer la validation en deux étapes puis créer un « mot de passe d'application » (Compte Google > Sécurité). C'est lui qui va dans `.env.local`, pas le mot de passe du compte.
3. **`.env.local`** : boîtes mail, Claude, Supabase, Rainbow, `SECRETARIAT_CLE`, agendas.
4. **`config.json`** : boîtes, sociétés (téléphones, noms exacts des bulles Rainbow), transferts, dossiers.
5. Vérifier Rainbow : `npm start -- bulles`.
6. Essai à blanc sur un mail enregistré (`.eml`) : `npm start -- essai C:\...\mail.eml`.
7. Premier passage : `npm start -- une-fois`, puis `http://localhost:3939/journal?cle=…`.
8. Démarrage automatique H24 (PowerShell administrateur) : `powershell -File scripts/installer.ps1`.

Mise à jour : `git pull` puis `npm install`. Journal du démon : `secretariat.log`.

### Rainbow

Il faut :

- un **compte Rainbow dédié** (ex. `secretariat@groupecyrneo.com`), ajouté comme membre de chaque bulle ;
- une **application** sur https://developers.openrainbow.com → `RAINBOW_APP_ID` / `RAINBOW_APP_SECRET`. Commencer en `RAINBOW_HOTE=sandbox`, puis demander le passage en production.

### Format des transferts

```json
"transferts": [
  { "categories": ["facture_recue"], "societes": "*", "vers": ["compta@groupecyrneo.com"] },
  { "categories": ["demande_devis"], "societes": ["sud-travaux"], "vers": ["devis@sudtravaux.com"] }
]
```

Catégories : `demande_intervention`, `demande_devis`, `complement_coordonnees`, `relance_client`, `facture_recue`, `administratif`, `publicite`, `autre`.

## Commandes

```bash
npm start                          # boucle H24 + écran
npm start -- une-fois              # un passage puis arrêt
npm start -- essai mail.eml        # tri d'un mail sans rien écrire ni envoyer
npm start -- rapport 2026-10-22    # Excel d'un jour donné
npm start -- bulles                # bulles Rainbow visibles
npm run types                      # vérification TypeScript
npm test                           # tests
```

## Organisation du code

```
src/
├─ demon.ts            boucle, commandes, rapport du soir
├─ traitement.ts       un mail : tri → décision → exécution selon le mode → journal
├─ logique/            pur, testé sans réseau
│  ├─ classification   consignes et schéma de sortie pour Claude, contrôle de la réponse
│  ├─ decision         que faire du mail
│  ├─ modeles          textes des mails clients et messages Rainbow
│  ├─ garde-fous       quand ne PAS répondre
│  └─ telephone        numéros français
├─ services/           imap, smtp, rainbow, classifieur, stockage (Supabase), fichiers, rapport-excel, serveur
└─ lib/                agenda iCal et client Supabase
```

Les données (journal, interventions) vont dans un projet Supabase dédié, « Secretariat ».

## Prochaines étapes

- **Dolibarr** : créer le bon d'intervention du jour dans la bonne société (colonne `interventions.dolibarr_ref` déjà prévue), puis pousser les factures du dossier « à saisir ».
- Destinataires des transferts par société et par type, à définir ensemble.
