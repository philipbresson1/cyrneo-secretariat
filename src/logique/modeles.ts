/**
 * Textes envoyés par le secrétariat : réponses automatiques aux clients et messages
 * Rainbow pour les équipes. Écrits comme le ferait une vraie secrétaire, sans jargon.
 */
import type { Classification, Intervention, MailRecu, Societe, TypeDemande } from './types';

export type MailSortant = { sujet: string; texte: string };

function salutation(nom: string): string {
  const n = nom.trim();
  // Une adresse mail ou un nom de société en guise de nom : on reste simple.
  if (!n || n.includes('@') || /\b(sarl|sas|sci|syndic|agence|cabinet)\b/i.test(n)) return 'Bonjour,';
  return `Bonjour ${n},`;
}

function prefixeRe(sujet: string): string {
  return /^re\s*:/i.test(sujet.trim()) ? sujet.trim() : `Re: ${sujet.trim() || 'votre demande'}`;
}

function signature(s: Societe): string {
  return [`L'équipe ${s.nom}`, [s.telephone, s.site].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
}

const MENTION_AUTO = "Ce message part automatiquement dès réception de votre mail : inutile d'y répondre, sauf pour nous apporter une précision.";

export function accuseIntervention(mail: MailRecu, c: Classification, s: Societe, reference: string): MailSortant {
  const lignes = [
    salutation(c.contact.nom),
    '',
    `Merci pour votre message. Votre demande d'intervention est bien enregistrée chez ${s.nom} (référence ${reference}).`,
    c.contact.telephone
      ? `Un membre de l'équipe vous rappelle ${s.delaiRappel} au ${c.contact.telephone} pour convenir d'un créneau.`
      : `Nous revenons vers vous ${s.delaiRappel} pour vous confirmer le créneau d'intervention.`,
  ];
  if (c.urgence === 'urgente') {
    lignes.push('', `Nous avons bien noté que c'est urgent. Si la situation s'aggrave d'ici là, appelez-nous directement au ${s.telephone}.`);
  }
  lignes.push('', 'Belle journée à vous,', signature(s), '', MENTION_AUTO);
  return { sujet: prefixeRe(mail.sujet), texte: lignes.join('\n') };
}

export function accuseDevis(mail: MailRecu, c: Classification, s: Societe, reference: string): MailSortant {
  const rappel = c.contact.telephone
    ? `Nous revenons vers vous ${s.delaiDevis}, et nous vous appellerons au ${c.contact.telephone} si nous avons besoin de précisions.`
    : `Nous revenons vers vous ${s.delaiDevis}.`;
  const lignes = [
    salutation(c.contact.nom),
    '',
    `Merci pour votre demande de devis, elle est bien arrivée chez ${s.nom} (référence ${reference}).`,
    rappel,
    '',
    'Belle journée à vous,',
    signature(s),
    '',
    MENTION_AUTO,
  ];
  return { sujet: prefixeRe(mail.sujet), texte: lignes.join('\n') };
}

const LIBELLES_MANQUANTS: Record<string, string> = {
  telephone: 'un numéro de téléphone où vous joindre facilement',
  adresse: "l'adresse exacte de l'intervention (rue, commune, et si besoin un repère pour trouver l'accès)",
};

export function demandeCoordonnees(mail: MailRecu, c: Classification, s: Societe, manquants: string[]): MailSortant {
  const liste = manquants.map((m) => `  - ${LIBELLES_MANQUANTS[m] ?? m}`);
  const lignes = [
    salutation(c.contact.nom),
    '',
    `Merci pour votre message, nous l'avons bien reçu chez ${s.nom}.`,
    `Pour organiser l'intervention, il nous manque ${manquants.length > 1 ? 'deux informations' : 'une information'} :`,
    ...liste,
    '',
    "Il suffit de répondre directement à ce mail. Dès qu'on a ces éléments, un membre de l'équipe vous rappelle.",
    `Vous pouvez aussi nous appeler au ${s.telephone}.`,
    '',
    'À très vite,',
    signature(s),
  ];
  return { sujet: prefixeRe(mail.sujet), texte: lignes.join('\n') };
}

/** Champs indispensables pour qu'un agent puisse rappeler et se déplacer. */
// Messageries grand public : derrière, un particulier qu'il faut pouvoir rappeler.
const WEBMAILS = /@(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|orange|wanadoo|free|sfr|neuf|bbox|laposte|gmx|proton|protonmail)\./i;

/** Un professionnel (bailleur, syndic, entreprise) qui envoie un bon avec l'adresse a donné ce
 *  qu'il faut : on lui répond par mail, inutile d'exiger un téléphone. */
export function estProfessionnel(email: string): boolean {
  return email.includes('@') && !WEBMAILS.test(email);
}

export function coordonneesManquantes(c: Classification, type: TypeDemande): string[] {
  // Une réclamation se traite avec l'expéditeur, par mail : rien à exiger.
  if (type === 'reclamation') return [];
  const manquants: string[] = [];
  const lieu = !!(c.contact.adresse || c.contact.commune);
  if (!c.contact.telephone && !(lieu && estProfessionnel(c.contact.email))) manquants.push('telephone');
  // Pour un devis, l'adresse peut attendre l'appel ; pour une intervention, non.
  if (type === 'intervention' && !c.contact.adresse && !c.contact.commune) manquants.push('adresse');
  return manquants;
}

function heure(d: Date): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

/** Message posté dans la bulle Rainbow de la société. */
export function messageRainbow(
  mail: MailRecu,
  c: Classification,
  s: Societe,
  reference: string,
  suite: string,
  titre = c.categorie === 'demande_devis' ? 'Nouvelle demande de devis' : "Nouvelle demande d'intervention"
): string {
  const lignes = [
    `${c.urgence === 'urgente' ? '🚨 URGENT — ' : '📋 '}${titre} · ${s.nom} · ${reference}`,
    `👤 ${c.contact.nom || mail.deNom || mail.deAdresse}${c.contact.telephone ? ` · 📞 ${c.contact.telephone}` : ' · 📞 pas de numéro'}`,
  ];
  const lieu = [c.contact.adresse, c.contact.commune].filter(Boolean).join(', ');
  if (lieu) lignes.push(`📍 ${lieu}`);
  if (c.nature) lignes.push(`🔧 ${c.nature}`);
  if (c.dateSouhaitee) lignes.push(`📅 Souhaité : ${c.dateSouhaitee}`);
  if (c.resume) lignes.push(`📝 ${c.resume}`);
  lignes.push(`✉️ Mail de ${mail.deAdresse} reçu sur ${mail.boite} le ${heure(mail.recuLe)}`);
  lignes.push(`➡️ ${suite}`);
  return lignes.join('\n');
}

export function messageRainbowComplement(mail: MailRecu, c: Classification, s: Societe, i: Intervention): string {
  const lieu = [c.contact.adresse || i.adresse, c.contact.commune || i.commune].filter(Boolean).join(', ');
  return [
    `✅ Coordonnées reçues · ${s.nom} · ${i.reference}`,
    `👤 ${c.contact.nom || i.client_nom} · 📞 ${c.contact.telephone || i.client_telephone || 'toujours pas de numéro'}`,
    lieu ? `📍 ${lieu}` : '',
    i.nature ? `🔧 ${i.nature}` : '',
    '➡️ À rappeler pour planifier.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function messageRainbowRelance(mail: MailRecu, c: Classification, s: Societe, titre = '🔁 Relance client'): string {
  return [
    `${titre} · ${s.nom}`,
    `👤 ${c.contact.nom || mail.deNom || mail.deAdresse}${c.contact.telephone ? ` · 📞 ${c.contact.telephone}` : ''}`,
    c.resume ? `📝 ${c.resume}` : '',
    `✉️ ${mail.deAdresse} — « ${mail.sujet} »`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function messageRainbowVehicule(mail: MailRecu, c: Classification, fichiers: string[]): string {
  const pj = mail.piecesJointes.map((p) => p.nom);
  return [
    `🚚 Entretien véhicules`,
    c.resume ? `📝 ${c.resume}` : '',
    `✉️ ${mail.deNom || mail.deAdresse} — « ${mail.sujet} »`,
    pj.length ? `📎 ${pj.join(', ')}` : '',
    fichiers.length ? `🗂️ Classé dans le dossier véhicules (${fichiers.length} fichier${fichiers.length > 1 ? 's' : ''})` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function referenceIntervention(id: number, type: TypeDemande, annee: number): string {
  return `${{ devis: 'DEV', reclamation: 'REC', intervention: 'INT' }[type]}-${annee}-${String(id).padStart(4, '0')}`;
}
