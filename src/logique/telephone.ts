/**
 * Numéros de téléphone français : détection dans un texte libre et mise en forme.
 * Sert à vérifier ce que renvoie le modèle — on ne promet jamais un rappel sur
 * un numéro qui n'existe pas dans le mail.
 */

// 0X XX XX XX XX, +33 X XX XX XX XX, 0033…, séparateurs espace, point ou tiret.
const RE_TELEPHONE = /(?:\+33\s?\(?0?\)?\s?|0033\s?|\b0)[1-9](?:[\s.\-]?\d{2}){4}\b/g;

/** Ramène un numéro à 10 chiffres commençant par 0, ou null s'il n'est pas valide. */
export function normaliserTelephone(brut: string): string | null {
  let chiffres = brut.replace(/[^\d+]/g, '');
  if (chiffres.startsWith('+33')) chiffres = '0' + chiffres.slice(3);
  else if (chiffres.startsWith('0033')) chiffres = '0' + chiffres.slice(4);
  chiffres = chiffres.replace(/\+/g, '');
  // « +33 (0)6 … » donne 006… une fois l'indicatif remplacé.
  if (chiffres.startsWith('00') && chiffres.length === 11) chiffres = chiffres.slice(1);
  if (!/^0[1-9]\d{8}$/.test(chiffres)) return null;
  return chiffres;
}

/** « 0612345678 » → « 06 12 34 56 78 ». */
export function formaterTelephone(numero: string): string {
  const n = normaliserTelephone(numero);
  if (!n) return numero;
  return n.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

/** Tous les numéros trouvés dans le texte, normalisés, sans doublon, hors numéros exclus
 *  (ceux des sociétés du groupe, souvent recopiés dans la signature ou la citation). */
export function trouverTelephones(texte: string, exclus: string[] = []): string[] {
  const interdits = new Set(exclus.map((e) => normaliserTelephone(e)).filter(Boolean));
  const vus = new Set<string>();
  for (const correspondance of texte.matchAll(RE_TELEPHONE)) {
    const n = normaliserTelephone(correspondance[0]);
    if (n && !interdits.has(n)) vus.add(n);
  }
  return [...vus];
}

/** Retient le numéro proposé par le modèle s'il figure bien dans le texte (et n'est pas
 *  un numéro du groupe), sinon le premier numéro trouvé dans le texte. Vide si aucun. */
export function choisirTelephone(proposeParModele: string, texte: string, exclus: string[]): string {
  const trouves = trouverTelephones(texte, exclus);
  const propose = normaliserTelephone(proposeParModele);
  if (propose && trouves.includes(propose)) return formaterTelephone(propose);
  return trouves.length > 0 ? formaterTelephone(trouves[0]) : '';
}
