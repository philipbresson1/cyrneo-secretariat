/**
 * Mise en forme HTML des mails automatiques, sur le modèle de la signature d'info@groupecyrneo.com
 * (Outlook) : trois colonnes — expéditeur, logo, adresse du groupe — puis le bandeau bleu
 * « Ensemble, préservons la nature » avec les sociétés du groupe et les réseaux sociaux.
 */
import type { Societe } from './types';

/** Identifiant de l'image du logo dans le mail (pièce jointe « inline »). */
export const CID_LOGO = 'logo-societe@cyrneo';

const LOGOS: Record<string, string> = {
  'sud-assainissement': 'sud-assainissement.png',
  'sud-travaux': 'sud-travaux.png',
  sottec: 'sottec.png',
  'multiservices-2a': 'multiservices-2a.png',
  'entretien-couleurs': 'entretien-couleurs.png',
};

/** Fichier du logo de la société (dans assets/signature), logo du groupe à défaut. */
export function fichierLogo(societe: string): string {
  return LOGOS[societe] ?? 'groupe-cyrneo.png';
}

function e(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const POLICE = "font-family:Calibri,Arial,sans-serif";
const BLEU = '#365F91';
const BLEU_FONCE = '#2F5496';

/** Corps du mail : un paragraphe par bloc de lignes, les lignes « - … » en liste à puces. */
export function corpsHtml(lignes: string[]): string {
  const blocs: string[][] = [[]];
  for (const l of lignes) {
    if (l.trim() === '') blocs.push([]);
    else blocs[blocs.length - 1].push(l);
  }
  return blocs
    .filter((b) => b.length > 0)
    .map((b) => {
      const puces = b.filter((l) => /^\s*-\s/.test(l));
      const texte = b.filter((l) => !/^\s*-\s/.test(l));
      return (
        (texte.length ? `<p style="margin:0 0 12px;${POLICE};font-size:11pt;color:#222">${texte.map(e).join('<br>')}</p>` : '') +
        (puces.length ? `<ul style="margin:0 0 12px 18px;padding:0;${POLICE};font-size:11pt;color:#222">${puces.map((p) => `<li>${e(p.replace(/^\s*-\s/, ''))}</li>`).join('')}</ul>` : '')
      );
    })
    .join('');
}

export function signatureHtml(s: Societe, adresse: string): string {
  const site = s.site ? (s.site.startsWith('http') ? s.site : `https://${s.site}`) : 'https://www.groupecyrneo.com';
  const ligne = (t: string, gras = false) => `<p style="margin:0;${POLICE};font-size:10pt;line-height:1.4;color:${gras ? BLEU_FONCE : BLEU}">${gras ? `<b>${t}</b>` : t}</p>`;
  const cellule = `border-top:1px solid ${BLEU};border-bottom:1px solid ${BLEU};padding:6px 8px;vertical-align:top`;
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;max-width:630px;margin-top:8px">
<tr>
<td style="${cellule};width:40%">${ligne('Le secrétariat', true)}${ligne(e(s.nom), true)}${ligne(`Tél. : ${e(s.telephone)}`)}<p style="margin:0;${POLICE};font-size:11pt"><a href="mailto:${e(adresse)}" style="color:#0000EE;font-weight:bold;text-decoration:none">${e(adresse)}</a></p></td>
<td style="${cellule};width:24%;text-align:center"><img src="cid:${CID_LOGO}" width="83" alt="${e(s.nom)}" style="display:inline-block;border:0;max-width:83px;height:auto"></td>
<td style="${cellule};width:36%">${ligne('Groupe Cyrnéo', true)}${ligne('BP 590')}${ligne('20186 Ajaccio Cedex 2')}${ligne('Tél. : 04.95.23.02.84')}</td>
</tr>
<tr><td colspan="3" style="background:#C6D9F1;border:1px solid #D9D9D9;border-bottom:1px solid ${BLEU};padding:6px 8px">
<p style="margin:0;${POLICE};font-size:10pt;color:${BLEU}"><b>Ensemble,</b> préservons la nature&nbsp; <a href="${e(site)}" style="color:#0563C1;font-weight:bold">${e(s.site || 'www.groupecyrneo.com')}</a></p>
<p style="margin:2px 0;${POLICE};font-size:10.5pt"><a href="https://www.sud-assainissement-ajaccio.com/" style="color:#0563C1">Sud Assainissement</a> - Assainissement 2b - <a href="https://www.multiservices2a2b.fr/" style="color:#0563C1">Multi Services 2a2b</a> - <a href="https://www.corse-insectes.com/" style="color:#0563C1">Corse 3D</a> - <a href="https://www.sottec.fr/" style="color:#0563C1">SOTTEC</a> - <a href="https://www.sudtravaux.com/" style="color:#0563C1">Sud Travaux</a> - <a href="https://www.entretienetcouleurs.com/" style="color:#0563C1">Entretien et Couleurs</a></p>
<p style="margin:0;${POLICE};font-size:10pt;color:${BLEU}"><b>Rejoignez-nous</b> sur les réseaux sociaux : <a href="https://www.facebook.com/SudAssainissementCorse/" style="color:${BLEU}">Facebook</a> · <a href="https://www.instagram.com/sud_assainissement/?hl=fr" style="color:${BLEU}">Instagram</a></p>
</td></tr></table>`;
}

/** Mail complet : corps, formule de politesse, signature, mention éventuelle en petit. */
export function mailHtml(corps: string[], formule: string, s: Societe, adresse: string, mention?: string): string {
  return `<!doctype html><html lang="fr"><body style="margin:0;padding:12px">${corpsHtml(corps)}<p style="margin:0 0 4px;${POLICE};font-size:11pt;color:#222">${e(formule)}</p>${signatureHtml(s, adresse)}${
    mention ? `<p style="margin:10px 0 0;${POLICE};font-size:8.5pt;color:#888">${e(mention)}</p>` : ''
  }</body></html>`;
}
