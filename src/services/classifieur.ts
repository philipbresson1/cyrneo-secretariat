/**
 * Appel au modèle pour trier un mail. Un mail par appel : la réponse reste courte et
 * une erreur ne fait perdre que ce mail, qui sera retenté au passage suivant.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Classification, Config, MailRecu } from '../logique/types';
import { consignesSysteme, construireMessage, lireClassification, pdfALire, schemaSortie } from '../logique/classification';

let client: Anthropic | null = null;

export async function classer(mail: MailRecu, config: Config, contexte: string | null): Promise<Classification> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Clé ANTHROPIC_API_KEY manquante (attendue dans .env.local)');
  client ??= new Anthropic();

  const reponse = await client.beta.messages.create({
    model: config.modele,
    max_tokens: 4000,
    // Le tri d'un mail est simple : effort bas, rapide et économique.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schemaSortie(config.societes) } },
    // Si le modèle décline (faux positif de sécurité), l'API bascule d'elle-même sur un autre modèle.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Consignes figées en tête : mises en cache d'un mail à l'autre.
    system: [{ type: 'text', text: consignesSysteme(config.societes), cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          ...pdfALire(mail).map(
            (p): Anthropic.Beta.BetaRequestDocumentBlock => ({
              type: 'document',
              title: p.nom,
              source: { type: 'base64', media_type: 'application/pdf', data: p.contenu.toString('base64') },
            })
          ),
          { type: 'text', text: construireMessage(mail, contexte) },
        ],
      },
    ],
  });

  if (reponse.stop_reason === 'refusal') throw new Error('Le modèle a refusé de traiter ce mail');
  if (reponse.stop_reason === 'max_tokens') throw new Error('Réponse du modèle tronquée');
  const bloc = reponse.content.find((b) => b.type === 'text');
  if (!bloc || bloc.type !== 'text') throw new Error('Réponse du modèle sans texte');
  return lireClassification(bloc.text, mail, config.societes);
}
