/**
 * Contrat d'entretien fosse sur deux ans, proposé après une vidange facturée. Les règles de
 * montage sont celles du site sud-assainissement-ajaccio.com (js/grille.js, seule source des
 * prix) : prix de la vidange selon le secteur, le volume (3 à 6 m³) et l'accès (+50 € au-delà de
 * 20 m), lissé en 24 mensualités ; la vidange vient d'être faite, donc « contrat seul » : il
 * finance la prochaine, dans deux ans.
 */
export type Grille = { GRILLE: Record<string, number[]>; ACCES_LOIN: number };

export type LigneFacture = { texte: string; ttc: number };

const sansAccents = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Une ligne de vidange de fosse (pas de bac à graisse, pas de poste de relevage). */
export const ligneVidangeFosse = (t: string) => {
  const s = sansAccents(t);
  return /vidange|pompage/.test(s) && !/graisse|relevage|separateur|hydrocarbure/.test(s);
};

/** Facture déjà liée à un contrat (mensualité, abonnement) : rien à proposer. */
export const ligneContrat = (t: string) => /contrat|mensualit|abonnement|prelevement/.test(sansAccents(t));

/** Communes rattachées aux secteurs de la grille (mêmes règles que l'assistant du site). */
const RATTACHEMENTS: Record<string, string> = {
  ajaccio: 'Grand Ajaccio', 'bastelica-mezzavia': 'Grand Ajaccio', mezzavia: 'Grand Ajaccio', afa: 'Grand Ajaccio', appietto: 'Grand Ajaccio',
  'grosseto-prugna': 'Porticcio', pietrosella: 'Porticcio', albitreccia: 'Porticcio',
  cauro: 'Cuttoli / plaine de Cuttoli', 'eccica-suarella': 'Cuttoli / plaine de Cuttoli', bastelica: 'Cuttoli / plaine de Cuttoli', 'cuttoli-corticchiato': 'Cuttoli / plaine de Cuttoli',
  calcatoggio: 'Tiuccia', casaglione: 'Tiuccia', coggia: 'Sagone', piana: 'Cargèse', cargese: 'Cargèse',
};

export function secteurDe(ville: string, adresse: string, grille: Grille): string | null {
  const lieu = sansAccents(`${ville} ${adresse}`).replace(/[’']/g, ' ');
  const v = sansAccents(ville).trim().replace(/\s+/g, '-');
  if (RATTACHEMENTS[v] && grille.GRILLE[RATTACHEMENTS[v]]) return RATTACHEMENTS[v];
  // Nom d'un secteur (ou d'une de ses parties : « Vero / Tavaco / Ucciani ») dans la ville ou l'adresse.
  for (const zone of Object.keys(grille.GRILLE)) {
    const parties = sansAccents(zone).replace(/[’']/g, ' ').split('/').map((p) => p.replace(/plaine de|grand/g, '').trim()).filter((p) => p.length >= 3);
    if (parties.some((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lieu))) return zone;
  }
  for (const [commune, zone] of Object.entries(RATTACHEMENTS)) if (new RegExp(`\\b${commune}\\b`).test(lieu)) return zone;
  return null;
}

/** Volume : écrit sur la facture (« 4 m3 »), sinon retrouvé d'après le prix facturé. */
export function volumeDe(lignes: LigneFacture[], secteur: string | null, grille: Grille): { volume: number | null; accesLoin: boolean } {
  const texte = sansAccents(lignes.map((l) => l.texte).join(' '));
  const accesLoin = /\+ ?20 ?m|plus de 20|> ?20 ?m|rallonge|tuyau supplementaire/.test(texte);
  const ecrit = /(\d+(?:[.,]\d+)?)\s*(?:m3|m³|m 3|metres? cubes?)/.exec(texte.replace(/m³/g, 'm3'));
  if (ecrit) {
    const v = Math.round(Number(ecrit[1].replace(',', '.')));
    if (v >= 1) return { volume: Math.min(6, Math.max(3, v)), accesLoin };
  }
  if (secteur && grille.GRILLE[secteur]) {
    const total = lignes.filter((l) => ligneVidangeFosse(l.texte)).reduce((a, l) => a + l.ttc, 0);
    for (const loin of [accesLoin, !accesLoin]) {
      const i = grille.GRILLE[secteur].findIndex((p) => Math.abs(p + (loin ? grille.ACCES_LOIN : 0) - total) < 1);
      if (i >= 0) return { volume: i + 3, accesLoin: loin };
    }
  }
  return { volume: null, accesLoin };
}

export const MOIS_CONTRAT = 24;

export function prixContrat(grille: Grille, secteur: string, volume: number, accesLoin: boolean): { vidange: number; mensualite: number } {
  const vidange = grille.GRILLE[secteur][volume - 3] + (accesLoin ? grille.ACCES_LOIN : 0);
  return { vidange, mensualite: Math.ceil((vidange * 100) / MOIS_CONTRAT) / 100 };
}
