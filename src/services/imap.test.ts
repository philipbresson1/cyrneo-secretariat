import { describe, expect, it } from 'vitest';
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser } from 'mailparser';
import { convertir } from './imap';

async function construire(options: ConstructorParameters<typeof MailComposer>[0]) {
  const brut = await new MailComposer(options).compile().build();
  return convertir(await simpleParser(brut), 'sud-assainissement', 42);
}

describe('conversion d’un mail brut', () => {
  it('extrait expéditeur, réponse, en-têtes anti-boucle et pièces jointes', async () => {
    const m = await construire({
      from: '"Marie Santoni" <marie.santoni@wanadoo.fr>',
      replyTo: 'm.santoni@gmail.com',
      to: 'contact@sud-assainissement-ajaccio.com',
      subject: 'Demande de vidange',
      text: 'Bonjour, je souhaite une vidange. 06 11 22 33 44',
      inReplyTo: '<secretariat-abc@sud-assainissement-ajaccio.com>',
      headers: { 'Auto-Submitted': 'no', Precedence: 'bulk' },
      attachments: [{ filename: 'facture.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }],
    });
    expect(m.deAdresse).toBe('marie.santoni@wanadoo.fr');
    expect(m.deNom).toBe('Marie Santoni');
    expect(m.repondreA).toBe('m.santoni@gmail.com');
    expect(m.inReplyTo).toBe('<secretariat-abc@sud-assainissement-ajaccio.com>');
    expect(m.entetes.autoSubmitted).toBe('no');
    expect(m.entetes.precedence).toBe('bulk');
    expect(m.piecesJointes).toHaveLength(1);
    expect(m.piecesJointes[0].nom).toBe('facture.pdf');
    expect(m.texte).toContain('06 11 22 33 44');
  });

  it('se rabat sur le HTML quand il n’y a pas de texte', async () => {
    const m = await construire({ from: 'a@b.fr', subject: 'x', html: '<p>Bonjour <b>équipe</b></p>' });
    expect(m.texte).toContain('Bonjour');
    expect(m.messageId).toMatch(/^</);
  });
});
