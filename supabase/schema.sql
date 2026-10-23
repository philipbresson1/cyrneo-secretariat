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
  type text not null check (type in ('accuse_intervention', 'accuse_devis', 'demande_coordonnees', 'transfert', 'alerte', 'rapport')),
  destinataire text not null,
  sujet text not null,
  message_id text,
  simulation boolean not null default false,
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
