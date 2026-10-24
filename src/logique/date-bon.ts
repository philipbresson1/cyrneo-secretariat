/**
 * Date d'intervention d'un bon : sans elle, le BI n'apparaît pas dans le « panier » où les agents
 * choisissent leurs interventions.
 *  - débouchage : le jour de la demande (toujours fait dans la journée), ou le jour du rappel
 *    convenu (« à rappeler demain 8h ») ;
 *  - vidange et le reste : le jour fixé avec le client, sinon rien (la passe de la veille date le
 *    bon d'après le planning).
 */
import type { Classification } from './types';
import { decalageParis, jourParis } from '../lib/agenda';

export const estDebouchage = (nature: string) => /d[ée]bouch|bouch[ée]|engorg|hydrocur|curage/i.test(nature);

/** « AAAA-MM-JJTHH:MM » en heure de Paris → Date. */
export function depuisParis(creneau: string): Date {
  return new Date(`${creneau}:00${decalageParis(new Date(`${creneau}:00Z`))}`);
}

export function dateDuBon(c: Pick<Classification, 'nature' | 'creneau' | 'creneauType'>, recuLe: Date): Date | null {
  const creneau = c.creneau ? depuisParis(c.creneau) : null;
  if (creneau && c.creneauType !== 'rappel') return creneau;
  if (estDebouchage(c.nature)) return creneau ?? recuLe;
  return null;
}

/** Dates d'intervention déjà portées par un bon Dolibarr : le champ complémentaire réglé
 *  (dolibarr.champDateBon), sinon les lignes datées. */
export function datesDuBon(b: Record<string, unknown>, champ?: string): Date[] {
  const vers = (v: unknown) => {
    const n = typeof v === 'string' && /\D/.test(v) ? Date.parse(v) / 1000 : Number(v);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
  };
  if (champ) return [vers(((b.array_options ?? {}) as Record<string, unknown>)[`options_${champ.replace(/^options_/, '')}`])].filter((d): d is Date => !!d);
  const lignes = Array.isArray(b.lines) ? (b.lines as Record<string, unknown>[]) : [];
  return lignes.map((l) => vers(l.date ?? l.datei)).filter((d): d is Date => !!d);
}

export const memeJour = (a: Date, b: Date) => jourParis(a) === jourParis(b);

export const jourFr = (d: Date) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' }).format(d);
