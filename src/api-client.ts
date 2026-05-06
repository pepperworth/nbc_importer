import FormData from 'form-data';

export interface ApiClientConfig {
  baseUrl: string;
  filesUrl: string;
  jwt: string;
  schoolId: string;
  dryRun: boolean;
}

interface RoomResponse {
  id: string;
}

interface BoardResponse {
  id: string;
}
interface ColumnResponse {
  id: string;
}
interface CardResponse {
  id: string;
}
interface ElementResponse {
  id: string;
}

export class ApiClient {
  constructor(private readonly cfg: ApiClientConfig) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    console.log(`  → ${method} ${path}`);

    if (this.cfg.dryRun) {
      return { id: `dry-run-${Math.random().toString(36).slice(2, 9)}` } as T;
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.jwt}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status} ${res.statusText}\n${text}`);
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T;
    }
    return res.json() as Promise<T>;
  }

  async createShareToken(parentType: 'room', parentId: string): Promise<{ token: string; expiresAt?: string }> {
    return this.request('POST', '/sharetoken', { parentType, parentId });
  }

  async createRoom(name: string): Promise<string> {
    const res = await this.request<RoomResponse>('POST', '/rooms', {
      name,
      color: 'blue-grey',
      features: [],
    });
    return res.id;
  }

  async createBoard(title: string, roomId: string): Promise<string> {
    const res = await this.request<BoardResponse>('POST', '/boards', {
      title,
      parentId: roomId,
      parentType: 'room',
      layout: 'columns',
    });
    return res.id;
  }

  async createColumn(boardId: string): Promise<string> {
    const res = await this.request<ColumnResponse>('POST', `/boards/${boardId}/columns`);
    return res.id;
  }

  async renameColumn(columnId: string, title: string): Promise<void> {
    await this.request<void>('PATCH', `/columns/${columnId}/title`, { title });
  }

  async createCard(columnId: string): Promise<string> {
    const res = await this.request<CardResponse>('POST', `/columns/${columnId}/cards`);
    return res.id;
  }

  async renameCard(cardId: string, title: string): Promise<void> {
    await this.request<void>('PATCH', `/cards/${cardId}/title`, { title });
  }

  async setCardColor(cardId: string, backgroundColor: string): Promise<void> {
    await this.request<void>('PATCH', `/cards/${cardId}/color`, { backgroundColor });
  }

  async createElement(
    cardId: string,
    type: 'richText' | 'file' | 'link' | 'collaborativeTextEditor',
    toPosition: number,
  ): Promise<string> {
    const res = await this.request<ElementResponse>('POST', `/cards/${cardId}/elements`, {
      type,
      toPosition,
    });
    return res.id;
  }

  async setRichTextContent(elementId: string, html: string): Promise<void> {
    await this.request<void>('PATCH', `/elements/${elementId}/content`, {
      data: {
        type: 'richText',
        content: {
          text: html,
          inputFormat: 'richTextCk5',
        },
      },
    });
  }

  async setLinkContent(
    elementId: string,
    url: string,
    title: string,
    description: string = '',
  ): Promise<void> {
    await this.request<void>('PATCH', `/elements/${elementId}/content`, {
      data: {
        type: 'link',
        content: { url, title, description, imageUrl: '' },
      },
    });
  }

  async setFileCaption(elementId: string, caption: string, alternativeText: string): Promise<void> {
    await this.request<void>('PATCH', `/elements/${elementId}/content`, {
      data: {
        type: 'file',
        content: { caption, alternativeText },
      },
    });
  }

  async uploadFile(
    elementId: string,
    fileName: string,
    mimeType: string,
    buffer: Buffer,
  ): Promise<void> {
    const url = `${this.cfg.filesUrl}/file/upload/school/${this.cfg.schoolId}/boardnodes/${elementId}`;
    console.log(`  → POST (upload) /file/upload/school/{schoolId}/boardnodes/${elementId}`);

    if (this.cfg.dryRun) return;

    const form = new FormData();
    form.append('file', buffer, { filename: fileName, contentType: mimeType });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.jwt}`,
        ...form.getHeaders(),
      },
      body: form.getBuffer(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`File upload failed for ${fileName} → ${res.status} ${res.statusText}\n${text}`);
    }
  }
}
