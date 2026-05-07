// CANONICAL Parser-Logik für Edumaps-Boards (NBC v0.10).
// Läuft serverseitig mit linkedom; die DOM-API entspricht der des Browsers,
// daher ist `edumaps_export.js` (Tampermonkey) inhaltlich gespiegelt — bei
// Änderung BEIDE pflegen.

// ── Pure Node-Helpers (kein DOM) ───────────────────────────────────────

export function buildExport(columns, boardTitle) {
  let totalCards = 0, totalElements = 0, totalFiles = 0, totalLinks = 0,
      totalInternalLinks = 0, totalQrCodes = 0, totalCollaborativeTextEditors = 0,
      totalCardsColored = 0;
  for (const col of columns) {
    for (const card of col.cards) {
      totalCards++;
      if (card.backgroundColor && card.backgroundColor !== 'transparent') totalCardsColored++;
      for (const el of (card.elements || [])) {
        totalElements++;
        if (el.type === 'file') totalFiles++;
        if (el.type === 'link') totalLinks++;
        if (el.type === 'internalLink') totalInternalLinks++;
        if (el.type === 'qrCode') totalQrCodes++;
        if (el.type === 'collaborativeTextEditor') totalCollaborativeTextEditors++;
      }
    }
  }
  return {
    exportDate: new Date().toISOString(),
    version: '0.11',
    boardTitle,
    totalColumns: columns.length,
    totalCards,
    totalCardsColored,
    totalFiles,
    totalLinks,
    totalInternalLinks,
    totalQrCodes,
    totalCollaborativeTextEditors,
    totalVideoConferences: 0,
    totalExternalTools: 0,
    totalElements,
    columns,
  };
}

export function collectMediaUrls(columns) {
  const map = new Map(); // fileName → _originalUrl
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        if (el.type === 'file' && el._originalUrl) {
          map.set(el.fileName, el._originalUrl);
        }
      }
    }
  }
  return map;
}

export function injectFileData(columns, dataMap) {
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        if (el.type === 'file' && dataMap.has(el.fileName)) {
          el.fileData = dataMap.get(el.fileName);
        }
      }
    }
  }
}

export function stripInternalFields(columns) {
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        delete el._originalUrl;
      }
    }
  }
}

// ── Hex-Farbe → NBC-CardColor (CIE-Lab Nearest-Neighbor) ───────────────
// Portiert aus app/pipeline/colors.py (steedalot/nbcimport, main nach
// PR #21 + #21-fix b2e13f10 „Material-Lighten-Pastelle korrekt zuordnen").
//
// Statt nur die Base-Sättigung pro Farbton zu hinterlegen, listen wir hier
// alle 10 offiziellen Vuetify-Schattierungen (lighten5..1, base, darken1..4)
// als Anker pro CardColor. Hintergrund: Quellen können auch Pastelle als
// Karten-Hintergrund nutzen (z.B. Edumaps-textbg-Spans, Taskcards-Karten).
// Pastelle haben in CIE-Lab kleine Distanz zu Unbunt — gegen eine Base-
// Only-Palette gewinnt deshalb fast immer "grey". Mit allen Schattierungen
// als Ankerpunkten findet die Nearest-Neighbour-Suche den korrekten Farbton,
// unabhängig davon, wie hell oder dunkel die Quelle ihn anbietet.
const PALETTE_ANCHORS = [
  // red
  ['red', '#ffebee'], ['red', '#ffcdd2'], ['red', '#ef9a9a'],
  ['red', '#e57373'], ['red', '#ef5350'], ['red', '#f44336'],
  ['red', '#e53935'], ['red', '#d32f2f'], ['red', '#c62828'],
  ['red', '#b71c1c'],
  // pink
  ['pink', '#fce4ec'], ['pink', '#f8bbd0'], ['pink', '#f48fb1'],
  ['pink', '#f06292'], ['pink', '#ec407a'], ['pink', '#e91e63'],
  ['pink', '#d81b60'], ['pink', '#c2185b'], ['pink', '#ad1457'],
  ['pink', '#880e4f'],
  // purple
  ['purple', '#f3e5f5'], ['purple', '#e1bee7'], ['purple', '#ce93d8'],
  ['purple', '#ba68c8'], ['purple', '#ab47bc'], ['purple', '#9c27b0'],
  ['purple', '#8e24aa'], ['purple', '#7b1fa2'], ['purple', '#6a1b9a'],
  ['purple', '#4a148c'],
  // deep purple
  ['deepPurple', '#ede7f6'], ['deepPurple', '#d1c4e9'], ['deepPurple', '#b39ddb'],
  ['deepPurple', '#9575cd'], ['deepPurple', '#7e57c2'], ['deepPurple', '#673ab7'],
  ['deepPurple', '#5e35b1'], ['deepPurple', '#512da8'], ['deepPurple', '#4527a0'],
  ['deepPurple', '#311b92'],
  // indigo
  ['indigo', '#e8eaf6'], ['indigo', '#c5cae9'], ['indigo', '#9fa8da'],
  ['indigo', '#7986cb'], ['indigo', '#5c6bc0'], ['indigo', '#3f51b5'],
  ['indigo', '#3949ab'], ['indigo', '#303f9f'], ['indigo', '#283593'],
  ['indigo', '#1a237e'],
  // blue
  ['blue', '#e3f2fd'], ['blue', '#bbdefb'], ['blue', '#90caf9'],
  ['blue', '#64b5f6'], ['blue', '#42a5f5'], ['blue', '#2196f3'],
  ['blue', '#1e88e5'], ['blue', '#1976d2'], ['blue', '#1565c0'],
  ['blue', '#0d47a1'],
  // light blue
  ['lightBlue', '#e1f5fe'], ['lightBlue', '#b3e5fc'], ['lightBlue', '#81d4fa'],
  ['lightBlue', '#4fc3f7'], ['lightBlue', '#29b6f6'], ['lightBlue', '#03a9f4'],
  ['lightBlue', '#039be5'], ['lightBlue', '#0288d1'], ['lightBlue', '#0277bd'],
  ['lightBlue', '#01579b'],
  // cyan
  ['cyan', '#e0f7fa'], ['cyan', '#b2ebf2'], ['cyan', '#80deea'],
  ['cyan', '#4dd0e1'], ['cyan', '#26c6da'], ['cyan', '#00bcd4'],
  ['cyan', '#00acc1'], ['cyan', '#0097a7'], ['cyan', '#00838f'],
  ['cyan', '#006064'],
  // teal
  ['teal', '#e0f2f1'], ['teal', '#b2dfdb'], ['teal', '#80cbc4'],
  ['teal', '#4db6ac'], ['teal', '#26a69a'], ['teal', '#009688'],
  ['teal', '#00897b'], ['teal', '#00796b'], ['teal', '#00695c'],
  ['teal', '#004d40'],
  // green
  ['green', '#e8f5e9'], ['green', '#c8e6c9'], ['green', '#a5d6a7'],
  ['green', '#81c784'], ['green', '#66bb6a'], ['green', '#4caf50'],
  ['green', '#43a047'], ['green', '#388e3c'], ['green', '#2e7d32'],
  ['green', '#1b5e20'],
  // light green
  ['lightGreen', '#f1f8e9'], ['lightGreen', '#dcedc8'], ['lightGreen', '#c5e1a5'],
  ['lightGreen', '#aed581'], ['lightGreen', '#9ccc65'], ['lightGreen', '#8bc34a'],
  ['lightGreen', '#7cb342'], ['lightGreen', '#689f38'], ['lightGreen', '#558b2f'],
  ['lightGreen', '#33691e'],
  // lime
  ['lime', '#f9fbe7'], ['lime', '#f0f4c3'], ['lime', '#e6ee9c'],
  ['lime', '#dce775'], ['lime', '#d4e157'], ['lime', '#cddc39'],
  ['lime', '#c0ca33'], ['lime', '#afb42b'], ['lime', '#9e9d24'],
  ['lime', '#827717'],
  // yellow
  ['yellow', '#fffde7'], ['yellow', '#fff9c4'], ['yellow', '#fff59d'],
  ['yellow', '#fff176'], ['yellow', '#ffee58'], ['yellow', '#ffeb3b'],
  ['yellow', '#fdd835'], ['yellow', '#fbc02d'], ['yellow', '#f9a825'],
  ['yellow', '#f57f17'],
  // amber
  ['amber', '#fff8e1'], ['amber', '#ffecb3'], ['amber', '#ffe082'],
  ['amber', '#ffd54f'], ['amber', '#ffca28'], ['amber', '#ffc107'],
  ['amber', '#ffb300'], ['amber', '#ffa000'], ['amber', '#ff8f00'],
  ['amber', '#ff6f00'],
  // orange
  ['orange', '#fff3e0'], ['orange', '#ffe0b2'], ['orange', '#ffcc80'],
  ['orange', '#ffb74d'], ['orange', '#ffa726'], ['orange', '#ff9800'],
  ['orange', '#fb8c00'], ['orange', '#f57c00'], ['orange', '#ef6c00'],
  ['orange', '#e65100'],
  // deep orange
  ['deepOrange', '#fbe9e7'], ['deepOrange', '#ffccbc'], ['deepOrange', '#ffab91'],
  ['deepOrange', '#ff8a65'], ['deepOrange', '#ff7043'], ['deepOrange', '#ff5722'],
  ['deepOrange', '#f4511e'], ['deepOrange', '#e64a19'], ['deepOrange', '#d84315'],
  ['deepOrange', '#bf360c'],
  // brown
  ['brown', '#efebe9'], ['brown', '#d7ccc8'], ['brown', '#bcaaa4'],
  ['brown', '#a1887f'], ['brown', '#8d6e63'], ['brown', '#795548'],
  ['brown', '#6d4c41'], ['brown', '#5d4037'], ['brown', '#4e342e'],
  ['brown', '#3e2723'],
  // grey — die hellsten Schattierungen (#fafafa, #f5f5f5) fehlen absichtlich;
  // isWhiteish() fängt sie vorher ab und liefert 'transparent'.
  ['grey', '#eeeeee'], ['grey', '#e0e0e0'], ['grey', '#bdbdbd'],
  ['grey', '#9e9e9e'], ['grey', '#757575'], ['grey', '#616161'],
  ['grey', '#424242'], ['grey', '#212121'],
  // blue grey
  ['blueGrey', '#eceff1'], ['blueGrey', '#cfd8dc'], ['blueGrey', '#b0bec5'],
  ['blueGrey', '#90a4ae'], ['blueGrey', '#78909c'], ['blueGrey', '#607d8b'],
  ['blueGrey', '#546e7a'], ['blueGrey', '#455a64'], ['blueGrey', '#37474f'],
  ['blueGrey', '#263238'],
];

function parseHex(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m6 = s.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (m6) return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)];
  const m3 = s.match(/^#?([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (m3) return m3.slice(1).map(c => parseInt(c + c, 16));
  return null;
}

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function rgbToLab(r, g, b) {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  // sRGB → XYZ (D65)
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000;
  const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Anker in Lab vorberechnen, damit jeder Aufruf nur eine Distanzschleife
// über die Liste läuft und nicht je Anker die sRGB→Lab-Konversion neu macht.
const PALETTE_LAB = PALETTE_ANCHORS.map(([name, hex]) => [name, rgbToLab(...parseHex(hex))]);

function isWhiteish([r, g, b]) {
  return Math.min(r, g, b) >= 240 && Math.max(r, g, b) - Math.min(r, g, b) <= 8;
}

export function hexToNbcColor(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return 'transparent';
  const rgb = parseHex(s);
  if (rgb === null) return null;
  if (isWhiteish(rgb)) return 'transparent';
  const target = rgbToLab(...rgb);
  let best = null;
  let bestD2 = Infinity;
  for (const [name, lab] of PALETTE_LAB) {
    const dl = target[0] - lab[0], da = target[1] - lab[1], db = target[2] - lab[2];
    const d2 = dl * dl + da * da + db * db;
    if (d2 < bestD2) { bestD2 = d2; best = name; }
  }
  return best;
}

// ── DOM-Parser ─────────────────────────────────────────────────────────

const TIMELINE_TYPES = ['34'];
const STICKERWALL_TYPES = ['22'];

// Edumaps-Widgets ohne NBC-Entsprechung. Reihenfolge ist relevant: spezifischere
// Klassen zuerst, damit z.B. coursestart-btn (Sonderfall von quizstart-btn-wrap)
// nicht als generischer Quiz-Starter erkannt wird.
const UNSUPPORTED_WIDGETS = [
  ['quiz-wrap',          'Single-/Multiple-Choice-Quiz'],
  ['coursestart-btn',    'Kurs-Starter-Button'],
  ['quizstart-btn-wrap', 'Quiz-Starter-Button'],
  ['sendprompt-btn',     'KI-Prompt-Button'],
  ['poll-wrap',          'Umfrage/Abstimmung'],
  ['test-wrap',          'Zuordnungsübung'],
  ['cboxlist',           'Abhakliste'],
  ['boxcountdown',       'Countdown-Timer'],
  ['ttsaudio',           'Text-to-Speech-Audio'],
];
const TEAMTEXT_RE = /^https?:\/\/team\.edumaps\.de\/p\//i;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function detectUnsupportedWidget(el) {
  for (const [cls, label] of UNSUPPORTED_WIDGETS) {
    if (el.querySelector('.' + cls)) return label;
  }
  return null;
}

function renderWidgetWarning(label) {
  return '<p>⚠️ Edumaps-Element „' + escHtml(label) + '" konnte nicht in die NBC übertragen werden.</p>';
}

function cleanTableForCk5(table) {
  // NBC-Tabellen liegen als <figure class="table"><table><thead?>…</thead?><tbody>…</tbody></table></figure>
  // im CKEditor-5-Save-Format vor. Edumaps markiert Header-Zeilen, indem die erste
  // Zeile komplett aus <th> besteht.
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  let headerRow = null;
  let bodyRows = rows;
  const firstCells = Array.from(rows[0].querySelectorAll('th, td'));
  if (firstCells.length && firstCells.every(c => c.tagName.toLowerCase() === 'th')) {
    headerRow = rows[0];
    bodyRows = rows.slice(1);
  }
  const cell = (c) => c.innerHTML.trim().replace(/\s+/g, ' ');
  const parts = ['<figure class="table"><table>'];
  if (headerRow) {
    parts.push('<thead><tr>');
    headerRow.querySelectorAll('th, td').forEach(c => parts.push('<th>' + cell(c) + '</th>'));
    parts.push('</tr></thead>');
  }
  if (bodyRows.length) {
    parts.push('<tbody>');
    bodyRows.forEach(row => {
      parts.push('<tr>');
      row.querySelectorAll('th, td').forEach(c => parts.push('<td>' + cell(c) + '</td>'));
      parts.push('</tr>');
    });
    parts.push('</tbody>');
  }
  parts.push('</table></figure>');
  return parts.join('');
}

function findQrCodes(boxEl) {
  // Pro .hasqrcode-Container ein Eintrag (Edumaps hat oft Preview-Btn + qrcodeimage
  // mit identischem data-url — hier wäre sonst alles doppelt).
  const found = [];
  let idx = 1;
  boxEl.querySelectorAll('.hasqrcode').forEach(wrap => {
    const target = wrap.querySelector('[data-url]');
    if (!target) return;
    const dataUrl = (target.getAttribute('data-url') || '').trim();
    if (!dataUrl) return;
    found.push({ content: dataUrl, index: idx++ });
  });
  return found;
}

function getTypeId(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const part of parts) if (/^\d+$/.test(part)) return part;
  return null;
}

function detectBoardType(pathname) {
  const id = getTypeId(pathname);
  if (!id) return null;
  if (TIMELINE_TYPES.includes(id)) return 'timeline';
  if (STICKERWALL_TYPES.includes(id)) return 'stickerwall';
  return 'pinboard';
}

function getBoardTitle(document) {
  const headline = document.querySelector('h1.mapeditor-headline');
  if (headline) return headline.textContent.trim();
  const h1 = document.querySelector('h1');
  if (h1) return h1.textContent.trim();
  const titleEl = document.querySelector('title');
  const raw = titleEl ? titleEl.textContent : '';
  return raw.replace(/\s*[|\-–]\s*edumaps.*/i, '').trim() || 'Edumaps Board';
}

function uniqueFileName(name, usedNames) {
  if (!usedNames.has(name)) { usedNames.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot >= 0 ? name.slice(0, dot) : name;
  const ext  = dot >= 0 ? name.slice(dot) : '';
  let i = 2;
  while (usedNames.has(base + '_' + i + ext)) i++;
  const unique = base + '_' + i + ext;
  usedNames.add(unique);
  return unique;
}

function extractImageElements(boxEl, startOrder, usedNames) {
  const elements = [];
  let order = startOrder;
  boxEl.querySelectorAll('a.mediaitem-img[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const cleanHref = href.replace(/#.*$/, '').replace(/\/preview$/, '');
    const segments = cleanHref.split('/').filter(Boolean);
    let baseName = segments[segments.length - 2] || segments[segments.length - 1] || 'bild';
    const isPng = href.includes('.png');
    const isJpg = href.includes('.jpg') || href.includes('.jpeg');
    const isGif = href.includes('.gif');
    if (isPng && !baseName.endsWith('.png')) baseName += '.png';
    else if (isJpg && !baseName.endsWith('.jpg')) baseName += '.jpg';
    else if (isGif && !baseName.endsWith('.gif')) baseName += '.gif';
    else if (!baseName.includes('.')) baseName += '.png';
    const fileName = uniqueFileName(baseName, usedNames);
    elements.push({ order: order++, type: 'file', fileName, fileInfo: 'Bild, Edumaps',
                    content: '📎 ' + fileName, shouldBeBold: true, _originalUrl: href });
  });
  const seenHrefs = new Set(elements.map(e => e._originalUrl));
  boxEl.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (!src.includes('/file/') && !src.includes('/upload/')) return;
    if (src.includes('preview') || src.includes('thumb')) return;
    if (seenHrefs.has(src)) return;
    seenHrefs.add(src);
    const baseName = src.split('/').pop().split('?')[0] || 'bild.png';
    const fileName = uniqueFileName(baseName, usedNames);
    elements.push({ order: order++, type: 'file', fileName, fileInfo: 'Bild, Edumaps',
                    content: '📎 ' + fileName, shouldBeBold: true, _originalUrl: src });
  });
  return elements;
}

function injectAnchorPlaceholders(html) {
  // href="#anker" → href="__ANCHOR__anker" — wird nach dem Import aufgelöst
  return html.replace(/href="#([^"]+)"/g, 'href="__ANCHOR__$1"');
}

function hasInlineOnlyLinks(li) {
  // Zeile enthält nur interne Links (kein Text außer in den Links, kein ol/ul)
  const puretext = li.querySelector('.line-puretext');
  if (!puretext) return false;
  const anchors = puretext.querySelectorAll('a.inline.selfopener[href^="#"]');
  if (!anchors.length) return false;
  if (puretext.querySelector('ol, ul')) return false;
  return anchors.length === 1;
}

function cleanTextlineHtml(li) {
  // Extrahiert innerHTML eines li.textline und behält nur href/title an <a>-Tags.
  // Gibt '' zurück wenn der Inhalt leer/nur Whitespace ist.
  let html = li.innerHTML || '';
  // Strip <a> attributes except href and title
  html = html.replace(/<a([^>]*)>/gi, (_, attrs) => {
    const href = (attrs.match(/href="([^"]*)"/) || [])[1] || '';
    const title = (attrs.match(/title="([^"]*)"/) || [])[1] || '';
    let out = '<a';
    if (href) out += ` href="${href}"`;
    if (title) out += ` title="${title}"`;
    return out + '>';
  });
  // Strip mapanchor spans
  html = html.replace(/<span[^>]*class="mapanchor"[^>]*>.*?<\/span>/g, '').trim();
  if (!html || html.replace(/\s/g, '') === '') return '';
  return injectAnchorPlaceholders(html);
}

function extractTextContent(boxEl) {
  // Inhalt wird als (html, isBlock)-Paare gesammelt. Block-Elemente
  // (<table>, <blockquote>, Widget-Warnungen) dürfen laut HTML5-Spec nicht
  // in <p> stehen — CKEditor-5 würde die Tabelle sonst beim Laden verlieren.
  const parts = [];
  boxEl.querySelectorAll('li.itemline').forEach(li => {
    if (li.querySelector('a.mediaitem-img')) return;
    if (li.querySelector('a[class*="mediaitem-"]')) return;
    if (hasInlineOnlyLinks(li)) return;

    const puretext = li.querySelector('.line-puretext');
    if (puretext) {
      // QR-Codes werden vom Parent (parseBox) als eigenes File-Element erzeugt —
      // hier keine leere Text-Zeile produzieren.
      if (puretext.querySelector('.hasqrcode, .qrcodeimage')) return;

      const widgetLabel = detectUnsupportedWidget(puretext);
      if (widgetLabel) {
        parts.push({ html: renderWidgetWarning(widgetLabel), isBlock: true });
        return;
      }

      const table = puretext.querySelector('table');
      if (table) {
        const cleaned = cleanTableForCk5(table);
        if (cleaned) parts.push({ html: cleaned, isBlock: true });
        return;
      }

      let html = puretext.innerHTML.replace(/<span[^>]*class="mapanchor"[^>]*>.*?<\/span>/g, '').trim();
      if (html !== '&nbsp;' && html !== '' && html.replace(/\s/g,'') !== '') {
        html = injectAnchorPlaceholders(html);
        parts.push({ html, isBlock: false });
      }
      return;
    }

    const bq = li.querySelector('blockquote');
    if (bq && bq.textContent.trim()) {
      let html = '<blockquote>' + bq.innerHTML.trim() + '</blockquote>';
      html = injectAnchorPlaceholders(html);
      parts.push({ html, isBlock: true });
      return;
    }

    // textline: Fließtext direkt im <li> ohne .line-puretext-Wrapper,
    // ggf. mit Inline-Links. <a>-Tags auf href/title reduzieren.
    if ((li.getAttribute('class') || '').split(' ').includes('textline')) {
      const inner = cleanTextlineHtml(li);
      if (inner) parts.push({ html: inner, isBlock: false });
    }
  });
  if (!parts.length) return '';
  return parts.map(p => p.isBlock ? p.html : '<p>' + p.html + '</p>').join('');
}

function extractLinkElements(boxEl, startOrder) {
  const elements = [];
  let order = startOrder;
  boxEl.querySelectorAll('li.itemline a[class*="mediaitem-"]').forEach(a => {
    if (a.classList.contains('mediaitem-img')) return;
    const href = a.getAttribute('href') || '';
    if (!href) return;
    // Edumaps-Teamtext (Etherpad auf team.edumaps.de) → CollabTextEditor in NBC.
    // Der NBC-Pad ist beim Anlegen leer; der Server hängt zusätzlich einen Link
    // auf den Original-Pad an, damit der Lehrer den Inhalt rüberkopieren kann.
    if (TEAMTEXT_RE.test(href)) {
      const innerSpan = a.querySelector('span');
      const padTitle = (innerSpan && innerSpan.textContent ? innerSpan.textContent.trim() : '') || 'Teamtext';
      elements.push({ order: order++, type: 'collaborativeTextEditor',
                      title: padTitle, originalUrl: href, content: '📝 ' + padTitle });
      return;
    }
    let title = (a.getAttribute('aria-label') || '').replace(/^Externen Link öffnen\s*[-–]\s*/i, '').trim();
    if (/link\s+öffnet|externen?\s+link|neuem?\s+tab/i.test(title)) title = '';
    if (!title) title = a.textContent.replace(/\s+/g, ' ').trim();
    if (!title) title = href;
    elements.push({ order: order++, type: 'link', url: href, title, content: '🔗 ' + title });
  });
  return elements;
}

function extractQrCodeMarkers(boxEl, startOrder) {
  // Marker-Element — wird vom Server (renderQrCodesInline) zu file mit fileData PNG.
  const elements = [];
  let order = startOrder;
  findQrCodes(boxEl).forEach(({ content, index }) => {
    const fileName = 'qrcode-' + index + '.png';
    elements.push({
      order: order++,
      type: 'qrCode',
      content,
      fileName,
      caption: 'QR-Code → ' + content,
    });
  });
  return elements;
}

function extractInternalLinkElements(boxEl, startOrder) {
  // Nur einzelne interne Links (nicht in ol/ul) → als eigenes Link-Element
  const elements = [];
  let order = startOrder;
  boxEl.querySelectorAll('li.itemline').forEach(li => {
    if (!hasInlineOnlyLinks(li)) return;
    const a = li.querySelector('a.inline.selfopener[href^="#"]');
    const anchor = a.getAttribute('href') || '';
    if (!anchor || anchor === '#') return;
    const title = a.textContent.replace(/\s+/g, ' ').trim() || anchor;
    elements.push({ order: order++, type: 'internalLink', anchor, title, content: '↩ ' + title });
  });
  return elements;
}

function getBoxAnchorId(boxEl) {
  const span = boxEl.querySelector('span.mapanchor[id]');
  return span ? span.id : null;
}

function getBoxBackgroundColor(boxEl) {
  // Edumaps färbt h3.boxlabel via inline style="background:#xxxxxx;" — das ist
  // der Streifen oben auf der Karte und entspricht der "Karten-Farbe".
  // Fallback: Style direkt am .box-item (manche Board-Typen).
  const candidates = [
    boxEl.querySelector('h3.boxlabel[style*="background"]'),
    boxEl.querySelector('.boxhead[style*="background"]'),
    boxEl.matches?.('[style*="background"]') ? boxEl : null,
  ];
  for (const el of candidates) {
    if (!el) continue;
    const style = el.getAttribute('style') || '';
    const m = style.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/);
    if (m) return m[1];
  }
  return null;
}

function parseBox(boxEl, usedNames) {
  const labelEl = boxEl.querySelector('h3.boxlabel');
  const title = labelEl ? labelEl.textContent.trim() : 'Pin';
  const anchorId = getBoxAnchorId(boxEl);
  const rawColor = getBoxBackgroundColor(boxEl);
  const mappedColor = rawColor ? hexToNbcColor(rawColor) : null;
  const elements = [];
  let order = 0;
  const textHtml = extractTextContent(boxEl);
  if (textHtml) elements.push({ order: order++, type: 'text', content: textHtml });
  const imgEls = extractImageElements(boxEl, order, usedNames);
  imgEls.forEach(el => { el.order = order++; elements.push(el); });
  const linkEls = extractLinkElements(boxEl, order);
  linkEls.forEach(el => { el.order = order++; elements.push(el); });
  const internalLinkEls = extractInternalLinkElements(boxEl, order);
  internalLinkEls.forEach(el => { el.order = order++; elements.push(el); });
  const qrEls = extractQrCodeMarkers(boxEl, order);
  qrEls.forEach(el => { el.order = order++; elements.push(el); });
  const card = { title, elements, content: elements.map(e => e.content || '').join('') };
  if (anchorId) card.anchorId = anchorId;
  if (rawColor) card.backgroundColorRaw = rawColor;
  if (mappedColor) card.backgroundColor = mappedColor;
  return card;
}

// Edumaps zeigt im UI nur einen Spalten-Header — wenn der DOM-`.path-item` leer
// ist (häufig), leitet Edumaps den Titel aus dem `h3.boxlabel` der ersten Karte
// ab und unterdrückt dort den Karten-Titel. Wir nehmen exakt diese Logik nach,
// sonst erscheint der Titel in NBC doppelt: einmal als Spalten-Header, einmal
// als Titel der ersten Karte. Eine reine Header-Karte ohne sonstigen Inhalt
// wird ganz gedroppt; eine Karte mit Inhalt verliert nur den Titel.
function dedupeFirstCardTitle(cards, sourceWasFirstLabel) {
  if (!sourceWasFirstLabel || cards.length === 0) return cards;
  const first = cards[0];
  if (!first.title) return cards;
  if (first.elements.length === 0) return cards.slice(1);
  first.title = '';
  return cards;
}

function getColumnTitle(pathCol) {
  // Nur span.pathlabel für den Titel lesen — nicht das gesamte path-item,
  // weil div.path-descr (Spalten-Kurzbeschreibung) sonst den Titel verfälscht.
  const pathItem = pathCol.querySelector('.path-wrap .path-item') || pathCol.querySelector('.path-item');
  if (pathItem) {
    const pathlabel = pathItem.querySelector('span.pathlabel');
    const title = pathlabel ? pathlabel.textContent.trim() : pathItem.textContent.trim();
    const pathDescrEl = pathItem.querySelector('div.path-descr');
    const pathDescr = pathDescrEl ? pathDescrEl.textContent.trim() : '';
    if (title) return { title, fromPathItem: true, pathDescr };
  }
  const firstLabel = pathCol.querySelector('h3.boxlabel');
  const firstLabelText = firstLabel ? firstLabel.textContent.trim() : '';
  return { title: firstLabelText, fromPathItem: false, pathDescr: '' };
}

function parsePinboard(document, usedNames) {
  const boardTitle = getBoardTitle(document);
  const pathCols = document.querySelectorAll('.map-content-wrap .path-column');
  if (pathCols.length > 1) {
    const columns = [];
    pathCols.forEach((pathCol, idx) => {
      const { title: colTitleRaw, fromPathItem, pathDescr } = getColumnTitle(pathCol);
      const colTitle = colTitleRaw || 'Spalte ' + (idx + 1);
      const boxEls = pathCol.querySelectorAll('.box-item');
      let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
      cards = dedupeFirstCardTitle(cards, !fromPathItem && !!colTitleRaw);
      if (pathDescr) {
        cards = [{ title: '', elements: [{ order: 0, type: 'richText', text: '<p>' + pathDescr + '</p>' }], role: 'importer_description' }, ...cards];
      }
      if (cards.length > 0) columns.push({ title: colTitle, cards });
    });
    if (columns.length > 0) return columns;
  }
  const boxEls = document.querySelectorAll('.map-content-wrap .box-item');
  const cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
  return [{ title: boardTitle, cards }];
}

function parseTimeline(document, usedNames) {
  const pathCols = document.querySelectorAll('.path-column');
  const columns = [];
  pathCols.forEach((pathCol, idx) => {
    const { title: colTitleRaw, fromPathItem, pathDescr } = getColumnTitle(pathCol);
    const colTitle = colTitleRaw || 'Woche ' + (idx + 1);
    const boxEls = pathCol.querySelectorAll('.box-item');
    let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
    cards = dedupeFirstCardTitle(cards, !fromPathItem && !!colTitleRaw);
    if (pathDescr) {
      cards = [{ title: '', elements: [{ order: 0, type: 'richText', text: '<p>' + pathDescr + '</p>' }], role: 'importer_description' }, ...cards];
    }
    if (cards.length > 0) columns.push({ title: colTitle, cards });
  });
  if (columns.length === 0) return parsePinboard(document, usedNames);
  return columns;
}

function parseStickerwall(document, usedNames) {
  const pathCols = document.querySelectorAll('.path-column');
  if (pathCols.length > 1) {
    const columns = [];
    pathCols.forEach((pathCol, idx) => {
      const { title: colTitleRaw, fromPathItem, pathDescr } = getColumnTitle(pathCol);
      const colTitle = colTitleRaw || 'Gruppe ' + (idx + 1);
      const boxEls = pathCol.querySelectorAll('.box-item');
      let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
      cards = dedupeFirstCardTitle(cards, !fromPathItem && !!colTitleRaw);
      if (pathDescr) {
        cards = [{ title: '', elements: [{ order: 0, type: 'richText', text: '<p>' + pathDescr + '</p>' }], role: 'importer_description' }, ...cards];
      }
      if (cards.length > 0) columns.push({ title: colTitle, cards });
    });
    if (columns.length > 0) return columns;
  }
  return parsePinboard(document, usedNames);
}

export function parseDocument(document, pathname) {
  const usedNames = new Set();
  const boardType = detectBoardType(pathname);
  const boardTitle = getBoardTitle(document);
  let columns;
  if (boardType === 'timeline')         columns = parseTimeline(document, usedNames);
  else if (boardType === 'stickerwall') columns = parseStickerwall(document, usedNames);
  else                                  columns = parsePinboard(document, usedNames);
  return { columns, boardTitle, boardType };
}
