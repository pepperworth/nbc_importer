export interface EdumapsTextElement {
  order: number;
  type: 'text';
  content: string;
}

export interface EdumapsFileElement {
  order: number;
  type: 'file';
  fileName: string;
  fileInfo: string;
  content: string;
  fileData: string;
  shouldBeBold?: boolean;
}

export interface EdumapsLinkElement {
  order: number;
  type: 'link';
  url: string;
  title: string;
  content: string;
}

export interface EdumapsInternalLinkElement {
  order: number;
  type: 'internalLink';
  anchor: string;
  title: string;
  content: string;
}

// Marker für Edumaps-QR-Code-Widgets. Der Server (renderQrCodesInline)
// rendert das PNG und konvertiert das Element vor dem Upload zu einem File.
export interface EdumapsQrCodeElement {
  order: number;
  type: 'qrCode';
  content: string;   // data-url Inhalt (Quelle für den QR-Code)
  fileName: string;  // 'qrcode-N.png'
  caption: string;   // 'QR-Code → …'
}

// Edumaps-Teamtext (Etherpad auf team.edumaps.de) → NBC collaborativeTextEditor.
// Der Importer hängt nach dem Pad zusätzlich einen Link auf den Original-Pad an.
export interface EdumapsCollabTextEditorElement {
  order: number;
  type: 'collaborativeTextEditor';
  title: string;
  originalUrl: string;
  content: string;
}

export type EdumapsElement =
  | EdumapsTextElement
  | EdumapsFileElement
  | EdumapsLinkElement
  | EdumapsInternalLinkElement
  | EdumapsQrCodeElement
  | EdumapsCollabTextEditorElement;

export interface EdumapsCard {
  title: string;
  content: string;
  elements: EdumapsElement[];
  anchorId?: string;
  backgroundColorRaw?: string;
  backgroundColor?: string;
}

export interface EdumapsColumn {
  title: string;
  cards: EdumapsCard[];
}

export interface EdumapsExport {
  exportDate: string;
  version: string;
  boardTitle: string;
  totalColumns: number;
  totalCards: number;
  totalFiles: number;
  totalLinks: number;
  totalInternalLinks?: number;
  totalQrCodes?: number;
  totalCollaborativeTextEditors?: number;
  totalCardsColored?: number;
  totalVideoConferences: number;
  totalExternalTools: number;
  totalElements: number;
  columns: EdumapsColumn[];
}
