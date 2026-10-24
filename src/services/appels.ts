/**
 * Demandes reçues par téléphone : le bureau les note dans Dolibarr (bon d'intervention) ou
 * dans une bulle Rainbow. Le secrétariat fait l'aller-retour pour que la liste des
 * interventions reste complète :
 *   - bon saisi dans Dolibarr → fiche créée, annoncée dans la bulle de la société ;
 *   - post-it écrit dans une bulle → fiche créée, tiers reconnu, réponse dans la bulle ; quand
 *     le post est modifié pour y ajouter le n° du BI (habitude du bureau), la fiche est liée au bon.
 * Le bureau crée lui-même le BI : rien n'est créé dans Dolibarr à partir d'un post. Un bon
 * n'est relevé qu'au bout de 30 minutes, le temps que son numéro soit ajouté au post ; sinon
 * il est rapproché par tiers ou téléphone (3 jours), ou créé comme fiche à part.
 */
import type { Classification, Config, Intervention, MailRecu, Societe } from '../logique/types';
import { choisirBulle } from '../logique/decision';
import { classer } from './classifieur';
import { bonParRef, entiteDe, lireBons, lirePropositions, modifiesDepuis, propositionParRef, type BonLu } from './dolibarr';
import { historiqueBulle, memeBulle, publier, type MessageBulle } from './rainbow';
import * as db from './stockage';
import { blocRainbow, indexTiers, reconnaitreTiers, tiersParId, type TiersReconnu } from './tiers';
import { nomPresent } from '../logique/tiers';

type Journal = (texte: string) => void;

const STATUT_DEVIS: Record<number, Intervention['statut']> = { 0: 'a_planifier', 1: 'planifiee', 2: 'realisee', 3: 'annulee', 4: 'realisee' };

/** Devis : les devis à faire sont notés dans Rainbow (ou reçus par mail) ; Dolibarr ne sert qu'à
 *  les finaliser. Quand une proposition apparaît pour le même client, la demande lui est reliée,
 *  puis suit son statut : validée → envoyée (sort des devis à faire), signée → acceptée,
 *  refusée → annulée. Les propositions signées sont aussi gardées pour la liste « devis
 *  acceptés à planifier ». */
export async function releverDevisDolibarr(config: Config, log: Journal): Promise<void> {
  const idx = await indexTiers();
  // Seulement les propositions modifiées depuis le dernier relevé (jamais toute la base).
  const depuisTexte = await db.lireSynchro('dolibarr_devis');
  const depuis = depuisTexte ? new Date(depuisTexte) : null;
  const debut = new Date();
  for (const entite of new Set(Object.values(config.dolibarr.entites))) {
    const s = societeDeLEntite(config, entite);
    if (!s) continue;
    const recentes = await lirePropositions(config, entite, depuis);
    if (recentes.length === 0) continue;
    const parId = new Map(recentes.map((p) => [p.id, p]));
    const liees = await db.devisAvecProposition(entite, recentes.map((p) => p.id));
    for (const fiche of liees) {
      const statut = STATUT_DEVIS[parId.get(fiche.dolibarr_id!)!.statut];
      if (statut && statut !== fiche.statut) await db.majIntervention(fiche.id, { statut });
    }

    // Propositions pas encore reliées : on cherche la demande du même client (tiers, sinon nom).
    const dejaLiees = new Set(liees.map((f) => f.dolibarr_id));
    const ouverts = await db.devisOuvertsSansProposition(s.id);
    for (const p of recentes.filter((x) => !dejaLiees.has(x.id) && x.statut !== 3)) {
      const nom = idx.tiers.get(p.socid)?.nom ?? '';
      const demande = ouverts.find((f) => (f.dolibarr_tiers_id && f.dolibarr_tiers_id === p.socid) || (nom && (nomPresent(nom, f.client_nom) || nomPresent(f.client_nom, nom))));
      if (!demande) continue;
      ouverts.splice(ouverts.indexOf(demande), 1);
      await db.majIntervention(demande.id, { dolibarr_id: p.id, dolibarr_entite: entite, dolibarr_ref: p.ref, dolibarr_tiers_id: p.socid || null, statut: STATUT_DEVIS[p.statut] ?? demande.statut });
      log(`${demande.reference} reliée au devis Dolibarr ${p.ref}`);
    }

    // Devis signés (jamais de montant : l'écran Travaux est vu par les agents) : les modifiées
    // signées entrent dans la liste, les autres en sortent (facturées, refusées…).
    const signes = recentes
      .filter((p) => p.statut === 2)
      .map((p) => ({ id: p.id, ref: p.ref, societe: s.id, tiers_id: p.socid || null, tiers_nom: idx.tiers.get(p.socid)?.nom ?? '', libelle: p.libelle, signe_le: p.signeLe?.toISOString() ?? null }));
    if (depuis) await db.majDevisSignes(entite, signes, recentes.filter((p) => p.statut !== 2).map((p) => p.id));
    else await db.remplacerDevisSignes(entite, signes);
  }
  await db.ecrireSynchro('dolibarr_devis', debut.toISOString());
}

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
  const liee = await db.interventionDuBon(entite, b.id, b.ref, b.refClient);
  if (liee) {
    if (!liee.dolibarr_id) await db.majIntervention(liee.id, { dolibarr_id: b.id, dolibarr_entite: entite, dolibarr_ref: b.ref, dolibarr_tiers_id: liee.dolibarr_tiers_id ?? (b.socid || null) });
    return;
  }
  const idx = await indexTiers();
  const t = b.socid ? await tiersParId(config, entite, b.socid) : null;
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

const DELAI_BON = 30 * 60_000;

/** Relève les nouveaux bons de chaque société. Au tout premier passage, reprend sans les
 *  annoncer les bons ouverts des 14 derniers jours, puis ne suit que les nouveaux. */
export async function releverBonsDolibarr(config: Config, log: Journal): Promise<void> {
  // Clôtures : bons modifiés depuis le dernier contrôle (toutes les 30 min au plus).
  const controle = await db.lireSynchro('dolibarr_bons_controle');
  const controleDu = controle ? new Date(controle) : new Date(Date.now() - 86_400_000);
  const aControler = Date.now() - controleDu.getTime() > 30 * 60_000;
  const debut = new Date();

  for (const entite of new Set(Object.values(config.dolibarr.entites))) {
    const s = societeDeLEntite(config, entite);
    if (!s) continue;
    const curseur = `dolibarr_bons_${entite}`;
    const dernier = await db.lireSynchro(curseur);
    // Le tout premier relevé (fait le 24/10) a posé les curseurs : ensuite, seulement les
    // bons créés après le dernier n° vu.
    if (dernier === null) {
      const derniers = await lireBons(config, entite, `(t.datec:>=:'${new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)}')`);
      for (const b of derniers.filter((x) => !termine(x))) {
        await importerBon(config, s, entite, b, false, log).catch((e) => log(`⚠️ Bon Dolibarr ${b.ref} : ${e instanceof Error ? e.message : String(e)}`));
      }
      await db.ecrireSynchro(curseur, String(Math.max(0, ...derniers.map((b) => b.id))));
      continue;
    }
    let fait = Number(dernier);
    for (const b of (await lireBons(config, entite, `(t.rowid:>:${fait})`)).sort((x, y) => x.id - y.id)) {
      // Laisse au bureau le temps d'ajouter le n° du BI à son post Rainbow.
      if (Date.now() - b.creeLe.getTime() < DELAI_BON) break;
      try {
        await importerBon(config, s, entite, b, true, log);
      } catch (e) {
        log(`⚠️ Bon Dolibarr ${b.ref} : ${e instanceof Error ? e.message : String(e)}`);
      }
      fait = b.id;
    }
    if (fait > Number(dernier)) await db.ecrireSynchro(curseur, String(fait));

    // Bons clôturés ou facturés dans Dolibarr : la fiche passe en réalisée.
    if (!aControler) continue;
    const modifies = await lireBons(config, entite, modifiesDepuis(controleDu));
    for (const fiche of await db.interventionsAvecBon(entite, modifies.filter(termine).map((b) => b.id))) {
      if (fiche.statut !== 'realisee' && fiche.statut !== 'annulee') {
        await db.majIntervention(fiche.id, { statut: 'realisee' });
        log(`${fiche.reference} réalisée (bon ${fiche.dolibarr_ref} clôturé dans Dolibarr)`);
      }
    }
  }
  if (aControler) await db.ecrireSynchro('dolibarr_bons_controle', debut.toISOString());
}

/** Société dont c'est la bulle (bulle principale, d'astreinte ou ITV) ; 'test' pour la bulle
 *  de test (la société vient alors de la lecture du message). */
export function societeDeLaBulle(config: Config, bulle: string): Societe | 'test' | null {
  if (config.test.bulleRainbow && memeBulle(bulle, config.test.bulleRainbow)) return 'test';
  return config.societes.find((s) => [s.bulleRainbow, s.bulleUrgence, s.bulleInspection].some((b) => b && memeBulle(b, bulle))) ?? null;
}

/** Numéro de devis Dolibarr écrit dans un post (PR2610-0041). */
export function numeroDevis(texte: string): string | null {
  const m = texte.match(/\bPR\s?-?(\d{4})-(\d{3,5})\b/i);
  return m ? `PR${m[1]}-${m[2]}` : null;
}

/** Lie la demande de devis à la proposition Dolibarr dont le numéro a été écrit dans le post. */
async function lierDevis(config: Config, fiche: Intervention, ref: string, log: Journal): Promise<void> {
  if (fiche.dolibarr_ref === ref || !config.dolibarr.url || !process.env.DOLIBARR_API_KEY) return;
  for (const entite of new Set([entiteDe(config, fiche.societe), ...Object.values(config.dolibarr.entites)])) {
    const p = await propositionParRef(config, entite, ref);
    if (!p) continue;
    await db.majIntervention(fiche.id, { dolibarr_ref: p.ref, dolibarr_id: p.id, dolibarr_entite: entite, dolibarr_tiers_id: fiche.dolibarr_tiers_id ?? (p.socid || null), statut: STATUT_DEVIS[p.statut] ?? fiche.statut });
    log(`${fiche.reference} liée au devis ${p.ref}`);
    return;
  }
}

/** Reprise d'une bulle : relit ses posts des `jours` derniers jours et en tire les devis à faire
 *  (sans rien répondre dans la bulle). Les anciennes demandes d'intervention sont ignorées : elles
 *  ont été traitées depuis. */
export async function repriseBulle(config: Config, nom: string, jours: number, log: Journal): Promise<number> {
  const posts = await historiqueBulle(nom, jours);
  let crees = 0;
  for (const m of posts) {
    try {
      if (await traiterMessageBulle(config, m, log, { reprise: true })) crees += 1;
    } catch (e) {
      log(`⚠️ Reprise « ${nom} » : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`Reprise de « ${nom} » : ${posts.length} post(s) relu(s) sur ${jours} jours, ${crees} devis à faire ajouté(s)`);
  return crees;
}

/** Numéro de BI écrit dans un post (numérotation Dolibarr : FI2610-0012). */
export function numeroBon(texte: string): string | null {
  const m = texte.match(/\b(?:FI|BI)\s?-?(\d{4})-(\d{3,5})\b/i);
  return m ? `FI${m[1]}-${m[2]}` : null;
}

/** Lie la fiche au bon dont le numéro a été écrit dans le post. */
async function lierBon(config: Config, fiche: Intervention, ref: string, log: Journal): Promise<void> {
  if (fiche.dolibarr_ref === ref) return;
  let lien: Partial<Intervention> = { dolibarr_ref: ref };
  if (config.dolibarr.url && process.env.DOLIBARR_API_KEY) {
    const entites = [entiteDe(config, fiche.societe), ...new Set(Object.values(config.dolibarr.entites))];
    for (const entite of new Set(entites)) {
      const b = await bonParRef(config, entite, ref);
      if (b) {
        lien = { dolibarr_ref: b.ref, dolibarr_id: b.id, dolibarr_entite: entite, dolibarr_tiers_id: fiche.dolibarr_tiers_id ?? (b.socid || null) };
        break;
      }
    }
  }
  await db.majIntervention(fiche.id, lien);
  log(`${fiche.reference} liée au bon ${ref}`);
}

/** Post d'une bulle. Nouvelle demande prise au téléphone : fiche + tiers + réponse. Post
 *  modifié avec le n° du BI (ou du devis Dolibarr) : fiche liée. Renvoie true si une fiche est créée.
 *  En reprise (anciens posts) : devis seulement, aucune réponse dans la bulle. */
export async function traiterMessageBulle(config: Config, m: MessageBulle, log: Journal, options: { reprise?: boolean } = {}): Promise<boolean> {
  const cible = societeDeLaBulle(config, m.bulle);
  if (!cible) return false;
  // On répond dans les bulles des sociétés en mode réel seulement ; la bulle de test, toujours.
  const repondre = !options.reprise && config.mode !== 'simulation' && (config.mode === 'reel' || cible === 'test');
  // Un post modifié garde la clé du post d'origine.
  const cle = `rainbow:${m.remplace ?? m.id}`;
  const bonEcrit = numeroBon(m.texte);
  const devisEcrit = numeroDevis(m.texte);
  const existante = await db.interventionParCle(cle);
  if (existante) {
    if (bonEcrit && existante.type !== 'devis') await lierBon(config, existante, bonEcrit, log);
    if (devisEcrit && existante.type === 'devis') await lierDevis(config, existante, devisEcrit, log);
    return false;
  }
  if (m.texte.length < 25) return false;

  const pseudo: MailRecu = {
    boite: 'rainbow',
    uid: 0,
    messageId: cle,
    inReplyTo: null,
    references: [],
    deAdresse: '',
    deNom: m.auteur,
    repondreA: '',
    sujet: `Post Rainbow (${m.bulle})`,
    recuLe: m.date ?? new Date(),
    texte: m.texte,
    entetes: { autoSubmitted: null, precedence: null, listId: null, autoResponseSuppress: null },
    piecesJointes: [],
  } as MailRecu;
  const contexte =
    `Ce n'est pas un mail : c'est un post-it écrit par ${m.auteur || 'un membre de l’équipe'} dans la bulle Rainbow « ${m.bulle} » de l'équipe. ` +
    "S'il note une nouvelle demande d'un client (prise au téléphone ou sur place), catégorie demande_intervention ou demande_devis, avec les coordonnées du client. " +
    "Un devis à établir (chiffrage, visite pour devis, « devis à faire ») : demande_devis. Un devis déjà fait, envoyé ou signé : autre. " +
    "Un numéro de bon d'intervention (FI…) ou de devis (PR…) peut y figurer : ce n'est pas une coordonnée. " +
    "Toute autre chose (discussion, planning, suivi ou compte rendu d'une intervention déjà connue, question à un collègue) : catégorie autre.";
  const c: Classification = await classer(pseudo, config, contexte);
  if (c.categorie !== 'demande_devis' && (options.reprise || c.categorie !== 'demande_intervention')) return false;

  const s = cible === 'test' ? (config.societes.find((x) => x.id === c.societe) ?? config.societes[0]) : cible;
  const r = await reconnaitreTiers(config, pseudo, c).catch(() => null);
  const tiersId = r?.tiers?.id ?? null;

  const devis = c.categorie === 'demande_devis';
  const deja = devis ? (tiersId ? await db.devisEnCoursDuTiers(tiersId) : null) : await db.interventionRecenteSemblable(tiersId, c.contact.telephone);
  if (deja) {
    if (bonEcrit && !devis) await lierBon(config, deja, bonEcrit, log);
    if (devisEcrit && devis) await lierDevis(config, deja, devisEcrit, log);
    if (repondre) await publier(m.bulle, `ℹ️ Déjà enregistrée : ${deja.reference} (${deja.nature || deja.resume})`);
    return false;
  }

  const fiche: Intervention = await db.creerInterventionTelephone({
    source: 'rainbow',
    cle,
    type: devis ? 'devis' : 'intervention',
    societe: s.id,
    urgence: c.urgence,
    ...(m.date ? { cree_le: m.date.toISOString() } : {}),
    client_nom: c.contact.nom || r?.tiers?.nom || '',
    client_telephone: c.contact.telephone || r?.tiers?.telephone || '',
    client_email: c.contact.email || r?.tiers?.email || '',
    adresse: c.contact.adresse || r?.tiers?.adresse || '',
    commune: c.contact.commune || r?.tiers?.ville || '',
    nature: c.nature,
    date_souhaitee: c.dateSouhaitee,
    resume: `${c.resume} (post de ${m.auteur || 'l’équipe'} dans Rainbow)`,
    dolibarr_tiers_id: tiersId,
  });
  log(`Post dans « ${m.bulle} » → ${fiche.reference}`);
  if (bonEcrit && !devis) await lierBon(config, fiche, bonEcrit, log);
  if (devisEcrit && devis) await lierDevis(config, fiche, devisEcrit, log);

  if (repondre) {
    await publier(
      m.bulle,
      [`✅ ${fiche.reference} · ${s.nom}${bonEcrit && !devis ? ` · bon ${bonEcrit}` : ''}`, r && r.index.tiers.size > 0 ? blocRainbow(r) : ''].filter(Boolean).join('\n')
    );
  }
  return true;
}
