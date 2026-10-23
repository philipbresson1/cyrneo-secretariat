/**
 * Types partagés du secrétariat. Aucune dépendance : importables partout, tests compris.
 */

/** simulation : rien ne sort (ni mail, ni Rainbow), tout est journalisé.
 *  test : tout sort, mais vers la bulle et l'adresse de test uniquement.
 *  reel : production. */
export type Mode = 'simulation' | 'test' | 'reel';

export type Categorie =
  | 'demande_intervention'
  | 'demande_devis'
  | 'complement_coordonnees' // réponse d'un client à notre demande de coordonnées
  | 'relance_client' // client qui relance une demande déjà faite
  | 'facture_recue'
  | 'administratif' // banque, URSSAF, assurance, fournisseur sans facture…
  | 'publicite'
  | 'autre';

export const CATEGORIES: Categorie[] = [
  'demande_intervention',
  'demande_devis',
  'complement_coordonnees',
  'relance_client',
  'facture_recue',
  'administratif',
  'publicite',
  'autre',
];

export const LIBELLES_CATEGORIES: Record<Categorie, string> = {
  demande_intervention: "Demande d'intervention",
  demande_devis: 'Demande de devis',
  complement_coordonnees: 'Coordonnées complétées',
  relance_client: 'Relance client',
  facture_recue: 'Facture reçue',
  administratif: 'Administratif',
  publicite: 'Publicité',
  autre: 'Autre',
};

export type Societe = {
  id: string;
  nom: string;
  metier: string; // aide le modèle à attribuer une demande reçue sur la boîte du groupe
  telephone: string;
  site: string;
  bulleRainbow: string; // nom exact de la bulle Rainbow
  delaiRappel: string; // ex. « dans la journée »
  delaiDevis: string; // ex. « sous 48 h »
  alerteSecours: string[]; // adresses prévenues par mail si Rainbow est indisponible
};

export type Boite = {
  id: string;
  adresse: string;
  utilisateurEnv: string;
  motDePasseEnv: string;
  societeParDefaut: string; // société retenue quand le mail ne permet pas de trancher
  imap?: { hote: string; port: number };
  smtp?: { hote: string; port: number };
};

export type RegleTransfert = {
  categories: Categorie[];
  societes: string[] | '*';
  vers: string[];
};

export type Agenda = { nom: string; icsEnv: string; couleur: string };

export type Config = {
  mode: Mode;
  intervalleMinutes: number;
  repriseHeures: number; // au tout premier passage, ne traite que les mails de moins de N heures
  domainesInternes: string[]; // domaines ou adresses complètes du groupe
  boites: Boite[];
  societes: Societe[];
  transferts: RegleTransfert[];
  agendas: Agenda[];
  dossiers: { factures: string; rapports: string };
  rapport: { heure: string; destinataires: string[] };
  test: { bulleRainbow: string; adresse: string };
  serveur: { port: number; ecranPublic: boolean };
  modele: string;
  dolibarr: { actif: boolean; url: string; entites: Record<string, number> };
  /** Colonnes de planning de l'écran d'accueil ; chacune regroupe un ou plusieurs agendas (icsEnv). */
  ecran: { colonnes: { titre: string; agendas: string[] }[] };
};

export type PieceJointe = { nom: string; type: string; taille: number; contenu: Buffer };

export type MailRecu = {
  boite: string;
  uid: number;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  deAdresse: string;
  deNom: string;
  repondreA: string; // Reply-To s'il existe, sinon From
  sujet: string;
  recuLe: Date;
  texte: string;
  entetes: {
    autoSubmitted: string | null;
    precedence: string | null;
    listId: string | null;
    autoResponseSuppress: string | null;
  };
  piecesJointes: PieceJointe[];
};

export type Contact = {
  nom: string;
  telephone: string;
  email: string;
  adresse: string;
  commune: string;
};

export type Classification = {
  categorie: Categorie;
  societe: string; // id de société, ou 'inconnue'
  urgence: 'urgente' | 'normale';
  resume: string;
  nature: string;
  dateSouhaitee: string;
  contact: Contact;
};

export type StatutIntervention = 'coordonnees_demandees' | 'a_planifier' | 'planifiee' | 'realisee' | 'annulee';

export type Intervention = {
  id: number;
  reference: string;
  type: 'intervention' | 'devis';
  societe: string;
  statut: StatutIntervention;
  urgence: 'urgente' | 'normale';
  client_nom: string;
  client_telephone: string;
  client_email: string;
  adresse: string;
  commune: string;
  nature: string;
  date_souhaitee: string;
  resume: string;
  boite: string;
  mail_message_id: string;
  relance_message_id: string | null;
  date_prevue: string | null;
  intervenant: string | null;
  notes: string | null;
  dolibarr_ref: string | null;
  cree_le: string;
};

/** Ce que le secrétariat décide de faire d'un mail. L'exécution est séparée de la
 *  décision : c'est ce qui permet le mode simulation et des tests sans réseau. */
export type Action =
  | { type: 'creer_intervention'; nature: 'intervention' | 'devis'; statut: StatutIntervention }
  | { type: 'completer_intervention'; interventionId: number; statut: StatutIntervention }
  | { type: 'rainbow'; societe: string; gabarit: 'nouvelle' | 'complement' | 'relance'; suite: string }
  | { type: 'repondre'; modele: 'accuse_intervention' | 'accuse_devis' | 'demande_coordonnees'; manquants: string[] }
  | { type: 'classer_pieces_jointes' }
  | { type: 'transferer'; vers: string[] }
  | { type: 'bon_dolibarr' };

export type ActionExecutee = { action: Action['type']; detail: string; ok: boolean; simulee: boolean };
