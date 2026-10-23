/**
 * Demandes reçues par téléphone : le bureau les note dans Dolibarr (bon d'intervention) ou
 * dans une bulle Rainbow. Le secrétariat fait l'aller-retour pour que la liste des
 * interventions reste complète :
 *   - bon saisi dans Dolibarr → fiche créée, annoncée dans la bulle de la société ;
 *   - demande écrite dans une bulle → fiche créée, bon Dolibarr (mode réel), réponse dans la bulle.
 * Un même appel noté des deux côtés est rapproché (même tiers ou même téléphone, 3 jours).
 */
import type { Classification, Config, Intervention, MailRecu, Societe } from '../logique/types';
import { choisirBulle } from '../logique/decision';
import { classer } from './classifieur';
import { creerBonIntervention, entiteDe, lireBonsRecents, type BonLu } from './dolibarr';
import { memeBulle, publier, type MessageBulle } from './rainbow';
import * as db from './stockage';
import { blocRainbow, indexTiers, reconnaitreTiers, type TiersReconnu } from './tiers';

type Journal = (texte: string) => void;

/** Société de chaque entité Dolibarr (la première déclarée quand plusieurs partagent une entité). */
function societeDeLEntite(config: Config, entite: number): Societe | null {
  const id = Object.entries(config.dolibarr.entites).find(([, e]) => e === entite)?.[0];
  return config.societes.find((s) => s.id === id) ?? null;
}

/** Statut de la fiche d'après celui du bon (0 brouillon, 1 validé, 2 facturé, 3 clôturé). */
const termine = (b: BonLu) => b.statut >= 2;

function premiereLigne(texte: string): string {
  return texte.replace(/<[^>]+>/g, ' ').split(/\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? '';
}

async function importerBon(config: Config, s: Societe, entite: number, b: BonLu, annoncer: boolean, log: Journal): Promise<void> {
  if (await db.interventionDuBon(entite, b.id, b.ref, b.refClient)) return;
  const idx = await indexTiers();
  const t = idx.tiers.get(b.socid) ?? null;
  const champsBon = { dolibarr_id: b.id, dolibarr_entite: entite, dolibarr_ref: b.ref, dolibarr_tiers_id: t?.id ?? null };

  // Même appel déjà écrit dans une bulle : on rattache le bon à cette fiche.
  const semblable = await db.interventionRecenteSemblable(t?.id ?? null, t?.telephone ?? '');
  if (semblable) {
    await db.majIntervention(semblable.id, champsBon);
    log(`Bon Dolibarr ${b.ref} rattaché à ${semblable.reference}`);
    return;
  }

  const fiche = await db.creerInterventionTelephone({
    source: 'dolibarr',
    cle: `dolibarr:${entite}:${b.id}`,
    type: 'intervention',
    societe: s.id,
    statut: termine(b) ? 'realisee' : 'a_planifier',
    urgence: /urgent/i.test(b.description) ? 'urgente' : 'normale',
    client_nom: t?.nom ?? '',
    client_telephone: t?.telephone ?? '',
    client_email: t?.email ?? '',
    adresse: t?.adresse ?? '',
    commune: t?.ville ?? '',
    nature: premiereLigne(b.description) || 'Intervention',
    date_souhaitee: '',
    resume: b.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500),
    ...champsBon,
  });
  log(`Bon Dolibarr ${b.ref} → ${fiche.reference}`);
  if (!annoncer || config.mode === 'simulation') return;

  const reconnu: TiersReconnu = { tiers: t, syndic: t?.parent_id ? (idx.tiers.get(t.parent_id) ?? null) : null, possibles: [], index: idx };
  const bulle = choisirBulle(config, s, { gabarit: 'nouvelle', type: 'intervention', inspectionCamera: false, recuLe: new Date() });
  await publier(
    bulle,
    [`📞 Inter saisie dans Dolibarr — ${s.nom}`, `${fiche.reference} · bon ${b.ref}`, `🔧 ${fiche.nature}`, idx.tiers.size > 0 ? blocRainbow(reconnu) : ''].filter(Boolean).join('\n')
  );
}

/** Relève les nouveaux bons de chaque société. Au tout premier passage, reprend sans les
 *  annoncer les bons ouverts des 14 derniers jours, puis ne suit que les nouveaux. */
export async function releverBonsDolibarr(config: Config, log: Journal): Promise<void> {
  for (const entite of new Set(Object.values(config.dolibarr.entites))) {
    const s = societeDeLEntite(config, entite);
    if (!s) continue;
    const curseur = `dolibarr_bons_${entite}`;
    const dernier = await db.lireSynchro(curseur);
    const bons = await lireBonsRecents(config, entite);
    const premier = dernier === null;
    const aImporter = premier
      ? bons.filter((b) => !termine(b) && Date.now() - b.creeLe.getTime() < 14 * 86_400_000)
      : bons.filter((b) => b.id > Number(dernier));
    for (const b of aImporter.sort((x, y) => x.id - y.id)) {
      try {
        await importerBon(config, s, entite, b, !premier, log);
      } catch (e) {
        log(`⚠️ Bon Dolibarr ${b.ref} : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (bons.length > 0) await db.ecrireSynchro(curseur, String(Math.max(Number(dernier ?? 0), ...bons.map((b) => b.id))));

    // Bons clôturés ou facturés dans Dolibarr : la fiche passe en réalisée.
    for (const fiche of await db.interventionsAvecBon(entite, bons.filter(termine).map((b) => b.id))) {
      if (fiche.statut !== 'realisee' && fiche.statut !== 'annulee') {
        await db.majIntervention(fiche.id, { statut: 'realisee' });
        log(`${fiche.reference} réalisée (bon ${fiche.dolibarr_ref} clôturé dans Dolibarr)`);
      }
    }
  }
}

/** Société dont c'est la bulle (bulle principale, d'astreinte ou ITV). En mode test, seule la
 *  bulle de test est écoutée et la société vient de la lecture du message. */
export function societeDeLaBulle(config: Config, bulle: string): Societe | 'test' | null {
  if (config.mode === 'test') return memeBulle(bulle, config.test.bulleRainbow) ? 'test' : null;
  return config.societes.find((s) => [s.bulleRainbow, s.bulleUrgence, s.bulleInspection].some((b) => b && memeBulle(b, bulle))) ?? null;
}

/** Message d'une bulle : nouvelle demande prise au téléphone ? Si oui, fiche + bon + réponse. */
export async function traiterMessageBulle(config: Config, m: MessageBulle, log: Journal): Promise<void> {
  const cible = societeDeLaBulle(config, m.bulle);
  if (!cible || m.texte.length < 25) return;
  const cle = `rainbow:${m.id}`;
  if (await db.interventionParCle(cle)) return;

  const pseudo: MailRecu = {
    boite: 'rainbow',
    uid: 0,
    messageId: cle,
    inReplyTo: null,
    references: [],
    deAdresse: '',
    deNom: m.auteur,
    repondreA: '',
    sujet: `Message Rainbow (${m.bulle})`,
    recuLe: new Date(),
    texte: m.texte,
    entetes: { autoSubmitted: null, precedence: null, listId: null, autoResponseSuppress: null },
    piecesJointes: [],
  } as MailRecu;
  const contexte =
    `Ce n'est pas un mail : c'est un message écrit par ${m.auteur || 'un membre de l’équipe'} dans la bulle Rainbow « ${m.bulle} » de l'équipe. ` +
    "S'il note une nouvelle demande d'un client (prise au téléphone ou sur place), catégorie demande_intervention ou demande_devis, avec les coordonnées du client. " +
    "Toute autre chose (discussion, planning, suivi ou compte rendu d'une intervention déjà connue, question à un collègue) : catégorie autre.";
  const c: Classification = await classer(pseudo, config, contexte);
  if (c.categorie !== 'demande_intervention' && c.categorie !== 'demande_devis') return;

  const s = cible === 'test' ? (config.societes.find((x) => x.id === c.societe) ?? config.societes[0]) : cible;
  const r = await reconnaitreTiers(config, pseudo, c).catch(() => null);
  const tiersId = r?.tiers?.id ?? null;

  const deja = await db.interventionRecenteSemblable(tiersId, c.contact.telephone);
  if (deja) {
    if (config.mode !== 'simulation') await publier(m.bulle, `ℹ️ Déjà enregistrée : ${deja.reference} (${deja.nature || deja.resume})`);
    return;
  }

  let fiche: Intervention = await db.creerInterventionTelephone({
    source: 'rainbow',
    cle,
    type: c.categorie === 'demande_devis' ? 'devis' : 'intervention',
    societe: s.id,
    urgence: c.urgence,
    client_nom: c.contact.nom || r?.tiers?.nom || '',
    client_telephone: c.contact.telephone || r?.tiers?.telephone || '',
    client_email: c.contact.email || r?.tiers?.email || '',
    adresse: c.contact.adresse || r?.tiers?.adresse || '',
    commune: c.contact.commune || r?.tiers?.ville || '',
    nature: c.nature,
    date_souhaitee: c.dateSouhaitee,
    resume: `${c.resume} (noté par ${m.auteur || 'l’équipe'} dans Rainbow)`,
    dolibarr_tiers_id: tiersId,
  });
  log(`Demande notée dans « ${m.bulle} » → ${fiche.reference}`);

  let ligneBon = '';
  if (fiche.type === 'intervention') {
    if (config.mode !== 'reel' || !config.dolibarr.actif) ligneBon = config.mode === 'reel' ? '' : '(mode test : pas de bon Dolibarr)';
    else if (!r?.tiers) ligneBon = '⚠️ Bon à faire dans Dolibarr (tiers non reconnu avec certitude)';
    else {
      try {
        const entite = entiteDe(config, s.id);
        const bon = await creerBonIntervention(config, entite, r.tiers.id, c, fiche.reference);
        fiche = await db.majIntervention(fiche.id, { dolibarr_id: bon.id, dolibarr_entite: entite, dolibarr_ref: bon.ref });
        ligneBon = `Bon ${bon.ref} créé en brouillon dans Dolibarr`;
      } catch (e) {
        ligneBon = `⚠️ Bon Dolibarr non créé : ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }
  if (config.mode === 'simulation') return;
  await publier(
    m.bulle,
    [`✅ Enregistrée : ${fiche.reference} · ${s.nom}`, `🔧 ${fiche.nature}${fiche.urgence === 'urgente' ? ' · URGENT' : ''}`, r && r.index.tiers.size > 0 ? blocRainbow(r) : '', ligneBon]
      .filter(Boolean)
      .join('\n')
  );
}
