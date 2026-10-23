/**
 * Reconnaissance du tiers Dolibarr d'une demande, à partir de la liste synchronisée.
 *
 * Un tiers est le lieu ou le client de l'intervention : une résidence, une personne, une
 * entreprise. Il est parfois rattaché à un syndic (tiers parent). Le syndic qui écrit n'est
 * pas le client de l'intervention : on cherche la résidence ou l'occupant derrière lui.
 */

export type Tiers = {
  id: number;
  nom: string;
  alias: string;
  code_client: string;
  code_fournisseur: string;
  siret: string;
  tva_intra: string;
  adresse: string;
  cp: string;
  ville: string;
  telephone: string;
  email: string;
  parent_id: number | null;
  client: number;
  fournisseur: number;
  actif: boolean;
  note_publique: string;
  note_privee: string;
};

export type ContactTiers = { id: number; tiers_id: number | null; nom: string; email: string; telephone: string; poste: string };

export type IndexTiers = {
  tiers: Map<number, Tiers>;
  contactsParTiers: Map<number, ContactTiers[]>;
  parEmail: Map<string, number[]>; // email → tiers (le sien ou celui d'un de ses contacts)
  parTelephone: Map<string, number[]>; // 9 derniers chiffres → tiers
  enfants: Map<number, number[]>; // syndic → tiers rattachés
};

export type Demande = {
  expediteur: string; // adresse de l'expéditeur du mail
  nom: string;
  email: string;
  telephone: string;
  adresse: string;
  commune: string;
  texte: string; // résumé et nature : le nom d'une résidence y figure souvent
};

export type Candidat = { tiers: Tiers; score: number; raisons: string[] };

const MOTS_VIDES = new Set(
  'residence residences villa villas rue route chemin avenue av bd boulevard impasse lotissement lot lieu dit bat batiment immeuble appartement appt app le la les de du des d l au aux et en sur a m mr mme mlle monsieur madame mademoiselle sci sarl sas sa eurl copropriete copro syndic locataire locataires proprietaire chez pour'.split(' ')
);

export function mots(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((m) => m && !MOTS_VIDES.has(m) && (m.length >= 3 || /^\d+$/.test(m)));
}

export function chiffres(tel: string): string[] {
  return tel
    .split(/[\/,;]| ou /)
    .map((t) => t.replace(/\D/g, ''))
    .filter((t) => t.length >= 9)
    .map((t) => t.slice(-9));
}

const ajouter = (m: Map<string, number[]>, cle: string, id: number) => {
  if (!cle) return;
  const l = m.get(cle) ?? [];
  if (!l.includes(id)) l.push(id);
  m.set(cle, l);
};

export function indexer(tiers: Tiers[], contacts: ContactTiers[]): IndexTiers {
  const index: IndexTiers = { tiers: new Map(), contactsParTiers: new Map(), parEmail: new Map(), parTelephone: new Map(), enfants: new Map() };
  for (const t of tiers) {
    index.tiers.set(t.id, t);
    ajouter(index.parEmail, t.email, t.id);
    for (const c of chiffres(t.telephone)) ajouter(index.parTelephone, c, t.id);
    if (t.parent_id) index.enfants.set(t.parent_id, [...(index.enfants.get(t.parent_id) ?? []), t.id]);
  }
  for (const c of contacts) {
    if (!c.tiers_id || !index.tiers.has(c.tiers_id)) continue;
    index.contactsParTiers.set(c.tiers_id, [...(index.contactsParTiers.get(c.tiers_id) ?? []), c]);
    ajouter(index.parEmail, c.email, c.tiers_id);
    for (const t of chiffres(c.telephone)) ajouter(index.parTelephone, t, c.tiers_id);
  }
  return index;
}

const RE_SYNDIC = /syndic|immobili|immo\b|gestion|foncia|nexity|citya|oralia|square habitat|agence|regie|bailleur|erilia|logirem|office public|opac|opah|habitat/i;

/** Syndic, agence ou bailleur : a des tiers rattachés, ou son nom le dit. */
export function estSyndic(index: IndexTiers, t: Tiers): boolean {
  return (index.enfants.get(t.id)?.length ?? 0) > 0 || RE_SYNDIC.test(`${t.nom} ${t.alias}`);
}

/** Le nom (client, résidence) se retrouve-t-il dans ce texte (titre d'agenda, nom saisi) ? Tous
 *  ses mots significatifs doivent y être. */
export function nomPresent(nom: string, texte: string): boolean {
  const cherches = mots(nom).filter((m) => !/^\d+$/.test(m));
  if (cherches.length === 0) return false;
  const dans = new Set(mots(texte));
  return cherches.every((m) => dans.has(m));
}

/** Syndic à l'origine de la demande : celui dont l'expéditeur est l'adresse ou un contact. */
export function syndicExpediteur(index: IndexTiers, expediteur: string): Tiers | null {
  for (const id of index.parEmail.get(expediteur.toLowerCase()) ?? []) {
    const t = index.tiers.get(id);
    if (t && estSyndic(index, t)) return t;
  }
  return null;
}

/** Candidats classés du plus probable au moins probable (8 au plus). */
export function candidats(index: IndexTiers, d: Demande, syndic: Tiers | null): Candidat[] {
  const scores = new Map<number, Candidat>();
  const noter = (id: number, points: number, raison: string) => {
    const t = index.tiers.get(id);
    if (!t || (syndic && id === syndic.id)) return;
    const c = scores.get(id) ?? { tiers: t, score: 0, raisons: [] };
    c.score += points;
    if (!c.raisons.includes(raison)) c.raisons.push(raison);
    scores.set(id, c);
  };

  // Email et téléphone du client (pas ceux du syndic qui écrit).
  const emails = [d.email, syndic ? '' : d.expediteur].map((e) => e.toLowerCase()).filter(Boolean);
  for (const e of new Set(emails)) for (const id of index.parEmail.get(e) ?? []) noter(id, 60, 'email');
  for (const t of chiffres(d.telephone)) for (const id of index.parTelephone.get(t) ?? []) noter(id, 60, 'téléphone');

  // Lieu : mots de l'adresse, de la commune, du nom et du résumé contre nom / adresse du tiers.
  const motsDemande = new Set(mots(`${d.adresse} ${d.commune} ${d.nom} ${d.texte}`));
  const commune = mots(d.commune).join(' ');
  if (motsDemande.size > 0) {
    for (const t of index.tiers.values()) {
      const motsTiers = new Set(mots(`${t.nom} ${t.alias} ${t.adresse}`));
      let communs = 0;
      for (const m of motsTiers) if (motsDemande.has(m)) communs += /^\d+$/.test(m) ? 0.5 : 1;
      if (communs === 0) continue;
      noter(t.id, Math.min(60, communs * 15), 'nom/adresse');
      if (commune && mots(t.ville).join(' ') === commune) noter(t.id, 10, 'commune');
    }
  }

  for (const c of scores.values()) {
    if (syndic && c.tiers.parent_id === syndic.id) {
      c.score += 25;
      c.raisons.push(`rattaché à ${syndic.nom}`);
    }
    if (!c.tiers.actif) c.score -= 20;
  }
  return [...scores.values()].filter((c) => c.score >= 20).sort((a, b) => b.score - a.score).slice(0, 8);
}

/** Le premier candidat est-il assez net pour se passer d'un arbitrage ? */
export function evident(liste: Candidat[]): boolean {
  if (liste.length === 0) return false;
  const [a, b] = liste;
  return a.score >= 70 && (!b || a.score - b.score >= 25);
}

/** Ligne de présentation d'un tiers (Rainbow, arbitrage). */
export function decrireTiers(index: IndexTiers, t: Tiers): string {
  const parent = t.parent_id ? index.tiers.get(t.parent_id) : null;
  return [
    `${t.nom}${t.alias ? ` (${t.alias})` : ''}${t.code_client ? ` · ${t.code_client}` : ''}`,
    [t.adresse, [t.cp, t.ville].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    parent ? `syndic : ${parent.nom}` : '',
    t.telephone ? `tél. ${t.telephone}` : '',
    t.email,
    t.actif ? '' : 'INACTIF',
  ]
    .filter(Boolean)
    .join(' · ');
}
