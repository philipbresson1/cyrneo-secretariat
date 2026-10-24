/**
 * Contrat type (modèle Word de Cyrneo-app) et mandat SEPA, pré-remplis pour un contrat 2 ans
 * après vidange. Mêmes textes que l'espace commercial du site (lib/contrat-word.js) : contrat seul,
 * il finance la prochaine vidange dans vingt-quatre mois.
 */
import { docxSimple, remplirDocx, type Paragraphe } from '../lib/docx';
import { MOIS_CONTRAT } from './contrat';

export type DonneesContrat = {
  client_nom: string;
  adresse: string;
  cp: string;
  ville: string;
  telephone: string;
  email: string;
  secteur: string;
  volume: number;
  acces_loin: boolean;
  vidange_ttc: number;
  mensualite: number;
  reference: string; // réf. du contrat Dolibarr (ou provisoire)
  rum: string;
};

const euros = (n: number) => `${n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €`;
const aujourdhui = () => new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });

/** RUM, comme le site : SUDASSAI-<NOM>-<année>. */
export function rum(nom: string, annee = new Date().getFullYear()): string {
  const base = (nom.replace(/^\s*(mme|mlle|mr|m\.|madame|monsieur)\s+/i, '') || 'CLIENT').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return `SUDASSAI-${base}-${annee}`;
}

export function valeursContrat(d: DonneesContrat): Record<string, string> {
  const adresse = [d.adresse, [d.cp, d.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {
    numero_contrat: d.reference,
    numero_devis: 'sans objet',
    date_emission: aujourdhui(),
    client_nom: d.client_nom,
    client_adresse: d.adresse,
    client_code_postal: d.cp,
    client_ville: d.ville,
    client_siret: 'sans objet (particulier)',
    client_representant: d.client_nom,
    client_telephone: d.telephone,
    client_email: d.email,
    site_intervention: adresse,
    type_bac: `${d.volume} m³`,
    couverts: d.secteur,
    frequence: 'Vidange tous les 2 ans',
    acces: d.acces_loin ? 'Plus de 20 m entre le camion et la fosse' : 'Moins de 20 m entre le camion et la fosse',
    clause_vidange:
      'Le présent contrat ne comprend pas de vidange à la souscription : il finance les vidanges à venir, la première intervenant vingt-quatre (24) mois après la prise d’effet. Le Client déclare que la dernière vidange de sa fosse date de moins de douze (12) mois.',
    type_duree: 'Contrat d’entretien, reconduction tacite',
    date_debut: 'à la date de signature',
    duree: `${MOIS_CONTRAT} mois`,
    montant_ht: `${euros(d.vidange_ttc)} TTC`,
    montant_tva: `${euros(d.mensualite)} TTC / mois`,
    montant_ttc: `${euros(d.mensualite * MOIS_CONTRAT)} TTC sur ${MOIS_CONTRAT} mois`,
    modalites_paiement: 'Prélèvement SEPA mensuel (mandat joint, à retourner signé avec un RIB).',
    fait_a: d.ville || 'Ajaccio',
    fait_le: '……………………',
  };
}

export const contratDocx = (modele: Buffer, d: DonneesContrat) => remplirDocx(modele, valeursContrat(d));

/** Champs du mandat type fourni par le bureau (assets/contrats/mandat.docx). */
export function valeursMandat(d: DonneesContrat): Record<string, string> {
  return {
    ...valeursContrat(d),
    rum: d.rum,
    mensualite: `${euros(d.mensualite)} TTC`,
    iban: '',
    bic: '',
    date_signature: '',
  };
}

/** Mandat SEPA séparé, pré-rempli : le modèle du bureau s'il est fourni, sinon un mandat simple
 *  (le client complète IBAN, BIC, date et signature). */
export function mandatDocx(d: DonneesContrat, modele?: Buffer | null): Buffer {
  if (modele) return remplirDocx(modele, valeursMandat(d));
  const P = (texte: string, o: Omit<Paragraphe, 'texte'> = {}): Paragraphe => ({ texte, ...o });
  return docxSimple([
    P('MANDAT DE PRÉLÈVEMENT SEPA', { gras: true, taille: 16, centre: true, couleur: '232B66' }),
    P(`Référence unique du mandat (RUM) : ${d.rum}`, { centre: true, taille: 9 }),
    P(
      'En signant ce formulaire de mandat, vous autorisez SUD ASSAINISSEMENT à envoyer des instructions à votre banque pour débiter votre compte, et votre banque à débiter votre compte conformément aux instructions de SUD ASSAINISSEMENT. Vous bénéficiez du droit d’être remboursé par votre banque selon les conditions décrites dans la convention que vous avez passée avec elle. Une demande de remboursement doit être présentée dans les 8 semaines suivant la date de débit de votre compte pour un prélèvement autorisé.',
      { taille: 9 }
    ),
    P('Créancier', { gras: true, couleur: '0A4F75' }),
    P('SAS SUD ASSAINISSEMENT\nIdentifiant créancier SEPA (ICS) : FR52ZZZ620650\nBP 590 — 20186 Ajaccio Cedex 2 — France'),
    P('Débiteur (le client)', { gras: true, couleur: '0A4F75' }),
    P(`Nom / Prénom : ${d.client_nom}\nAdresse : ${d.adresse}\nCode postal / Ville : ${[d.cp, d.ville].filter(Boolean).join(' ')}\nPays : France`),
    P('IBAN : FR__ ____ ____ ____ ____ ____ ___\nBIC : ___________'),
    P('Type de paiement : paiement récurrent / répétitif', { gras: true }),
    P(`Contrat lié : ${d.reference} — contrat d’entretien fosse septique, vidange tous les 2 ans, ${euros(d.mensualite)} TTC par mois sur ${MOIS_CONTRAT} mois.\nCode identifiant du débiteur : SUD ASSAINISSEMENT - ENTRETIEN`),
    P('Signé à : ……………………………    Le : ……… / ……… / …………'),
    P('Signature du débiteur :\n\n\n'),
    P('Vos droits concernant le présent mandat sont expliqués dans un document que vous pouvez obtenir auprès de votre banque. Merci de retourner ce mandat signé accompagné d’un RIB.', { taille: 8 }),
  ]);
}
