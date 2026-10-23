/**
 * Tri d'un mail par le modèle : consignes, schéma de sortie et contrôle de la réponse.
 * Pur (aucun réseau) : l'appel lui-même vit dans services/classifieur.ts.
 */
import { CATEGORIES, type Categorie, type Classification, type MailRecu, type Societe } from './types';
import { choisirTelephone } from './telephone';

export const MAX_CARACTERES_CORPS = 6000;
export const MAX_PDF = 3;
export const TAILLE_MAX_PDF = 5 * 1024 * 1024;

/** PDF joints transmis au modèle : les bons de travaux portent l'adresse et la nature. */
export function pdfALire(mail: MailRecu) {
  return mail.piecesJointes
    .filter((p) => (p.type === 'application/pdf' || /\.pdf$/i.test(p.nom)) && p.taille > 0 && p.taille <= TAILLE_MAX_PDF)
    .slice(0, MAX_PDF);
}

export function consignesSysteme(societes: Societe[]): string {
  const liste = societes.map((s) => `- ${s.id} : ${s.nom} — ${s.metier}`).join('\n');
  return [
    "Tu tiens le secrétariat du groupe CYRNEO, à Ajaccio (Corse-du-Sud). Le groupe réunit plusieurs sociétés qui partagent les mêmes clients :",
    liste,
    '',
    'Pour le mail reçu, renseigne le schéma de sortie :',
    "- categorie : demande_intervention (un client veut qu'on vienne faire quelque chose), demande_devis (il veut un prix avant de décider), complement_coordonnees (il répond à notre demande de coordonnées), relance_client (il relance une demande déjà faite), reclamation (litige ou contestation qui demande une réponse : facture contestée ou en double, client mécontent, travaux mal faits, refus ou exigence d'un partenaire qui bloque un chantier, mise en demeure, rejet d'une offre de marché), facture_recue (un fournisseur ou prestataire nous envoie une facture), entretien_vehicule (tout ce qui concerne l'entretien des camions et véhicules du groupe : garage, pièces détachées, pneus, contrôle technique, carte grise, devis ou factures de garage ; prioritaire sur facture_recue), administratif, publicite, autre.",
    "- societe : l'identifiant de la société concernée d'après le métier demandé. 'inconnue' si rien ne permet de trancher.",
    "- urgence : pour une réclamation, 'urgente' si un chantier est bloqué, un délai court en jeu ou une mise en demeure ; sinon 'normale'. Pour le reste, 'urgente' seulement pour un débordement, un refoulement, une canalisation bouchée, une fuite, des nuisibles dans un commerce alimentaire, ou si le client le dit clairement. Sinon 'normale'.",
    "- resume : une phrase courte et concrète, comme un collègue la noterait sur un post-it.",
    "- nature : ce qu'il faut faire, en quelques mots (ex. « vidange fosse 3 m³ », « débouchage évier »).",
    "- dateSouhaitee : la date ou la période voulue par le client, telle qu'il l'écrit. Vide sinon.",
    "- inspectionCamera : true si la demande (intervention ou devis) porte sur une inspection caméra ou ITV de canalisations, sinon false.",
    "- contact : les coordonnées DU CLIENT (jamais celles d'une société du groupe). nom, telephone, email, adresse (lieu de l'intervention), commune. Laisse vide ce qui n'est pas écrit dans le mail : n'invente rien.",
    "Si le mail est transféré par un syndic ou une agence, le contact est la personne à joindre sur place quand elle est indiquée, sinon le syndic.",
    "Les PDF joints sont fournis avant le mail : lis-les. Un bon de travaux, bon de commande ou ordre de service d'un bailleur (Erilia, OPH…), d'un syndic ou d'une entreprise est une demande_intervention : la nature, l'adresse, le locataire ou le contact sur place y figurent. Un bon qui porte sur une intervention déjà réalisée (pour facturer) est administratif.",
  ].join('\n');
}

export function construireMessage(mail: MailRecu, contexte: string | null): string {
  const corps = mail.texte.length > MAX_CARACTERES_CORPS ? mail.texte.slice(0, MAX_CARACTERES_CORPS) + '…' : mail.texte;
  const pj = mail.piecesJointes.map((p) => p.nom).join(', ');
  return [
    `Boîte de réception : ${mail.boite}`,
    `De : ${mail.deNom ? `${mail.deNom} <${mail.deAdresse}>` : mail.deAdresse}`,
    `Sujet : ${mail.sujet}`,
    `Reçu le : ${mail.recuLe.toISOString()}`,
    pj ? `Pièces jointes : ${pj}` : 'Pièces jointes : aucune',
    contexte ? `Contexte : ${contexte}` : '',
    '',
    corps || '(corps vide)',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const CHAINE = { type: 'string' } as const;

export function schemaSortie(societes: Societe[]) {
  return {
    type: 'object',
    properties: {
      categorie: { type: 'string', enum: CATEGORIES },
      societe: { type: 'string', enum: [...societes.map((s) => s.id), 'inconnue'] },
      urgence: { type: 'string', enum: ['urgente', 'normale'] },
      resume: CHAINE,
      nature: CHAINE,
      dateSouhaitee: CHAINE,
      inspectionCamera: { type: 'boolean' },
      contact: {
        type: 'object',
        properties: { nom: CHAINE, telephone: CHAINE, email: CHAINE, adresse: CHAINE, commune: CHAINE },
        required: ['nom', 'telephone', 'email', 'adresse', 'commune'],
        additionalProperties: false,
      },
    },
    required: ['categorie', 'societe', 'urgence', 'resume', 'nature', 'dateSouhaitee', 'inspectionCamera', 'contact'],
    additionalProperties: false,
  };
}

function texte(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Valide la réponse du modèle et la recoupe avec le mail. Lève si la réponse est inexploitable. */
export function lireClassification(json: string, mail: MailRecu, societes: Societe[]): Classification {
  let brut: Record<string, unknown>;
  try {
    brut = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('Réponse du modèle illisible (JSON invalide)');
  }
  const categorie = brut.categorie as Categorie;
  if (!CATEGORIES.includes(categorie)) throw new Error(`Catégorie inconnue : ${String(brut.categorie)}`);

  const ids = societes.map((s) => s.id);
  const societe = ids.includes(texte(brut.societe)) ? texte(brut.societe) : 'inconnue';
  const c = (brut.contact ?? {}) as Record<string, unknown>;

  const numerosDuGroupe = societes.map((s) => s.telephone);
  const email = texte(c.email) || mail.repondreA || mail.deAdresse;

  return {
    categorie,
    societe,
    urgence: brut.urgence === 'urgente' ? 'urgente' : 'normale',
    resume: texte(brut.resume),
    nature: texte(brut.nature),
    dateSouhaitee: texte(brut.dateSouhaitee),
    inspectionCamera: brut.inspectionCamera === true,
    contact: {
      nom: texte(c.nom) || mail.deNom,
      // Le numéro doit exister dans le mail : on ne promet pas de rappeler un numéro inventé.
      telephone: choisirTelephone(texte(c.telephone), `${mail.sujet}\n${mail.texte}`, numerosDuGroupe),
      email,
      adresse: texte(c.adresse),
      commune: texte(c.commune),
    },
  };
}
