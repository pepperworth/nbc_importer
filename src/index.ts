import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { program } from 'commander';
import dotenv from 'dotenv';
import type { EdumapsExport } from './edumaps-types.js';
import { ApiClient } from './api-client.js';
import { runImport } from './importer.js';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Ungültiger JWT (nicht 3 Segmente).');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload) as Record<string, unknown>;
}

function extractSchoolId(payload: Record<string, unknown>): string {
  // schoolId is typically stored in `schoolId`, `school`, or inside a nested object
  const schoolId =
    (payload['schoolId'] as string | undefined) ??
    (payload['school'] as string | undefined) ??
    (payload['schoolid'] as string | undefined);
  return schoolId ?? '';
}

program
  .name('edumaps-import')
  .description('Importiert ein Edumaps-Export-JSON als Board in einen NBC-Room')
  .requiredOption('--json <path>', 'Pfad zur Edumaps-Export-JSON-Datei')
  .option('--room-id <id>', 'MongoDB-ID eines bestehenden Rooms (fehlt: neuer Room wird erstellt)')
  .option('--school-id <id>', 'School-ID (wird sonst aus dem JWT-Payload gelesen)')
  .option('--base-url <url>', 'NBC API Base-URL', process.env['NBC_BASE_URL'] ?? 'https://niedersachsen.cloud/api/v3')
  .option('--dry-run', 'Kein Netzwerk — nur Validierung und Ausgabe geplanter Schritte', false)
  .option('--import-colors', 'Karten-Hintergrundfarben aus Edumaps übernehmen (mappt h3.boxlabel-Hex auf NBC-Palette). Default aus.', false)
  .parse(process.argv);

const opts = program.opts<{
  json: string;
  roomId?: string;
  schoolId?: string;
  baseUrl: string;
  dryRun: boolean;
  importColors: boolean;
}>();

async function main(): Promise<void> {
  const jwt = process.env['NBC_JWT'];
  if (!jwt && !opts.dryRun) {
    console.error('Fehler: NBC_JWT ist nicht gesetzt. Bitte in .env eintragen oder als Umgebungsvariable setzen.');
    process.exit(1);
  }

  // Validate JWT expiry
  if (jwt) {
    try {
      const payload = parseJwtPayload(jwt);
      const exp = payload['exp'] as number | undefined;
      if (exp && Date.now() / 1000 > exp) {
        const expDate = new Date(exp * 1000).toLocaleString('de-DE');
        console.error(`Fehler: JWT ist abgelaufen (${expDate}). Bitte neuen Token aus dem Browser kopieren.`);
        process.exit(1);
      }
      if (exp) {
        const expiresIn = Math.round((exp - Date.now() / 1000) / 86400);
        console.log(`JWT gültig noch ~${expiresIn} Tage.`);
      }

      // Try to extract schoolId from JWT if not provided
      if (!opts.schoolId) {
        const schoolId = extractSchoolId(payload);
        if (schoolId) {
          opts.schoolId = schoolId;
          console.log(`schoolId aus JWT: ${schoolId}`);
        }
      }
    } catch {
      console.error('Warnung: JWT-Payload konnte nicht dekodiert werden.');
    }
  }

  if (!opts.dryRun && !opts.schoolId) {
    console.error(
      'Fehler: schoolId konnte nicht aus dem JWT gelesen werden. Bitte --school-id <id> angeben.',
    );
    process.exit(1);
  }

  // Load and parse export JSON
  const jsonPath = resolve(opts.json);
  let exportData: EdumapsExport;
  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    exportData = JSON.parse(raw) as EdumapsExport;
  } catch (err) {
    console.error(`Fehler beim Lesen von "${jsonPath}": ${(err as Error).message}`);
    process.exit(1);
  }

  if (!exportData.columns || !exportData.boardTitle) {
    console.error('Fehler: JSON-Datei hat nicht das erwartete Edumaps-Export-Format (fehlt: boardTitle, columns).');
    process.exit(1);
  }

  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  // Files-Storage läuft auf derselben Domain wie die Haupt-API (/api/v3/file/upload/...)
  const filesUrl = process.env['NBC_FILES_STORAGE_URL']?.replace(/\/$/, '') ?? baseUrl;

  const client = new ApiClient({
    baseUrl,
    filesUrl,
    jwt: jwt ?? '',
    schoolId: opts.schoolId ?? '',
    dryRun: opts.dryRun,
  });

  try {
    const { boardId, boardTitle, roomId } = await runImport(exportData, opts.roomId, client, opts.dryRun, { importColors: opts.importColors });

    if (!opts.dryRun) {
      const origin = opts.baseUrl.replace('/api/v3', '');

      let shareUrl: string | null = null;
      let shareExpiresAt: string | null = null;
      if (roomId) {
        try {
          const share = await client.createShareToken('room', roomId);
          shareUrl = `${origin}/rooms?import=${share.token}&importedType=room`;
          shareExpiresAt = share.expiresAt ?? null;
        } catch (err) {
          console.error(`Warnung: Share-Link konnte nicht erstellt werden: ${(err as Error).message}`);
        }
      }

      console.log('─'.repeat(60));
      console.log(`✓ Import abgeschlossen!`);
      console.log(`  Board-ID:  ${boardId}`);
      console.log(`  Titel:     ${boardTitle}`);
      console.log(`  Room-URL:  ${origin}/rooms/${roomId}`);
      if (shareUrl) {
        console.log(`  Share-URL: ${shareUrl}`);
        if (shareExpiresAt) {
          console.log(`             (gültig bis ${new Date(shareExpiresAt).toLocaleString('de-DE')})`);
        }
      }
      console.log('─'.repeat(60));
    }
  } catch (err) {
    console.error(`\nFehler beim Import: ${(err as Error).message}`);
    console.error('Bereits erstellte Ressourcen bleiben bestehen (kein Rollback).');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
