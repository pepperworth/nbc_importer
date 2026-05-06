// ==UserScript==
// @name         Edumaps Board Export [0.10]
// @namespace    https://www.edumaps.de/
// @version      0.12
// @description  Exportiert Edumaps-Boards als NBC-v0.10-JSON (inkl. Mediendateien als Base64) oder sendet direkt an NBC-Import.
// @author       Johannes Felbermair, Claude
// @match        https://www.edumaps.de/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      www.edumaps.de
// @connect      nbc.almostready.dev
// @run-at       document-idle
// ==/UserScript==

// HINWEIS: Die Parser-Funktionen (getTypeId, detectBoardType, getBoardTitle,
// uniqueFileName, extractImageElements, extractTextContent, extractLinkElements,
// extractInternalLinkElements, extractQrCodeMarkers, detectUnsupportedWidget,
// cleanTableForCk5, parseBox, parsePinboard, parseTimeline, parseStickerwall,
// hexToNbcColor, getBoxBackgroundColor, buildExport, collectMediaUrls,
// injectFileData, stripInternalFields) sind mit edumaps-parser.js gespiegelt.
// Bei inhaltlichen Änderungen beide pflegen.


(function () {
    'use strict';

    const CONFIG = {
        DEBUG: true,
        TIMELINE_TYPES: ['34'],
        STICKERWALL_TYPES: ['22']
    };

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

    function log(...args) {
        if (CONFIG.DEBUG) console.log('[Edumaps Export 0.10]', ...args);
    }

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
    function injectAnchorPlaceholders(html) {
        // href="#anker" → href="__ANCHOR__anker" — wird nach dem Import aufgelöst
        return html.replace(/href="#([^"]+)"/g, 'href="__ANCHOR__$1"');
    }
    function hasInlineOnlyLinks(li) {
        const puretext = li.querySelector('.line-puretext');
        if (!puretext) return false;
        const anchors = puretext.querySelectorAll('a.inline.selfopener[href^="#"]');
        if (!anchors.length) return false;
        if (puretext.querySelector('ol, ul')) return false;
        return anchors.length === 1;
    }
    function getBoxAnchorId(boxEl) {
        const span = boxEl.querySelector('span.mapanchor[id]');
        return span ? span.id : null;
    }

    // --- Karten-Hintergrundfarbe (Edumaps → NBC) ---
    // Edumaps speichert sie als inline style="background:#xxxxxx" auf h3.boxlabel.
    // NBC akzeptiert nur 20 Material-Farbnamen — wir mappen perzeptuell via
    // CIE-Lab Nearest-Neighbor (CIE76). Pro CardColor stehen alle 10 Vuetify-
    // Schattierungen (lighten5..1, base, darken1..4) als Anker zur Verfügung —
    // sonst landen Pastelle systematisch auf grey. Algorithmus portiert aus
    // app/pipeline/colors.py (steedalot/nbcimport, fix b2e13f10).
    const PALETTE_ANCHORS = [
        ['red','#ffebee'],['red','#ffcdd2'],['red','#ef9a9a'],['red','#e57373'],
        ['red','#ef5350'],['red','#f44336'],['red','#e53935'],['red','#d32f2f'],
        ['red','#c62828'],['red','#b71c1c'],
        ['pink','#fce4ec'],['pink','#f8bbd0'],['pink','#f48fb1'],['pink','#f06292'],
        ['pink','#ec407a'],['pink','#e91e63'],['pink','#d81b60'],['pink','#c2185b'],
        ['pink','#ad1457'],['pink','#880e4f'],
        ['purple','#f3e5f5'],['purple','#e1bee7'],['purple','#ce93d8'],['purple','#ba68c8'],
        ['purple','#ab47bc'],['purple','#9c27b0'],['purple','#8e24aa'],['purple','#7b1fa2'],
        ['purple','#6a1b9a'],['purple','#4a148c'],
        ['deepPurple','#ede7f6'],['deepPurple','#d1c4e9'],['deepPurple','#b39ddb'],['deepPurple','#9575cd'],
        ['deepPurple','#7e57c2'],['deepPurple','#673ab7'],['deepPurple','#5e35b1'],['deepPurple','#512da8'],
        ['deepPurple','#4527a0'],['deepPurple','#311b92'],
        ['indigo','#e8eaf6'],['indigo','#c5cae9'],['indigo','#9fa8da'],['indigo','#7986cb'],
        ['indigo','#5c6bc0'],['indigo','#3f51b5'],['indigo','#3949ab'],['indigo','#303f9f'],
        ['indigo','#283593'],['indigo','#1a237e'],
        ['blue','#e3f2fd'],['blue','#bbdefb'],['blue','#90caf9'],['blue','#64b5f6'],
        ['blue','#42a5f5'],['blue','#2196f3'],['blue','#1e88e5'],['blue','#1976d2'],
        ['blue','#1565c0'],['blue','#0d47a1'],
        ['lightBlue','#e1f5fe'],['lightBlue','#b3e5fc'],['lightBlue','#81d4fa'],['lightBlue','#4fc3f7'],
        ['lightBlue','#29b6f6'],['lightBlue','#03a9f4'],['lightBlue','#039be5'],['lightBlue','#0288d1'],
        ['lightBlue','#0277bd'],['lightBlue','#01579b'],
        ['cyan','#e0f7fa'],['cyan','#b2ebf2'],['cyan','#80deea'],['cyan','#4dd0e1'],
        ['cyan','#26c6da'],['cyan','#00bcd4'],['cyan','#00acc1'],['cyan','#0097a7'],
        ['cyan','#00838f'],['cyan','#006064'],
        ['teal','#e0f2f1'],['teal','#b2dfdb'],['teal','#80cbc4'],['teal','#4db6ac'],
        ['teal','#26a69a'],['teal','#009688'],['teal','#00897b'],['teal','#00796b'],
        ['teal','#00695c'],['teal','#004d40'],
        ['green','#e8f5e9'],['green','#c8e6c9'],['green','#a5d6a7'],['green','#81c784'],
        ['green','#66bb6a'],['green','#4caf50'],['green','#43a047'],['green','#388e3c'],
        ['green','#2e7d32'],['green','#1b5e20'],
        ['lightGreen','#f1f8e9'],['lightGreen','#dcedc8'],['lightGreen','#c5e1a5'],['lightGreen','#aed581'],
        ['lightGreen','#9ccc65'],['lightGreen','#8bc34a'],['lightGreen','#7cb342'],['lightGreen','#689f38'],
        ['lightGreen','#558b2f'],['lightGreen','#33691e'],
        ['lime','#f9fbe7'],['lime','#f0f4c3'],['lime','#e6ee9c'],['lime','#dce775'],
        ['lime','#d4e157'],['lime','#cddc39'],['lime','#c0ca33'],['lime','#afb42b'],
        ['lime','#9e9d24'],['lime','#827717'],
        ['yellow','#fffde7'],['yellow','#fff9c4'],['yellow','#fff59d'],['yellow','#fff176'],
        ['yellow','#ffee58'],['yellow','#ffeb3b'],['yellow','#fdd835'],['yellow','#fbc02d'],
        ['yellow','#f9a825'],['yellow','#f57f17'],
        ['amber','#fff8e1'],['amber','#ffecb3'],['amber','#ffe082'],['amber','#ffd54f'],
        ['amber','#ffca28'],['amber','#ffc107'],['amber','#ffb300'],['amber','#ffa000'],
        ['amber','#ff8f00'],['amber','#ff6f00'],
        ['orange','#fff3e0'],['orange','#ffe0b2'],['orange','#ffcc80'],['orange','#ffb74d'],
        ['orange','#ffa726'],['orange','#ff9800'],['orange','#fb8c00'],['orange','#f57c00'],
        ['orange','#ef6c00'],['orange','#e65100'],
        ['deepOrange','#fbe9e7'],['deepOrange','#ffccbc'],['deepOrange','#ffab91'],['deepOrange','#ff8a65'],
        ['deepOrange','#ff7043'],['deepOrange','#ff5722'],['deepOrange','#f4511e'],['deepOrange','#e64a19'],
        ['deepOrange','#d84315'],['deepOrange','#bf360c'],
        ['brown','#efebe9'],['brown','#d7ccc8'],['brown','#bcaaa4'],['brown','#a1887f'],
        ['brown','#8d6e63'],['brown','#795548'],['brown','#6d4c41'],['brown','#5d4037'],
        ['brown','#4e342e'],['brown','#3e2723'],
        // grey: #fafafa und #f5f5f5 fehlen absichtlich — fängt isWhiteish() ab.
        ['grey','#eeeeee'],['grey','#e0e0e0'],['grey','#bdbdbd'],['grey','#9e9e9e'],
        ['grey','#757575'],['grey','#616161'],['grey','#424242'],['grey','#212121'],
        ['blueGrey','#eceff1'],['blueGrey','#cfd8dc'],['blueGrey','#b0bec5'],['blueGrey','#90a4ae'],
        ['blueGrey','#78909c'],['blueGrey','#607d8b'],['blueGrey','#546e7a'],['blueGrey','#455a64'],
        ['blueGrey','#37474f'],['blueGrey','#263238'],
    ];
    function parseHex(value) {
        const s = String(value || '').trim();
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
        const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
        const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000;
        const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
        const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
        const fx = f(x), fy = f(y), fz = f(z);
        return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    }
    const PALETTE_LAB = PALETTE_ANCHORS.map(([n, hex]) => [n, rgbToLab(...parseHex(hex))]);
    function hexToNbcColor(value) {
        if (value == null) return null;
        const s = String(value).trim().toLowerCase();
        if (!s) return null;
        if (s === 'transparent') return 'transparent';
        const rgb = parseHex(s);
        if (rgb === null) return null;
        if (Math.min(...rgb) >= 240 && Math.max(...rgb) - Math.min(...rgb) <= 8) return 'transparent';
        const target = rgbToLab(...rgb);
        let best = null, bestD2 = Infinity;
        for (const [n, lab] of PALETTE_LAB) {
            const dl = target[0] - lab[0], da = target[1] - lab[1], db = target[2] - lab[2];
            const d2 = dl * dl + da * da + db * db;
            if (d2 < bestD2) { bestD2 = d2; best = n; }
        }
        return best;
    }
    function getBoxBackgroundColor(boxEl) {
        const candidates = [
            boxEl.querySelector('h3.boxlabel[style*="background"]'),
            boxEl.querySelector('.boxhead[style*="background"]'),
            (boxEl.matches && boxEl.matches('[style*="background"]')) ? boxEl : null,
        ];
        for (const el of candidates) {
            if (!el) continue;
            const m = (el.getAttribute('style') || '').match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/);
            if (m) return m[1];
        }
        return null;
    }

    // --- Fortschritts-UI ---
    // Zeigt eine mehrzeilige Box: Statuszeile + optionaler Fortschrittsbalken
    function getOrCreateProgressUI() {
        let box = document.getElementById('em-export-status');
        if (!box) {
            box = document.createElement('div');
            box.id = 'em-export-status';
            Object.assign(box.style, {
                position: 'fixed',
                top: '20px',
                right: '20px',
                padding: '10px 14px',
                borderRadius: '6px',
                zIndex: 2147483647,
                color: '#fff',
                fontSize: '13px',
                maxWidth: '340px',
                wordBreak: 'break-word',
                fontFamily: 'monospace',
                lineHeight: '1.5',
                boxShadow: '0 3px 10px rgba(0,0,0,0.3)'
            });

            const statusLine = document.createElement('div');
            statusLine.id = 'em-status-line';
            box.appendChild(statusLine);

            const barWrap = document.createElement('div');
            barWrap.id = 'em-bar-wrap';
            Object.assign(barWrap.style, {
                marginTop: '6px',
                background: 'rgba(255,255,255,0.25)',
                borderRadius: '3px',
                height: '6px',
                display: 'none'
            });
            const bar = document.createElement('div');
            bar.id = 'em-bar';
            Object.assign(bar.style, {
                height: '100%',
                borderRadius: '3px',
                background: '#fff',
                width: '0%',
                transition: 'width 0.2s'
            });
            barWrap.appendChild(bar);
            box.appendChild(barWrap);

            const subLine = document.createElement('div');
            subLine.id = 'em-sub-line';
            Object.assign(subLine.style, { fontSize: '11px', opacity: '0.85', marginTop: '3px', display: 'none' });
            box.appendChild(subLine);

            document.body.appendChild(box);
        }
        return box;
    }

    function notify(msg, type = 'info', progress = null, subtext = null) {
        const box = getOrCreateProgressUI();
        box.style.background = type === 'error' ? '#f44336' : type === 'success' ? '#4caf50' : '#2196f3';

        document.getElementById('em-status-line').textContent = msg;

        const barWrap = document.getElementById('em-bar-wrap');
        const bar     = document.getElementById('em-bar');
        if (progress !== null) {
            barWrap.style.display = 'block';
            bar.style.width = Math.round(progress * 100) + '%';
        } else {
            barWrap.style.display = 'none';
        }

        const subLine = document.getElementById('em-sub-line');
        if (subtext) {
            subLine.style.display = 'block';
            subLine.textContent = subtext;
        } else {
            subLine.style.display = 'none';
        }
    }

    // --- Board-Typ-ID aus URL ---
    function getTypeId() {
        const parts = location.pathname.split('/').filter(Boolean);
        for (const part of parts) {
            if (/^\d+$/.test(part)) return part;
        }
        return null;
    }

    function detectBoardType() {
        const id = getTypeId();
        if (!id) return null;
        if (CONFIG.TIMELINE_TYPES.includes(id)) return 'timeline';
        if (CONFIG.STICKERWALL_TYPES.includes(id)) return 'stickerwall';
        return 'pinboard';
    }

    // --- Board-Titel ---
    function getBoardTitle() {
        const headline = document.querySelector('h1.mapeditor-headline');
        if (headline) return headline.textContent.trim();
        const h1 = document.querySelector('h1');
        if (h1) return h1.textContent.trim();
        return document.title.replace(/\s*[|\-–]\s*edumaps.*/i, '').trim() || 'Edumaps Board';
    }

    // --- Eindeutigen Dateinamen im media/-Ordner sicherstellen ---
    function uniqueFileName(name, usedNames) {
        if (!usedNames.has(name)) { usedNames.add(name); return name; }
        const dot = name.lastIndexOf('.');
        const base = dot >= 0 ? name.slice(0, dot) : name;
        const ext  = dot >= 0 ? name.slice(dot) : '';
        let i = 2;
        while (usedNames.has(`${base}_${i}${ext}`)) i++;
        const unique = `${base}_${i}${ext}`;
        usedNames.add(unique);
        return unique;
    }

    // --- Bilder aus einer Box extrahieren ---
    // Gibt Elemente zurück; _originalUrl wird später zum Herunterladen genutzt.
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
            elements.push({
                order: order++,
                type: 'file',
                fileName,
                fileInfo: 'Bild, Edumaps',
                content: `📎 ${fileName}`,
                shouldBeBold: true,
                _originalUrl: href
            });
        });

        // Direkt eingebettete Bilder (nicht schon über a.mediaitem-img erfasst)
        const seenHrefs = new Set(elements.map(e => e._originalUrl));
        boxEl.querySelectorAll('img[src]').forEach(img => {
            const src = img.getAttribute('src') || '';
            if (!src.includes('/file/') && !src.includes('/upload/')) return;
            if (src.includes('preview') || src.includes('thumb')) return;
            if (seenHrefs.has(src)) return;
            seenHrefs.add(src);

            const baseName = src.split('/').pop().split('?')[0] || 'bild.png';
            const fileName = uniqueFileName(baseName, usedNames);
            elements.push({
                order: order++,
                type: 'file',
                fileName,
                fileInfo: 'Bild, Edumaps',
                content: `📎 ${fileName}`,
                shouldBeBold: true,
                _originalUrl: src
            });
        });

        return elements;
    }

    // --- Text-HTML aus einer Box bereinigen ---
    // Sammelt Inhalte als (html, isBlock)-Paare. Block-Elemente (<table>, <blockquote>,
    // Widget-Warnungen) dürfen nicht in <p> stehen — CKEditor-5 würde die Tabelle
    // sonst beim Laden verlieren.
    function extractTextContent(boxEl) {
        const parts = [];
        boxEl.querySelectorAll('li.itemline').forEach(li => {
            if (li.querySelector('a.mediaitem-img')) return;
            if (li.querySelector('a[class*="mediaitem-"]')) return;
            if (hasInlineOnlyLinks(li)) return;
            const puretext = li.querySelector('.line-puretext');
            if (puretext) {
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
                if (html !== '&nbsp;' && html !== '' && html.replace(/\s/g, '') !== '') {
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
            }
        });
        if (!parts.length) return '';
        return parts.map(p => p.isBlock ? p.html : '<p>' + p.html + '</p>').join('');
    }

    // --- Links (YouTube, externe URLs, Teamtext) aus einer Box extrahieren ---
    function extractLinkElements(boxEl, startOrder) {
        const elements = [];
        let order = startOrder;

        boxEl.querySelectorAll('li.itemline a[class*="mediaitem-"]').forEach(a => {
            if (a.classList.contains('mediaitem-img')) return; // Bilder separat
            const href = a.getAttribute('href') || '';
            if (!href) return;

            // Edumaps-Teamtext (team.edumaps.de/p/…) → CollabTextEditor in NBC.
            // Der Server hängt zusätzlich einen Link auf den Original-Pad an.
            if (TEAMTEXT_RE.test(href)) {
                const innerSpan = a.querySelector('span');
                const padTitle = (innerSpan && innerSpan.textContent ? innerSpan.textContent.trim() : '') || 'Teamtext';
                elements.push({
                    order: order++,
                    type: 'collaborativeTextEditor',
                    title: padTitle,
                    originalUrl: href,
                    content: `📝 ${padTitle}`
                });
                return;
            }

            // Titel: aria-label bereinigen, sonst sichtbarer Text
            let title = (a.getAttribute('aria-label') || '').replace(/^Externen Link öffnen\s*[-–]\s*/i, '').trim();
            if (!title) title = a.textContent.replace(/\s+/g, ' ').trim();
            if (!title) title = href;

            elements.push({
                order: order++,
                type: 'link',
                url: href,
                title,
                content: `🔗 ${title}`
            });
        });

        return elements;
    }

    // --- Einzelne interne Karten-Links → eigene internalLink-Elemente ---
    function extractInternalLinkElements(boxEl, startOrder) {
        const elements = [];
        let order = startOrder;
        boxEl.querySelectorAll('li.itemline').forEach(li => {
            if (!hasInlineOnlyLinks(li)) return;
            const a = li.querySelector('a.inline.selfopener[href^="#"]');
            const anchor = a.getAttribute('href') || '';
            if (!anchor || anchor === '#') return;
            const title = a.textContent.replace(/\s+/g, ' ').trim() || anchor;
            elements.push({ order: order++, type: 'internalLink', anchor, title, content: `↩ ${title}` });
        });
        return elements;
    }

    // --- QR-Code-Marker (Server rendert das PNG) ---
    function extractQrCodeMarkers(boxEl, startOrder) {
        const elements = [];
        let order = startOrder;
        findQrCodes(boxEl).forEach(({ content, index }) => {
            const fileName = `qrcode-${index}.png`;
            elements.push({
                order: order++,
                type: 'qrCode',
                content,
                fileName,
                caption: `QR-Code → ${content}`
            });
        });
        return elements;
    }

    // --- Eine Box in eine NBC-Karte umwandeln ---
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

        const content = elements.map(e => e.content || '').join('');
        const card = { title, elements, content };
        if (anchorId) card.anchorId = anchorId;
        if (rawColor) card.backgroundColorRaw = rawColor;
        if (mappedColor) card.backgroundColor = mappedColor;
        return card;
    }

    // Edumaps-UI zeigt nur einen Spalten-Header — bei leerem .path-item wird der
    // Titel aus dem h3.boxlabel der ersten Karte abgeleitet, und die erste Karte
    // selbst trägt im UI keinen sichtbaren Titel mehr (sie wird quasi zum Header).
    // In NBC würde das ohne Eingriff doppelt erscheinen: Spalten-Header + Karten-
    // Titel mit identischem Text. Wir spiegeln das Edumaps-Verhalten:
    //   - Karte hat keinen sonstigen Inhalt → komplett weglassen
    //   - Karte hat Inhalt → nur den Titel leeren
    function dedupeFirstCardTitle(cards, sourceWasFirstLabel) {
        if (!sourceWasFirstLabel || cards.length === 0) return cards;
        const first = cards[0];
        if (!first.title) return cards;
        if (first.elements.length === 0) return cards.slice(1);
        first.title = '';
        return cards;
    }

    // --- Parser: Pinnwand ---
    function parsePinboard(usedNames) {
        const boardTitle = getBoardTitle();
        const pathCols = document.querySelectorAll('.map-content-wrap .path-column');
        log(`Pinnwand-Parser: ${pathCols.length} path-columns`);

        if (pathCols.length > 1) {
            const columns = [];
            pathCols.forEach((pathCol, idx) => {
                const pathItem = pathCol.querySelector('.path-item');
                const pathItemText = pathItem?.textContent?.trim() || '';
                const firstLabel = pathCol.querySelector('h3.boxlabel');
                const firstLabelText = firstLabel ? firstLabel.textContent.trim() : '';
                const colTitle = pathItemText || firstLabelText || `Spalte ${idx + 1}`;
                const boxEls = pathCol.querySelectorAll('.box-item');
                let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
                cards = dedupeFirstCardTitle(cards, !pathItemText && !!firstLabelText);
                if (cards.length > 0) columns.push({ title: colTitle, cards });
            });
            if (columns.length > 0) return columns;
        }

        const boxEls = document.querySelectorAll('.map-content-wrap .box-item');
        log(`Pinnwand-Parser Fallback: ${boxEls.length} Boxen`);
        const cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
        return [{ title: boardTitle, cards }];
    }

    // --- Parser: Zeitstrahl (Typ 34) ---
    function parseTimeline(usedNames) {
        const pathCols = document.querySelectorAll('.path-column');
        log(`Zeitstrahl-Parser: ${pathCols.length} path-columns`);
        const columns = [];

        pathCols.forEach((pathCol, idx) => {
            const pathWrap = pathCol.querySelector('.path-wrap .path-item');
            const pathItemText = pathWrap ? pathWrap.textContent.trim() : '';
            const firstLabel = pathCol.querySelector('h3.boxlabel');
            const firstLabelText = firstLabel ? firstLabel.textContent.trim() : '';
            const colTitle = pathItemText || firstLabelText || `Woche ${idx + 1}`;
            const boxEls = pathCol.querySelectorAll('.box-item');
            let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
            cards = dedupeFirstCardTitle(cards, !pathItemText && !!firstLabelText);
            if (cards.length > 0) columns.push({ title: colTitle, cards });
        });

        if (columns.length === 0) return parsePinboard(usedNames);
        return columns;
    }

    // --- Parser: Stickerwand (Typ 22) ---
    function parseStickerwall(usedNames) {
        const pathCols = document.querySelectorAll('.path-column');
        if (pathCols.length > 1) {
            const columns = [];
            pathCols.forEach((pathCol, idx) => {
                const pathItem = pathCol.querySelector('.path-item');
                const pathItemText = pathItem?.textContent?.trim() || '';
                const firstLabel = pathCol.querySelector('h3.boxlabel');
                const firstLabelText = firstLabel ? firstLabel.textContent.trim() : '';
                const colTitle = pathItemText || firstLabelText || `Gruppe ${idx + 1}`;
                const boxEls = pathCol.querySelectorAll('.box-item');
                let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
                cards = dedupeFirstCardTitle(cards, !pathItemText && !!firstLabelText);
                if (cards.length > 0) columns.push({ title: colTitle, cards });
            });
            if (columns.length > 0) return columns;
        }
        return parsePinboard(usedNames);
    }

    // --- Export-JSON bauen (NBC v0.11 Schema) ---
    function buildExport(columns, boardTitle) {
        let totalCards = 0, totalElements = 0, totalFiles = 0, totalLinks = 0,
            totalInternalLinks = 0, totalQrCodes = 0, totalCollaborativeTextEditors = 0,
            totalCardsColored = 0;
        columns.forEach(col => {
            col.cards.forEach(card => {
                totalCards++;
                if (card.backgroundColor && card.backgroundColor !== 'transparent') totalCardsColored++;
                (card.elements || []).forEach(el => {
                    totalElements++;
                    if (el.type === 'file') totalFiles++;
                    if (el.type === 'link') totalLinks++;
                    if (el.type === 'internalLink') totalInternalLinks++;
                    if (el.type === 'qrCode') totalQrCodes++;
                    if (el.type === 'collaborativeTextEditor') totalCollaborativeTextEditors++;
                });
            });
        });
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
            columns
        };
    }

    // --- ArrayBuffer → Base64-Data-URL ---
    function bufferToDataUrl(buffer, fileName) {
        const ext = (fileName.split('.').pop() || 'bin').toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                       gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
                       pdf: 'application/pdf' }[ext] || 'application/octet-stream';
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return `data:${mime};base64,${btoa(binary)}`;
    }

    // --- Eine Datei per GM_xmlhttpRequest als ArrayBuffer laden ---
    function fetchBlob(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                onload(res) {
                    if (res.status >= 200 && res.status < 300) {
                        resolve(res.response);
                    } else {
                        reject(new Error(`HTTP ${res.status}`));
                    }
                },
                onerror() { reject(new Error(`Netzwerkfehler: ${url}`)); }
            });
        });
    }

    // --- Alle Medien-URLs aus den geparsten Spalten sammeln ---
    function collectMediaUrls(columns) {
        const map = new Map(); // fileName → originalUrl
        columns.forEach(col => {
            col.cards.forEach(card => {
                (card.elements || []).forEach(el => {
                    if (el.type === 'file' && el._originalUrl) {
                        map.set(el.fileName, el._originalUrl);
                    }
                });
            });
        });
        return map;
    }

    // --- _originalUrl aus Export-Objekt entfernen ---
    function stripInternalFields(columns) {
        columns.forEach(col => {
            col.cards.forEach(card => {
                (card.elements || []).forEach(el => { delete el._originalUrl; });
            });
        });
    }

    // --- fileData in Elementen nachträglich setzen ---
    function injectFileData(columns, dataMap) {
        columns.forEach(col => {
            col.cards.forEach(card => {
                (card.elements || []).forEach(el => {
                    if (el.type === 'file' && dataMap.has(el.fileName)) {
                        el.fileData = dataMap.get(el.fileName);
                    }
                });
            });
        });
    }

    async function prepareExportData() {
        notify('Board wird geparst…');
        const boardType = detectBoardType();
        const boardTitle = getBoardTitle();
        log(`Board-Typ: ${boardType}, Titel: ${boardTitle}`);

        const usedNames = new Set();
        let columns;
        if (boardType === 'timeline')         columns = parseTimeline(usedNames);
        else if (boardType === 'stickerwall') columns = parseStickerwall(usedNames);
        else                                  columns = parsePinboard(usedNames);

        if (!columns || columns.length === 0 || columns.every(c => c.cards.length === 0)) {
            notify('Keine Inhalte gefunden. Debug-Button für Details klicken.', 'error');
            return null;
        }

        const mediaMap = collectMediaUrls(columns);
        const mediaEntries = Array.from(mediaMap.entries());
        const total = mediaEntries.length;
        log(`${total} Mediendateien gefunden. Starte Downloads…`);

        const dataMap = new Map();
        const failed = [];

        for (let i = 0; i < total; i++) {
            const [fileName, url] = mediaEntries[i];
            notify(`Lade Medien… (${i}/${total})`, 'info', i / total, fileName);
            log(`[${i + 1}/${total}] ${fileName}`);
            try {
                const buffer = await fetchBlob(url);
                dataMap.set(fileName, bufferToDataUrl(buffer, fileName));
                log(`  ✓ (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
            } catch (e) {
                failed.push(fileName);
                log(`  ✗ ${e.message}`);
            }
        }

        const exportData = buildExport(columns, boardTitle);
        injectFileData(exportData.columns, dataMap);
        stripInternalFields(exportData.columns);
        exportData.sourceUrl = location.href;

        return { exportData, total, failed };
    }

    // --- Haupt-Export ---
    async function exportBoard() {
        const t0 = Date.now();
        try {
            const result = await prepareExportData();
            if (!result) return;
            const { exportData, total, failed } = result;

            const json = JSON.stringify(exportData, null, 2);
            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            a.download = `edumaps-export-v0.10-${timestamp}.json`;
            a.click();
            URL.revokeObjectURL(a.href);

            const totalMs = Date.now() - t0;
            const failMsg = failed.length ? ` (${failed.length} Fehler)` : '';
            notify(
                `Fertig: ${exportData.totalCards} Karten, ${total} Bilder${failMsg} — ${(totalMs / 1000).toFixed(1)} s`,
                failed.length ? 'error' : 'success',
                null,
                failed.length ? `Fehler: ${failed.join(', ')}` : null
            );

            console.group('[Edumaps Export 0.10] Export-Zusammenfassung');
            console.log(`Gesamt: ${totalMs} ms | Karten: ${exportData.totalCards} | Bilder: ${total} | JSON: ${(blob.size / 1024).toFixed(0)} KB`);
            if (failed.length) console.warn('Fehlgeschlagene Downloads:', failed);
            console.groupEnd();

        } catch (e) {
            log('Export-Fehler:', e);
            notify('Export fehlgeschlagen: ' + (e.message || e), 'error');
        }
    }

    // --- Debug ---
    function debugBoard() {
        const info = {
            boardType: detectBoardType(),
            typeId: getTypeId(),
            boardTitle: getBoardTitle(),
            url: location.href,
            boxItems: document.querySelectorAll('.box-item').length,
            pathColumns: document.querySelectorAll('.path-column').length,
            boxlabels: Array.from(document.querySelectorAll('h3.boxlabel')).map(h => h.textContent.trim()),
            mediaitemImgs: document.querySelectorAll('a.mediaitem-img').length,
            itemlines: document.querySelectorAll('li.itemline').length
        };
        console.group('[Edumaps Export 0.10] DEBUG');
        console.log(info);
        console.groupEnd();
        notify(`Debug: ${info.boxItems} Boxen, ${info.pathColumns} Spalten — siehe Konsole`, 'info');
    }

    const NBC_IMPORT_URL = 'https://nbc.almostready.dev/api/ingest/edumaps';

    async function sendToNbc(exportData) {
        let jwt = GM_getValue('nbc_jwt', '');
        if (!jwt) {
            jwt = prompt('NBC JWT-Token eingeben:\n(F12 → Application → Cookies → niedersachsen.cloud → jwt)');
            if (!jwt || !jwt.trim()) return;
            GM_setValue('nbc_jwt', jwt.trim());
        } else {
            const useSaved = confirm('Gespeicherter JWT gefunden. Verwenden?\n\nAbbrechen = neuen Token eingeben.');
            if (!useSaved) {
                jwt = prompt('Neuen NBC JWT-Token eingeben:', jwt);
                if (!jwt || !jwt.trim()) return;
                GM_setValue('nbc_jwt', jwt.trim());
            }
        }
        jwt = jwt.trim();

        const importColors = confirm('Karten-Farben aus Edumaps übernehmen?\n(Edumaps färbt nur den Titel-Streifen, NBC die ganze Karte.)');
        const omitWidgetWarnings = confirm('Platzhalter für nicht abbildbare Module (Quiz, Umfrage, …) weglassen?\n(Ohne = Hinweis-Zeile in der Karte.)');
        const addSummaryCard = confirm('Zusammenfassungs-Spalte voranstellen?\n(Quell-URL + Etherpad-Links als erste Spalte.)');

        notify('Sende an NBC-Import …', 'info');

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: NBC_IMPORT_URL,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({
                    jwt,
                    payload: exportData,
                    importColors,
                    omitWidgetWarnings,
                    addSummaryCard,
                }),
                onload(resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        try {
                            const result = JSON.parse(resp.responseText);
                            notify('Import gestartet!', 'success');
                            if (result.statusUrl) {
                                window.open(result.statusUrl, '_blank');
                            }
                            resolve(result);
                        } catch (e) {
                            notify('Antwort konnte nicht gelesen werden.', 'error');
                            reject(e);
                        }
                    } else {
                        let detail = '';
                        try { detail = JSON.parse(resp.responseText).error || ''; } catch {}
                        notify(`Fehler ${resp.status}: ${detail || resp.statusText}`, 'error');
                        if (resp.status === 400 && detail.includes('JWT')) {
                            GM_setValue('nbc_jwt', '');
                        }
                        reject(new Error(`${resp.status}: ${detail}`));
                    }
                },
                onerror(err) {
                    notify('Netzwerkfehler beim Senden an NBC.', 'error');
                    reject(err);
                },
            });
        });
    }

    // --- UI ---
    function addStyles() {
        if (document.getElementById('em-export-styles')) return;
        const style = document.createElement('style');
        style.id = 'em-export-styles';
        style.textContent = `
            #em-export-ui button {
                width: 48px; height: 48px;
                border: none; border-radius: 50%;
                display: flex; flex-direction: column;
                align-items: center; justify-content: center;
                font-size: 20px; cursor: pointer; color: #fff;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            }
            #em-export-ui .em-export-btn { background: #2196f3; }
            #em-export-ui .em-debug-btn  { background: #ff9800; }
            #em-export-ui .em-send-btn   { background: #4caf50; }
            #em-export-ui button .em-letter { font-size: 10px; line-height: 1; }
        `;
        document.head.appendChild(style);
    }

    function initUI() {
        if (document.getElementById('em-export-ui')) return;
        if (!detectBoardType()) return;

        addStyles();

        const wrapper = document.createElement('div');
        wrapper.id = 'em-export-ui';
        Object.assign(wrapper.style, {
            position: 'fixed', bottom: '20px', right: '20px',
            zIndex: 2147483647, display: 'flex', gap: '8px',
            flexDirection: 'column', alignItems: 'center'
        });

        const expBtn = document.createElement('button');
        expBtn.className = 'em-export-btn';
        expBtn.title = 'Edumaps Board als JSON exportieren (inkl. Bilder als Base64)';
        expBtn.innerHTML = `<span class="em-letter">E</span>📤`;
        expBtn.addEventListener('click', exportBoard);

        const sendBtn = document.createElement('button');
        sendBtn.className = 'em-send-btn';
        sendBtn.title = 'Direkt an NBC-Import senden (JWT nötig)';
        sendBtn.innerHTML = `<span class="em-letter">S</span>🚀`;
        sendBtn.addEventListener('click', async () => {
            try {
                const data = await prepareExportData();
                if (!data) return;
                await sendToNbc(data);
            } catch (e) {
                log('Senden fehlgeschlagen:', e);
            }
        });

        const dbgBtn = document.createElement('button');
        dbgBtn.className = 'em-debug-btn';
        dbgBtn.title = 'Debug: Board-Struktur in Konsole ausgeben';
        dbgBtn.innerHTML = `<span class="em-letter">D</span>🐞`;
        dbgBtn.addEventListener('click', debugBoard);

        wrapper.append(expBtn, sendBtn, dbgBtn);
        document.body.appendChild(wrapper);
        log('UI initialisiert, Board-Typ:', detectBoardType());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(initUI, 1500));
    } else {
        setTimeout(initUI, 1500);
    }
    setTimeout(initUI, 4000);

})();
