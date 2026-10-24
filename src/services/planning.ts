/**
 * Rapprochement avec les plannings : une demande « à planifier » dont le client apparaît dans un
 * agenda d'équipe (nom ou téléphone dans le rendez-vous, à partir de la date de la demande) est
 * au planning : elle passe en « planifiée », avec la date du rendez-vous.
 */
import type { Config, Intervention } from '../logique/types';
import { rdvDesJours, type Rdv } from '../lib/agenda';
import { nomPresent } from '../logique/tiers';
import * as db from './stockage';

type Journal = (texte: string) => void;
type RdvDate = { date: Date; rdv: Rdv };

const chiffres = (t: string) => t.replace(/\D/g, '');

/** Le rendez-vous concerne-t-il ce client ? Nom (tous ses mots significatifs) ou téléphone. */
export function rdvDuClient(fiche: Pick<Intervention, 'client_nom' | 'client_telephone'>, r: Rdv): boolean {
  const texte = `${r.titre} ${r.lieu ?? ''} ${r.description}`;
  const tel = chiffres(fiche.client_telephone).slice(-9);
  if (tel.length === 9 && chiffres(texte).includes(tel)) return true;
  return !!fiche.client_nom && nomPresent(fiche.client_nom, texte);
}

/** Premier rendez-vous du client à partir de la veille de la demande. */
export function rdvPlanifie(fiche: Pick<Intervention, 'client_nom' | 'client_telephone' | 'cree_le'>, rdvs: RdvDate[]): RdvDate | null {
  const depuis = new Date(fiche.cree_le).getTime() - 86_400_000;
  return rdvs.filter((x) => x.date.getTime() >= depuis && rdvDuClient(fiche, x.rdv)).sort((a, b) => a.date.getTime() - b.date.getTime())[0] ?? null;
}

export async function rapprocherPlannings(config: Config, log: Journal): Promise<void> {
  const fiches = await db.fichesAPlanifier();
  if (!fiches.length) return;
  // Du plus ancien jour utile (demande la plus ancienne, 60 j au plus) à deux mois devant.
  const plusAncienne = Math.min(...fiches.map((f) => new Date(f.cree_le).getTime()));
  const premier = new Date(Math.max(plusAncienne - 86_400_000, Date.now() - 60 * 86_400_000));
  const jours = Math.ceil((Date.now() - premier.getTime()) / 86_400_000) + 60;
  const rdvs: RdvDate[] = [];
  for (const a of config.agendas) {
    const url = process.env[a.icsEnv];
    if (!url) continue;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      for (const j of rdvDesJours(await r.text(), premier, jours)) for (const rdv of j.rdvs) rdvs.push({ date: rdv.debut ?? j.date, rdv });
    } catch {
      // agenda injoignable : on réessaiera au prochain passage
    }
  }
  for (const f of fiches) {
    const trouve = rdvPlanifie(f, rdvs);
    if (!trouve) continue;
    await db.majIntervention(f.id, { statut: 'planifiee', date_prevue: trouve.date.toISOString() });
    log(`${f.reference} au planning : « ${trouve.rdv.titre.slice(0, 50)} » le ${trouve.date.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}`);
  }
}
