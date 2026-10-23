/**
 * Connecteur Dolibarr (API REST, module Multi-société).
 *
 * Un seul accès (DOLIBARR_API_KEY) pour toutes les sociétés : l'en-tête DOLAPIENTITY
 * choisit la société (l'« entité » Dolibarr) à chaque appel. Le compte API doit avoir
 * accès à chaque entité et les droits Tiers (lire/créer) et Interventions (lire/créer).
 *
 * Les bons sont créés en BROUILLON : un humain les valide dans Dolibarr.
 */
import type { Classification, Config } from '../logique/types';

export type ClientDolibarr = { id: number; nom: string; cree: boolean };
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

/** Nom de la société configurée dans l'entité : sert à vérifier la connexion et le numéro d'entité. */
export async function nomEntite(config: Config, entite: number): Promise<string> {
  const societe = await appel<{ name?: string; nom?: string }>(config, entite, 'GET', '/setup/company');
  return societe.name ?? societe.nom ?? '(sans nom)';
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

type TiersBrut = { id: string | number; name?: string; nom?: string };

function filtre(valeur: string): string {
  // Les apostrophes casseraient le filtre SQL de Dolibarr : elles ne servent pas à la recherche.
  return valeur.replace(/['"()]/g, ' ').trim();
}

async function chercher(config: Config, entite: number, sqlfilters: string): Promise<TiersBrut | null> {
  try {
    const liste = await appel<TiersBrut[]>(config, entite, 'GET', `/thirdparties?limit=1&sqlfilters=${encodeURIComponent(sqlfilters)}`);
    return liste?.[0] ?? null;
  } catch (e) {
    // Dolibarr répond 404 quand la recherche ne trouve rien.
    if (e instanceof ErreurDolibarr && e.statut === 404) return null;
    throw e;
  }
}

/** Retrouve le client par email, puis par téléphone ; le crée s'il n'existe pas. */
export async function trouverOuCreerClient(config: Config, entite: number, c: Classification): Promise<ClientDolibarr> {
  const { email, telephone, nom, adresse, commune } = c.contact;
  const tel = telephone.replace(/\s/g, '');

  let trouve: TiersBrut | null = null;
  if (email) trouve = await chercher(config, entite, `(t.email:=:'${filtre(email)}')`);
  if (!trouve && tel) trouve = await chercher(config, entite, `(t.phone:like:'%${filtre(tel.slice(-9))}%')`);
  if (trouve) return { id: Number(trouve.id), nom: trouve.name ?? trouve.nom ?? nom, cree: false };

  const id = await appel<number>(config, entite, 'POST', '/thirdparties', {
    name: nom || email || tel || 'Client à identifier',
    client: 1, // client (et non prospect ou fournisseur)
    code_client: 'auto', // numérotation automatique de Dolibarr
    email: email || undefined,
    phone: tel || undefined,
    address: adresse || undefined,
    town: commune || undefined,
    country_code: 'FR',
    note_private: 'Créé automatiquement par le secrétariat CYRNEO à partir d’un mail.',
  });
  return { id: Number(id), nom: nom || email || tel, cree: true };
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
