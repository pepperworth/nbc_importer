# edumaps-import

Tool zum Importieren von Edumaps-Boards als neue Räume + Boards auf `niedersachsen.cloud`. Besteht aus:

- **Web-UI** unter [nbc.almostready.dev](https://nbc.almostready.dev) — JWT eintragen, entweder Edumaps-URL einfügen **oder** JSON-Datei hochladen, fertig
- **CLI** für lokale/automatisierte Läufe
- **Tampermonkey-Userscript** (`edumaps_export.js`) zum Erzeugen der Export-JSON aus Edumaps

Nach erfolgreichem Import erhält man zwei Links:
- **Raum-Link** — intern, nur für Raum-Mitglieder
- **Share-Link** — öffentlich, per `POST /api/v3/sharetoken` erstellt (gültig ca. 21 Tage)

## Web-UI: zwei Wege zum Import

1. **Edumaps-URL** einfügen (empfohlen, nur öffentliche Boards) — der Server lädt das HTML direkt per HTTP, parst es mit `linkedom` (kein Headless-Chrome) und folgt Redirects nur innerhalb von `edumaps.de` (SSRF-Schutz).
2. **JSON-Datei** hochladen (klassisch) — zuvor mit dem Tampermonkey-Userscript erzeugt, funktioniert auch für nicht-öffentliche Boards.

Die Parser-Logik liegt als Canonical-Quelle in [edumaps-parser.js](edumaps-parser.js) und ist mit `edumaps_export.js` (Tampermonkey) inhaltlich gespiegelt — bei Änderungen **beide** pflegen.

## JWT holen

`F12 → Application → Storage → Cookies → https://niedersachsen.cloud → jwt → Value kopieren`

Das Tool prüft die Gültigkeit und liest `schoolId` automatisch aus dem JWT-Payload.

## CLI

### Setup

```bash
cd tools/edumaps-import
npm install
cp .env.example .env
# .env befüllen: NBC_JWT=ey...
```

### Verwendung

```bash
# Dry-Run (kein Netzwerk, nur Validierung)
npm run import -- --json ../../edumaps-export.json --dry-run

# Echter Import — erstellt neuen Raum + Board + Share-Link
npm run import -- --json ../../edumaps-export.json
```

### Optionen

| Flag | Beschreibung |
|---|---|
| `--json <path>` | Pfad zur Edumaps-Export-JSON (erforderlich) |
| `--room-id <id>` | In bestehenden Raum importieren (sonst wird ein neuer erstellt) |
| `--school-id <id>` | School-ID (wird normalerweise aus JWT gelesen) |
| `--base-url <url>` | NBC API Base-URL (Standard: `https://niedersachsen.cloud/api/v3`) |
| `--dry-run` | Kein Netzwerk — Validierung + Ausgabe geplanter Schritte |
| `--import-colors` | Karten-Farben aus Edumaps übernehmen (Default aus). Edumaps färbt nur den Titel-Streifen, NBC die ganze Karte — visuell anders. Bei `transparent`-/Weiß-Karten wird sowieso nichts gesetzt. |

## Was wird importiert?

- Board mit Titel aus dem Export
- Alle Spalten mit ihren Titeln
- Alle Karten mit ihren Titeln
- Elemente in der richtigen Reihenfolge:
  - `text` → richText-Element (HTML 1:1)
  - `file` → Upload + Caption
  - `link` → Link-Element mit URL + Titel

Nicht unterstützt: `drawing`, `videoConference`, `externalTool` — das Tool bricht mit einer Fehlermeldung ab.

## Edumaps Export (Tampermonkey)

`edumaps_export.js` ist ein Tampermonkey-Userscript, das den Export direkt aus der Edumaps-Oberfläche ermöglicht.

### Installation

1. [Tampermonkey](https://www.tampermonkey.net/) im Browser installieren
2. Neues Skript anlegen und den Inhalt von `edumaps_export.js` einfügen
3. Speichern

### Verwendung

1. Auf `app.edumaps.de` ein Board öffnen (Pinboard, Timeline oder Stickerwall)
2. Oben rechts erscheint ein **"Edumaps exportieren"**-Button
3. Klicken → das Skript lädt alle Medien als base64 herunter und speichert die JSON-Datei
4. Die JSON-Datei kann direkt in das Import-Tool (CLI oder Web-UI auf [nbc.almostready.dev](https://nbc.almostready.dev)) geladen werden

Bei Bedarf gibt es auch einen **"Debug"**-Button, der die geparste Struktur in der Konsole ausgibt.

## Server-seitige Dependencies

Der URL-Modus nutzt einen direkten HTTP-Request statt Headless-Chrome — Edumaps liefert das Board server-seitig als HTML aus, ein einfacher `fetch` reicht. `linkedom` parst das HTML in eine DOM-API, gegen die derselbe Code wie im Tampermonkey-Userscript läuft.

Keine zusätzlichen Systempakete nötig. Das Deploy-Skript (`deploy.sh`) überträgt `package.json` + `edumaps-parser.js` und führt anschließend `npm install --omit=dev` auf dem Server aus.
