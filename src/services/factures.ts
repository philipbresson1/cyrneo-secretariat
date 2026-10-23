/**
 * Factures fournisseurs reçues par mail → Dolibarr : lecture du PDF par le modèle, fournisseur
 * retrouvé (ou créé s'il est inconnu), facture saisie en brouillon dans la société facturée
 * avec le PDF joint. Rien n'est écrit dans Dolibarr hors du mode réel : en test, on montre
 * seulement ce qui serait fait.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Config, MailRecu, PieceJointe } from '../logique/types';
import { pdfALire } from '../logique/classification';
import { consignesFacture, controlerFacture, resumeFacture, schemaFacture, trouverFournisseur, type FactureLue } from '../logique/facture';
import { creerFactureFournisseur, creerFournisseur, entiteDe, factureFournisseurExiste } from './dolibarr';
import { ajouterTiersLocal, indexTiers } from './tiers';

let anthropic: Anthropic | null = null;

export async function lireFacture(config: Config, pdf: PieceJointe): Promise<FactureLue> {
  anthropic ??= new Anthropic();
  const reponse = await anthropic.messages.create({
    model: config.modele,
    max_tokens: 3000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schemaFacture(config.societes) } },
    system: consignesFacture(config.societes),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', title: pdf.nom, source: { type: 'base64', media_type: 'application/pdf', data: pdf.contenu.toString('base64') } },
          { type: 'text', text: `Lis la facture « ${pdf.nom} ».` },
        ],
      },
    ],
  });
  const bloc = reponse.content.find((b) => b.type === 'text');
  if (reponse.stop_reason !== 'end_turn' || !bloc || bloc.type !== 'text') throw new Error('Lecture de la facture impossible');
  return JSON.parse(bloc.text) as FactureLue;
}

/** Saisit les factures jointes au mail. Renvoie les lignes à poster dans la bulle admin. */
export async function saisirFactures(config: Config, mail: MailRecu): Promise<string[]> {
  const ecrire = config.mode === 'reel' && config.dolibarr.actif;
  const lignes: string[] = [];
  for (const pdf of pdfALire(mail)) {
    try {
      const f = await lireFacture(config, pdf);
      if (!f.estFactureFournisseur) continue; // CGV, devis, relevé… : rien à saisir
      const resume = resumeFacture(f, config.societes);
      const raison = controlerFacture(f, config.societes);
      if (raison) {
        lignes.push(`⚠️ ${resume}\n   À saisir à la main : ${raison}`);
        continue;
      }
      const entite = entiteDe(config, f.societe);
      const connu = trouverFournisseur(await indexTiers(), f.fournisseur, mail.deAdresse);
      if (!ecrire) {
        lignes.push(`🧪 ${resume}\n   Serait saisie en brouillon · fournisseur ${connu ? `existant : ${connu.nom}` : 'à créer'}`);
        continue;
      }
      let socid = connu?.id ?? 0;
      if (!connu) {
        socid = await creerFournisseur(config, entite, f.fournisseur);
        await ajouterTiersLocal({
          id: socid, nom: f.fournisseur.nom, alias: '', code_client: '', code_fournisseur: '', siret: f.fournisseur.siret.replace(/\s/g, ''),
          tva_intra: f.fournisseur.tvaIntra.replace(/\s/g, '').toUpperCase(), adresse: f.fournisseur.adresse, cp: f.fournisseur.cp, ville: f.fournisseur.ville,
          telephone: f.fournisseur.telephone, email: f.fournisseur.email.toLowerCase(), parent_id: null, client: 0, fournisseur: 1, actif: true, note_publique: '', note_privee: '',
        });
      }
      const deja = await factureFournisseurExiste(config, entite, socid, f.numero);
      if (deja) {
        lignes.push(`ℹ️ ${resume}\n   Déjà saisie dans Dolibarr (${deja})`);
        continue;
      }
      const facture = await creerFactureFournisseur(config, entite, socid, f, pdf);
      lignes.push(
        `🧾 ${resume}\n   Saisie en brouillon ${facture.ref}${connu ? '' : ' · fournisseur créé'}\n   ${config.dolibarr.url}/fourn/facture/card.php?facid=${facture.id}`
      );
    } catch (e) {
      lignes.push(`⚠️ ${pdf.nom} : à saisir à la main (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return lignes;
}
