/**
 * Envoi des mails du secrétariat par le SMTP OVH de la boîte qui a reçu le mail :
 * le client reçoit la réponse de l'adresse à laquelle il a écrit.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { randomUUID } from 'node:crypto';
import type { Boite, PieceJointe } from '../logique/types';
import { identifiants } from './imap';

const transports = new Map<string, Transporter>();

function transport(b: Boite): Transporter {
  let t = transports.get(b.id);
  if (!t) {
    t = nodemailer.createTransport({
      host: b.smtp?.hote ?? 'ssl0.ovh.net',
      port: b.smtp?.port ?? 465,
      secure: (b.smtp?.port ?? 465) === 465,
      auth: identifiants(b),
    });
    transports.set(b.id, t);
  }
  return t;
}

export type Envoi = {
  boite: Boite;
  nomExpediteur: string;
  a: string[];
  sujet: string;
  texte: string;
  enReponseA?: string; // Message-ID du mail d'origine
  references?: string[];
  piecesJointes?: PieceJointe[];
  automatique: boolean; // réponse automatique : en-têtes anti-boucle
};

/** Envoie et renvoie le Message-ID généré (sert à relier la réponse du client). */
export async function envoyer(e: Envoi): Promise<string> {
  const domaine = e.boite.adresse.split('@')[1] ?? 'secretariat.local';
  const messageId = `<secretariat-${randomUUID()}@${domaine}>`;
  const entetes: Record<string, string> = {};
  if (e.automatique) {
    // RFC 3834 : signale une réponse automatique pour que les répondeurs d'en face se taisent.
    entetes['Auto-Submitted'] = 'auto-replied';
    entetes['X-Auto-Response-Suppress'] = 'All';
  }
  await transport(e.boite).sendMail({
    from: { name: e.nomExpediteur, address: e.boite.adresse },
    to: e.a,
    subject: e.sujet,
    text: e.texte,
    messageId,
    inReplyTo: e.enReponseA,
    references: e.enReponseA ? [...(e.references ?? []), e.enReponseA] : undefined,
    headers: entetes,
    attachments: (e.piecesJointes ?? []).map((p) => ({ filename: p.nom, content: p.contenu, contentType: p.type })),
  });
  return messageId;
}
