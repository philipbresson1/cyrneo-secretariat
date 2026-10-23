/**
 * Serveur web local du PC (réseau du bureau uniquement) :
 *   /ecran          écran de la salle d'accueil (interventions + agendas), sans connexion
 *   /interventions  suivi et mise à jour des statuts (clé requise)
 *   /journal        historique complet des mails traités, avec recherche (clé requise)
 *   /etat           santé du démon, en JSON
 * La clé se donne une fois dans l'adresse (?cle=…) puis reste en cookie.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Config, Intervention, StatutIntervention } from '../logique/types';
import { LIBELLES_CATEGORIES, type Categorie } from '../logique/types';
import { decalageParis, rdvDuJour, type Rdv } from '../lib/agenda';
import { chercherJournal, creerInterventionManuelle, interventionsOuvertes, majIntervention, type NouvelleDemande } from './stockage';

export type Etat = { demarreLe: Date; dernierPassage: Date | null; erreurs: string[]; mode: string };

const STATUTS: Record<StatutIntervention, string> = {
  coordonnees_demandees: 'En attente du client',
  a_planifier: 'À planifier',
  planifiee: 'Planifiée',
  realisee: 'Réalisée',
  annulee: 'Annulée',
};

function e(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fmtHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
const fmtJour = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtComplet = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// --- Agendas : relus au plus toutes les 5 minutes -------------------------------
type AgendaLu = { env: string; nom: string; couleur: string; aujourdhui: Rdv[]; demain: Rdv[]; erreur: string | null };
let cacheAgendas: { lu: number; agendas: AgendaLu[] } | null = null;

async function lireAgendas(config: Config): Promise<AgendaLu[]> {
  if (cacheAgendas && Date.now() - cacheAgendas.lu < 5 * 60_000) return cacheAgendas.agendas;
  const maintenant = new Date();
  const demain = new Date(maintenant.getTime() + 86_400_000);
  const agendas = await Promise.all(
    config.agendas.map(async (a): Promise<AgendaLu> => {
      const url = process.env[a.icsEnv];
      if (!url) return { env: a.icsEnv, nom: a.nom, couleur: a.couleur, aujourdhui: [], demain: [], erreur: `variable ${a.icsEnv} absente` };
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ics = await r.text();
        return { env: a.icsEnv, nom: a.nom, couleur: a.couleur, aujourdhui: rdvDuJour(ics, maintenant), demain: rdvDuJour(ics, demain).map((x) => ({ ...x, passe: false })), erreur: null };
      } catch {
        // Jamais l'URL dans le message : elle donne un accès permanent à l'agenda.
        return { env: a.icsEnv, nom: a.nom, couleur: a.couleur, aujourdhui: [], demain: [], erreur: 'agenda injoignable' };
      }
    })
  );
  cacheAgendas = { lu: Date.now(), agendas };
  return agendas;
}

// --- Pages ----------------------------------------------------------------------
const STYLE = `
:root{--fond:#0f172a;--carte:#1e293b;--texte:#f1f5f9;--doux:#94a3b8;--ligne:#334155;--urgent:#ef4444;--ok:#22c55e;--attente:#f59e0b}
*{box-sizing:border-box}body{margin:0;background:var(--fond);color:var(--texte);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:#93c5fd}h1{margin:0;font-size:1.6rem}h2{font-size:1.1rem;margin:0 0 .6rem;color:var(--doux);text-transform:uppercase;letter-spacing:.05em}
.barre{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.5rem;border-bottom:1px solid var(--ligne)}
.horloge{font-size:2rem;font-variant-numeric:tabular-nums}
.grille{display:grid;grid-template-columns:2fr 1fr;gap:1.2rem;padding:1.2rem 1.5rem}
@media (max-width:900px){.grille{grid-template-columns:1fr}}
.carte{background:var(--carte);border-radius:12px;padding:1rem 1.2rem}
.inter{border-left:6px solid var(--ok);padding:.6rem .8rem;margin-bottom:.6rem;background:#0b1222;border-radius:8px}
.inter.urgente{border-color:var(--urgent)}.inter.attente{border-color:var(--attente)}
.inter .haut{display:flex;justify-content:space-between;gap:1rem;font-weight:600;font-size:1.1rem}
.inter .bas{color:var(--doux);margin-top:.2rem}
.etiquette{display:inline-block;padding:.1rem .5rem;border-radius:999px;background:var(--ligne);font-size:.8rem;margin-right:.4rem}
.rdv{display:flex;gap:.8rem;padding:.35rem 0;border-bottom:1px solid var(--ligne)}.rdv.passe{opacity:.4}
.rdv .h{min-width:3.2rem;font-variant-numeric:tabular-nums;color:var(--doux)}
.agenda h3{margin:.8rem 0 .3rem;font-size:1rem}.pastille{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.4rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.45rem;border-bottom:1px solid var(--ligne);vertical-align:top}
th{color:var(--doux);font-weight:600}input,select,button{font:inherit;padding:.3rem .5rem;border-radius:6px;border:1px solid var(--ligne);background:#0b1222;color:var(--texte)}
button{background:#2563eb;border-color:#2563eb;cursor:pointer}.vide{color:var(--doux);font-style:italic}
.erreur{color:var(--urgent)}.nav a{margin-left:1rem}
`;

function page(titre: string, corps: string, rafraichir = 0): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${rafraichir ? `<meta http-equiv="refresh" content="${rafraichir}">` : ''}<title>${e(titre)}</title><style>${STYLE}</style></head><body>${corps}</body></html>`;
}

/** « 2026-10-23T09:00 » en heure de Paris, pour un champ datetime-local. */
function heureParisPourChamp(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function nomSociete(config: Config, id: string | null): string {
  return config.societes.find((s) => s.id === id)?.nom ?? id ?? '';
}

/** Titre d'agenda lisible sur une ligne : les rendez-vous contiennent souvent des retours
 *  à la ligne, des mentions Rainbow et des numéros collés. */
export function nettoyerTitre(t: string): string {
  return t
    .replace(/<@[^>]*>/g, '')
    .replace(/\s*\n+\s*/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·-]+|[\s·-]+$/g, '')
    .trim();
}

/** Ancienneté d'une demande, pour le rappel : « 2 h », « 3 j ». */
function depuis(iso: string, maintenant = Date.now()): string {
  const minutes = Math.max(0, Math.round((maintenant - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} j`;
}

const STYLE_ECRAN = `
:root{--fond:#0b1526;--carte:#13233b;--texte:#f1f5f9;--doux:#8fa3bd;--ligne:#22385a;--urgent:#ef4444;--attente:#f59e0b;--ok:#22c55e}
*{box-sizing:border-box;margin:0}
html{font-size:clamp(13px,1.12vw,30px)}
body{height:100vh;overflow:hidden;background:var(--fond);color:var(--texte);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
header{display:flex;justify-content:space-between;align-items:baseline;padding:.5rem 1.2rem;border-bottom:1px solid var(--ligne)}
header h1{font-size:1.6rem;font-weight:700}header h1 span{color:#a1d8ee}
#h{font-size:1.8rem;font-variant-numeric:tabular-nums;color:#a1d8ee}
main{flex:1;min-height:0;display:grid;grid-template-columns:repeat(var(--cols),1fr) 1.15fr;gap:.7rem;padding:.7rem 1.2rem}
section{min-height:0;display:flex;flex-direction:column;background:var(--carte);border-radius:12px;padding:.9rem 1rem}
section h2{font-size:1.2rem;margin-bottom:.6rem;display:flex;justify-content:space-between;align-items:baseline}
section h2 small{font-size:.85rem;color:var(--doux);font-weight:500}
.liste{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:.35rem}
.rdv{display:flex;gap:.6rem;padding:.35rem .5rem;border-left:4px solid var(--c);background:#0d1a2e;border-radius:6px;line-height:1.25}
.rdv.passe{opacity:.38}.rdv.encours{background:#173457;box-shadow:inset 0 0 0 1px #3fa7d6}
.rdv .h{min-width:3.1rem;font-variant-numeric:tabular-nums;color:#a1d8ee;font-weight:600}
.rdv .t{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.rdv .ag{color:var(--doux);font-size:.75rem}
.sep{color:var(--doux);font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;margin:.5rem 0 .1rem}
.plus{color:var(--doux);font-style:italic;padding:.2rem .5rem}
.vide{color:var(--doux);font-style:italic}
.bon{padding:.45rem .6rem;border-left:5px solid var(--ok);background:#0d1a2e;border-radius:6px;line-height:1.25}
.bon.urgente{border-color:var(--urgent);background:#2a1418}.bon.attente{border-color:var(--attente)}
.bon .l1{display:flex;justify-content:space-between;gap:.5rem;font-weight:600}
.bon .l1 .age{color:var(--doux);font-weight:500;white-space:nowrap}
.bon .l2{color:var(--doux);font-size:.85rem;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.alerte{color:var(--urgent)}
#retards{background:var(--urgent);color:#fff;border-radius:999px;padding:0 .6rem;font-size:.85rem}
main.equipes{grid-template-columns:repeat(var(--cols),1fr)}
main.bureau{display:block}
.grille{display:grid;grid-template-columns:repeat(auto-fill,minmax(22rem,1fr));grid-auto-rows:min-content;gap:.7rem;height:100%;align-content:start}
.fiche{padding:.7rem .9rem;border-left:7px solid var(--ok);background:var(--carte);border-radius:10px;line-height:1.3}
.fiche.urgente{border-color:var(--urgent);background:#2a1418}.fiche.attente{border-color:var(--attente)}
.fiche .l1{display:flex;justify-content:space-between;gap:.5rem;font-weight:700;font-size:1.15rem}
.fiche .age{color:var(--doux);font-weight:500;white-space:nowrap}
.fiche .nat{font-size:1.05rem;margin:.2rem 0}
.fiche .l2{color:var(--doux);font-size:.9rem}
.fiche .etat{color:var(--attente);font-size:.9rem;margin-top:.2rem}
.compteurs{display:flex;gap:.7rem;padding:.7rem 1.2rem 0}
.compteur{flex:1;background:var(--carte);border-radius:10px;padding:.5rem .9rem;display:flex;align-items:baseline;gap:.6rem}
.compteur b{font-size:2.2rem}.compteur span{color:var(--doux)}
.compteur.rouge b{color:var(--urgent)}.compteur.orange b{color:var(--attente)}
`;

// Retire les éléments qui débordent d'une liste et affiche « + N autres » : l'écran ne défile jamais.
const SCRIPT_ECRAN = `
const h=document.getElementById('h');const t=()=>h.textContent=new Date().toLocaleString('fr-FR',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});t();setInterval(t,15000);
document.querySelectorAll('.liste').forEach(l=>{let n=0;const p=document.createElement('div');p.className='plus';
while(l.scrollHeight>l.clientHeight+1){const el=[...l.children].filter(x=>!x.classList.contains('plus')&&!x.classList.contains('sep')).pop();if(!el)break;el.remove();n++;p.textContent='+ '+n+' autre'+(n>1?'s':'');if(!p.isConnected)l.appendChild(p);}
const der=l.lastElementChild;if(der&&der.classList.contains('sep'))der.remove();});
`;

function ligneRdv(r: Rdv, a: AgendaLu, plusieurs: boolean, maintenant: number): string {
  const encours = !r.journeeEntiere && r.debut && r.fin && r.debut.getTime() <= maintenant && r.fin.getTime() > maintenant;
  const classe = r.passe ? 'passe' : encours ? 'encours' : '';
  const heure = r.journeeEntiere ? 'Jour' : r.debut ? fmtHeure.format(r.debut) : '';
  return `<div class="rdv ${classe}" style="--c:${e(a.couleur)}"><span class="h">${heure}</span><span class="t">${e(nettoyerTitre(r.titre))}${plusieurs ? ` <span class="ag">· ${e(a.nom)}</span>` : ''}</span></div>`;
}

function colonnePlanning(titre: string, agendas: AgendaLu[], maintenant: number): string {
  const plusieurs = agendas.length > 1;
  const trier = <T extends { r: Rdv }>(x: T[]): T[] =>
    x.sort((p, q) => (p.r.journeeEntiere === q.r.journeeEntiere ? (p.r.debut?.getTime() ?? 0) - (q.r.debut?.getTime() ?? 0) : p.r.journeeEntiere ? -1 : 1));
  const jour = trier(agendas.flatMap((a) => a.aujourdhui.map((r) => ({ r, a }))));
  const demain = trier(agendas.flatMap((a) => a.demain.map((r) => ({ r, a }))));
  const erreurs = agendas.filter((a) => a.erreur).map((a) => `<div class="alerte">${e(a.nom)} : ${e(a.erreur)}</div>`).join('');
  const restants = jour.filter((x) => !x.r.passe).length;
  // Les rendez-vous passés ne restent affichés que les jours calmes : sinon ils prennent la
  // place de ce qui arrive (dont demain).
  const visibles = jour.length <= 5 ? jour : jour.filter((x) => !x.r.passe);
  return `<section><h2>${e(titre)} <small>${restants} à venir</small></h2><div class="liste">${erreurs}${
    visibles.map((x) => ligneRdv(x.r, x.a, plusieurs, maintenant)).join('') || '<div class="vide">Rien aujourd’hui</div>'
  }${demain.length ? `<div class="sep">Demain · ${demain.length}</div>${demain.map((x) => ligneRdv(x.r, x.a, plusieurs, maintenant)).join('')}` : ''}</div></section>`;
}

function ligneBon(config: Config, i: Intervention): string {
  const attente = i.statut === 'coordonnees_demandees';
  const classe = i.urgence === 'urgente' ? 'urgente' : attente ? 'attente' : '';
  const lieu = [i.commune || i.adresse, nomSociete(config, i.societe)].filter(Boolean).join(' · ');
  return `<div class="bon ${classe}"><div class="l1"><span>${i.urgence === 'urgente' ? '🚨 ' : ''}${e(i.client_nom || 'Client')}</span><span class="age">${depuis(i.cree_le)}</span></div>
<div class="l2">${e(i.nature || i.resume)}</div><div class="l2">${attente ? '⏳ coordonnées attendues · ' : ''}${e(lieu)}${i.client_telephone ? ` · ${e(i.client_telephone)}` : ''}</div></div>`;
}

/** Taille réglable dans l'adresse (?zoom=1.3) : chaque TV a sa distance de lecture. */
function zoomDe(url: URL): number {
  const z = Number(url.searchParams.get('zoom'));
  return Number.isFinite(z) && z >= 0.5 && z <= 3 ? z : 1;
}

function pageAffichage(titre: string, sousTitre: string, contenu: string, zoom: number, base: string): string {
  const corps = `<header><h1>Groupe <span>CYRNEO</span> · ${e(sousTitre)}</h1><div id="h"></div></header>${contenu}<script>${SCRIPT_ECRAN}</script>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>${e(titre)}</title><style>${STYLE_ECRAN}html{font-size:calc(${base} * ${zoom})}</style></head><body>${corps}</body></html>`;
}

async function chargerBons(): Promise<{ bons: Intervention[]; erreur: string }> {
  try {
    const inters = await interventionsOuvertes();
    // Rappel : tout ce qui n'est pas encore planifié, urgences d'abord, puis le plus ancien.
    const bons = inters
      .filter((i) => i.statut === 'a_planifier' || i.statut === 'coordonnees_demandees')
      .sort((a, b) => (a.urgence === b.urgence ? a.cree_le.localeCompare(b.cree_le) : a.urgence === 'urgente' ? -1 : 1));
    return { bons, erreur: '' };
  } catch (err) {
    console.error('[ecran]', err instanceof Error ? err.message : err);
    return { bons: [], erreur: 'Bons indisponibles pour le moment' };
  }
}

async function colonnesPlanning(config: Config): Promise<string[]> {
  const agendas = await lireAgendas(config);
  const maintenant = Date.now();
  return config.ecran.colonnes.map((c) =>
    colonnePlanning(c.titre, c.agendas.map((env) => agendas.find((a) => a.env === env)).filter((a): a is AgendaLu => !!a), maintenant)
  );
}

/** Écran mixte : plannings + bons à traiter (premier format). */
async function pageEcran(config: Config, url: URL): Promise<string> {
  const [colonnes, { bons, erreur }] = await Promise.all([colonnesPlanning(config), chargerBons()]);
  const enRetard = bons.filter((i) => Date.now() - new Date(i.cree_le).getTime() > 24 * 3_600_000).length;
  const contenu = `<main style="--cols:${colonnes.length}">${colonnes.join('')}
<section><h2>Bons à traiter <small>${bons.length}${enRetard ? ` · <span id="retards">${enRetard} depuis + 24 h</span>` : ''}</small></h2><div class="liste">${
    erreur ? `<div class="alerte">${e(erreur)}</div>` : bons.map((i) => ligneBon(config, i)).join('') || '<div class="vide">Tout est planifié 👍</div>'
  }</div></section></main>`;
  return pageAffichage('Planning CYRNEO', 'Planning', contenu, zoomDe(url), 'clamp(13px,1.12vw,30px)');
}

/** Écran des équipes : uniquement les plannings, en grand. */
async function pageEquipes(config: Config, url: URL): Promise<string> {
  const colonnes = await colonnesPlanning(config);
  const contenu = `<main class="equipes" style="--cols:${colonnes.length}">${colonnes.join('')}</main>`;
  return pageAffichage('Planning équipes', 'Planning des équipes', contenu, zoomDe(url), 'clamp(16px,1.45vw,40px)');
}

function ficheBon(config: Config, i: Intervention): string {
  const attente = i.statut === 'coordonnees_demandees';
  const classe = i.urgence === 'urgente' ? 'urgente' : attente ? 'attente' : '';
  const lieu = [i.adresse, i.commune].filter(Boolean).join(', ');
  return `<div class="fiche ${classe}"><div class="l1"><span>${i.urgence === 'urgente' ? '🚨 ' : ''}${e(i.client_nom || 'Client')}</span><span class="age">${depuis(i.cree_le)}</span></div>
<div class="nat">${e(i.nature || i.resume)}</div>
${lieu ? `<div class="l2">📍 ${e(lieu)}</div>` : ''}
<div class="l2">${i.client_telephone ? `📞 ${e(i.client_telephone)} · ` : ''}${e(nomSociete(config, i.societe))} · ${e(i.reference)}${i.dolibarr_ref ? ` · ${e(i.dolibarr_ref)}` : ''}</div>
${attente ? '<div class="etat">⏳ coordonnées demandées au client</div>' : i.date_souhaitee ? `<div class="etat">📅 souhaité : ${e(i.date_souhaitee)}</div>` : ''}</div>`;
}

/** Écran du bureau : les interventions à prévoir, en grandes fiches, avec les compteurs. */
async function pageBureau(config: Config, url: URL): Promise<string> {
  const { bons, erreur } = await chargerBons();
  const maintenant = Date.now();
  const urgentes = bons.filter((i) => i.urgence === 'urgente').length;
  const attente = bons.filter((i) => i.statut === 'coordonnees_demandees').length;
  const retard = bons.filter((i) => maintenant - new Date(i.cree_le).getTime() > 24 * 3_600_000).length;
  const compteur = (n: number, libelle: string, classe = '') => `<div class="compteur ${n && classe ? classe : ''}"><b>${n}</b><span>${libelle}</span></div>`;
  const contenu = `<div class="compteurs">${compteur(bons.length, 'à prévoir')}${compteur(urgentes, 'urgentes', 'rouge')}${compteur(retard, 'depuis + 24 h', 'rouge')}${compteur(attente, 'attendent le client', 'orange')}</div>
<main class="bureau"><div class="liste grille">${
    erreur ? `<div class="alerte">${e(erreur)}</div>` : bons.map((i) => ficheBon(config, i)).join('') || '<div class="vide">Tout est planifié 👍</div>'
  }</div></main>`;
  return pageAffichage('Bureau CYRNEO', 'Interventions à prévoir', contenu, zoomDe(url), 'clamp(15px,1.3vw,36px)');
}

function nav(): string {
  return '<div class="barre"><h1>Secrétariat CYRNEO</h1><div class="nav"><a href="/equipes">Écran équipes</a><a href="/bureau">Écran bureau</a><a href="/interventions">Interventions</a><a href="/journal">Journal</a></div></div>';
}

async function pageInterventions(config: Config): Promise<string> {
  const inters = await interventionsOuvertes();
  const options = (actuel: string) =>
    (Object.keys(STATUTS) as StatutIntervention[]).map((s) => `<option value="${s}" ${s === actuel ? 'selected' : ''}>${STATUTS[s]}</option>`).join('');
  const lignes = inters
    .map((i) => {
      const prevue = i.date_prevue ? heureParisPourChamp(new Date(i.date_prevue)) : '';
      return `<tr><td>${i.urgence === 'urgente' ? '🚨 ' : ''}${e(i.reference)}<br><span class="vide">${e(fmtComplet.format(new Date(i.cree_le)))}</span></td>
<td>${e(nomSociete(config, i.societe))}</td><td>${e(i.client_nom)}<br>${e(i.client_telephone)}<br><span class="vide">${e(i.client_email)}</span></td>
<td>${e([i.adresse, i.commune].filter(Boolean).join(', '))}</td><td>${e(i.nature)}<br><span class="vide">${e(i.resume)}</span></td>
<td><form method="post" action="/interventions/${i.id}"><select name="statut">${options(i.statut)}</select><br>
<input type="datetime-local" name="date_prevue" value="${prevue}"><br><input name="intervenant" placeholder="Intervenant" value="${e(i.intervenant ?? '')}"><br>
<button>Enregistrer</button></form></td></tr>`;
    })
    .join('');
  const societes = config.societes.map((x) => `<option value="${e(x.id)}">${e(x.nom)}</option>`).join('');
  const formulaire = `<details class="carte" style="margin:1.2rem 1.5rem 0"><summary style="cursor:pointer;font-weight:600">➕ Nouvelle demande (appel, passage au bureau…)</summary>
<form method="post" action="/interventions/nouvelle" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.6rem;margin-top:.8rem">
<select name="societe">${societes}</select><select name="type"><option value="intervention">Intervention</option><option value="devis">Devis</option></select>
<select name="urgence"><option value="normale">Normale</option><option value="urgente">Urgente</option></select>
<input name="client_nom" placeholder="Client *" required><input name="client_telephone" placeholder="Téléphone"><input name="client_email" placeholder="Email">
<input name="adresse" placeholder="Adresse"><input name="commune" placeholder="Commune"><input name="date_souhaitee" placeholder="Date souhaitée">
<input name="nature" placeholder="Demande (ex. vidange fosse 3 m³) *" required style="grid-column:1/-1"><button>Créer la demande</button></form></details>`;
  return page(
    'Interventions',
    `${nav()}${formulaire}<div style="padding:1.2rem 1.5rem" class="carte"><table><tr><th>Réf.</th><th>Société</th><th>Client</th><th>Lieu</th><th>Demande</th><th>Suivi</th></tr>${lignes || '<tr><td colspan="6" class="vide">Rien en cours</td></tr>'}</table></div>`
  );
}

async function pageJournal(config: Config, q: string): Promise<string> {
  const lignes = (await chercherJournal(q))
    .map(
      (j) => `<tr><td>${e(fmtComplet.format(new Date(j.recu_le)))}</td><td>${e(j.boite)}</td><td>${e(j.expediteur)}</td><td>${e(j.sujet)}<br><span class="vide">${e(j.resume ?? '')}</span></td>
<td>${e(j.categorie ? LIBELLES_CATEGORIES[j.categorie as Categorie] ?? j.categorie : '')}<br><span class="vide">${e(nomSociete(config, j.societe))}</span></td>
<td>${e(j.statut)}${j.erreur ? `<br><span class="erreur">${e(j.erreur)}</span>` : ''}</td>
<td>${j.actions.map((a) => `${a.ok ? '✓' : '✗'} ${e(a.action)} : ${e(a.detail)}`).join('<br>')}${j.fichiers.length ? `<br>📎 ${j.fichiers.map(e).join('<br>📎 ')}` : ''}</td></tr>`
    )
    .join('');
  return page(
    'Journal',
    `${nav()}<div style="padding:1.2rem 1.5rem"><form><input name="q" value="${e(q)}" placeholder="Nom, sujet, boîte…" size="40"> <button>Chercher</button></form>
<div class="carte" style="margin-top:1rem"><table><tr><th>Reçu</th><th>Boîte</th><th>Expéditeur</th><th>Sujet</th><th>Tri</th><th>Statut</th><th>Ce qui a été fait</th></tr>${lignes || '<tr><td colspan="7" class="vide">Aucun mail</td></tr>'}</table></div></div>`
  );
}

// --- Serveur --------------------------------------------------------------------
function lireCorps(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((ok, ko) => {
    let corps = '';
    req.on('data', (c) => {
      corps += c;
      if (corps.length > 10_000) req.destroy();
    });
    req.on('end', () => ok(new URLSearchParams(corps)));
    req.on('error', ko);
  });
}

/** Saisie de la clé : on la tape une fois par appareil, elle reste ensuite en cookie. */
function pageCle(url: URL): string {
  const erreur = url.searchParams.has('cle') ? '<p class="erreur">Clé incorrecte.</p>' : '';
  return page(
    'Accès',
    `<form method="get" action="${e(url.pathname)}" style="max-width:420px;margin:15vh auto;padding:2rem" class="carte">
<h1 style="margin-bottom:1rem">Secrétariat CYRNEO</h1>${erreur}
<p class="vide">Clé d'accès (une seule fois sur cet appareil)</p>
<input name="cle" type="password" autofocus style="width:100%;margin:.5rem 0 1rem"><button style="width:100%">Entrer</button></form>`
  );
}

/** Traite une requête. Partagé entre le serveur du PC et la fonction Vercel (Cyrnehome). */
export async function gererRequete(req: http.IncomingMessage, res: http.ServerResponse, config: Config, etat: Etat | null, cle: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const envoyer = (code: number, html: string, entetes: Record<string, string> = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...entetes });
    res.end(html);
  };
  try {
    const cookie = /(?:^|;\s*)secretariat=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const autorise = cookie === cle || url.searchParams.get('cle') === cle;
    const entetesCle: Record<string, string> = url.searchParams.get('cle') === cle ? { 'Set-Cookie': `secretariat=${cle}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` } : {};

    const ecrans: Record<string, (c: Config, u: URL) => Promise<string>> = { '/': pageEcran, '/ecran': pageEcran, '/equipes': pageEquipes, '/bureau': pageBureau };
    if (ecrans[url.pathname]) {
      if (!config.serveur.ecranPublic && !autorise) return envoyer(401, pageCle(url));
      return envoyer(200, await ecrans[url.pathname](config, url), entetesCle);
    }
    if (url.pathname === '/etat') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(etat ?? { mode: 'en ligne' }));
      return;
    }
    if (!autorise) return envoyer(401, pageCle(url));

    if (url.pathname === '/interventions' && req.method === 'GET') return envoyer(200, await pageInterventions(config), entetesCle);
    if (url.pathname === '/interventions/nouvelle' && req.method === 'POST') {
      const f = await lireCorps(req);
      const champ = (n: string) => (f.get(n) ?? '').trim().slice(0, 300);
      const societe = config.societes.some((x) => x.id === champ('societe')) ? champ('societe') : config.societes[0].id;
      if (!champ('client_nom') || !champ('nature')) return envoyer(400, page('Erreur', '<p style="padding:2rem">Client et demande sont obligatoires.</p>'));
      const d: NouvelleDemande = {
        type: champ('type') === 'devis' ? 'devis' : 'intervention',
        societe,
        urgence: champ('urgence') === 'urgente' ? 'urgente' : 'normale',
        client_nom: champ('client_nom'),
        client_telephone: champ('client_telephone'),
        client_email: champ('client_email'),
        adresse: champ('adresse'),
        commune: champ('commune'),
        nature: champ('nature'),
        date_souhaitee: champ('date_souhaitee'),
      };
      await creerInterventionManuelle(d);
      res.writeHead(303, { Location: '/interventions' });
      res.end();
      return;
    }
    const m = /^\/interventions\/(\d+)$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      const f = await lireCorps(req);
      const statut = f.get('statut') as StatutIntervention;
      if (!(statut in STATUTS)) return envoyer(400, page('Erreur', 'Statut inconnu'));
      const date = f.get('date_prevue');
      await majIntervention(Number(m[1]), {
        statut,
        // Le champ datetime-local est une heure de Paris, quel que soit le fuseau du serveur.
        date_prevue: date ? new Date(`${date}:00${decalageParis(new Date(`${date}:00Z`))}`).toISOString() : null,
        intervenant: f.get('intervenant')?.trim() || null,
      });
      res.writeHead(303, { Location: '/interventions' });
      res.end();
      return;
    }
    if (url.pathname === '/journal') return envoyer(200, await pageJournal(config, url.searchParams.get('q') ?? ''), entetesCle);
    return envoyer(404, page('Introuvable', '<p style="padding:2rem">Page introuvable.</p>'));
  } catch (err) {
    console.error('[serveur]', err instanceof Error ? err.message : err);
    return envoyer(500, page('Erreur', '<p style="padding:2rem">Erreur interne, voir le journal.</p>'));
  }
}

export function demarrerServeur(config: Config, etat: Etat): http.Server {
  const cle = process.env.SECRETARIAT_CLE || randomUUID();
  if (!process.env.SECRETARIAT_CLE) console.log(`[serveur] SECRETARIAT_CLE absente : clé provisoire ${cle}`);
  const serveur = http.createServer((req, res) => void gererRequete(req, res, config, etat, cle));
  serveur.listen(config.serveur.port, '0.0.0.0', () => {
    console.log(`[serveur] écran d'accueil : http://<ce-PC>:${config.serveur.port}/ecran`);
  });
  return serveur;
}
