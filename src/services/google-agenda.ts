/**
 * Écriture dans les agendas Google des équipes, par un compte de service Google : chaque agenda
 * est partagé avec l'adresse du compte de service (droit « Modifier les événements »).
 *
 * .env.local : GOOGLE_COMPTE_SERVICE = chemin du fichier de clé JSON du compte de service (ou son
 * contenu JSON). Lecture des agendas : toujours par les adresses iCal (AGENDA_ICS_*).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

type Cle = { client_email: string; private_key: string };

let jeton: { valeur: string; expire: number } | null = null;

function cle(): Cle {
  const v = process.env.GOOGLE_COMPTE_SERVICE?.trim();
  if (!v) throw new Error('Compte de service Google non configuré (GOOGLE_COMPTE_SERVICE dans .env.local)');
  return JSON.parse(v.startsWith('{') ? v : readFileSync(v, 'utf8')) as Cle;
}

export const agendaGoogleConfigure = (): boolean => !!process.env.GOOGLE_COMPTE_SERVICE?.trim();

const base64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Jeton d'accès (une heure), obtenu en signant une demande avec la clé du compte de service. */
async function jetonAcces(): Promise<string> {
  if (jeton && Date.now() < jeton.expire) return jeton.valeur;
  const { client_email, private_key } = cle();
  const maintenant = Math.floor(Date.now() / 1000);
  const entete = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corps = base64url(
    JSON.stringify({ iss: client_email, scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat: maintenant, exp: maintenant + 3600 })
  );
  const signature = base64url(createSign('RSA-SHA256').update(`${entete}.${corps}`).sign(private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${entete}.${corps}.${signature}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`Google refuse le compte de service : ${j.error_description ?? r.status}`);
  jeton = { valeur: j.access_token, expire: Date.now() + ((j.expires_in ?? 3600) - 300) * 1000 };
  return jeton.valeur;
}

export type Evenement = { titre: string; description: string; lieu?: string; debut: string; minutes: number }; // debut : AAAA-MM-JJTHH:MM, heure de Paris

/** « 2026-10-25T08:00 » + 30 min → « 2026-10-25T08:30:00 » (heure locale, sans fuseau). */
export function ajouterMinutes(debut: string, minutes: number): string {
  const d = new Date(`${debut}:00Z`);
  return new Date(d.getTime() + minutes * 60_000).toISOString().slice(0, 19);
}

/** Crée l'événement ; renvoie son lien. */
export async function inscrire(calendrier: string, e: Evenement): Promise<string> {
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendrier)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await jetonAcces()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: e.titre,
      description: e.description,
      location: e.lieu || undefined,
      start: { dateTime: `${e.debut}:00`, timeZone: 'Europe/Paris' },
      end: { dateTime: ajouterMinutes(e.debut, e.minutes), timeZone: 'Europe/Paris' },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json()) as { htmlLink?: string; error?: { message?: string } };
  if (!r.ok) {
    const conseil = r.status === 404 || r.status === 403 ? ' (agenda non partagé avec le compte de service ?)' : '';
    throw new Error(`Google Agenda : ${j.error?.message ?? r.status}${conseil}`);
  }
  return j.htmlLink ?? '';
}
