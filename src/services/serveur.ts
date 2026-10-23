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
import { chercherJournal, interventionsOuvertes, majIntervention } from './stockage';

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
type AgendaLu = { nom: string; couleur: string; aujourdhui: Rdv[]; demain: Rdv[]; erreur: string | null };
let cacheAgendas: { lu: number; agendas: AgendaLu[] } | null = null;

async function lireAgendas(config: Config): Promise<AgendaLu[]> {
  if (cacheAgendas && Date.now() - cacheAgendas.lu < 5 * 60_000) return cacheAgendas.agendas;
  const maintenant = new Date();
  const demain = new Date(maintenant.getTime() + 86_400_000);
  const agendas = await Promise.all(
    config.agendas.map(async (a): Promise<AgendaLu> => {
      const url = process.env[a.icsEnv];
      if (!url) return { nom: a.nom, couleur: a.couleur, aujourdhui: [], demain: [], erreur: `variable ${a.icsEnv} absente` };
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ics = await r.text();
        return { nom: a.nom, couleur: a.couleur, aujourdhui: rdvDuJour(ics, maintenant), demain: rdvDuJour(ics, demain).map((x) => ({ ...x, passe: false })), erreur: null };
      } catch {
        // Jamais l'URL dans le message : elle donne un accès permanent à l'agenda.
        return { nom: a.nom, couleur: a.couleur, aujourdhui: [], demain: [], erreur: 'agenda injoignable' };
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

function carteInter(config: Config, i: Intervention): string {
  const classe = i.urgence === 'urgente' ? 'urgente' : i.statut === 'coordonnees_demandees' ? 'attente' : '';
  const lieu = [i.adresse, i.commune].filter(Boolean).join(', ');
  const quand = i.date_prevue ? `${fmtJour.format(new Date(i.date_prevue))} ${fmtHeure.format(new Date(i.date_prevue))}` : i.date_souhaitee ? `souhaité : ${i.date_souhaitee}` : '';
  return `<div class="inter ${classe}"><div class="haut"><span>${i.urgence === 'urgente' ? '🚨 ' : ''}${e(i.client_nom || 'Client')} — ${e(i.nature || i.resume)}</span><span>${e(quand)}</span></div>
<div class="bas"><span class="etiquette">${e(nomSociete(config, i.societe))}</span><span class="etiquette">${e(STATUTS[i.statut])}</span>${e(lieu)}${i.intervenant ? ` · 👷 ${e(i.intervenant)}` : ''} · ${e(i.reference)}${i.dolibarr_ref ? ` · Dolibarr ${e(i.dolibarr_ref)}` : ''}</div></div>`;
}

function listeRdv(rdvs: Rdv[]): string {
  if (rdvs.length === 0) return '<div class="vide">Rien de prévu</div>';
  return rdvs
    .map((r) => `<div class="rdv ${r.passe ? 'passe' : ''}"><span class="h">${r.journeeEntiere ? 'Journée' : r.debut ? fmtHeure.format(r.debut) : ''}</span><span>${e(r.titre)}${r.lieu ? ` <span class="vide">· ${e(r.lieu)}</span>` : ''}</span></div>`)
    .join('');
}

async function pageEcran(config: Config): Promise<string> {
  // Base injoignable ou pas encore configurée : l'écran garde au moins les agendas.
  let erreurBase = '';
  const [inters, agendas] = await Promise.all([
    interventionsOuvertes().catch((e: unknown) => {
      console.error('[ecran]', e instanceof Error ? e.message : e);
      erreurBase = 'Interventions indisponibles pour le moment';
      return [] as Intervention[];
    }),
    lireAgendas(config),
  ]);
  const aPlanifier = inters.filter((i) => i.statut === 'a_planifier' || i.statut === 'coordonnees_demandees');
  const planifiees = inters.filter((i) => i.statut === 'planifiee').sort((a, b) => (a.date_prevue ?? '').localeCompare(b.date_prevue ?? ''));
  const blocAgendas = agendas
    .map((a) => `<div class="agenda"><h3><span class="pastille" style="background:${e(a.couleur)}"></span>${e(a.nom)}</h3>${a.erreur ? `<div class="erreur">${e(a.erreur)}</div>` : `${listeRdv(a.aujourdhui)}<div class="vide" style="margin-top:.4rem">Demain</div>${listeRdv(a.demain)}`}</div>`)
    .join('');
  const corps = `<div class="barre"><h1>Groupe CYRNEO · Planning</h1><div class="horloge" id="h"></div></div>
<div class="grille"><div>
${erreurBase ? `<div class="carte erreur" style="margin-bottom:1.2rem">${e(erreurBase)}</div>` : ''}<div class="carte"><h2>À planifier (${aPlanifier.length})</h2>${aPlanifier.map((i) => carteInter(config, i)).join('') || '<div class="vide">Tout est planifié 👍</div>'}</div>
<div class="carte" style="margin-top:1.2rem"><h2>Interventions planifiées (${planifiees.length})</h2>${planifiees.map((i) => carteInter(config, i)).join('') || '<div class="vide">Aucune</div>'}</div>
</div><div class="carte"><h2>Agendas du jour</h2>${blocAgendas || '<div class="vide">Aucun agenda configuré</div>'}</div></div>
<script>const h=document.getElementById('h');const t=()=>h.textContent=new Date().toLocaleString('fr-FR',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});t();setInterval(t,15000)</script>`;
  return page('Planning CYRNEO', corps, 60);
}

function nav(): string {
  return '<div class="barre"><h1>Secrétariat CYRNEO</h1><div class="nav"><a href="/ecran">Écran</a><a href="/interventions">Interventions</a><a href="/journal">Journal</a></div></div>';
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
  return page(
    'Interventions',
    `${nav()}<div style="padding:1.2rem 1.5rem" class="carte"><table><tr><th>Réf.</th><th>Société</th><th>Client</th><th>Lieu</th><th>Demande</th><th>Suivi</th></tr>${lignes || '<tr><td colspan="6" class="vide">Rien en cours</td></tr>'}</table></div>`
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

    if (url.pathname === '/' || url.pathname === '/ecran') {
      if (!config.serveur.ecranPublic && !autorise) return envoyer(401, pageCle(url));
      return envoyer(200, await pageEcran(config), entetesCle);
    }
    if (url.pathname === '/etat') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(etat ?? { mode: 'en ligne' }));
      return;
    }
    if (!autorise) return envoyer(401, pageCle(url));

    if (url.pathname === '/interventions' && req.method === 'GET') return envoyer(200, await pageInterventions(config), entetesCle);
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
