/**
 * Lecture et contrôle de config.json. Les mots de passe n'y figurent
 * jamais : la config ne contient que les NOMS des variables de .env.local.
 */
import type { Config } from './types';

const DEFAUTS = {
  mode: 'simulation',
  intervalleMinutes: 2,
  repriseHeures: 24,
  domainesInternes: [],
  transferts: [],
  agendas: [],
  dossiers: { factures: 'donnees/factures', rapports: 'donnees/rapports' },
  rapport: { heure: '19:00', destinataires: [] },
  test: { bulleRainbow: '', adresse: '' },
  serveur: { port: 3939, ecranPublic: true },
  modele: 'claude-opus-5-5',
  dolibarr: { actif: false, url: '', entites: {} },
  ecran: { colonnes: [] },
  heuresOuvrees: { debut: '08:00', fin: '18:00' },
} as const;

export function validerConfig(brut: unknown): Config {
  if (!brut || typeof brut !== 'object') throw new Error('config.json : objet attendu');
  const c = { ...DEFAUTS, ...(brut as Record<string, unknown>) } as unknown as Config;
  const erreurs: string[] = [];

  if (!['simulation', 'test', 'reel'].includes(c.mode)) erreurs.push(`mode inconnu « ${c.mode} » (simulation, test ou reel)`);
  if (!Array.isArray(c.societes) || c.societes.length === 0) erreurs.push('au moins une société est attendue');
  if (!Array.isArray(c.boites) || c.boites.length === 0) erreurs.push('au moins une boîte mail est attendue');

  const ids = new Set((c.societes ?? []).map((s) => s.id));
  for (const s of c.societes ?? []) {
    if (!s.id || !s.nom) erreurs.push('chaque société doit avoir un id et un nom');
    if (!s.bulleRainbow) erreurs.push(`société ${s.id} : bulleRainbow manquante`);
    s.alerteSecours ??= [];
    s.delaiRappel ||= 'dans la journée';
    s.delaiDevis ||= 'sous 48 h';
  }
  for (const b of c.boites ?? []) {
    if (!b.id || !b.adresse || !b.utilisateurEnv || !b.motDePasseEnv) erreurs.push(`boîte ${b.id ?? '?'} : id, adresse, utilisateurEnv et motDePasseEnv sont obligatoires`);
    if (!ids.has(b.societeParDefaut)) erreurs.push(`boîte ${b.id} : societeParDefaut « ${b.societeParDefaut} » ne correspond à aucune société`);
  }
  for (const r of c.transferts ?? []) {
    if (r.societes !== '*') for (const s of r.societes) if (!ids.has(s)) erreurs.push(`transfert : société inconnue « ${s} »`);
  }
  if (c.mode === 'test' && (!c.test.bulleRainbow || !c.test.adresse)) {
    erreurs.push('mode test : renseigner test.bulleRainbow et test.adresse (tout y sera envoyé à la place des vrais destinataires)');
  }
  // Sans colonnes définies : une colonne par agenda.
  if (!c.ecran.colonnes.length) c.ecran = { colonnes: c.agendas.map((a) => ({ titre: a.nom, agendas: [a.icsEnv] })) };
  for (const col of c.ecran.colonnes) {
    for (const env of col.agendas) if (!c.agendas.some((a) => a.icsEnv === env)) erreurs.push(`ecran : agenda « ${env} » absent de la liste agendas`);
  }
  if (c.dolibarr.actif) {
    if (!/^https?:\/\//.test(c.dolibarr.url)) erreurs.push('dolibarr.url : adresse du Dolibarr attendue (https://…)');
    for (const [s, n] of Object.entries(c.dolibarr.entites)) {
      if (!ids.has(s)) erreurs.push(`dolibarr.entites : société inconnue « ${s} »`);
      if (!Number.isInteger(n) || n < 1) erreurs.push(`dolibarr.entites.${s} : numéro d'entité entier attendu`);
    }
  }
  if (!/^\d{1,2}:\d{2}$/.test(c.heuresOuvrees.debut) || !/^\d{1,2}:\d{2}$/.test(c.heuresOuvrees.fin)) erreurs.push('heuresOuvrees : debut et fin au format HH:MM');
  if (!/^\d{1,2}:\d{2}$/.test(c.rapport.heure)) erreurs.push('rapport.heure au format HH:MM');

  // Société sans numéro : les mails clients donnent celui du groupe, jamais un trou.
  const numeroGroupe = (c.societes ?? []).find((s) => s.telephone)?.telephone ?? '';
  if (!numeroGroupe) erreurs.push('au moins une société doit avoir un téléphone');
  for (const s of c.societes ?? []) s.telephone ||= numeroGroupe;

  if (erreurs.length > 0) throw new Error('config.json invalide :\n  - ' + erreurs.join('\n  - '));
  // Les boîtes lues sont internes d'office : jamais de réponse automatique entre elles.
  c.domainesInternes = [...new Set([...c.domainesInternes, ...c.boites.map((b) => b.adresse)].map((d) => d.toLowerCase()))];
  return c;
}
