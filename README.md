# nbc-import

Web-Tool zum Importieren öffentlicher Boards aus Edumaps, Taskcards und Padlet in die Niedersachsen-Cloud (NBC). Betrieben unter [nbc.almostready.dev](https://nbc.almostready.dev).

## Funktionsweise

Der Import läuft in drei Schritten:

1. **Quelle** — Board-URL eingeben (Edumaps, Taskcards oder Padlet)
2. **Optionen** — Farben übernehmen, Meta-Spalte aktivieren, Platzhalter-Hinweise ausblenden
3. **Import** — Server-seitiger Job mit Live-Log via SSE

Nach dem Import erhält man einen **Teilen-Link** (Board-Import, `columnBoard`), über den das fertige Board in eine NBC-Instanz übernommen werden kann.

## Quellen

| Quelle | Modus | Anmerkungen |
|--------|-------|-------------|
| **Edumaps** | URL-Pull | Nur öffentliche Boards; HTML-Fetch + linkedom-Parser |
| **Taskcards** | URL-Pull | GraphQL-API; nur öffentliche Boards |
| **Padlet** | URL-Pull | HTML + JSON-API; nur öffentliche Boards |

## Auth-Modi

Das Tool unterstützt zwei Auth-Modi, einstellbar in `config.yaml`:

### `auth.mode: jwt` (Produktionsmodus, Standard)

Der Nutzer gibt seinen eigenen NBC-JWT ein (aus DevTools → Cookies → `jwt`). Das Tool importiert das Board unter dem Account des Nutzers.

```yaml
auth:
  mode: jwt
```

### `auth.mode: password` (Staging-/Server-Modus)

Der Server logt sich mit einem festen Service-Account ein (`NBC_EMAIL` / `NBC_PASSWORD` in `.env`). Das JWT-Feld ist in der UI ausgeblendet — Nutzer brauchen keinen NBC-Account. Alle Boards landen in einem konfigurierten Ablage-Raum (`nbc.ablage_room_id`).

```yaml
auth:
  mode: password

nbc:
  ablage_room_id: "60abc123..."  # Raum-ID im Service-Account
```

```env
NBC_EMAIL=importer@schule.de
NBC_PASSWORD=geheimesPasswort
```

## Pipeline-Stages

Nach dem Fetch läuft jedes Board durch drei Stages:

| Stage | Was passiert |
|-------|-------------|
| `normalize-card-colors` | Hex-Farben aus der Quelle werden via CIE-Lab-Nearest-Neighbor auf NBC-Farben gemappt |
| `link-preview` | OG/Twitter-Metadaten für Link-Elemente werden nachgeladen (Concurrency 5, SSRF-Guard) |
| `board-lint` | Strukturwarnungen: leere Karten, fehlende Titel, Duplikate, überdimensionierte Boards |

## Meta-Spalte

Optional wird eine Spalte „Über diesen Bereich" vorangestellt mit:
- Karte mit Quell-URL und Beschreibung
- Karte mit gefundenen Etherpad-Links
- Karte mit Hinweis auf weggelassene Inhalte (nicht importierbare Widgets)

## Jobpersistenz

Jobs werden in SQLite gespeichert (`data/jobs.sqlite`). Der SSE-Live-Log wird in der DB gehalten und bei Reconnect vollständig wiedergegeben — Jobs überleben Server-Neustarts.

## Setup (lokal / eigene Instanz)

```bash
npm install
cp .env.example .env
# .env befüllen (s.u.)
node server.js
```

### `.env`

```env
# NBC API-Endpunkt (Standard: Produktion)
NBC_BASE_URL=https://niedersachsen.cloud/api/v3

# Port (Standard: 3010)
PORT=3010

# Nur bei auth.mode: password
# NBC_EMAIL=importer@schule.de
# NBC_PASSWORD=geheimesPasswort
```

### `config.yaml`

```yaml
lint:
  oversized_card_max_elements: 20
  oversized_board_max_cards: 200
  max_warnings: 50

features:
  board_ttl_days: 30
  link_preview_enabled: true

auth:
  mode: jwt          # oder: password

nbc:
  ablage_room_id: "" # Nur bei auth.mode: password
```

## Deployment

Der Server wird per `rsync` + `systemctl restart` deployed. `deploy.sh` liegt lokal und ist nicht im Repository (enthält Server-Adresse). Neues Deployment:

```bash
rsync -av --exclude='node_modules' --exclude='.git' --exclude='data' --exclude='.env' \
  ./ root@server:/opt/nbc-import/
ssh root@server "cd /opt/nbc-import && npm install --omit=dev && systemctl restart nbc-import"
```

## Architektur

```
server.js                  Express-Server, Routes, SSE, Job-Runner
src/
  importers/
    registry.js            findImporter(url) / findImporterByName(name)
    edumaps.js             HTML-Fetch + linkedom-Parser
    taskcards.js           GraphQL-Pull
    padlet.js              HTML + JSON-API
  pipeline/
    runner.js              Sequenzielle Stage-Ausführung
    colors.js              CIE-Lab Hex→NBC-Farb-Mapping
    stages/
      normalize-card-colors.js
      link-preview.js
      board-lint.js
  nbc/
    client.js              NBC API-Wrapper (fetch + SSRF-Guard)
    session.js             NBCSession — Login, Token-Refresh, Retry
    exporter.js            IntermediateBoard → NBC Room/Board/Cards/Elements
    meta-column.js         „Über diesen Bereich"-Spalte
  jobs/
    store.js               SQLite-Jobs (better-sqlite3, WAL)
    cleanup.js             Täglicher TTL-Sweep
  config.js                config.yaml + .env Loader
config.yaml                Lint-Schwellen, Auth-Modus, Ablage-Raum
public/
  index.html               Wizard-UI (3 Steps, SSE-Live-Log)
  status.html              Job-Status-Seite
```
