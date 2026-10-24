/**
 * Relecture des factures émises : une vidange de fosse facturée → proposition de contrat
 * d'entretien sur deux ans (la vidange vient d'être faite, le contrat finance la prochaine).
 *
 * Le contrat est celui du site (modèle Word de Cyrneo-app, signature en ligne, prélèvement SEPA
 * Stripe) : le secrétariat prépare le lien de signature sans l'envoyer ; le bureau relit et
 * l'envoie au client depuis la page Contrats. Rien ne part chez le client automatiquement.
 *
 * Variables : SITE_SA_URL (par défaut le site de Sud Assainissement), SITE_PRO_CODE (code de
 * l'espace commercial du site, pour préparer les liens).
 */
import vm from 'node:vm';
import type { Config } from '../logique/types';
import { ligneContrat, ligneVidangeFosse, MOIS_CONTRAT, prixContrat, secteurDe, volumeDe, type Grille } from '../logique/contrat';
import { estSyndic } from '../logique/tiers';
import { contratActif, lireFacturesEmises } from './dolibarr';
import { indexTiers, tiersParId } from './tiers';
import { publier } from './rainbow';
import * as db from './stockage';

type Journal = (texte: string) => void;

const SOCIETES_CONTRAT = ['sud-assainissement'];
const site = () => (process.env.SITE_SA_URL || 'https://www.sud-assainissement-ajaccio.com').replace(/\/$/, '');
const euros = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;

let grille: { valeur: Grille; le: number } | null = null;

/** La grille tarifaire du site (js/grille.js), seule source des prix ; relue toutes les 6 h. */
export async function chargerGrille(): Promise<Grille> {
  if (grille && Date.now() - grille.le < 6 * 3_600_000) return grille.valeur;
  const r = await fetch(`${site()}/js/grille.js`);
  if (!r.ok) throw new Error(`grille tarifaire du site : HTTP ${r.status}`);
  const module = { exports: {} as Grille };
  vm.runInNewContext(await r.text(), { module, self: {} }, { timeout: 1000 });
  if (!module.exports.GRILLE) throw new Error('grille tarifaire du site illisible');
  grille = { valeur: module.exports, le: Date.now() };
  return module.exports;
}

export async function relireFacturesEmises(config: Config, log: Journal): Promise<string[]> {
  const g = await chargerGrille();
  const bilan: string[] = [];
  for (const societe of config.contrats?.societes ?? SOCIETES_CONTRAT) {
    const entite = config.dolibarr.entites[societe];
    if (!entite) continue;
    const curseur = `factures_emises:${entite}`;
    const depuis = await db.lireSynchro(curseur);
    const debut = new Date();
    // Premier relevé : onze mois en arrière (au-delà d'un an, ce serait un pack, pas un contrat seul).
    const factures = await lireFacturesEmises(config, entite, depuis ? new Date(depuis) : null, new Date(Date.now() - 330 * 86_400_000));
    for (const f of factures) {
      if (!f.socid || !f.lignes.some((l) => ligneVidangeFosse(l.texte)) || f.lignes.some((l) => ligneContrat(l.texte))) continue;
      if (Date.now() - f.date.getTime() > 365 * 86_400_000) continue;
      if (await db.contratDejaPropose(entite, f.socid, f.id)) continue;
      if ((await contratActif(config, entite, f.socid)) === true) continue;
      const ligne = await preparer(config, g, entite, f);
      if (ligne) {
        bilan.push(ligne);
        log(`Contrat d'entretien à proposer : ${ligne}`);
      }
    }
    await db.ecrireSynchro(curseur, debut.toISOString());
  }
  if (bilan.length) {
    const texte = [`📄 Contrats d'entretien à proposer (vidange facturée → contrat 2 ans) : ${bilan.length}`, ...bilan.slice(0, 15), bilan.length > 15 ? `… et ${bilan.length - 15} autres` : '', 'À relire et envoyer depuis la page Contrats.']
      .filter(Boolean)
      .join('\n');
    const bulle = config.mode === 'reel' ? config.bulles.admin : config.test.bulleRainbow;
    if (bulle) await publier(bulle, texte).catch((e) => log(`⚠️ Bilan contrats : ${e instanceof Error ? e.message : String(e)}`));
  }
  return bilan;
}

async function preparer(config: Config, g: Grille, entite: number, f: Awaited<ReturnType<typeof lireFacturesEmises>>[number]): Promise<string | null> {
  const t = await tiersParId(config, entite, f.socid);
  if (!t || !t.actif) return null;
  const manque: string[] = [];
  if (estSyndic(await indexTiers(), t)) manque.push('client syndic : contrat sur mesure');
  const secteur = secteurDe(t.ville, t.adresse, g);
  const { volume, accesLoin } = volumeDe(f.lignes, secteur, g);
  if (!secteur) manque.push(`secteur à choisir (${t.ville || 'commune inconnue'})`);
  if (!volume) manque.push('volume de la fosse');
  if (!t.email) manque.push('email du client');
  const prix = secteur && volume ? prixContrat(g, secteur, volume, accesLoin) : null;
  let contrat = await db.ajouterContratPropose({
    entite, facture_id: f.id, facture_ref: f.ref, facture_le: f.date.toISOString(), tiers_id: t.id,
    client_nom: t.nom, email: t.email, telephone: t.telephone, adresse: t.adresse, cp: t.cp, ville: t.ville,
    secteur, volume, acces_loin: accesLoin, vidange_ttc: prix?.vidange ?? null, mensualite: prix?.mensualite ?? null,
    statut: manque.length ? 'a_completer' : 'pret', lien: null, note: manque.join(' · '),
  });
  if (contrat.statut === 'pret' && process.env.SITE_PRO_CODE) {
    try {
      contrat = await db.majContratPropose(contrat.id, { lien: await lienSignature(contrat, false) });
    } catch (e) {
      contrat = await db.majContratPropose(contrat.id, { note: `lien non créé : ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const quoi = prix ? `${volume} m³ ${secteur} → ${euros(prix.mensualite)}/mois sur ${MOIS_CONTRAT} mois` : 'à compléter';
  return `• ${t.nom} (${f.ref}) : ${quoi}${manque.length ? ` — manque : ${manque.join(', ')}` : ''}`;
}

/** Lien de signature en ligne du site (proposition.html), avec ou sans mail au client. Le prix
 *  est recalculé par le site à partir de sa grille. */
export async function lienSignature(c: db.ContratPropose, envoyer: boolean, emailCible = c.email): Promise<string> {
  const auth = await fetch(`${site()}/.netlify/functions/pro-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: process.env.SITE_PRO_CODE ?? '', operateur: 'Secrétariat CYRNEO' }),
  });
  if (!auth.ok) throw new Error(`espace commercial du site : HTTP ${auth.status}`);
  const { token } = (await auth.json()) as { token: string };
  const r = await fetch(`${site()}/.netlify/functions/proposition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'creer',
      type: 'fosse',
      token,
      envoyer,
      champs: {
        'c-resp': c.client_nom, 'c-adr': c.adresse, 'c-cp': c.cp, 'c-ville': c.ville, 'c-tel': c.telephone, 'c-mail': emailCible,
        'c-zone': c.secteur, 'c-vol': String(c.volume), 'c-acces': c.acces_loin ? '50' : '0', 'c-freq': String(MOIS_CONTRAT),
        'c-debut': '', 'c-vendeur': 'Secrétariat CYRNEO', 'c-derniere': 'recente',
      },
    }),
  });
  const j = (await r.json().catch(() => ({}))) as { url?: string; erreur?: string };
  if (!r.ok || !j.url) throw new Error(j.erreur ?? `proposition : HTTP ${r.status}`);
  return j.url;
}

/** Envoi au client, depuis la page Contrats (en mode test : à l'adresse de test). */
export async function envoyerContrat(config: Config, id: number): Promise<db.ContratPropose> {
  const c = await db.contratPropose(id);
  if (!c) throw new Error('contrat introuvable');
  if (!c.secteur || !c.volume || !c.email) throw new Error(`à compléter avant envoi : ${c.note}`);
  const reel = config.mode === 'reel';
  const lien = await lienSignature(c, true, reel ? c.email : config.test.adresse);
  return db.majContratPropose(id, { lien, statut: reel ? 'envoye' : c.statut, note: reel ? '' : `essai envoyé à ${config.test.adresse}` });
}

/** Le bureau complète un contrat (email, secteur, volume, accès) : prix recalculé, prêt à
 *  envoyer quand rien ne manque. */
export async function completerContrat(id: number, f: URLSearchParams): Promise<db.ContratPropose> {
  const c = await db.contratPropose(id);
  if (!c) throw new Error('contrat introuvable');
  const g = await chargerGrille();
  const email = (f.get('email') ?? '').trim().slice(0, 120);
  const secteur = g.GRILLE[f.get('secteur') ?? ''] ? f.get('secteur')! : null;
  const v = Number(f.get('volume'));
  const volume = v >= 3 && v <= 6 ? v : null;
  const accesLoin = f.get('acces_loin') === 'on';
  if (email && (!email.includes('@') || /[\s<>]/.test(email))) throw new Error('email invalide');
  const manque = [!secteur && 'secteur', !volume && 'volume de la fosse', !email && 'email du client', c.note.includes('syndic') && 'client syndic : contrat sur mesure'].filter(Boolean) as string[];
  const prix = secteur && volume ? prixContrat(g, secteur, volume, accesLoin) : null;
  const maj = await db.majContratPropose(id, {
    email, secteur, volume, acces_loin: accesLoin, vidange_ttc: prix?.vidange ?? null, mensualite: prix?.mensualite ?? null,
    statut: manque.length ? 'a_completer' : 'pret', note: manque.length ? `manque : ${manque.join(', ')}` : '', lien: null,
  });
  // Lien de relecture (sans envoi), pour voir le contrat tel que le client le recevra.
  if (maj.statut === 'pret' && process.env.SITE_PRO_CODE) return db.majContratPropose(id, { lien: await lienSignature(maj, false) });
  return maj;
}
