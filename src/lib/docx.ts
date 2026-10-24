/**
 * Documents Word (.docx) sans dépendance : un .docx est une archive ZIP. On remplace les champs
 * {{...}} du modèle (contrat type de Cyrneo-app) ou on assemble un document simple (mandat).
 */
import zlib from 'node:zlib';

type Fichier = { nom: string; contenu: Buffer };

function lireZip(buf: Buffer): Fichier[] {
  let fin = buf.length - 22;
  while (fin >= 0 && buf.readUInt32LE(fin) !== 0x06054b50) fin--;
  if (fin < 0) throw new Error('docx illisible');
  const nb = buf.readUInt16LE(fin + 10);
  let pos = buf.readUInt32LE(fin + 16);
  const fichiers: Fichier[] = [];
  for (let i = 0; i < nb; i++) {
    const methode = buf.readUInt16LE(pos + 10);
    const tailleC = buf.readUInt32LE(pos + 20);
    const lgNom = buf.readUInt16LE(pos + 28), lgExtra = buf.readUInt16LE(pos + 30), lgCom = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const nom = buf.toString('utf8', pos + 46, pos + 46 + lgNom);
    const debut = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const brut = buf.subarray(debut, debut + tailleC);
    fichiers.push({ nom, contenu: methode === 8 ? zlib.inflateRawSync(brut) : Buffer.from(brut) });
    pos += 46 + lgNom + lgExtra + lgCom;
  }
  return fichiers;
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function ecrireZip(fichiers: Fichier[]): Buffer {
  const locaux: Buffer[] = [], centraux: Buffer[] = [];
  let decalage = 0;
  for (const f of fichiers) {
    const nom = Buffer.from(f.nom, 'utf8');
    const comp = zlib.deflateRawSync(f.contenu);
    const crc = crc32(f.contenu);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(0, 10); l.writeUInt32LE(crc, 14); l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(f.contenu.length, 22); l.writeUInt16LE(nom.length, 26); l.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.contenu.length, 24);
    c.writeUInt16LE(nom.length, 28); c.writeUInt32LE(decalage, 42);
    locaux.push(l, nom, comp);
    centraux.push(c, nom);
    decalage += 30 + nom.length + comp.length;
  }
  const central = Buffer.concat(centraux);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(fichiers.length, 8); fin.writeUInt16LE(fichiers.length, 10);
  fin.writeUInt32LE(central.length, 12); fin.writeUInt32LE(decalage, 16);
  return Buffer.concat([...locaux, central, fin]);
}

export const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Remplace les champs {{nom}} du modèle ; un champ sans valeur devient une ligne pointillée. */
export function remplirDocx(modele: Buffer, valeurs: Record<string, string>): Buffer {
  return ecrireZip(
    lireZip(modele).map((f) =>
      /^word\/(document|header\d*|footer\d*)\.xml$/.test(f.nom)
        ? { nom: f.nom, contenu: Buffer.from(f.contenu.toString('utf8').replace(/\{\{([a-z_]+)\}\}/g, (_, k: string) => xml(valeurs[k] || '……………………')), 'utf8') }
        : f
    )
  );
}

export type Paragraphe = { texte: string; gras?: boolean; taille?: number; centre?: boolean; couleur?: string };

/** Document Word simple : une suite de paragraphes. */
export function docxSimple(paragraphes: Paragraphe[]): Buffer {
  const corps = paragraphes
    .map((p) => {
      const rpr = `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>${p.gras ? '<w:b/>' : ''}${p.couleur ? `<w:color w:val="${p.couleur}"/>` : ''}<w:sz w:val="${(p.taille ?? 10) * 2}"/></w:rPr>`;
      const lignes = p.texte.split('\n').map((t, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(t)}</w:t>`).join('');
      return `<w:p><w:pPr><w:spacing w:after="120"/>${p.centre ? '<w:jc w:val="center"/>' : ''}</w:pPr><w:r>${rpr}${lignes}</w:r></w:p>`;
    })
    .join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${corps}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return ecrireZip([
    { nom: '[Content_Types].xml', contenu: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { nom: '_rels/.rels', contenu: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { nom: 'word/document.xml', contenu: Buffer.from(doc, 'utf8') },
  ]);
}
