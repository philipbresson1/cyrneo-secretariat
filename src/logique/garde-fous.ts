/**
 * Garde-fous des réponses automatiques. Une réponse automatique envoyée à un robot
 * (autre répondeur, liste de diffusion, notification) peut déclencher une boucle de
 * mails sans fin : on préfère ne pas répondre plutôt que répondre à tort.
 */
import type { MailRecu } from './types';

const PREFIXES_ROBOTS = [
  'no-reply', 'noreply', 'ne-pas-repondre', 'nepasrepondre', 'donotreply', 'do-not-reply',
  'notification', 'notifications', 'mailer-daemon', 'postmaster', 'bounce', 'alerts', 'alert',
  'newsletter', 'info-noreply',
];

const SUJETS_AUTOMATIQUES = [
  /^r[ée]ponse automatique/i,
  /^absence/i,
  /^auto(matic)?[ -]?reply/i,
  /^out of (the )?office/i,
  /^accus[ée] de r[ée]ception/i,
  /^undeliverable/i,
  /^non remis/i,
  /^delivery status notification/i,
  /^mail delivery (failed|system)/i,
];

export function domaine(adresse: string): string {
  return adresse.split('@')[1]?.toLowerCase().trim() ?? '';
}

/** `internes` mélange des domaines (groupecyrneo.com) et des adresses complètes
 *  (agent.sudassai@gmail.com) : une boîte Gmail ne rend pas tout gmail.com interne. */
export function estInterne(adresse: string, internes: string[]): boolean {
  const a = adresse.toLowerCase().trim();
  const d = domaine(a);
  return internes.some((i) => {
    const x = i.toLowerCase();
    return x.includes('@') ? a === x : d === x || d.endsWith('.' + x);
  });
}

export function estRobot(adresse: string): boolean {
  const locale = adresse.split('@')[0]?.toLowerCase() ?? '';
  return PREFIXES_ROBOTS.some((p) => locale.startsWith(p));
}

/** Raison pour laquelle on ne répond PAS automatiquement, ou null si on peut répondre. */
export function raisonDeNePasRepondre(mail: MailRecu, domainesInternes: string[]): string | null {
  const adresse = mail.repondreA || mail.deAdresse;
  if (!adresse || !adresse.includes('@')) return 'adresse de réponse absente';
  if (estInterne(adresse, domainesInternes) || estInterne(mail.deAdresse, domainesInternes)) return 'expéditeur interne au groupe';
  if (estRobot(mail.deAdresse) || estRobot(adresse)) return 'expéditeur automatique';

  const auto = mail.entetes.autoSubmitted?.toLowerCase().trim();
  if (auto && auto !== 'no') return 'mail envoyé automatiquement (Auto-Submitted)';
  const precedence = mail.entetes.precedence?.toLowerCase().trim();
  if (precedence && ['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return 'mail de masse (Precedence)';
  if (mail.entetes.listId) return 'liste de diffusion (List-Id)';
  const suppress = mail.entetes.autoResponseSuppress?.toLowerCase() ?? '';
  if (/\b(all|autoreply|oof)\b/.test(suppress)) return "l'expéditeur refuse les réponses automatiques";
  if (SUJETS_AUTOMATIQUES.some((re) => re.test(mail.sujet.trim()))) return 'réponse automatique ou retour de non-remise';
  return null;
}
