/**
 * Connecteur Dolibarr (API REST, module Multi-société).
 *
 * Un seul accès (DOLIBARR_API_KEY) pour toutes les sociétés : l'en-tête DOLAPIENTITY
 * choisit la société (l'« entité » Dolibarr) à chaque appel. Le compte API doit avoir
 * accès à chaque entité et les droits Tiers (lire) et Interventions (lire/créer).
 *
 * Les bons sont créés en BROUILLON : un humain les valide dans Dolibarr.
 * Aucun tiers n'est jamais créé ici : le bon n'est fait que sur un tiers existant, reconnu
 * dans la liste synchronisée (voir services/tiers.ts).
 */
import type { Classification, Config } from '../logique/types';
import type { ContactTiers, Tiers } from '../logique/tiers';
import { prixUnitaireSaisi, type FactureLue, type FournisseurLu } from '../logique/facture';

export type BonDolibarr = { id: number; ref: string };

export class ErreurDolibarr extends Error {
  constructor(
    message: string,
    readonly statut: number
  ) {
    super(message);
  }
}

function base(config: Config): string {
  const url = config.dolibarr?.url?.replace(/\/+$/, '');
  if (!url) throw new Error('Dolibarr non configuré (dolibarr.url dans config.json)');
  return `${url}/api/index.php`;
}

export function entiteDe(config: Config, societe: string): number {
  const entite = config.dolibarr?.entites?.[societe];
  if (!entite) throw new Error(`Aucune entité Dolibarr pour la société « ${societe} » (dolibarr.entites dans config.json)`);
  return entite;
}

async function appel<T>(config: Config, entite: number, methode: 'GET' | 'POST', chemin: string, corps?: unknown): Promise<T> {
  const cle = process.env.DOLIBARR_API_KEY;
  if (!cle) throw new Error('Clé DOLIBARR_API_KEY manquante (attendue dans .env.local)');
  const reponse = await fetch(`${base(config)}${chemin}`, {
    method: methode,
    headers: {
      DOLAPIKEY: cle,
      DOLAPIENTITY: String(entite),
      Accept: 'application/json',
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const texte = await reponse.text();
  if (!reponse.ok) {
    // Le message d'erreur Dolibarr est utile ; la clé, elle, n'y figure jamais.
    let detail = texte.slice(0, 300);
    try {
      const j = JSON.parse(texte) as { error?: { message?: string } };
      detail = j.error?.message ?? detail;
    } catch {
      // réponse non JSON (page d'erreur du serveur)
    }
    throw new ErreurDolibarr(`Dolibarr ${methode} ${chemin.split('?')[0]} : HTTP ${reponse.status} ${detail}`, reponse.status);
  }
  return (texte ? JSON.parse(texte) : null) as T;
}

/** Vérifie les droits du compte API dans une entité : lecture des tiers et des interventions.
 *  (/setup/company serait plus parlant, mais Dolibarr le réserve aux administrateurs.) */
export async function verifierDroits(config: Config, entite: number): Promise<void> {
  for (const chemin of ['/thirdparties?limit=1', '/interventions?limit=1']) {
    try {
      await appel(config, entite, 'GET', chemin);
    } catch (e) {
      // 404 : liste vide, l'accès est bon.
      if (!(e instanceof ErreurDolibarr && e.statut === 404)) throw e;
    }
  }
}

/** Entités du module Multi-société, si son API est disponible : id et nom de chaque société.
 *  Renvoie null quand l'API ne l'expose pas (on vérifie alors entité par entité). */
export async function listerEntites(config: Config): Promise<{ id: number; nom: string }[] | null> {
  try {
    const liste = await appel<{ id: number | string; label?: string; name?: string }[]>(config, 1, 'GET', '/multicompany?limit=50');
    return (liste ?? []).map((x) => ({ id: Number(x.id), nom: x.label ?? x.name ?? '' }));
  } catch (e) {
    if (e instanceof ErreurDolibarr && (e.statut === 404 || e.statut === 501)) return null;
    throw e;
  }
}

/** Filtre « modifié depuis » (colonne tms de Dolibarr). Trois heures de marge : le fuseau de la
 *  base Dolibarr n'est pas connu, et relire un objet deux fois est sans effet. */
export function modifiesDepuis(d: Date): string {
  const t = new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
  return `(t.tms:>=:'${t}')`;
}

/** Lit toutes les pages d'une liste de l'API (Dolibarr répond 404 quand une page est vide). */
async function toutLire<T>(config: Config, entite: number, chemin: string, sqlfilters?: string): Promise<T[]> {
  const tout: T[] = [];
  const filtre = sqlfilters ? `&sqlfilters=${encodeURIComponent(sqlfilters)}` : '';
  for (let page = 0; ; page++) {
    let lot: T[];
    try {
      lot = (await appel<T[]>(config, entite, 'GET', `${chemin}${chemin.includes('?') ? '&' : '?'}limit=500&page=${page}&sortfield=t.rowid&sortorder=ASC${filtre}`)) ?? [];
    } catch (e) {
      if (e instanceof ErreurDolibarr && e.statut === 404) break;
      throw e;
    }
    tout.push(...lot);
    if (lot.length < 500) break;
  }
  return tout;
}

/** Objet de l'API sans les champs vides : c'est ce qu'on garde en « brut » pour référence. */
function compacter(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && v && Object.keys(v).length === 0)));
}

const texte = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

export type TiersLu = Tiers & { brut: Record<string, unknown> };
export type ContactLu = ContactTiers & { brut: Record<string, unknown> };

/** Liste complète des tiers et de leurs contacts, toutes sociétés confondues (dédoublonnée :
 *  les tiers partagés entre entités remontent dans chacune). */
function versTiers(t: Record<string, unknown>): TiersLu {
  return {
    id: Number(t.id),
    nom: texte(t.name ?? t.nom),
    alias: texte(t.name_alias),
    code_client: texte(t.code_client),
    code_fournisseur: texte(t.code_fournisseur),
    siret: texte(t.idprof2).replace(/\s/g, ''),
    tva_intra: texte(t.tva_intra).replace(/\s/g, '').toUpperCase(),
    adresse: texte(t.address),
    cp: texte(t.zip),
    ville: texte(t.town),
    telephone: [texte(t.phone), texte(t.phone_mobile)].filter(Boolean).join(' / '),
    email: texte(t.email).toLowerCase(),
    parent_id: Number(t.parent) > 0 ? Number(t.parent) : null,
    client: Number(t.client) || 0,
    fournisseur: Number(t.fournisseur) || 0,
    actif: String(t.status ?? '1') === '1',
    note_publique: texte(t.note_public),
    note_privee: texte(t.note_private),
    brut: compacter(t),
  };
}

function versContact(c: Record<string, unknown>): ContactLu {
  return {
    id: Number(c.id),
    tiers_id: Number(c.socid) > 0 ? Number(c.socid) : null,
    nom: [texte(c.firstname), texte(c.lastname)].filter(Boolean).join(' '),
    email: texte(c.email).toLowerCase(),
    telephone: [texte(c.phone_pro), texte(c.phone_mobile), texte(c.phone_perso)].filter(Boolean).join(' / '),
    poste: texte(c.poste),
    brut: compacter(c),
  };
}

/** Tiers et contacts de toutes les sociétés (dédoublonnés : les tiers partagés entre entités
 *  remontent dans chacune). Avec `depuis`, seulement ceux modifiés depuis cette date : c'est le
 *  relevé quotidien ; la relecture complète n'a lieu qu'une fois par mois. */
export async function lireTiersEtContacts(config: Config, depuis?: Date): Promise<{ tiers: TiersLu[]; contacts: ContactLu[] }> {
  const filtre = depuis ? modifiesDepuis(depuis) : undefined;
  const tiers = new Map<number, TiersLu>();
  const contacts = new Map<number, ContactLu>();
  for (const entite of new Set(Object.values(config.dolibarr.entites))) {
    for (const t of await toutLire<Record<string, unknown>>(config, entite, '/thirdparties', filtre)) if (!tiers.has(Number(t.id))) tiers.set(Number(t.id), versTiers(t));
    for (const c of await toutLire<Record<string, unknown>>(config, entite, '/contacts', filtre)) if (!contacts.has(Number(c.id))) contacts.set(Number(c.id), versContact(c));
  }
  return { tiers: [...tiers.values()], contacts: [...contacts.values()] };
}

/** Un seul tiers (créé depuis le dernier relevé), ou null. */
export async function lireUnTiers(config: Config, entite: number, id: number): Promise<TiersLu | null> {
  try {
    return versTiers(await appel<Record<string, unknown>>(config, entite, 'GET', `/thirdparties/${id}`));
  } catch (e) {
    if (e instanceof ErreurDolibarr && e.statut === 404) return null;
    throw e;
  }
}

export type BonLu = {
  id: number;
  ref: string;
  socid: number;
  description: string;
  statut: number; // 0 brouillon, 1 validé, 2 facturé, 3 clôturé
  creeLe: Date;
  refClient: string;
  facturationDemarree: boolean;
};

const VRAI = (v: unknown) => v === true || v === 1 || /^(1|oui|yes|true)$/i.test(String(v ?? '').trim());

/** « Facturation démarrée » : bon classé facturé, ou case à cocher Dolibarr (champ
 *  complémentaire dont le nom contient « factur »). */
export function facturationDemarree(b: Record<string, unknown>, statut: number): boolean {
  if (statut === 2) return true;
  const options = (b.array_options ?? {}) as Record<string, unknown>;
  return Object.entries(options).some(([cle, v]) => /factur/i.test(cle) && VRAI(v));
}

/** Bons d'intervention d'une société répondant au filtre (nouveaux depuis un n°, ou modifiés
 *  depuis une date) : jamais la liste entière. */
function versBon(b: Record<string, unknown>): BonLu {
  const statut = Number(b.statut ?? b.fk_statut ?? b.status) || 0;
  return {
    id: Number(b.id),
    ref: texte(b.ref),
    socid: Number(b.socid) || 0,
    description: texte(b.description),
    statut,
    creeLe: new Date(Number(b.datec ?? b.date_creation ?? 0) * 1000),
    refClient: texte(b.ref_client),
    facturationDemarree: facturationDemarree(b, statut),
  };
}

export async function lireBons(config: Config, entite: number, sqlfilters: string): Promise<BonLu[]> {
  const liste = await toutLire<Record<string, unknown>>(config, entite, '/interventions', sqlfilters);
  return liste.map(versBon);
}

export type PropositionLue = { id: number; ref: string; socid: number; statut: number; creeLe: Date; signeLe: Date | null; libelle: string; refClient: string };

/** Propositions commerciales (devis).
 *  Statuts Dolibarr : 0 brouillon, 1 validée (envoyée), 2 signée, 3 refusée, 4 facturée. */
/** Propositions modifiées depuis une date ; sans date (tout premier relevé), les 200 dernières. */
export async function lirePropositions(config: Config, entite: number, depuis: Date | null): Promise<PropositionLue[]> {
  let liste: Record<string, unknown>[];
  if (depuis) liste = await toutLire<Record<string, unknown>>(config, entite, '/proposals', modifiesDepuis(depuis));
  else {
    try {
      liste = (await appel<Record<string, unknown>[]>(config, entite, 'GET', '/proposals?limit=200&sortfield=t.rowid&sortorder=DESC')) ?? [];
    } catch (e) {
      if (e instanceof ErreurDolibarr && e.statut === 404) return [];
      throw e;
    }
  }
  return liste.map((p) => {
    const lignes = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]) : [];
    const premiere = texte(lignes[0]?.desc ?? lignes[0]?.description ?? lignes[0]?.product_label).replace(/<[^>]+>/g, ' ');
    return {
      id: Number(p.id),
      ref: texte(p.ref),
      socid: Number(p.socid) || 0,
      statut: Number(p.statut ?? p.fk_statut ?? p.status) || 0,
      creeLe: new Date(Number(p.datec ?? p.date_creation ?? p.date ?? 0) * 1000),
      // Date de signature (clôture) ; les montants ne sont jamais repris : les écrans sont vus par les agents.
      signeLe: Number(p.date_signature ?? p.date_cloture) > 0 ? new Date(Number(p.date_signature ?? p.date_cloture) * 1000) : null,
      libelle: (texte(p.note_public).replace(/<[^>]+>/g, ' ') || premiere).replace(/\s+/g, ' ').trim().slice(0, 200),
      refClient: texte(p.ref_client),
    };
  });
}

/** Proposition commerciale par sa référence (ex. D-ST-260055), ou null. */
export async function propositionParRef(config: Config, entite: number, ref: string): Promise<{ id: number; ref: string; socid: number; statut: number } | null> {
  try {
    const liste = await appel<Record<string, unknown>[]>(config, entite, 'GET', `/proposals?limit=1&sqlfilters=${encodeURIComponent(`(t.ref:=:'${ref.replace(/[^\w-]/g, '')}')`)}`);
    const p = liste?.[0];
    return p ? { id: Number(p.id), ref: texte(p.ref), socid: Number(p.socid) || 0, statut: Number(p.statut ?? p.fk_statut ?? p.status) || 0 } : null;
  } catch (e) {
    if (e instanceof ErreurDolibarr && e.statut === 404) return null;
    throw e;
  }
}

/** Bon d'intervention par sa référence (ex. I-SA-260430), ou null. */
export async function bonParRef(config: Config, entite: number, ref: string): Promise<BonLu | null> {
  try {
    const liste = await appel<Record<string, unknown>[]>(config, entite, 'GET', `/interventions?limit=1&sqlfilters=${encodeURIComponent(`(t.ref:=:'${ref.replace(/[^\w-]/g, '')}')`)}`);
    const b = liste?.[0];
    return b ? versBon(b) : null;
  } catch (e) {
    if (e instanceof ErreurDolibarr && e.statut === 404) return null;
    throw e;
  }
}

/** Texte du bon : ce qu'un technicien doit savoir en ouvrant la fiche. */
export function descriptionBon(c: Classification, reference: string): string {
  const lignes = [
    c.nature || c.resume,
    c.urgence === 'urgente' ? 'URGENT' : '',
    [c.contact.adresse, c.contact.commune].filter(Boolean).length ? `Lieu : ${[c.contact.adresse, c.contact.commune].filter(Boolean).join(', ')}` : '',
    c.contact.telephone ? `Contact : ${c.contact.nom} ${c.contact.telephone}`.trim() : '',
    c.dateSouhaitee ? `Souhaité : ${c.dateSouhaitee}` : '',
    c.resume && c.nature ? `Demande : ${c.resume}` : '',
    `Réf. secrétariat : ${reference}`,
  ];
  return lignes.filter(Boolean).join('\n');
}

/** Crée le bon d'intervention en brouillon et renvoie sa référence Dolibarr. */
export async function creerBonIntervention(config: Config, entite: number, socid: number, c: Classification, reference: string): Promise<BonDolibarr> {
  const id = await appel<number>(config, entite, 'POST', '/interventions', {
    socid,
    fk_project: 0, // champ obligatoire de l'API ; 0 = aucun projet
    description: descriptionBon(c, reference),
    ref_client: reference,
    note_private: `Créé par le secrétariat CYRNEO depuis un mail (${reference}).`,
  });
  const bon = await appel<{ id: number | string; ref?: string }>(config, entite, 'GET', `/interventions/${id}`);
  return { id: Number(id), ref: bon.ref ?? `#${id}` };
}

/** Crée un fournisseur (seule création de tiers autorisée : demandée pour les factures). */
export async function creerFournisseur(config: Config, entite: number, f: FournisseurLu): Promise<number> {
  const id = await appel<number>(config, entite, 'POST', '/thirdparties', {
    name: f.nom,
    client: 0,
    fournisseur: 1,
    code_fournisseur: 'auto',
    address: f.adresse || undefined,
    zip: f.cp || undefined,
    town: f.ville || undefined,
    email: f.email || undefined,
    phone: f.telephone || undefined,
    idprof2: f.siret.replace(/\s/g, '') || undefined,
    idprof1: f.siret.replace(/\D/g, '').slice(0, 9) || undefined,
    tva_intra: f.tvaIntra.replace(/\s/g, '') || undefined,
    country_code: 'FR',
    note_private: 'Créé automatiquement par le secrétariat CYRNEO à partir d’une facture reçue par mail.',
  });
  return Number(id);
}

/** Facture de ce fournisseur avec ce numéro déjà saisie ? (évite les doublons) */
export async function factureFournisseurExiste(config: Config, entite: number, socid: number, numero: string): Promise<string | null> {
  const ref = numero.replace(/'/g, ' ');
  try {
    const liste = await appel<{ ref?: string }[]>(
      config,
      entite,
      'GET',
      `/supplierinvoices?limit=1&sqlfilters=${encodeURIComponent(`(t.ref_supplier:=:'${ref}') and (t.fk_soc:=:${socid})`)}`
    );
    return liste?.[0] ? (liste[0].ref ?? numero) : null;
  } catch (e) {
    if (e instanceof ErreurDolibarr && e.statut === 404) return null;
    throw e;
  }
}

const horodatage = (jour: string) => Math.floor(new Date(`${jour}T12:00:00Z`).getTime() / 1000);

/** Facture fournisseur en brouillon, avec toutes ses lignes, PDF joint. */
export async function creerFactureFournisseur(
  config: Config,
  entite: number,
  socid: number,
  f: FactureLue,
  pdf: { nom: string; contenu: Buffer }
): Promise<{ id: number; ref: string }> {
  const id = Number(
    await appel<number>(config, entite, 'POST', '/supplierinvoices', {
      socid,
      ref_supplier: f.numero,
      type: f.avoir ? 2 : 0,
      date: horodatage(f.date),
      ...(f.echeance && /^\d{4}-\d{2}-\d{2}$/.test(f.echeance) ? { date_echeance: horodatage(f.echeance) } : {}),
      label: f.libelle.slice(0, 255),
      note_private: 'Saisie automatique du secrétariat CYRNEO depuis le PDF reçu par mail : à vérifier avant validation.',
    })
  );
  for (const l of f.lignes) {
    await appel(config, entite, 'POST', `/supplierinvoices/${id}/lines`, {
      description: l.description,
      pu_ht: prixUnitaireSaisi(l),
      qty: l.quantite,
      remise_percent: l.remisePct,
      tva_tx: l.tauxTva,
      product_type: 0,
    });
  }
  const facture = await appel<{ ref?: string }>(config, entite, 'GET', `/supplierinvoices/${id}`);
  const ref = facture.ref ?? `(PROV${id})`;
  await appel(config, entite, 'POST', '/documents/upload', {
    filename: pdf.nom.replace(/[^\w.\- ]/g, '_'),
    modulepart: 'supplier_invoice',
    ref,
    subdir: '',
    filecontent: pdf.contenu.toString('base64'),
    fileencoding: 'base64',
    overwriteifexists: 0,
    createdirifnotexists: 1,
  });
  return { id, ref };
}
