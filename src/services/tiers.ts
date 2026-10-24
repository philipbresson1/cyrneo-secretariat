/**
 * Liste des tiers Dolibarr gardée dans Supabase : synchronisée chaque semaine par le démon,
 * consultée à chaque demande pour reconnaître le client (résidence, personne, entreprise)
 * et son syndic. Jamais de création de tiers : s'il n'est pas reconnu, on le signale.
 */
import Anthropic from '@anthropic-ai/sdk';
import { creerClientAdmin } from '../lib/supabase/admin';
import type { Classification, Config, MailRecu } from '../logique/types';
import { candidats, decrireTiers, evident, indexer, syndicExpediteur, type Candidat, type ContactTiers, type IndexTiers, type Tiers } from '../logique/tiers';
import { lireTiersEtContacts, lireUnTiers } from './dolibarr';

let client: ReturnType<typeof creerClientAdmin> | null = null;
const sb = () => (client ??= creerClientAdmin());

function verifier<T>(r: { data: T; error: { message: string } | null }, quoi: string): T {
  if (r.error) throw new Error(`${quoi} : ${r.error.message}`);
  return r.data;
}

const JOUR = 24 * 3_600_000;
const MOIS = 30 * JOUR;

async function dateSynchro(nom: string): Promise<Date | null> {
  const data = verifier(await sb().from('secretariat_synchro').select('fait_le').eq('nom', nom).maybeSingle(), 'Lecture synchro');
  return data ? new Date((data as { fait_le: string }).fait_le) : null;
}

/** Dernier relevé des tiers (complet ou des seules modifications). */
export const derniereSynchro = () => dateSynchro('dolibarr_tiers');

/** Un relevé par jour (seulement les tiers modifiés depuis la veille). */
export async function synchroDue(maintenant = new Date()): Promise<boolean> {
  const d = await derniereSynchro();
  return !d || maintenant.getTime() - d.getTime() >= JOUR;
}

async function parLots<T>(table: string, lignes: T[]): Promise<void> {
  for (let i = 0; i < lignes.length; i += 500) {
    verifier(await sb().from(table).upsert(lignes.slice(i, i + 500) as never[]), `Écriture ${table}`);
  }
}

/** Met la copie à jour. Chaque jour : seulement les tiers et contacts modifiés depuis le dernier
 *  relevé. Une fois par mois, la nuit (ou sur demande) : relecture complète, qui retire aussi les
 *  tiers supprimés de Dolibarr. */
export async function synchroniserTiers(config: Config, complet = false, maintenant = new Date()): Promise<string> {
  const precedent = await derniereSynchro();
  const dernierComplet = (await dateSynchro('dolibarr_tiers_complet')) ?? precedent;
  const heure = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(maintenant));
  const toutRelire = complet || !precedent || (!!dernierComplet && maintenant.getTime() - dernierComplet.getTime() >= MOIS && heure >= 1 && heure < 5);

  const debut = maintenant.toISOString();
  const { tiers, contacts } = await lireTiersEtContacts(config, toutRelire ? undefined : precedent!);
  if (toutRelire && tiers.length === 0) throw new Error('Dolibarr ne renvoie aucun tiers : copie conservée telle quelle');
  await parLots('dolibarr_tiers', tiers.map((t) => ({ ...t, vu_le: debut })));
  await parLots('dolibarr_contacts', contacts.map((c) => ({ ...c, vu_le: debut })));
  if (toutRelire) {
    // Ce qui n'a pas été revu a disparu de Dolibarr.
    verifier(await sb().from('dolibarr_tiers').delete().lt('vu_le', debut), 'Nettoyage tiers');
    verifier(await sb().from('dolibarr_contacts').delete().lt('vu_le', debut), 'Nettoyage contacts');
  }
  const bilan = toutRelire ? `relecture complète : ${tiers.length} tiers, ${contacts.length} contacts` : `${tiers.length} tiers et ${contacts.length} contacts modifiés`;
  const lignes = [{ nom: 'dolibarr_tiers', fait_le: debut, bilan }];
  if (toutRelire) lignes.push({ nom: 'dolibarr_tiers_complet', fait_le: debut, bilan });
  verifier(await sb().from('secretariat_synchro').upsert(lignes), 'Écriture synchro');
  if (tiers.length || contacts.length) index = null;
  return bilan;
}

/** Tiers par son id : dans la copie, sinon lu dans Dolibarr (créé depuis le dernier relevé) et
 *  ajouté à la copie. */
export async function tiersParId(config: Config, entite: number, id: number): Promise<Tiers | null> {
  const connu = (await indexTiers()).tiers.get(id);
  if (connu) return connu;
  const lu = await lireUnTiers(config, entite, id).catch(() => null);
  if (!lu) return null;
  const { brut: _brut, ...t } = lu;
  await ajouterTiersLocal(t);
  return t;
}

/** Tiers que l'on vient de créer dans Dolibarr : ajouté à la copie sans attendre la synchro. */
export async function ajouterTiersLocal(t: Tiers): Promise<void> {
  verifier(await sb().from('dolibarr_tiers').upsert({ ...t, vu_le: new Date().toISOString() }), 'Ajout tiers');
  index = null;
}

async function toutLire<T>(table: string, colonnes: string): Promise<T[]> {
  const tout: T[] = [];
  for (let de = 0; ; de += 1000) {
    const lot = verifier(await sb().from(table).select(colonnes).order('id').range(de, de + 999), `Lecture ${table}`) as T[];
    tout.push(...lot);
    if (lot.length < 1000) return tout;
  }
}

let index: IndexTiers | null = null;
let chargeLe = 0;

/** Copie en mémoire, relue toutes les 6 heures (ou après une synchro). */
export async function indexTiers(): Promise<IndexTiers> {
  if (!index || Date.now() - chargeLe > 6 * 3_600_000) {
    const tiers = await toutLire<Tiers>('dolibarr_tiers', 'id,nom,alias,code_client,code_fournisseur,siret,tva_intra,adresse,cp,ville,telephone,email,parent_id,client,fournisseur,actif,note_publique,note_privee');
    const contacts = await toutLire<ContactTiers>('dolibarr_contacts', 'id,tiers_id,nom,email,telephone,poste');
    index = indexer(tiers, contacts);
    chargeLe = Date.now();
  }
  return index;
}

export type TiersReconnu = {
  tiers: Tiers | null; // sûr : utilisable pour le bon d'intervention
  syndic: Tiers | null;
  possibles: Tiers[]; // pas sûr : à confirmer par le bureau
  index: IndexTiers;
};

let anthropic: Anthropic | null = null;

/** Plusieurs tiers possibles : le modèle tranche, ou dit qu'aucun ne convient. */
async function arbitrer(config: Config, index: IndexTiers, c: Classification, mail: MailRecu, syndic: Tiers | null, liste: Candidat[]): Promise<{ id: number; certain: boolean }> {
  anthropic ??= new Anthropic();
  const reponse = await anthropic.messages.create({
    model: config.modele,
    max_tokens: 1000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { id: { type: 'integer' }, certain: { type: 'boolean' } },
          required: ['id', 'certain'],
          additionalProperties: false,
        },
      },
    },
    system:
      "Tu rapproches une demande d'intervention reçue par mail d'un tiers du logiciel de gestion. Un tiers est le lieu ou le client de l'intervention : " +
      "une résidence, une personne ou une entreprise, parfois rattachée à un syndic. Le syndic ou l'agence qui écrit n'est jamais le tiers à retenir. " +
      "id : l'id du tiers qui correspond à la demande (même résidence ou même personne, même commune), 0 si aucun ne correspond. " +
      'certain : true seulement si le nom ou l’adresse concordent sans ambiguïté.',
    messages: [
      {
        role: 'user',
        content: [
          `Demande : ${c.resume}`,
          `Nature : ${c.nature}`,
          `Contact : ${[c.contact.nom, c.contact.telephone, c.contact.email].filter(Boolean).join(' · ') || '(aucun)'}`,
          `Lieu : ${[c.contact.adresse, c.contact.commune].filter(Boolean).join(', ') || '(non précisé)'}`,
          `Expéditeur : ${mail.deNom} <${mail.deAdresse}>${syndic ? ` — syndic connu : ${syndic.nom}` : ''}`,
          '',
          'Tiers possibles :',
          ...liste.map((x) => `- id ${x.tiers.id} : ${decrireTiers(index, x.tiers)}`),
        ].join('\n'),
      },
    ],
  });
  const bloc = reponse.content.find((b) => b.type === 'text');
  if (reponse.stop_reason !== 'end_turn' || !bloc || bloc.type !== 'text') throw new Error('Arbitrage du tiers impossible');
  return JSON.parse(bloc.text) as { id: number; certain: boolean };
}

export async function reconnaitreTiers(config: Config, mail: MailRecu, c: Classification): Promise<TiersReconnu> {
  const idx = await indexTiers();
  const syndic = syndicExpediteur(idx, mail.deAdresse);
  const liste = candidats(
    idx,
    { expediteur: mail.deAdresse, nom: c.contact.nom, email: c.contact.email, telephone: c.contact.telephone, adresse: c.contact.adresse, commune: c.contact.commune, texte: `${c.resume} ${c.nature}` },
    syndic
  );
  if (evident(liste)) return { tiers: liste[0].tiers, syndic, possibles: [], index: idx };
  if (liste.length === 0) return { tiers: null, syndic, possibles: [], index: idx };
  const choix = await arbitrer(config, idx, c, mail, syndic, liste);
  const retenu = liste.find((x) => x.tiers.id === choix.id)?.tiers ?? null;
  if (retenu && choix.certain) return { tiers: retenu, syndic, possibles: [], index: idx };
  return { tiers: null, syndic, possibles: retenu ? [retenu] : liste.slice(0, 3).map((x) => x.tiers), index: idx };
}

/** Bloc ajouté au message Rainbow. */
export function blocRainbow(r: TiersReconnu): string {
  const syndic = r.syndic ? `\n   Syndic : ${r.syndic.nom}` : '';
  if (r.tiers) {
    const note = r.tiers.note_publique ? `\n   Note : ${r.tiers.note_publique.replace(/\s+/g, ' ').slice(0, 200)}` : '';
    return `📇 Dolibarr : ${decrireTiers(r.index, r.tiers)}${r.syndic && r.tiers.parent_id !== r.syndic.id ? syndic : ''}${note}`;
  }
  if (r.possibles.length > 0) return `📇 Dolibarr, à confirmer :\n${r.possibles.map((t) => `   • ${decrireTiers(r.index, t)}`).join('\n')}${syndic}`;
  return `📇 Dolibarr : tiers non trouvé, à créer avant le bon d'intervention${syndic}`;
}
