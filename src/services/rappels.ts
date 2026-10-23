/**
 * Rappels de rendez-vous : chaque jour (17 h par défaut), lit les plannings du lendemain et
 * envoie un mail de rappel à chaque client dont on connaît l'adresse — écrite dans le
 * rendez-vous, ou retrouvée par son téléphone dans les demandes reçues.
 */
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import type { Config } from '../logique/types';
import { estWeekEnd, rdvDuJour, titreComparable, type Rdv } from '../lib/agenda';
import { estInterne } from '../logique/garde-fous';
import { trouverTelephones } from '../logique/telephone';
import { rappelRdv, type InfosRappel } from '../logique/modeles';
import { imagesSignature } from '../logique/signature';
import { envoyer } from './smtp';
import { emailParTelephone, noterEnvoi, rappelDejaEnvoye } from './stockage';

const RE_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Adresses de clients écrites dans le rendez-vous (titre, lieu, notes), hors adresses du groupe. */
export function emailsDuRdv(r: Rdv, internes: string[]): string[] {
  const texte = `${r.titre}\n${r.lieu ?? ''}\n${r.description}`;
  return [...new Set((texte.match(RE_EMAIL) ?? []).map((m) => m.toLowerCase()))].filter((m) => !estInterne(m, internes));
}

type Resume = { pertinent: boolean; nom: string; objet: string; lieu: string };

let anthropic: Anthropic | null = null;

/** Le titre d'un rendez-vous est écrit pour l'équipe (références, numéros, abréviations) :
 *  le modèle en tire une formulation présentable au client, et écarte ce qui n'est pas un
 *  rendez-vous client (congés, réunions, points internes). */
async function resumer(r: Rdv, config: Config): Promise<Resume> {
  anthropic ??= new Anthropic();
  const reponse = await anthropic.messages.create({
    model: config.modele,
    max_tokens: 2000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            pertinent: { type: 'boolean' },
            nom: { type: 'string' },
            objet: { type: 'string' },
            lieu: { type: 'string' },
          },
          required: ['pertinent', 'nom', 'objet', 'lieu'],
          additionalProperties: false,
        },
      },
    },
    system:
      "Tu prépares le rappel de rendez-vous envoyé la veille à un client d'une entreprise d'assainissement, de nettoyage ou de travaux en Corse. " +
      "pertinent : false si ce n'est pas une intervention chez un client (congés, absence, réunion, point interne, formation). " +
      "nom : le nom du client tel qu'on l'écrirait dans « Bonjour … » (ex. « Madame Lux », « Monsieur Errard »), vide si inconnu ou s'il s'agit d'une société. " +
      "objet : l'intervention en quelques mots, compréhensible par le client, sans référence interne ni abréviation (ex. « la vidange de votre fosse septique », « le curage de votre réseau d'évacuation », « l'entretien de votre bac à graisse »). " +
      "lieu : l'adresse de l'intervention si elle est écrite, sinon vide. N'invente rien.",
    messages: [{ role: 'user', content: `Titre : ${r.titre}\nLieu : ${r.lieu ?? ''}\nNotes : ${r.description || '(aucune)'}` }],
  });
  const bloc = reponse.content.find((b) => b.type === 'text');
  if (reponse.stop_reason !== 'end_turn' || !bloc || bloc.type !== 'text') throw new Error('Résumé du rendez-vous impossible');
  return JSON.parse(bloc.text) as Resume;
}

export type BilanRappels = { envoyes: string[]; sansEmail: number; ignores: number; deja: number; suites: number; erreurs: string[] };

/** Rendez-vous de demain qui prolonge un chantier déjà en cours aujourd'hui : même événement
 *  sur plusieurs jours, ou même intitulé repris jour après jour. Le client sait qu'on est là. */
export function suiteDeChantier(r: Rdv, aujourdhui: Rdv[]): boolean {
  return aujourdhui.some((x) => x.uid === r.uid || titreComparable(x.titre) === titreComparable(r.titre));
}

/** Envoie les rappels des rendez-vous de demain. `apercu` : n'envoie rien, liste seulement. */
export async function envoyerRappels(config: Config, maintenant = new Date(), apercu = false): Promise<BilanRappels> {
  const bilan: BilanRappels = { envoyes: [], sansEmail: 0, ignores: 0, deja: 0, suites: 0, erreurs: [] };
  const boite = config.boites.find((b) => b.id === config.rappels.boite);
  if (!boite) throw new Error(`Boîte d'envoi des rappels inconnue : ${config.rappels.boite}`);
  // Midi demain, heure de Paris : rdvDuJour prend le jour calendaire de cette date.
  const demain = new Date(maintenant.getTime() + 24 * 3_600_000);
  const simulation = apercu || config.mode === 'simulation';

  for (const agenda of config.agendas) {
    const societe = config.societes.find((s) => s.id === agenda.societe);
    const url = process.env[agenda.icsEnv];
    if (!societe || !url) continue;
    let rdvs: Rdv[];
    let aujourdhui: Rdv[];
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ics = await r.text();
      rdvs = rdvDuJour(ics, demain).map((x) => ({ ...x, passe: false }));
      // La veille, et pour un lundi tout le week-end jusqu'au vendredi : un chantier arrêté le
      // week-end reprend sans nouveau rappel.
      aujourdhui = [];
      for (let k = 1; k <= 3; k++) {
        const jour = new Date(demain.getTime() - k * 86_400_000);
        aujourdhui.push(...rdvDuJour(ics, jour));
        if (!estWeekEnd(jour)) break;
      }
    } catch (e) {
      bilan.erreurs.push(`${agenda.nom} : ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Adresses des clients chez qui on est la veille : pas de rappel s'ils nous ont encore demain.
    const emailsDuJour = new Set(aujourdhui.flatMap((x) => emailsDuRdv(x, config.domainesInternes)));

    for (const rdv of rdvs) {
      if (suiteDeChantier(rdv, aujourdhui)) {
        bilan.suites += 1;
        continue;
      }
      try {
        let email: string | undefined = emailsDuRdv(rdv, config.domainesInternes)[0];
        if (!email) {
          for (const tel of trouverTelephones(`${rdv.titre}\n${rdv.description}`, config.societes.map((s) => s.telephone))) {
            email = (await emailParTelephone(tel)) ?? undefined;
            if (email) break;
          }
        }
        if (!email) {
          bilan.sansEmail += 1;
          continue;
        }
        const client: string = email;
        if (emailsDuJour.has(client)) {
          bilan.suites += 1;
          continue;
        }
        if (await rappelDejaEnvoye(rdv.uid)) {
          bilan.deja += 1;
          continue;
        }
        const resume = await resumer(rdv, config);
        if (!resume.pertinent) {
          bilan.ignores += 1;
          continue;
        }
        const infos: InfosRappel = { nom: resume.nom, objet: resume.objet, debut: rdv.debut, lieu: resume.lieu || rdv.lieu || '' };
        const m = rappelRdv(infos, demain, societe);
        const destinataire = config.mode === 'test' ? config.test.adresse : client;
        if (!simulation) {
          await envoyer({
            boite,
            nomExpediteur: societe.nom,
            a: [destinataire],
            sujet: m.sujet,
            texte: m.texte,
            html: m.html,
            images: imagesSignature(path.resolve('assets/signature')),
            automatique: true,
          });
        }
        if (!apercu) await noterEnvoi({ journalId: null, type: 'rappel_rdv', destinataire: client, sujet: m.sujet, messageId: null, simulation, cle: rdv.uid });
        bilan.envoyes.push(`${simulation ? '[simulation] ' : ''}${client}${destinataire !== client ? ` (envoyé à ${destinataire})` : ''} · ${agenda.nom} · ${resume.objet}`);
      } catch (e) {
        bilan.erreurs.push(`${agenda.nom} « ${rdv.titre.slice(0, 40)} » : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return bilan;
}
