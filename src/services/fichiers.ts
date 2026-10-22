/**
 * Classement des pièces jointes des factures reçues, en attendant la saisie dans
 * Dolibarr : <dossier factures>/<société>/<AAAA-MM>/<date>_<expéditeur>_<fichier>.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { MailRecu } from '../logique/types';

const TYPES_UTILES = /^(application\/pdf|image\/(jpeg|png|tiff)|application\/(vnd\.openxmlformats|msword|vnd\.ms-excel|xml)|text\/xml)/i;

function propre(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(0, 80);
}

async function existe(f: string): Promise<boolean> {
  try {
    await access(f);
    return true;
  } catch {
    return false;
  }
}

export async function classerPiecesJointes(mail: MailRecu, societe: string, racine: string): Promise<string[]> {
  const jour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(mail.recuLe); // AAAA-MM-JJ
  const dossier = path.resolve(racine, propre(societe), jour.slice(0, 7));
  await mkdir(dossier, { recursive: true });
  const expediteur = propre(mail.deNom || mail.deAdresse.split('@')[0]);
  const ecrits: string[] = [];
  for (const pj of mail.piecesJointes) {
    if (!TYPES_UTILES.test(pj.type) && !/\.(pdf|xml)$/i.test(pj.nom)) continue;
    const base = `${jour}_${expediteur}_${propre(pj.nom)}`;
    let cible = path.join(dossier, base);
    // Deux factures du même nom le même jour : on ne s'écrase pas.
    for (let n = 2; await existe(cible); n += 1) cible = path.join(dossier, base.replace(/(\.\w+)?$/, `_${n}$1`));
    await writeFile(cible, pj.contenu);
    ecrits.push(cible);
  }
  return ecrits;
}
