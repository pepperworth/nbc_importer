(function () {
  "use strict";

  const TASKCARDS_GRAPHQL_URL = "https://www.taskcards.de/graphql";
  const TASKCARDS_BASE_URL = "https://www.taskcards.de";

  const TASKCARDS_BOARD_QUERY = `query ($id: String!) {
  board(id: $id) {
    id name description type
    lists { id name position color }
    cards {
      id title description link videoConference color created modified
      attachments { id filename length mimetype downloadLink previewLink }
      chalkBoardPosition { height width left top }
      kanbanPosition { listId position }
      timeLinePosition { position }
      storyPosition { position }
      worldMapPosition { lat lng }
    }
  }
}`.trim();

  function parseTaskcardsBoardLink(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/(?:^|\.)taskcards\.de$/i.test(u.hostname)) return null;
    for (const candidate of [u.pathname, u.hash ? u.hash.slice(1) : '']) {
      const m = candidate.match(/\/board\/([^/?#]+)/);
      if (m && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m[1])) {
        const token = u.searchParams.get('token') || '';
        return { boardId: m[1], token };
      }
    }
    return null;
  }

  async function taskcardsGraphql(payload, xToken) {
    const headers = { 'Content-Type': 'application/json' };
    if (xToken) headers['x-token'] = xToken;
    const res = await fetch(TASKCARDS_GRAPHQL_URL, { method: 'POST', mode: 'cors', headers, body: JSON.stringify(payload) });
    const data = await res.json();
    if (Array.isArray(data.errors) && data.errors.length) throw new Error(`GraphQL-Fehler: ${data.errors[0]?.message || 'Unbekannt'}`);
    return data;
  }

  async function fetchBoard(boardLink) {
    const visitor = await taskcardsGraphql({ query: 'mutation { createVisitor { id noActive } }' });
    const xToken = visitor?.data?.createVisitor?.id;
    if (!xToken) throw new Error('Kein Visitor-Token.');
    if (boardLink.token) {
      const r = await fetch(`${TASKCARDS_BASE_URL}/api/boards/${encodeURIComponent(boardLink.boardId)}/permissions/${encodeURIComponent(boardLink.token)}/accesses`, {
        method: 'POST', mode: 'cors',
        headers: { 'Content-Type': 'application/json', 'x-token': xToken },
        body: JSON.stringify({ password: '' }),
      });
      if (!r.ok && r.status !== 409) throw new Error(`Zugriff nicht möglich: HTTP ${r.status}`);
    }
    const result = await taskcardsGraphql({ operationName: null, variables: { id: boardLink.boardId }, query: TASKCARDS_BOARD_QUERY }, xToken);
    const board = result?.data?.board;
    if (!board) throw new Error('Keine Boarddaten erhalten.');
    return board;
  }

  const NBC_IMPORT_URL = 'https://nbc.almostready.dev';

  async function run() {
    const sourceUrl = location.href;
    const boardLink = parseTaskcardsBoardLink(sourceUrl);
    if (!boardLink) { alert('Kein Taskcards-Board erkannt.'); return; }

    const jwt = prompt('NBC JWT-Token (aus F12 → Cookies → niedersachsen.cloud → jwt):');
    if (!jwt?.trim()) return;

    const status = document.createElement('div');
    status.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1976d2;color:#fff;padding:12px 18px;border-radius:8px;font-family:sans-serif;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    status.textContent = 'Board wird geladen...';
    document.body.appendChild(status);

    try {
      const board = await fetchBoard(boardLink);
      status.textContent = 'Import wird gestartet...';
      const res = await fetch(`${NBC_IMPORT_URL}/api/ingest/taskcards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jwt: jwt.trim(),
          payload: { source_url: sourceUrl, data: { board } },
          addSummaryCard: false,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      status.remove();
      window.open(`${NBC_IMPORT_URL}/status/${encodeURIComponent(body.jobId)}`, '_blank');
    } catch (e) {
      status.style.background = '#c62828';
      status.textContent = 'Fehler: ' + e.message;
      setTimeout(() => status.remove(), 8000);
    }
  }

  run();
})();
