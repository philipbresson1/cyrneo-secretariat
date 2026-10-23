import { describe, expect, it } from 'vitest';
import { choisirTelephone, formaterTelephone, normaliserTelephone, trouverTelephones } from './telephone';
import { raisonDeNePasRepondre } from './garde-fous';
import { lireClassification, pdfALire } from './classification';
import { choisirBulle, decider, type Contexte } from './decision';
import { accuseIntervention, coordonneesManquantes, demandeCoordonnees, estProfessionnel, messageRainbow, referenceIntervention } from './modeles';
import { appliquerEnv, validerConfig } from './config';
import { horsHeuresOuvrees, joursFeries, paques } from './horaires';
import type { Classification, Config, Intervention, MailRecu } from './types';
import exemple from '../../config.exemple.json';

const config: Config = validerConfig(exemple);

function mail(partiel: Partial<MailRecu> = {}): MailRecu {
  return {
    boite: 'sud-assainissement',
    uid: 1,
    messageId: '<a@b>',
    inReplyTo: null,
    references: [],
    deAdresse: 'jean.martin@orange.fr',
    deNom: 'Jean Martin',
    repondreA: 'jean.martin@orange.fr',
    sujet: 'Fosse pleine',
    recuLe: new Date('2026-10-22T08:00:00Z'),
    texte: 'Bonjour, ma fosse déborde, pouvez-vous passer ? Je suis au 06 12 34 56 78. 12 route de la mer, Porticcio.',
    entetes: { autoSubmitted: null, precedence: null, listId: null, autoResponseSuppress: null },
    piecesJointes: [],
    ...partiel,
  };
}

function classification(partiel: Partial<Classification> = {}): Classification {
  return {
    categorie: 'demande_intervention',
    societe: 'sud-assainissement',
    urgence: 'urgente',
    resume: 'Fosse qui déborde à Porticcio',
    nature: 'vidange fosse',
    dateSouhaitee: '',
    inspectionCamera: false,
    contact: { nom: 'Jean Martin', telephone: '06 12 34 56 78', email: 'jean.martin@orange.fr', adresse: '12 route de la mer', commune: 'Porticcio' },
    ...partiel,
  };
}

function ctx(partiel: Partial<Contexte> = {}): Contexte {
  return { config, raisonPasDeReponse: null, dejaRepondu: false, interventionLiee: null, ...partiel };
}

describe('téléphone', () => {
  it('normalise les formats courants', () => {
    expect(normaliserTelephone('06.12.34.56.78')).toBe('0612345678');
    expect(normaliserTelephone('+33 6 12 34 56 78')).toBe('0612345678');
    expect(normaliserTelephone('+33 (0)6 12 34 56 78')).toBe('0612345678');
    expect(normaliserTelephone('0033612345678')).toBe('0612345678');
    expect(normaliserTelephone('12345')).toBeNull();
    expect(formaterTelephone('0495230284')).toBe('04 95 23 02 84');
  });

  it('ignore les numéros du groupe recopiés dans le mail', () => {
    expect(trouverTelephones('Appelez le 04 95 23 02 84 ou moi au 0611223344', ['04 95 23 02 84'])).toEqual(['0611223344']);
  });

  it("n'accepte pas un numéro proposé par le modèle absent du mail", () => {
    expect(choisirTelephone('06 99 99 99 99', 'rien ici', [])).toBe('');
    expect(choisirTelephone('0612345678', 'tel 06-12-34-56-78', [])).toBe('06 12 34 56 78');
  });
});

describe('garde-fous', () => {
  it('répond à un client normal', () => {
    expect(raisonDeNePasRepondre(mail(), config.domainesInternes)).toBeNull();
  });
  it('ne répond pas aux robots, listes, répondeurs et collègues', () => {
    expect(raisonDeNePasRepondre(mail({ deAdresse: 'noreply@edf.fr', repondreA: 'noreply@edf.fr' }), [])).toMatch(/automatique/);
    expect(raisonDeNePasRepondre(mail({ entetes: { autoSubmitted: 'auto-replied', precedence: null, listId: null, autoResponseSuppress: null } }), [])).toMatch(/Auto-Submitted/);
    expect(raisonDeNePasRepondre(mail({ entetes: { autoSubmitted: null, precedence: 'bulk', listId: null, autoResponseSuppress: null } }), [])).toMatch(/masse/);
    expect(raisonDeNePasRepondre(mail({ sujet: 'Réponse automatique : absent' }), [])).toMatch(/automatique/);
    expect(raisonDeNePasRepondre(mail({ deAdresse: 'pb@groupecyrneo.com', repondreA: 'pb@groupecyrneo.com' }), config.domainesInternes)).toMatch(/interne/);
    // Une adresse Gmail d'agent du groupe est interne, pas tout gmail.com.
    expect(raisonDeNePasRepondre(mail({ deAdresse: 'agent.ms2a@gmail.com', repondreA: 'agent.ms2a@gmail.com' }), config.domainesInternes)).toMatch(/interne/);
    expect(raisonDeNePasRepondre(mail({ deAdresse: 'client@gmail.com', repondreA: 'client@gmail.com' }), config.domainesInternes)).toBeNull();
  });
});

describe('lecture de la classification', () => {
  it('recoupe le téléphone avec le mail et complète le nom', () => {
    const json = JSON.stringify({ ...classification(), contact: { nom: '', telephone: '0612345678', email: '', adresse: 'x', commune: 'y' } });
    const c = lireClassification(json, mail(), config.societes);
    expect(c.contact.telephone).toBe('06 12 34 56 78');
    expect(c.contact.nom).toBe('Jean Martin');
    expect(c.contact.email).toBe('jean.martin@orange.fr');
  });
  it('remplace une société inconnue par « inconnue »', () => {
    const c = lireClassification(JSON.stringify({ ...classification(), societe: 'pas-a-nous' }), mail(), config.societes);
    expect(c.societe).toBe('inconnue');
  });
  it('lève sur un JSON invalide', () => {
    expect(() => lireClassification('{', mail(), config.societes)).toThrow(/illisible/);
  });
});

describe('PDF transmis au modèle', () => {
  it('garde au plus 3 PDF de 5 Mo, ignore le reste', () => {
    const pj = (nom: string, type: string, taille: number) => ({ nom, type, taille, contenu: Buffer.alloc(1) });
    const m = mail({
      piecesJointes: [
        pj('bon.pdf', 'application/pdf', 1000),
        pj('photo.jpg', 'image/jpeg', 1000),
        pj('scan.PDF', 'application/octet-stream', 1000),
        pj('gros.pdf', 'application/pdf', 9 * 1024 * 1024),
        pj('b.pdf', 'application/pdf', 10),
        pj('c.pdf', 'application/pdf', 10),
      ],
    });
    expect(pdfALire(m).map((p) => p.nom)).toEqual(['bon.pdf', 'scan.PDF', 'b.pdf']);
  });
});

describe('décision', () => {
  it('demande complète : intervention à planifier, accusé, Rainbow', () => {
    const actions = decider(mail(), classification(), ctx());
    expect(actions.map((a) => a.type)).toEqual(['creer_intervention', 'repondre', 'rainbow']);
    expect(actions[0]).toMatchObject({ statut: 'a_planifier' });
    expect(actions[1]).toMatchObject({ modele: 'accuse_intervention' });
  });

  it('sans téléphone : coordonnées demandées au client', () => {
    const c = classification({ contact: { ...classification().contact, telephone: '' } });
    const actions = decider(mail(), c, ctx());
    expect(actions[0]).toMatchObject({ statut: 'coordonnees_demandees' });
    expect(actions[1]).toMatchObject({ modele: 'demande_coordonnees', manquants: ['telephone'] });
  });

  it("expéditeur automatique : on prévient l'équipe sans répondre", () => {
    const actions = decider(mail(), classification(), ctx({ raisonPasDeReponse: 'expéditeur automatique' }));
    expect(actions.map((a) => a.type)).toEqual(['creer_intervention', 'rainbow']);
  });

  it('société inconnue : société par défaut de la boîte', () => {
    const actions = decider(mail({ boite: 'info-cyrneo' }), classification({ societe: 'inconnue' }), ctx());
    expect(actions.find((a) => a.type === 'rainbow')).toMatchObject({ societe: 'cyrneo' });
  });

  it('réponse du client avec les coordonnées : intervention complétée et accusé', () => {
    const liee = { id: 7, type: 'intervention', societe: 'sud-assainissement', client_telephone: '', adresse: '12 route', commune: 'Porticcio', client_nom: 'Jean', client_email: '', nature: 'vidange' } as Intervention;
    const actions = decider(mail(), classification({ categorie: 'complement_coordonnees' }), ctx({ interventionLiee: liee, dejaRepondu: true }));
    expect(actions[0]).toMatchObject({ type: 'completer_intervention', interventionId: 7, statut: 'a_planifier' });
    expect(actions.some((a) => a.type === 'repondre')).toBe(true);
  });

  it('réponse encore incomplète : pas de deuxième relance automatique', () => {
    const liee = { id: 7, type: 'intervention', societe: 'sud-assainissement', client_telephone: '', adresse: '', commune: '', client_nom: '', client_email: '', nature: '' } as Intervention;
    const c = classification({ contact: { nom: '', telephone: '', email: '', adresse: '', commune: '' } });
    const actions = decider(mail(), c, ctx({ interventionLiee: liee }));
    expect(actions.some((a) => a.type === 'repondre')).toBe(false);
  });

  it('facture avec PDF : classement des pièces jointes et transferts configurés', () => {
    const cfg = { ...config, transferts: [{ categories: ['facture_recue' as const], societes: '*' as const, vers: ['Compta@exemple.fr'] }] };
    const m = mail({ piecesJointes: [{ nom: 'f.pdf', type: 'application/pdf', taille: 10, contenu: Buffer.from('') }] });
    const actions = decider(m, classification({ categorie: 'facture_recue' }), ctx({ config: cfg }));
    expect(actions).toEqual([{ type: 'classer_pieces_jointes', dossier: 'factures' }, { type: 'transferer', vers: ['compta@exemple.fr'] }]);
  });

  it('Dolibarr actif : bon créé seulement quand on peut joindre le client', () => {
    const cfg = { ...config, dolibarr: { actif: true, url: 'https://d.fr', entites: { 'sud-assainissement': 2 } } };
    expect(decider(mail(), classification(), ctx({ config: cfg })).map((a) => a.type)).toContain('bon_dolibarr');
    const sansTel = classification({ contact: { ...classification().contact, telephone: '' } });
    expect(decider(mail(), sansTel, ctx({ config: cfg })).map((a) => a.type)).not.toContain('bon_dolibarr');
    // Société sans entité Dolibarr, ou devis : pas de bon.
    expect(decider(mail(), classification({ societe: 'sottec' }), ctx({ config: cfg })).map((a) => a.type)).not.toContain('bon_dolibarr');
    expect(decider(mail(), classification({ categorie: 'demande_devis' }), ctx({ config: cfg })).map((a) => a.type)).not.toContain('bon_dolibarr');
    // Dolibarr inactif (exemple) : jamais de bon.
    expect(decider(mail(), classification(), ctx()).map((a) => a.type)).not.toContain('bon_dolibarr');
  });

  it('Dolibarr : le bon part quand le client complète ses coordonnées', () => {
    const cfg = { ...config, dolibarr: { actif: true, url: 'https://d.fr', entites: { 'sud-assainissement': 2 } } };
    const liee = { id: 7, type: 'intervention', societe: 'sud-assainissement', client_telephone: '', adresse: '12 route', commune: 'Porticcio', client_nom: 'Jean', client_email: '', nature: 'vidange', dolibarr_ref: null } as Intervention;
    expect(decider(mail(), classification(), ctx({ config: cfg, interventionLiee: liee })).map((a) => a.type)).toContain('bon_dolibarr');
  });

  it('réclamation : fiche sur l’écran du bureau, Rainbow, jamais de réponse automatique', () => {
    const actions = decider(mail(), classification({ categorie: 'reclamation' }), ctx());
    expect(actions).toEqual([
      { type: 'creer_intervention', nature: 'reclamation', statut: 'a_planifier' },
      { type: 'rainbow', societe: 'sud-assainissement', gabarit: 'reclamation', suite: 'À traiter.' },
    ]);
    expect(referenceIntervention(5, 'reclamation', 2026)).toBe('REC-2026-0005');
  });

  it('les bulles Rainbow de la config correspondent aux vraies bulles', () => {
    const sa = config.societes.find((x) => x.id === 'sud-assainissement')!;
    expect([sa.bulleRainbow, sa.bulleUrgence]).toEqual(['Intervention SUD ASSAINISSEMENT', 'Urgence assainissement']);
  });

  it('entretien véhicule : pièces jointes au dossier véhicules et bulle entretien', () => {
    const m = mail({ piecesJointes: [{ nom: 'facture-garage.pdf', type: 'application/pdf', taille: 10, contenu: Buffer.from('') }] });
    expect(decider(m, classification({ categorie: 'entretien_vehicule' }), ctx())).toEqual([
      { type: 'classer_pieces_jointes', dossier: 'vehicules' },
      { type: 'rainbow', societe: 'sud-assainissement', gabarit: 'vehicule', suite: '' },
    ]);
    expect(config.bulles.vehicules).toBe('Entretien vehicules cyrneo');
    expect(config.societes.find((x) => x.id === 'sud-assainissement')!.bulleInspection).toBe('ITV Sud assai');
  });

  it('publicité : rien à faire', () => {
    expect(decider(mail(), classification({ categorie: 'publicite' }), ctx())).toEqual([]);
  });
});

describe('professionnel sans téléphone', () => {
  const erilia = classification({ contact: { nom: 'Erilia', telephone: '', email: 'myriam.grimaldi@erilia.fr', adresse: 'Sorbier G2', commune: 'Ajaccio' } });
  it("un bailleur qui donne l'adresse n'a pas à fournir de téléphone", () => {
    expect(estProfessionnel('myriam.grimaldi@erilia.fr')).toBe(true);
    expect(estProfessionnel('jean.martin@orange.fr')).toBe(false);
    expect(coordonneesManquantes(erilia, 'intervention')).toEqual([]);
    expect(decider(mail({ deAdresse: 'myriam.grimaldi@erilia.fr', repondreA: 'myriam.grimaldi@erilia.fr' }), erilia, ctx())[1]).toMatchObject({ modele: 'accuse_intervention' });
  });
  it('un particulier sans téléphone doit toujours le donner', () => {
    const p = classification({ contact: { ...erilia.contact, email: 'jean@gmail.com' } });
    expect(coordonneesManquantes(p, 'intervention')).toEqual(['telephone']);
  });
  it("l'accusé sans téléphone ne promet pas d'appel", () => {
    const s = config.societes.find((x) => x.id === 'sud-assainissement')!;
    const m = accuseIntervention(mail(), erilia, s, 'INT-1');
    expect(m.texte).toContain('Nous revenons vers vous');
    expect(m.texte).not.toContain(' au  ');
  });
});

describe('modèles de messages', () => {
  const s = config.societes.find((x) => x.id === 'sud-assainissement')!;
  it("l'accusé reprend le nom, la référence et le numéro", () => {
    const m = accuseIntervention(mail(), classification(), s, 'INT-2026-0042');
    expect(m.sujet).toBe('Re: Fosse pleine');
    expect(m.texte).toContain('Bonjour Jean Martin,');
    expect(m.texte).toContain('INT-2026-0042');
    expect(m.texte).toContain('06 12 34 56 78');
    expect(m.texte).toContain("c'est urgent");
  });
  it('la demande de coordonnées liste ce qui manque', () => {
    const m = demandeCoordonnees(mail(), classification(), s, ['telephone', 'adresse']);
    expect(m.texte).toContain('deux informations');
    expect(m.texte).toContain('numéro de téléphone');
  });
  it('le message Rainbow signale l’urgence', () => {
    expect(messageRainbow(mail(), classification(), s, 'INT-2026-0001', 'À rappeler.')).toMatch(/^🚨 URGENT/);
    expect(referenceIntervention(42, 'devis', 2026)).toBe('DEV-2026-0042');
  });
});

describe('heures d’astreinte', () => {
  const h = { debut: '08:00', fin: '18:00' };
  it('calcule Pâques et les fériés mobiles', () => {
    expect(paques(2026).toISOString().slice(0, 10)).toBe('2026-04-05');
    expect([...joursFeries(2026)]).toEqual(expect.arrayContaining(['2026-04-06', '2026-05-14', '2026-05-25', '2026-11-11']));
  });
  it('heures ouvrées en semaine, astreinte sinon (heure de Paris)', () => {
    expect(horsHeuresOuvrees(new Date('2026-10-22T08:30:00Z'), h)).toBe(false); // jeudi 10h30
    expect(horsHeuresOuvrees(new Date('2026-10-22T15:59:00Z'), h)).toBe(false); // jeudi 17h59
    expect(horsHeuresOuvrees(new Date('2026-10-22T16:00:00Z'), h)).toBe(true); // jeudi 18h00
    expect(horsHeuresOuvrees(new Date('2026-10-22T05:30:00Z'), h)).toBe(true); // jeudi 7h30
    expect(horsHeuresOuvrees(new Date('2026-10-24T10:00:00Z'), h)).toBe(true); // samedi
    expect(horsHeuresOuvrees(new Date('2026-11-11T10:00:00Z'), h)).toBe(true); // 11 novembre (mercredi)
    expect(horsHeuresOuvrees(new Date('2026-12-15T07:30:00Z'), h)).toBe(false); // mardi 8h30, heure d'hiver
  });
});

describe('choix de la bulle Rainbow', () => {
  // Routage de production : le mode test (celui de l'exemple) renverrait tout vers la bulle de test.
  const reel = { ...config, mode: 'reel' as const };
  const sa = config.societes.find((x) => x.id === 'sud-assainissement')!;
  const ms = config.societes.find((x) => x.id === 'multiservices-2a')!;
  const jeudi10h = new Date('2026-10-22T08:00:00Z');
  const jeudi20h = new Date('2026-10-22T18:00:00Z');
  const m = (p: Partial<Parameters<typeof choisirBulle>[2]>) => ({ gabarit: 'nouvelle' as const, type: 'intervention' as const, inspectionCamera: false, recuLe: jeudi10h, ...p });
  it('journée : bulle de la société', () => expect(choisirBulle(reel, sa, m({}))).toBe('Intervention SUD ASSAINISSEMENT'));
  it('soir : astreinte', () => expect(choisirBulle(reel, sa, m({ recuLe: jeudi20h }))).toBe('Urgence assainissement'));
  it('devis du soir : pas d’astreinte', () => expect(choisirBulle(reel, sa, m({ recuLe: jeudi20h, type: 'devis' }))).toBe('Intervention SUD ASSAINISSEMENT'));
  it('relance du soir : pas d’astreinte', () => expect(choisirBulle(reel, sa, m({ recuLe: jeudi20h, gabarit: 'relance' }))).toBe('Intervention SUD ASSAINISSEMENT'));
  it('inspection caméra en journée : ITV', () => expect(choisirBulle(reel, sa, m({ inspectionCamera: true, type: 'devis' }))).toBe('ITV Sud assai'));
  it('inspection caméra le soir : astreinte d’abord', () => expect(choisirBulle(reel, sa, m({ inspectionCamera: true, recuLe: jeudi20h }))).toBe('Urgence assainissement'));
  it('société sans astreinte : sa bulle même le soir', () => expect(choisirBulle(reel, ms, m({ recuLe: jeudi20h }))).toBe('Ms2A2B'));
  it('véhicules : bulle entretien', () => expect(choisirBulle(reel, ms, m({ gabarit: 'vehicule' }))).toBe('Entretien vehicules cyrneo'));
  it('mode test : toujours la bulle de test', () => expect(choisirBulle({ ...config, mode: 'test' }, sa, m({ recuLe: jeudi20h }))).toBe('Test secrétariat'));
});

describe('config', () => {
  it('le mode et l’adresse de test se règlent dans .env.local', () => {
    const c = validerConfig(appliquerEnv(exemple, { SECRETARIAT_MODE: 'TEST', SECRETARIAT_ADRESSE_TEST: 'moi@exemple.fr' }));
    expect(c.mode).toBe('test');
    expect(c.test).toEqual({ bulleRainbow: 'Test secrétariat', adresse: 'moi@exemple.fr' });
    // Sans adresse de test, le mode test refuse de démarrer plutôt que d'envoyer n'importe où.
    expect(() => validerConfig(appliquerEnv({ ...exemple, test: { ...exemple.test, adresse: '' } }, { SECRETARIAT_MODE: 'test' }))).toThrow(/mode test/);
    expect(() => validerConfig(appliquerEnv({ ...exemple, test: { bulleRainbow: '', adresse: '' } }, { SECRETARIAT_MODE: 'test' }))).toThrow(/mode test/);
  });

  it("l'exemple est valide et tourne en mode test vers pb@groupecyrneo.com", () => {
    expect(config.mode).toBe('test');
    expect(config.test.adresse).toBe('pb@groupecyrneo.com');
  });
  it('donne le numéro du groupe aux sociétés sans téléphone', () => {
    expect(config.societes.find((s) => s.id === 'sud-travaux')!.telephone).toBe('04 95 23 02 84');
  });
  it('signale une société par défaut inconnue', () => {
    expect(() => validerConfig({ ...exemple, boites: [{ ...exemple.boites[0], societeParDefaut: 'x' }] })).toThrow(/societeParDefaut/);
  });
});
