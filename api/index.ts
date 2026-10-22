/**
 * Cyrnehome — l'écran d'accueil et le suivi du secrétariat, en ligne sur Vercel.
 * Mêmes pages que le serveur du PC, mais tout est protégé par la clé, écran compris :
 * le site est sur internet, pas seulement sur le réseau du bureau.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import exemple from '../config.exemple.json';
import { validerConfig } from '../src/logique/config';
import { gererRequete } from '../src/services/serveur';

const config = validerConfig(exemple);
config.serveur.ecranPublic = false;

export default async function cyrnehome(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cle = process.env.SECRETARIAT_CLE;
  if (!cle) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Cyrnehome : variable SECRETARIAT_CLE absente sur Vercel.');
    return;
  }
  await gererRequete(req, res, config, null, cle);
}
