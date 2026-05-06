import QRCode from 'qrcode';
import type { ApiClient } from './api-client.js';
import type { EdumapsExport, EdumapsElement, EdumapsColumn } from './edumaps-types.js';

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error(`Unrecognised data URL prefix: ${dataUrl.slice(0, 40)}`);
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

const SUPPORTED_TYPES = ['text', 'file', 'link', 'internalLink', 'collaborativeTextEditor'] as const;

function assertSupportedElementType(el: EdumapsElement, path: string): void {
  if (!(SUPPORTED_TYPES as readonly string[]).includes(el.type)) {
    throw new Error(
      `Unsupported element type "${(el as { type: string }).type}" at ${path}.\n` +
        `Supported types: ${SUPPORTED_TYPES.join(', ')}.`,
    );
  }
}

// QR-Marker (type=qrCode) → inline file-Element mit gerendertem PNG.
// Mutiert die Spalten in-place.
async function renderQrCodesInline(columns: EdumapsColumn[]): Promise<number> {
  let count = 0;
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of card.elements) {
        if ((el as { type: string }).type !== 'qrCode') continue;
        const qr = el as unknown as {
          type: string; content: string; fileName: string; caption: string;
          fileData?: string; fileInfo?: string;
        };
        const buf = await QRCode.toBuffer(qr.content, {
          type: 'png',
          errorCorrectionLevel: 'M',
          scale: 10,
          margin: 4,
        });
        qr.type = 'file';
        qr.fileData = `data:image/png;base64,${buf.toString('base64')}`;
        qr.fileInfo = 'QR-Code, Edumaps';
        (qr as { content: string }).content = qr.caption || '';
        count++;
      }
    }
  }
  return count;
}

export async function runImport(
  data: EdumapsExport,
  roomId: string | undefined,
  client: ApiClient,
  dryRun: boolean,
  options: { importColors?: boolean } = {},
): Promise<{ boardId: string; boardTitle: string; roomId: string }> {
  const importColors = options.importColors === true;
  console.log(`\nBoard: "${data.boardTitle}"`);
  console.log(`  ${data.totalColumns} Spalte(n), ${data.totalCards} Karte(n), ${data.totalElements} Element(e)\n`);

  // QR-Marker zu inline-File-Elementen umrechnen, bevor validiert wird.
  const qrCount = await renderQrCodesInline(data.columns);
  if (qrCount > 0) console.log(`  ${qrCount} QR-Code(s) gerendert.\n`);

  // Pre-validate all element types before touching the API
  for (const [ci, col] of data.columns.entries()) {
    for (const [ki, card] of col.cards.entries()) {
      for (const el of card.elements) {
        assertSupportedElementType(el, `columns[${ci}].cards[${ki}].elements`);
      }
    }
  }

  if (dryRun) {
    console.log('[dry-run] Validierung erfolgreich — keine API-Calls.\n');
    console.log('Geplante Schritte:');
    if (!roomId) console.log(`  POST /rooms  (name="${data.boardTitle}")`);
    console.log(`  POST /boards  (title="${data.boardTitle}")`);
    for (const col of data.columns) {
      console.log(`  POST /boards/{boardId}/columns + PATCH title="${col.title}"`);
      for (const card of col.cards) {
        console.log(`    POST /columns/{columnId}/cards + PATCH title="${card.title}"`);
        for (const el of card.elements) {
          if (el.type === 'text') {
            console.log(`      POST element richText [pos ${el.order}] + PATCH content`);
          } else if (el.type === 'link') {
            console.log(`      POST element link [pos ${el.order}] "${el.url}"`);
          } else if (el.type === 'internalLink') {
            console.log(`      POST element link [pos ${el.order}] (internalLink "${el.title}" → ${el.anchor})`);
          } else if (el.type === 'collaborativeTextEditor') {
            console.log(`      POST element collaborativeTextEditor [pos ${el.order}] "${el.title || 'Teamtext'}"`);
            if (el.originalUrl) {
              console.log(`      POST element link [pos ${el.order + 1}] "Original-Pad: ${el.title || 'Teamtext'}"`);
            }
          } else {
            console.log(`      POST element file [pos ${el.order}] + upload "${el.fileName}" + PATCH caption`);
          }
        }
      }
    }
    return { boardId: 'dry-run', boardTitle: data.boardTitle, roomId: roomId ?? 'dry-run' };
  }

  if (!roomId) {
    process.stdout.write(`[1] Room erstellen...`);
    roomId = await client.createRoom(data.boardTitle);
    console.log(`  ✓ Room erstellt: ${roomId}`);
  }

  console.log(`[2] Board erstellen...`);
  const boardId = await client.createBoard(data.boardTitle, roomId);
  console.log(`    ✓ Board erstellt: ${boardId}\n`);

  for (const [ci, col] of data.columns.entries()) {
    console.log(`[Spalte ${ci + 1}/${data.totalColumns}] "${col.title}"`);
    const columnId = await client.createColumn(boardId);
    await client.renameColumn(columnId, col.title);
    console.log(`    ✓ Spalte erstellt: ${columnId}`);

    for (const [ki, card] of col.cards.entries()) {
      console.log(`  [Karte ${ki + 1}/${col.cards.length}] "${card.title}"`);
      const cardId = await client.createCard(columnId);
      await client.renameCard(cardId, card.title);
      console.log(`      ✓ Karte erstellt: ${cardId}`);

      if (importColors && card.backgroundColor && card.backgroundColor !== 'transparent') {
        await client.setCardColor(cardId, card.backgroundColor);
        console.log(`      ✓ Farbe ${card.backgroundColor}`);
      }

      const sortedElements = [...card.elements].sort((a, b) => a.order - b.order);

      for (const [ei, el] of sortedElements.entries()) {
        if (el.type === 'text') {
          process.stdout.write(`      [Element ${ei + 1}] richText...`);
          const elementId = await client.createElement(cardId, 'richText', el.order);
          await client.setRichTextContent(elementId, el.content);
          console.log(` ✓`);
        } else if (el.type === 'link') {
          process.stdout.write(`      [Element ${ei + 1}] link "${el.url}"...`);
          const elementId = await client.createElement(cardId, 'link', el.order);
          await client.setLinkContent(elementId, el.url, el.title);
          console.log(` ✓`);
        } else if (el.type === 'internalLink') {
          // CLI ohne Anker-Auflösung: als ungelöster Karten-Link auf das Board.
          process.stdout.write(`      [Element ${ei + 1}] internalLink "${el.title}"...`);
          const elementId = await client.createElement(cardId, 'link', el.order);
          const fallbackUrl = `https://niedersachsen.cloud/boards/${boardId}`;
          await client.setLinkContent(elementId, fallbackUrl, el.title);
          console.log(` ✓ (Anker ${el.anchor} → Board)`);
        } else if (el.type === 'collaborativeTextEditor') {
          process.stdout.write(`      [Element ${ei + 1}] collaborativeTextEditor "${el.title || 'Teamtext'}"...`);
          await client.createElement(cardId, 'collaborativeTextEditor', el.order);
          if (el.originalUrl) {
            const noteId = await client.createElement(cardId, 'link', el.order + 1);
            await client.setLinkContent(
              noteId,
              el.originalUrl,
              `Original-Pad: ${el.title || 'Teamtext'}`,
              'Der neue NBC-Etherpad oben ist leer. Inhalt aus dem Original-Pad bitte manuell rüberkopieren.',
            );
          }
          console.log(` ✓`);
        } else if (el.type === 'file') {
          process.stdout.write(`      [Element ${ei + 1}] file "${el.fileName}"...`);
          const elementId = await client.createElement(cardId, 'file', el.order);
          const { mimeType, buffer } = parseDataUrl(el.fileData);
          await client.uploadFile(elementId, el.fileName, mimeType, buffer);
          const altText = el.fileName.replace(/\.[^.]+$/, '');
          await client.setFileCaption(elementId, el.content, altText);
          console.log(` ✓`);
        }
      }
    }
    console.log();
  }

  return { boardId, boardTitle: data.boardTitle, roomId };
}
