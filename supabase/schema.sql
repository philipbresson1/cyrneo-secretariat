-- schema.sql — tables du secrétariat, dans le projet Supabase de Jarvis

-- Historique complet : une ligne par mail lu, quoi qu'il en soit advenu.
create table secretariat_journal (
  id bigint generated always as identity primary key,
  boite text not null,
  message_id text not null,
  recu_le timestamptz not null,
  expediteur text not null,
  expediteur_adresse text not null,
  sujet text not null,
  categorie text,
  societe text,
  urgence text,
  resume text,
  actions jsonb not null default '[]',   -- [{action, detail, ok, simulee}]
  statut text not null check (statut in ('traite', 'rien_a_faire', 'simulation', 'erreur')),
  erreur text,
  intervention_id bigint,
  fichiers text[] not null default '{}', -- pièces jointes classées sur le PC
  traite_le timestamptz not null default now(),
  unique (boite, message_id)
);
create index idx_journal_recu on secretariat_journal (recu_le desc);
create index idx_journal_expediteur on secretariat_journal (expediteur_adresse);

-- Demandes d'intervention et de devis, de la réception du mail à la réalisation.
create table interventions (
  id bigint generated always as identity primary key,
  reference text unique,
  type text not null check (type in ('intervention', 'devis', 'reclamation')),
  societe text not null,
  statut text not null check (statut in ('coordonnees_demandees', 'a_planifier', 'planifiee', 'realisee', 'annulee')),
  urgence text not null default 'normale' check (urgence in ('urgente', 'normale')),
  client_nom text not null default '',
  client_telephone text not null default '',
  client_email text not null default '',
  adresse text not null default '',
  commune text not null default '',
  nature text not null default '',
  date_souhaitee text not null default '',
  resume text not null default '',
  boite text not null,
  mail_message_id text not null,
  relance_message_id text,              -- Message-ID de notre demande de coordonnées
  date_prevue timestamptz,
  intervenant text,
  notes text,
  dolibarr_ref text,                    -- lot 2 : bon d'intervention Dolibarr
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now()
);
create index idx_interventions_statut on interventions (statut, societe);
create index idx_interventions_relance on interventions (relance_message_id);

-- Mails envoyés par le secrétariat (anti-boucle, traçabilité).
create table secretariat_envois (
  id bigint generated always as identity primary key,
  journal_id bigint references secretariat_journal (id),
  type text not null check (type in ('accuse_intervention', 'accuse_devis', 'demande_coordonnees', 'transfert', 'alerte', 'rapport', 'rappel_rdv')),
  destinataire text not null,
  sujet text not null,
  message_id text,
  simulation boolean not null default false,
  cle text,                             -- rappel de rendez-vous : identifiant iCal + date
  envoye_le timestamptz not null default now()
);
create index idx_envois_destinataire on secretariat_envois (destinataire, envoye_le desc);

-- Dernier mail lu par boîte (UID IMAP), pour reprendre là où on s'est arrêté.
create table secretariat_curseurs (
  boite text primary key,
  uid_validity text not null,
  dernier_uid bigint not null,
  maj_le timestamptz not null default now()
);

alter table secretariat_journal enable row level security;
alter table interventions enable row level security;
alter table secretariat_envois enable row level security;
alter table secretariat_curseurs enable row level security;

-- Lecture depuis le dashboard Jarvis (compte de Philip uniquement, comme 0002 de Jarvis) ;
-- écriture par le démon (service-role), sauf le suivi des interventions modifiable depuis le dashboard.
create policy lecture_journal on secretariat_journal for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');
create policy lecture_interventions on interventions for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');
create policy maj_interventions on interventions for update to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com')
  with check ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');
create policy lecture_envois on secretariat_envois for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');

-- Copie de la liste des tiers Dolibarr (commune à toutes les sociétés), resynchronisée chaque semaine.
-- Tiers = résidence, personne ou entreprise, parfois rattachée à un syndic (parent_id).
create table dolibarr_tiers (
  id bigint primary key,
  nom text not null default '',
  alias text not null default '',
  code_client text not null default '',
  adresse text not null default '',
  cp text not null default '',
  ville text not null default '',
  telephone text not null default '',
  email text not null default '',
  parent_id bigint,
  client smallint not null default 0,
  fournisseur smallint not null default 0,
  actif boolean not null default true,
  note_publique text not null default '',
  note_privee text not null default '',
  brut jsonb not null default '{}',
  vu_le timestamptz not null default now()
);
create index idx_tiers_parent on dolibarr_tiers (parent_id);
create table dolibarr_contacts (
  id bigint primary key,
  tiers_id bigint,
  nom text not null default '',
  email text not null default '',
  telephone text not null default '',
  poste text not null default '',
  brut jsonb not null default '{}',
  vu_le timestamptz not null default now()
);
create index idx_contacts_tiers on dolibarr_contacts (tiers_id);
create table secretariat_synchro (
  nom text primary key,
  fait_le timestamptz not null,
  bilan text not null default ''
);
alter table interventions add column dolibarr_tiers_id bigint;
alter table dolibarr_tiers enable row level security;
alter table dolibarr_contacts enable row level security;
alter table secretariat_synchro enable row level security;
create policy lecture_tiers on dolibarr_tiers for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');
create policy lecture_contacts on dolibarr_contacts for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');

-- Demandes prises au téléphone : notées dans Dolibarr (bon) ou dans une bulle Rainbow.
alter table interventions add column source text not null default 'mail';
alter table interventions add column dolibarr_id bigint;
alter table interventions add column dolibarr_entite int;
create index idx_interventions_dolibarr on interventions (dolibarr_entite, dolibarr_id);
alter table interventions add constraint interventions_source_check check (source in ('mail', 'bureau', 'dolibarr', 'rainbow'));

-- Identifiants des tiers (rapprochement des fournisseurs sur les factures reçues).
alter table dolibarr_tiers add column siret text not null default '';
alter table dolibarr_tiers add column tva_intra text not null default '';
alter table dolibarr_tiers add column code_fournisseur text not null default '';

-- Devis signés dans Dolibarr (écran Travaux : « devis acceptés à planifier »), sans montant.
create table dolibarr_devis_signes (
  entite int not null,
  id bigint not null,
  ref text not null,
  societe text not null,
  tiers_id bigint,
  tiers_nom text not null default '',
  libelle text not null default '',
  signe_le timestamptz,
  vu_le timestamptz not null default now(),
  primary key (entite, id)
);
alter table dolibarr_devis_signes enable row level security;
create policy lecture_devis_signes on dolibarr_devis_signes for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');

-- Surveillance : le démon écrit un signe de vie (secretariat_synchro 'battement') chaque minute ;
-- pg_cron vérifie toutes les 5 min et prévient par ntfy (téléphone + mail) après 15 min de silence.
-- Fonction public.surveiller_secretariat() appliquée par migration (sujet ntfy : voir la base).

-- Copie des bons d'intervention Dolibarr : statut réel des fiches et compteur « reste à facturer ».
create table dolibarr_bons (
  entite int not null,
  id bigint not null,
  ref text not null,
  societe text not null,
  socid bigint,
  tiers_nom text not null default '',
  statut smallint not null,                 -- 0 brouillon, 1 validé, 2 facturé, 3 clôturé
  facturation_demarree boolean not null default false,
  cree_le timestamptz,
  maj_le timestamptz not null default now(),
  primary key (entite, id)
);
create index idx_bons_a_facturer on dolibarr_bons (societe) where statut in (1, 3) and not facturation_demarree;
alter table dolibarr_bons enable row level security;
create policy lecture_bons on dolibarr_bons for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');

-- Contrats d'entretien proposés : vidange de fosse facturée → contrat 2 ans (grille du site),
-- brouillon Dolibarr, fichier Relances contrats envoyé au bureau.
create table contrats_proposes (
  id bigint generated always as identity primary key,
  entite int not null,
  facture_id bigint not null,
  facture_ref text not null,
  facture_le timestamptz,
  tiers_id bigint not null,
  client_nom text not null default '',
  email text not null default '',
  telephone text not null default '',
  adresse text not null default '',
  cp text not null default '',
  ville text not null default '',
  secteur text,
  volume smallint,
  acces_loin boolean not null default false,
  vidange_ttc numeric(10,2),
  mensualite numeric(10,2),
  statut text not null default 'a_completer', -- a_completer, pret, emis, signe, abandonne, ecarte
  lien text,
  note text not null default '',
  dolibarr_contrat_id bigint,               -- contrat Sud Assainissement en brouillon (validé = signé)
  dolibarr_contrat_ref text,
  rum text,
  total_ttc numeric(10,2),
  emis_le timestamptz,
  signe_le timestamptz,
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now(),
  unique (entite, facture_id)
);
create index idx_contrats_tiers on contrats_proposes (entite, tiers_id);
alter table contrats_proposes enable row level security;
create policy lecture_contrats on contrats_proposes for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'philip.bresson1@gmail.com');
