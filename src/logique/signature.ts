/**
 * Mise en forme HTML des mails automatiques, reprise du document « Signatures email —
 * Groupe CYRNEO » (signature d'info@groupecyrneo.com) : logo du groupe, filet bleu, « Groupe
 * CYRNEO » à la place d'un nom de personne, téléphone · info@, adresse du Stiletto, puis la
 * rangée des logos des sociétés. Signature identique quelle que soit la société concernée.
 */

const LOGOS = [
  { cid: 'groupe-cyrneo@cyrneo', fichier: 'groupe-cyrneo.png', nom: 'Groupe Cyrneo', site: 'https://www.groupecyrneo.com' },
  { cid: 'sud-travaux@cyrneo', fichier: 'sud-travaux.png', nom: 'Sud Travaux', site: 'https://www.sudtravaux.com' },
  { cid: 'sud-assainissement@cyrneo', fichier: 'sud-assainissement.png', nom: 'Sud Assainissement', site: 'https://www.sud-assainissement-ajaccio.com' },
  { cid: 'sottec@cyrneo', fichier: 'sottec.png', nom: 'Sottec', site: 'https://www.sottec.fr' },
  { cid: 'multiservices-2a@cyrneo', fichier: 'multiservices-2a.png', nom: 'Multi Services 2A', site: 'https://www.multiservices2a2b.fr' },
  { cid: 'entretien-couleurs@cyrneo', fichier: 'entretien-couleurs.png', nom: 'Entretien et Couleurs', site: 'https://www.entretienetcouleurs.com' },
];

/** Images à joindre au mail (« inline »), chemins relatifs au dossier assets/signature. */
export function imagesSignature(dossier: string): { cid: string; chemin: string }[] {
  return LOGOS.map((l) => ({ cid: l.cid, chemin: `${dossier}/${l.fichier}` }));
}

export const ADRESSE_SIGNATURE = 'info@groupecyrneo.com';
const TELEPHONE = '04 95 23 02 84';

function e(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const POLICE = 'font-family:Arial,Helvetica,sans-serif';

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
        (texte.length ? `<p style="margin:0 0 12px;${POLICE};font-size:14px;line-height:1.5;color:#20242A">${texte.map(e).join('<br>')}</p>` : '') +
        (puces.length ? `<ul style="margin:0 0 12px 18px;padding:0;${POLICE};font-size:14px;line-height:1.5;color:#20242A">${puces.map((p) => `<li>${e(p.replace(/^\s*-\s/, ''))}</li>`).join('')}</ul>` : '')
      );
    })
    .join('');
}

export function signatureHtml(): string {
  const [groupe, ...societes] = LOGOS;
  const logos = societes
    .map(
      (l, i) =>
        `<td style="${i < societes.length - 1 ? 'padding-right:8px;' : ''}"><a href="${l.site}" target="_blank"><img src="cid:${l.cid}" width="42" height="42" alt="${e(l.nom)}" style="display:block; border:0;"></a></td>`
    )
    .join('');
  return `<table cellpadding="0" cellspacing="0" border="0" style="${POLICE}; border-collapse:collapse; margin-top:18px;">
<tr>
<td style="vertical-align:middle; padding-right:20px;"><a href="${groupe.site}" target="_blank" style="text-decoration:none;"><img src="cid:${groupe.cid}" width="100" height="110" alt="Groupe Cyrneo" style="display:block; border:0;"></a></td>
<td style="vertical-align:middle; padding-left:20px; border-left:3px solid #0A4F75;">
<div style="${POLICE}; font-size:16px; font-weight:bold; color:#20242A; line-height:1.3;">Groupe CYRNEO</div>
<div style="${POLICE}; font-size:12.5px; color:#0A4F75; line-height:1.6; margin-top:7px;"><a href="tel:+33495230284" style="color:#0A4F75; text-decoration:none;">${TELEPHONE}</a><span style="color:#C7C4C1;">&nbsp;·&nbsp;</span><a href="mailto:${ADRESSE_SIGNATURE}" style="color:#0A4F75; text-decoration:none;">${ADRESSE_SIGNATURE}</a></div>
<div style="${POLICE}; font-size:12px; color:#666B73; line-height:1.5; margin-top:3px;">Lot 15 — ZI du Stiletto, 20090 Ajaccio</div>
</td>
</tr>
<tr><td colspan="2" style="padding-top:16px;"><table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>${logos}</tr></table></td></tr>
</table>`;
}

/** Signature en texte brut, pour les messageries qui n'affichent pas le HTML. */
export const SIGNATURE_TEXTE = `Groupe CYRNEO\n${TELEPHONE} · ${ADRESSE_SIGNATURE}\nLot 15 — ZI du Stiletto, 20090 Ajaccio`;

/** Mail complet : corps, formule de politesse, signature, mention éventuelle en petit. */
export function mailHtml(corps: string[], formule: string, mention?: string): string {
  return `<!doctype html><html lang="fr"><body style="margin:0;padding:12px">${corpsHtml(corps)}<p style="margin:0;${POLICE};font-size:14px;color:#20242A">${e(formule)}</p>${signatureHtml()}${
    mention ? `<p style="margin:14px 0 0;${POLICE};font-size:11px;color:#8A8F96">${e(mention)}</p>` : ''
  }</body></html>`;
}
