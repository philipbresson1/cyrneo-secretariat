/**
 * Factures fournisseurs reçues par mail : lecture du PDF (toutes les lignes), contrôles,
 * rapprochement du fournisseur avec la liste des tiers Dolibarr.
 */
import type { Societe } from './types';
import { mots, type IndexTiers, type Tiers } from './tiers';

export type FournisseurLu = { nom: string; siret: string; tvaIntra: string; adresse: string; cp: string; ville: string; email: string; telephone: string };

export type LigneFacture = { description: string; quantite: number; prixUnitaireHt: number; remisePct: number; tauxTva: number; totalHt: number };

export type FactureLue = {
  estFactureFournisseur: boolean; // false : devis, relance, facture émise par une de nos sociétés…
  avoir: boolean;
  fournisseur: FournisseurLu;
  societe: string; // id de la société facturée, ou 'inconnue'
  numero: string;
  date: string; // AAAA-MM-JJ
  echeance: string; // AAAA-MM-JJ ou ''
  libelle: string;
  lignes: LigneFacture[]; // toutes les lignes de la facture, telles qu'imprimées
  totalHt: number;
  totalTva: number;
  totalTtc: number;
};

const CHAINE = { type: 'string' } as const;
const NOMBRE = { type: 'number' } as const;

export function schemaFacture(societes: Societe[]) {
  return {
    type: 'object',
    properties: {
      estFactureFournisseur: { type: 'boolean' },
      avoir: { type: 'boolean' },
      fournisseur: {
        type: 'object',
        properties: { nom: CHAINE, siret: CHAINE, tvaIntra: CHAINE, adresse: CHAINE, cp: CHAINE, ville: CHAINE, email: CHAINE, telephone: CHAINE },
        required: ['nom', 'siret', 'tvaIntra', 'adresse', 'cp', 'ville', 'email', 'telephone'],
        additionalProperties: false,
      },
      societe: { type: 'string', enum: [...societes.map((s) => s.id), 'inconnue'] },
      numero: CHAINE,
      date: CHAINE,
      echeance: CHAINE,
      libelle: CHAINE,
      lignes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { description: CHAINE, quantite: NOMBRE, prixUnitaireHt: NOMBRE, remisePct: NOMBRE, tauxTva: NOMBRE, totalHt: NOMBRE },
          required: ['description', 'quantite', 'prixUnitaireHt', 'remisePct', 'tauxTva', 'totalHt'],
          additionalProperties: false,
        },
      },
      totalHt: NOMBRE,
      totalTva: NOMBRE,
      totalTtc: NOMBRE,
    },
    required: ['estFactureFournisseur', 'avoir', 'fournisseur', 'societe', 'numero', 'date', 'echeance', 'libelle', 'lignes', 'totalHt', 'totalTva', 'totalTtc'],
    additionalProperties: false,
  };
}

export function consignesFacture(societes: Societe[]): string {
  return [
    "Tu lis une facture reçue par une des sociétés du groupe CYRNEO (Corse) pour la saisir en facture fournisseur dans le logiciel de gestion.",
    'Sociétés du groupe (identifiant : nom) :',
    ...societes.map((s) => `- ${s.id} : ${s.nom}`),
    "estFactureFournisseur : true seulement pour une facture ou un avoir adressé à une société du groupe. false pour un devis, un bon de commande, une relance sans facture, un relevé, ou une facture émise PAR une société du groupe.",
    "avoir : true pour un avoir (note de crédit). Les montants restent positifs.",
    "fournisseur : l'émetteur de la facture. siret : 14 chiffres sans espace (vide si absent). tvaIntra : n° de TVA intracommunautaire sans espace (vide si absent).",
    "societe : la société du groupe facturée (destinataire de la facture), 'inconnue' si on ne peut pas le dire.",
    "numero : le numéro de la facture tel qu'imprimé. date et echeance au format AAAA-MM-JJ (echeance vide si absente).",
    "libelle : l'objet de la facture en quelques mots (ex. « Gasoil octobre », « Pièces camion IVECO »).",
    "lignes : TOUTES les lignes de la facture, dans l'ordre, sans en sauter ni en regrouper : description complète (référence article comprise), quantité, prix unitaire HT, remise en % (0 si aucune), taux de TVA en % (ex. 20, 10, 5.5, 2.1, 0), total HT de la ligne. " +
      "Les frais de port, éco-participations, consignes et remises globales imprimés comme des lignes sont aussi des lignes (remise globale : quantité 1, prix négatif).",
    'totalHt, totalTva, totalTtc : les totaux imprimés, en euros. Ne calcule rien qui ne soit écrit, n\'invente rien.',
  ].join('\n');
}

const arrondi = (n: number) => Math.round(n * 100) / 100;

/** Raison de ne pas saisir la facture automatiquement, ou null si elle est saisissable. */
export function controlerFacture(f: FactureLue, societes: Societe[]): string | null {
  if (!f.estFactureFournisseur) return "ce n'est pas une facture fournisseur";
  if (!societes.some((s) => s.id === f.societe)) return 'société facturée non identifiée';
  if (!f.numero.trim()) return 'numéro de facture illisible';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return 'date illisible';
  if (!f.fournisseur.nom.trim()) return 'fournisseur illisible';
  if (f.lignes.length === 0) return 'lignes illisibles';
  if (Math.abs(arrondi(f.totalHt + f.totalTva) - f.totalTtc) > 0.05) return `totaux incohérents (HT ${f.totalHt} + TVA ${f.totalTva} ≠ TTC ${f.totalTtc})`;
  const tolerance = Math.max(0.05, f.lignes.length * 0.01);
  // Chaque ligne telle que Dolibarr la recalculera (quantité × prix × remise).
  for (const [i, l] of f.lignes.entries()) {
    const calcule = arrondi(l.quantite * l.prixUnitaireHt * (1 - l.remisePct / 100));
    // Petit écart = prix unitaire arrondi à l'impression : corrigé par prixUnitaireSaisi.
    if (Math.abs(calcule - l.totalHt) > Math.max(0.05, Math.abs(l.totalHt) * 0.01)) return `ligne ${i + 1} incohérente (${l.quantite} × ${l.prixUnitaireHt} ≠ ${l.totalHt})`;
  }
  const somme = f.lignes.reduce((t, l) => t + l.totalHt, 0);
  if (Math.abs(arrondi(somme) - f.totalHt) > tolerance) return `somme des lignes (${arrondi(somme)}) différente du total HT (${f.totalHt}) : ligne manquante ?`;
  const tva = f.lignes.reduce((t, l) => t + (l.totalHt * l.tauxTva) / 100, 0);
  if (Math.abs(arrondi(tva) - f.totalTva) > tolerance) return `TVA recalculée (${arrondi(tva)}) différente de la TVA imprimée (${f.totalTva})`;
  return null;
}

/** Prix unitaire à saisir pour que Dolibarr retombe sur le total HT imprimé de la ligne
 *  (le prix imprimé est souvent arrondi : 800 L × 1,253 €). */
export function prixUnitaireSaisi(l: LigneFacture): number {
  const diviseur = l.quantite * (1 - l.remisePct / 100);
  if (!diviseur) return l.prixUnitaireHt;
  return Math.abs(arrondi(l.quantite * l.prixUnitaireHt * (1 - l.remisePct / 100)) - l.totalHt) <= 0.005 ? l.prixUnitaireHt : Math.round((l.totalHt / diviseur) * 1e5) / 1e5;
}

const chiffresSeuls = (s: string) => s.replace(/\D/g, '');

/** Fournisseur déjà dans Dolibarr : SIRET / SIREN, n° de TVA, domaine de l'expéditeur, puis nom exact. */
export function trouverFournisseur(index: IndexTiers, f: FournisseurLu, expediteur: string): Tiers | null {
  const tous = [...index.tiers.values()];
  const siret = chiffresSeuls(f.siret);
  const tva = f.tvaIntra.replace(/\s/g, '').toUpperCase();
  const parIdentifiant = tous.find(
    (t) => (siret.length >= 9 && t.siret && chiffresSeuls(t.siret).slice(0, 9) === siret.slice(0, 9)) || (tva.length > 4 && t.tva_intra === tva)
  );
  if (parIdentifiant) return parIdentifiant;

  const domaine = expediteur.split('@')[1]?.toLowerCase() ?? '';
  const webmail = /^(gmail|yahoo|hotmail|outlook|live|orange|wanadoo|free|sfr|laposte|icloud|me)\./;
  if (domaine && !webmail.test(domaine)) {
    const parDomaine = tous.filter((t) => t.fournisseur > 0 && t.email.endsWith(`@${domaine}`));
    if (parDomaine.length === 1) return parDomaine[0];
  }

  const nom = mots(f.nom).join(' ');
  if (!nom) return null;
  const parNom = tous.filter((t) => t.fournisseur > 0 && [t.nom, t.alias].some((n) => n && mots(n).join(' ') === nom));
  return parNom.length === 1 ? parNom[0] : null;
}

const euros = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

export function resumeFacture(f: FactureLue, societes: Societe[]): string {
  const s = societes.find((x) => x.id === f.societe)?.nom ?? 'société ?';
  return `${f.avoir ? 'Avoir' : 'Facture'} ${f.numero || '?'} · ${f.fournisseur.nom || 'fournisseur ?'} → ${s} · ${euros(f.totalTtc)} TTC${f.libelle ? ` · ${f.libelle}` : ''} · ${f.lignes.length} ligne${f.lignes.length > 1 ? 's' : ''}`;
}
