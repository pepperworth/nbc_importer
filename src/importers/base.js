export class ImporterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImporterError';
  }
}

/**
 * Basis-Schnittstelle für alle Importer.
 * Jeder Importer implementiert:
 *   - name: string
 *   - matches(url): boolean
 *   - fetchPull(url, logger): Promise<IntermediateBoard>
 *   - parsePush(payload): IntermediateBoard  (optional, nur Push-Importer)
 */
export class BaseImporter {
  get name() { throw new Error('name nicht implementiert'); }
  matches(_url) { return false; }
  async fetchPull(_url, _logger) { throw new ImporterError('fetchPull nicht implementiert'); }
  parsePush(_payload) { throw new ImporterError('parsePush nicht implementiert'); }
}
