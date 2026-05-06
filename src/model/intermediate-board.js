/**
 * Quell-agnostisches Datenmodell für Boards in der Pipeline.
 *
 * @typedef {'richText'|'link'|'file'|'internalLink'|'collaborativeTextEditor'|'videoConference'|'qrCode'} ElementType
 * @typedef {'columns'|'list'} BoardLayout
 *
 * @typedef {object} RichTextElement
 * @property {'richText'} type
 * @property {string} text - CKEditor 5 HTML
 * @property {string} [inputFormat]
 *
 * @typedef {object} LinkElement
 * @property {'link'} type
 * @property {string} url
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [imageUrl]
 *
 * @typedef {object} FileElement
 * @property {'file'} type
 * @property {string} filename
 * @property {string} [sourceUrl]   - URL für Server-Download (taskcards/padlet)
 * @property {string} [fileData]    - data: URL (base64, edumaps inline)
 * @property {string} [mimetype]
 * @property {number} [sizeBytes]
 * @property {string} [caption]
 *
 * @typedef {object} InternalLinkElement
 * @property {'internalLink'} type
 * @property {string} anchor        - z.B. '#mapanchor-123'
 * @property {string} [title]
 *
 * @typedef {object} CollaborativeTextEditorElement
 * @property {'collaborativeTextEditor'} type
 * @property {string} [title]
 * @property {string} [originalUrl] - Edumaps-Teamtext-Ursprung
 *
 * @typedef {object} VideoConferenceElement
 * @property {'videoConference'} type
 * @property {string} [title]
 *
 * @typedef {object} QrCodeElement   - transient, wird vor Export gerendert
 * @property {'qrCode'} type
 * @property {string} content        - Ziel-URL des QR-Codes
 * @property {string} filename
 * @property {string} [caption]
 *
 * @typedef {RichTextElement|LinkElement|FileElement|InternalLinkElement|CollaborativeTextEditorElement|VideoConferenceElement|QrCodeElement} Element
 *
 * @typedef {object} Card
 * @property {string} [title]
 * @property {Element[]} elements
 * @property {string} [backgroundColorRaw]   - Hex-Farbe aus Quelle
 * @property {string} [backgroundColor]      - normalisierter NBC-Palettenwert
 * @property {string} [anchorId]             - Edumaps mapanchor-ID
 * @property {string} [role]                 - intern: 'importer_description' o.ä.
 *
 * @typedef {object} Column
 * @property {string} [title]
 * @property {Card[]} cards
 *
 * @typedef {object} IntermediateBoard
 * @property {string} sourceUrl
 * @property {'edumaps'|'taskcards'|'padlet'|string} sourceType
 * @property {string} title
 * @property {BoardLayout} [layout]
 * @property {Column[]} columns
 * @property {string|null} [subtitle]
 */
