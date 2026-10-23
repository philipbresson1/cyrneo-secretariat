/**
 * Publication dans les bulles Rainbow (Alcatel-Lucent Enterprise).
 *
 * Il faut un compte Rainbow dédié au secrétariat (membre de toutes les bulles) et une
 * application déclarée sur https://developers.openrainbow.com (appID / appSecret).
 * Variables .env.local : RAINBOW_LOGIN, RAINBOW_MOTDEPASSE, RAINBOW_APP_ID,
 * RAINBOW_APP_SECRET, et RAINBOW_HOTE (official par défaut, sandbox pour les essais).
 */

type Bulle = { id: string; jid: string; name: string };
type SdkRainbow = {
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  events: { on: (evt: string, cb: (...args: unknown[]) => void) => void };
  bubbles: { getAll: () => Bulle[] };
  im: { sendMessageToBubbleJid: (message: string, jid: string, lang?: string) => Promise<unknown> };
  connectedUser?: { jid_im?: string };
};

/** Message écrit par une personne dans une bulle. */
/** remplace : id du message d'origine quand c'est une modification (ex. n° de BI ajouté). */
export type MessageBulle = { id: string; bulle: string; auteur: string; texte: string; remplace?: string };

type MessageSdk = { id?: string; type?: string; content?: string; fromJid?: string; fromBubbleJid?: string; from?: { displayName?: string }; originalMessageReplaced?: { id?: string } | null };

let ecouteur: ((m: MessageBulle) => void) | null = null;

let sdk: SdkRainbow | null = null;
let pret: Promise<void> | null = null;

function normaliser(nom: string): string {
  return nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Les erreurs du SDK sont des objets volumineux : on n'en garde que la cause utile. */
export function raisonRainbow(e: unknown): string {
  const x = (e ?? {}) as { code?: number; details?: string; error?: { errorDetailsCode?: number; errorDetails?: string } };
  const code = x.error?.errorDetailsCode;
  if (code === 401700) return "l'application n'est pas en production sur ce serveur (developers.openrainbow.com > Applications > Déployer), ou RAINBOW_HOTE ne correspond pas";
  if (x.code === 401) return `identifiant, mot de passe ou clés d'application refusés (${x.error?.errorDetails ?? x.details ?? '401'})`;
  return x.error?.errorDetails ?? x.details ?? (e instanceof Error ? e.message : 'erreur inconnue');
}

async function demarrer(): Promise<SdkRainbow> {
  const { RAINBOW_LOGIN, RAINBOW_MOTDEPASSE, RAINBOW_APP_ID, RAINBOW_APP_SECRET } = process.env;
  if (!RAINBOW_LOGIN || !RAINBOW_MOTDEPASSE || !RAINBOW_APP_ID || !RAINBOW_APP_SECRET) {
    throw new Error('Rainbow non configuré (RAINBOW_LOGIN, RAINBOW_MOTDEPASSE, RAINBOW_APP_ID, RAINBOW_APP_SECRET dans .env.local)');
  }
  // Import tardif : le SDK est lourd et inutile en mode simulation.
  const sdkModule = (await import('rainbow-node-sdk')) as unknown as { default?: unknown; NodeSDK?: unknown };
  const NodeSDK = (sdkModule.NodeSDK ?? sdkModule.default) as new (options: unknown) => SdkRainbow;
  const instance = new NodeSDK({
    rainbow: { host: process.env.RAINBOW_HOTE || 'official' },
    credentials: { login: RAINBOW_LOGIN, password: RAINBOW_MOTDEPASSE },
    application: { appID: RAINBOW_APP_ID, appSecret: RAINBOW_APP_SECRET },
    logs: { enableConsoleLogs: false, enableFileLogs: false, level: 'error' },
    im: { sendReadReceipt: false },
  });
  instance.events.on('rainbow_onmessagereceived', (...args: unknown[]) => {
    const m = args[0] as MessageSdk;
    if (!ecouteur || m.type !== 'groupchat' || !m.fromBubbleJid || !m.content?.trim()) return;
    if (m.fromJid && m.fromJid === instance.connectedUser?.jid_im) return; // nos propres messages
    const bulle = instance.bubbles.getAll().find((b) => b.jid === m.fromBubbleJid);
    if (!bulle) return;
    ecouteur({ id: m.id ?? `${m.fromBubbleJid}-${Date.now()}`, bulle: bulle.name, auteur: m.from?.displayName ?? '', texte: m.content.trim(), remplace: m.originalMessageReplaced?.id || undefined });
  });
  instance.events.on('rainbow_onerror', () => {
    console.error('[rainbow] erreur de connexion, reconnexion au prochain message');
    sdk = null;
    pret = null;
  });
  instance.events.on('rainbow_onstopped', () => {
    sdk = null;
    pret = null;
  });
  try {
    await instance.start();
  } catch (e) {
    throw new Error(`Connexion Rainbow refusée : ${raisonRainbow(e)}`);
  }
  return instance;
}

async function connecte(): Promise<SdkRainbow> {
  if (sdk) return sdk;
  pret ??= demarrer().then((s) => {
    sdk = s;
  });
  try {
    await pret;
  } catch (e) {
    pret = null;
    throw e;
  }
  return sdk!;
}

export async function listerBulles(): Promise<string[]> {
  const s = await connecte();
  return s.bubbles.getAll().map((b) => b.name);
}

export async function publier(nomBulle: string, texte: string): Promise<void> {
  const s = await connecte();
  const cible = normaliser(nomBulle);
  const bulle = s.bubbles.getAll().find((b) => normaliser(b.name) === cible);
  if (!bulle) {
    const noms = s.bubbles.getAll().map((b) => `« ${b.name} »`).join(', ');
    throw new Error(`Bulle Rainbow « ${nomBulle} » introuvable. Bulles visibles : ${noms || 'aucune'}`);
  }
  await s.im.sendMessageToBubbleJid(texte, bulle.jid, 'fr');
}

/** Écoute les messages des bulles (connexion ouverte et gardée). */
export async function ecouterBulles(cb: (m: MessageBulle) => void): Promise<void> {
  ecouteur = cb;
  await connecte();
}

/** Normalisation des noms de bulles, pour comparer à la config. */
export const memeBulle = (a: string, b: string): boolean => normaliser(a) === normaliser(b);

export async function arreter(): Promise<void> {
  if (sdk) await sdk.stop().catch(() => undefined);
  sdk = null;
  pret = null;
}
