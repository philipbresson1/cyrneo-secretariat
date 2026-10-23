import { describe, expect, it } from 'vitest';
import { choisirTelephone, formaterTelephone, normaliserTelephone, trouverTelephones } from './telephone';
import { raisonDeNePasRepondre } from './garde-fous';
import { lireClassification } from './classification';
import { decider, type Contexte } from './decision';
import { accuseIntervention, demandeCoordonnees, messageRainbow, referenceIntervention } from './modeles';
import { validerConfig } from './config';
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
    expect(actions).toEqual([{ type: 'classer_pieces_jointes' }, { type: 'transferer', vers: ['compta@exemple.fr'] }]);
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

  it('publicité : rien à faire', () => {
    expect(decider(mail(), classification({ categorie: 'publicite' }), ctx())).toEqual([]);
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

describe('config', () => {
  it("l'exemple est valide et démarre en simulation", () => {
    expect(config.mode).toBe('simulation');
  });
  it('donne le numéro du groupe aux sociétés sans téléphone', () => {
    expect(config.societes.find((s) => s.id === 'sud-travaux')!.telephone).toBe('04 95 23 02 84');
  });
  it('signale une société par défaut inconnue', () => {
    expect(() => validerConfig({ ...exemple, boites: [{ ...exemple.boites[0], societeParDefaut: 'x' }] })).toThrow(/societeParDefaut/);
  });
});
