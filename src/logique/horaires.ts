/**
 * Heures d'astreinte : en dehors des heures ouvrées (soir, nuit, week-end, jours fériés
 * français), les demandes d'intervention partent dans la bulle d'urgence de la société.
 */

/** Dimanche de Pâques (algorithme de Meeus/Jones/Butcher), en date UTC à minuit. */
export function paques(annee: number): Date {
  const a = annee % 19;
  const b = Math.floor(annee / 100);
  const c = annee % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31);
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(annee, mois - 1, jour));
}

/** Jours fériés légaux en France métropolitaine (dont la Corse), au format AAAA-MM-JJ. */
export function joursFeries(annee: number): Set<string> {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const decale = (d: Date, jours: number) => new Date(d.getTime() + jours * 86_400_000);
  const p = paques(annee);
  const fixes = ['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'].map((md) => `${annee}-${md}`);
  return new Set([...fixes, iso(decale(p, 1)), iso(decale(p, 39)), iso(decale(p, 50))]);
}

function partiesParis(date: Date): { jour: string; semaine: number; minutes: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  const semaine = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { jour: `${p.year}-${p.month}-${p.day}`, semaine, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function versMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Vrai si `date` tombe hors des heures ouvrées : avant `debut`, à partir de `fin`, le samedi,
 *  le dimanche ou un jour férié (heure de Paris). */
export function horsHeuresOuvrees(date: Date, heures: { debut: string; fin: string }): boolean {
  const { jour, semaine, minutes } = partiesParis(date);
  if (semaine === 0 || semaine === 6) return true;
  if (joursFeries(Number(jour.slice(0, 4))).has(jour)) return true;
  return minutes < versMinutes(heures.debut) || minutes >= versMinutes(heures.fin);
}
