/**
 * Lecture IMAP des boîtes (OVH par défaut, Gmail via imap.gmail.com). Lecture seule stricte : aucun mail n'est marqué lu,
 * déplacé ou supprimé. La reprise se fait par UID, mémorisé dans Supabase.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { Boite, MailRecu } from '../logique/types';

const HOTE_OVH = 'ssl0.ovh.net';
const TAILLE_MAX_MAIL = 30 * 1024 * 1024;
const MAX_PAR_PASSAGE = 50; // un gros arriéré est écoulé sur plusieurs passages

export function identifiants(b: Boite): { user: string; pass: string } {
  const user = process.env[b.utilisateurEnv];
  const pass = process.env[b.motDePasseEnv];
  if (!user || !pass) throw new Error(`Identifiants manquants pour ${b.id} (${b.utilisateurEnv} / ${b.motDePasseEnv} dans .env.local)`);
  return { user, pass };
}

function premiereAdresse(a: AddressObject | AddressObject[] | undefined): { adresse: string; nom: string } {
  const liste = Array.isArray(a) ? a : a ? [a] : [];
  const v = liste[0]?.value?.[0];
  return { adresse: (v?.address ?? '').toLowerCase(), nom: v?.name?.trim() ?? '' };
}

function entete(p: ParsedMail, nom: string): string | null {
  const v = p.headers.get(nom);
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in v) return String((v as { value: unknown }).value);
  return String(v);
}

export function convertir(p: ParsedMail, boite: string, uid: number): MailRecu {
  const de = premiereAdresse(p.from);
  const repondre = premiereAdresse(p.replyTo);
  const references = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const texte = (p.text ?? '').trim() || (typeof p.html === 'string' ? p.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
  return {
    boite,
    uid,
    // Un mail sans Message-ID (rare) reçoit un identifiant stable dérivé de la boîte et de l'UID.
    messageId: p.messageId ?? `<sans-id-${boite}-${uid}@secretariat>`,
    inReplyTo: p.inReplyTo ?? null,
    references,
    deAdresse: de.adresse,
    deNom: de.nom,
    repondreA: repondre.adresse || de.adresse,
    sujet: (p.subject ?? '').trim() || '(sans sujet)',
    recuLe: p.date ?? new Date(),
    texte,
    entetes: {
      autoSubmitted: entete(p, 'auto-submitted'),
      precedence: entete(p, 'precedence'),
      listId: entete(p, 'list-id'),
      autoResponseSuppress: entete(p, 'x-auto-response-suppress'),
    },
    piecesJointes: (p.attachments ?? [])
      // Les images intégrées à la signature ne sont pas des pièces jointes utiles.
      .filter((a) => a.contentDisposition !== 'inline' || a.contentType === 'application/pdf')
      .map((a) => ({ nom: a.filename ?? 'piece-jointe', type: a.contentType, taille: a.size, contenu: a.content })),
  };
}

/** Raison lisible d'un échec IMAP, sans jamais reprendre d'identifiant. */
export function raisonImap(e: unknown): string {
  const x = (e ?? {}) as { authenticationFailed?: boolean; code?: string; responseText?: string; message?: string };
  if (x.authenticationFailed) {
    return `identifiant ou mot de passe refusé${x.responseText ? ` (${x.responseText.slice(0, 120)})` : ''}`;
  }
  if (x.code === 'ENOTFOUND') return 'serveur introuvable (adresse IMAP ou connexion internet)';
  if (x.code === 'ETIMEDOUT' || x.code === 'ECONNREFUSED') return `serveur injoignable (${x.code})`;
  if (x.message?.startsWith('Identifiants manquants')) return x.message;
  return x.code ? `erreur ${x.code}` : 'erreur inconnue';
}

function client(b: Boite): ImapFlow {
  return new ImapFlow({
    host: b.imap?.hote ?? HOTE_OVH,
    port: b.imap?.port ?? 993,
    secure: true,
    auth: identifiants(b),
    logger: false,
    greetingTimeout: 30_000,
    socketTimeout: 180_000,
  });
}

/** Se connecte et compte les mails de la boîte de réception, sans rien lire. */
export async function testerBoite(b: Boite): Promise<number> {
  let c: ImapFlow;
  try {
    c = client(b);
  } catch (e) {
    throw new Error(raisonImap(e));
  }
  c.on('error', () => undefined);
  try {
    await c.connect();
    const boite = await c.mailboxOpen('INBOX', { readOnly: true });
    return boite.exists;
  } catch (e) {
    throw new Error(raisonImap(e));
  } finally {
    await c.logout().catch(() => undefined);
  }
}

export type Lot = { uidValidity: string; mails: MailRecu[]; dernierUidVu: number };

/** Lit les nouveaux mails d'une boîte depuis `dernierUid` (exclu). Au tout premier passage
 *  (curseur absent ou UIDVALIDITY changée), ne lit que les mails reçus depuis `depuis`. */
export async function lireNouveaux(b: Boite, curseur: { uidValidity: string; dernierUid: number } | null, depuis: Date): Promise<Lot> {
  let cx: ImapFlow;
  try {
    cx = client(b);
  } catch (e) {
    throw new Error(`Boîte ${b.id} : ${raisonImap(e)}`);
  }
  // Sans écouteur, une coupure réseau après connexion tue tout le processus.
  cx.on('error', (e: unknown) => {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: unknown }).code) : 'inconnu';
    console.error(`[imap] incident sur ${b.id} (${code})`);
  });

  try {
    await cx.connect();
    const boite = await cx.mailboxOpen('INBOX', { readOnly: true });
    const uidValidity = String(boite.uidValidity);
    const reprise = curseur && curseur.uidValidity === uidValidity;

    const recherche = reprise ? { uid: `${curseur.dernierUid + 1}:*` } : { since: depuis };
    let uids = ((await cx.search(recherche, { uid: true })) || []) as number[];
    // « n:* » renvoie toujours le dernier mail, même déjà lu : on refiltre.
    if (reprise) uids = uids.filter((u) => u > curseur.dernierUid);
    uids.sort((a, b2) => a - b2);
    const aLire = uids.slice(0, MAX_PAR_PASSAGE);

    if (aLire.length === 0) {
      return { uidValidity, mails: [], dernierUidVu: reprise ? curseur.dernierUid : Math.max(0, (boite.uidNext ?? 1) - 1) };
    }

    // Le parcours du fetch doit être fini avant toute autre commande (imapflow se fige sinon).
    const sources: { uid: number; source: Buffer }[] = [];
    for await (const m of cx.fetch(aLire, { uid: true, source: { maxLength: TAILLE_MAX_MAIL }, size: true }, { uid: true })) {
      if (m.source) sources.push({ uid: m.uid, source: m.source });
    }

    const mails: MailRecu[] = [];
    for (const s of sources) {
      const analyse = await simpleParser(s.source);
      mails.push(convertir(analyse, b.id, s.uid));
    }
    return { uidValidity, mails, dernierUidVu: aLire[aLire.length - 1] };
  } catch (e) {
    throw new Error(`Boîte ${b.id} : ${raisonImap(e)}`);
  } finally {
    try {
      await cx.logout();
    } catch {
      // déjà déconnecté
    }
  }
}
