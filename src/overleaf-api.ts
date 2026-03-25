import fetch, { Response } from 'node-fetch';
import FormData from 'form-data';
import { lookup as lookupMimeType } from 'mime-types';
import { OverleafCredentials } from './types';

interface Identity {
  csrfToken: string;
  cookies: string;
}

export interface FileEntity {
  _id: string;
  name: string;
  _type: 'doc' | 'file' | 'folder';
  mtime?: number;
}

export interface FolderEntity extends FileEntity {
  docs: FileEntity[];
  fileRefs: FileEntity[];
  folders: FolderEntity[];
}

export interface ProjectEntity {
  _id: string;
  name: string;
  rootFolder: FolderEntity[];
}

export class OverleafAPI {
  private baseUrl: string;
  private identity?: Identity;
  private readonly projectId: string;
  private socketCookieRefreshed = false;

  constructor(private readonly credentials: OverleafCredentials) {
    this.baseUrl = `https://${credentials.serverName}`;
    this.projectId = credentials.projectId;

    if (credentials.cookie) {
      this.identity = {
        csrfToken: extractCsrfFromCookie(credentials.cookie) || '',
        cookies: credentials.cookie,
      };
    }
  }

  async testAuth(): Promise<boolean> {
    try {
      if (!this.credentials.cookie) {
        return false;
      }
      const response = await fetch(`${this.baseUrl}/project`, {
        method: 'GET',
        headers: {
          'Cookie': this.credentials.cookie,
        },
      });

      if (!response.ok) {
        return false;
      }

      const html = await response.text();
      return /name="ol-user_id"/i.test(html);
    } catch {
      return false;
    }
  }

  async getProject(): Promise<ProjectEntity> {
    return this.joinProjectViaSocket();
  }

  async getFile(fileId: string): Promise<Buffer> {
    const response = await this.request('GET', `/project/${this.projectId}/file/${fileId}`);
    return response.buffer();
  }

  async getDoc(docId: string): Promise<string> {
    try {
      const response = await this.request('GET', `/project/${this.projectId}/doc/${docId}`);
      const text = await response.text();
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const parsed = JSON.parse(text) as any;
        if (typeof parsed.content === 'string') {
          return parsed.content;
        }
        if (Array.isArray(parsed.lines)) {
          return parsed.lines.join('\n');
        }
      }

      return text;
    } catch {
      return this.joinDocViaSocket(docId);
    }
  }

  async uploadFile(
    parentFolderId: string,
    filename: string,
    content: Uint8Array
  ): Promise<FileEntity> {
    const identity = await this.ensureIdentity();

    const fileBuffer = Buffer.from(content);
    const formData = new FormData();
    const mimeType = lookupMimeType(filename) || 'application/octet-stream';

    formData.append('targetFolderId', parentFolderId);
    formData.append('name', filename);
    formData.append('type', mimeType);
    formData.append('qqfile', fileBuffer, {
      filename,
      contentType: mimeType,
      knownLength: fileBuffer.length,
    });

    const response = await this.request(
      'POST',
      `/project/${this.projectId}/upload?folder_id=${encodeURIComponent(parentFolderId)}`,
      {
        headers: {
          'X-Csrf-Token': identity.csrfToken,
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    const result = await response.json() as any;
    const entityType = result.entity_type || result._type || 'file';
    const entityId = result.entity_id || result._id;

    return {
      _type: entityType,
      _id: entityId,
      name: filename,
    };
  }

  async createDoc(parentFolderId: string, filename: string): Promise<FileEntity> {
    const response = await this.request(
      'POST',
      `/project/${this.projectId}/doc`,
      {
        json: {
          parent_folder_id: parentFolderId,
          name: filename,
        },
      }
    );

    const result = await response.json() as any;
    return {
      _type: 'doc',
      _id: result._id,
      name: filename,
    };
  }

  async updateDoc(docId: string, content: string): Promise<void> {
    await this.request(
      'POST',
      `/project/${this.projectId}/doc/${docId}`,
      {
        json: {
          content,
        },
      }
    );
  }

  async deleteEntity(entityType: 'doc' | 'file' | 'folder', entityId: string): Promise<void> {
    await this.request('DELETE', `/project/${this.projectId}/${entityType}/${entityId}`);
  }

  async createFolder(parentFolderId: string, folderName: string): Promise<FolderEntity> {
    const response = await this.request(
      'POST',
      `/project/${this.projectId}/folder`,
      {
        json: {
          name: folderName,
          parent_folder_id: parentFolderId,
        },
      }
    );

    return response.json() as Promise<FolderEntity>;
  }

  async downloadProject(): Promise<Buffer> {
    const response = await this.request('GET', `/project/${this.projectId}/download/zip`);
    return response.buffer();
  }

  private async joinProjectViaSocket(): Promise<ProjectEntity> {
    const errors: string[] = [];

    try {
      return await this.joinProjectViaSocketV1();
    } catch (error) {
      errors.push(`v1: ${String(error)}`);
    }

    try {
      return await this.joinProjectViaSocketV2();
    } catch (error) {
      errors.push(`v2: ${String(error)}`);
    }

    throw new Error(
      `Socket joinProject failed. ${errors.join(' | ')}`
    );
  }

  private async joinProjectViaSocketV1(): Promise<ProjectEntity> {
    const identity = await this.ensureIdentity();
    const socket = this.createSocket(identity, 'v1');

    return await new Promise<ProjectEntity>((resolve, reject) => {
      let settled = false;

      const finish = (error?: Error, project?: ProjectEntity) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        try {
          socket.disconnect();
        } catch {
          // ignore
        }
        if (error) {
          reject(error);
        } else if (project) {
          resolve(project);
        } else {
          reject(new Error('Empty project payload from socket joinProject'));
        }
      };

      const timeout = setTimeout(() => {
        finish(new Error('Socket joinProject timeout'));
      }, 10000);

      socket.on('connectionRejected', (err: any) => {
        const message = err?.message || err || 'connection rejected';
        finish(new Error(String(message)));
      });

      socket.on('error', (err: any) => {
        finish(new Error(String(err?.message || err)));
      });

      socket.on('connect', () => {
        socket.emit('joinProject', { project_id: this.projectId }, (...args: any[]) => {
          const { error, project } = parseJoinProjectAck(args);
          if (error) {
            finish(new Error(error));
            return;
          }
          if (!project || !Array.isArray(project.rootFolder)) {
            finish(new Error('Invalid project payload from socket joinProject'));
            return;
          }
          finish(undefined, project);
        });
      });
    });
  }

  private async joinProjectViaSocketV2(): Promise<ProjectEntity> {
    const identity = await this.ensureIdentity();
    const socket = this.createSocket(identity, 'v2');

    return await new Promise<ProjectEntity>((resolve, reject) => {
      let settled = false;

      const finish = (error?: Error, project?: ProjectEntity) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        try {
          socket.disconnect();
        } catch {
          // ignore
        }
        if (error) {
          reject(error);
        } else if (project) {
          resolve(project);
        } else {
          reject(new Error('Empty project payload from socket v2'));
        }
      };

      const timeout = setTimeout(() => {
        finish(new Error('Socket joinProject v2 timeout'));
      }, 12000);

      socket.on('connectionRejected', (err: any) => {
        const message = err?.message || err || 'connection rejected';
        finish(new Error(String(message)));
      });

      socket.on('error', (err: any) => {
        finish(new Error(String(err?.message || err)));
      });

      socket.on('joinProjectResponse', (res: any) => {
        const project = res?.project as ProjectEntity | undefined;
        if (!project || !Array.isArray(project.rootFolder)) {
          finish(new Error('Invalid project payload from socket v2'));
          return;
        }
        finish(undefined, project);
      });
    });
  }

  private async joinDocViaSocket(docId: string): Promise<string> {
    const errors: string[] = [];

    try {
      return await this.joinDocViaSocketV2(docId);
    } catch (error) {
      errors.push(`v2: ${String(error)}`);
    }

    try {
      return await this.joinDocViaSocketV1(docId);
    } catch (error) {
      errors.push(`v1: ${String(error)}`);
    }

    throw new Error(
      `Socket joinDoc failed for ${docId}. ${errors.join(' | ')}`
    );
  }

  private async joinDocViaSocketV1(docId: string): Promise<string> {
    const identity = await this.ensureIdentity();
    const socket = this.createSocket(identity, 'v1');

    return await new Promise<string>((resolve, reject) => {
      let settled = false;

      const finish = (error?: Error, content?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        try {
          socket.disconnect();
        } catch {
          // ignore
        }
        if (error) {
          reject(error);
        } else {
          resolve(content || '');
        }
      };

      const timeout = setTimeout(() => {
        finish(new Error('Socket joinDoc timeout'));
      }, 10000);

      socket.on('connectionRejected', (err: any) => {
        const message = err?.message || err || 'connection rejected';
        finish(new Error(String(message)));
      });

      socket.on('error', (err: any) => {
        finish(new Error(String(err?.message || err)));
      });

      socket.on('connect', () => {
        socket.emit('joinProject', { project_id: this.projectId }, (...projectArgs: any[]) => {
          const { error } = parseJoinProjectAck(projectArgs);
          if (error) {
            finish(new Error(error));
            return;
          }

          socket.emit('joinDoc', docId, { encodeRanges: true }, (...docArgs: any[]) => {
            const parsed = parseJoinDocAck(docArgs);
            if (parsed.error) {
              finish(new Error(parsed.error));
              return;
            }
            finish(undefined, parsed.lines.join('\n'));
          });
        });
      });
    });
  }

  private async joinDocViaSocketV2(docId: string): Promise<string> {
    const identity = await this.ensureIdentity();
    const socket = this.createSocket(identity, 'v2');

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let joined = false;

      const finish = (error?: Error, content?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        try {
          socket.disconnect();
        } catch {
          // ignore
        }
        if (error) {
          reject(error);
        } else {
          resolve(content || '');
        }
      };

      const timeout = setTimeout(() => {
        finish(new Error('Socket joinDoc v2 timeout'));
      }, 12000);

      socket.on('connectionRejected', (err: any) => {
        const message = err?.message || err || 'connection rejected';
        finish(new Error(String(message)));
      });

      socket.on('error', (err: any) => {
        finish(new Error(String(err?.message || err)));
      });

      socket.on('joinProjectResponse', (res: any) => {
        if (joined) {
          return;
        }
        const project = res?.project as ProjectEntity | undefined;
        if (!project || !Array.isArray(project.rootFolder)) {
          finish(new Error('Invalid project payload from joinProjectResponse'));
          return;
        }
        joined = true;

        socket.emit('joinDoc', docId, { encodeRanges: true }, (...docArgs: any[]) => {
          const parsed = parseJoinDocAck(docArgs);
          if (parsed.error) {
            finish(new Error(parsed.error));
            return;
          }
          finish(undefined, parsed.lines.join('\n'));
        });
      });
    });
  }

  private createSocket(identity: Identity, scheme: 'v1' | 'v2'): any {
    const origin = new URL(this.baseUrl).origin;
    const query = scheme === 'v2'
      ? `?projectId=${encodeURIComponent(this.projectId)}&t=${Date.now()}`
      : '';
    const ioClient = require('socket.io-client');
    return ioClient.connect(`${origin}${query}`, {
      reconnect: false,
      'force new connection': true,
      extraHeaders: {
        'Origin': origin,
        'Cookie': identity.cookies,
      },
    });
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    route: string,
    options?: {
      json?: object;
      body?: FormData;
      headers?: Record<string, string>;
    }
  ): Promise<Response> {
    const identity = await this.ensureIdentity();

    const headers: Record<string, string> = {
      'Cookie': identity.cookies,
      ...options?.headers,
    };

    let body: string | FormData | undefined;
    if (options?.body) {
      body = options.body;
    } else if (options?.json) {
      headers['Content-Type'] = 'application/json';
      headers['X-Csrf-Token'] = identity.csrfToken;
      body = JSON.stringify({
        _csrf: identity.csrfToken,
        ...options.json,
      });
    } else if (method !== 'GET') {
      headers['X-Csrf-Token'] = identity.csrfToken;
    }

    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(`${method} ${route} failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  private async ensureIdentity(): Promise<Identity> {
    if (!this.credentials.cookie) {
      throw new Error('Not authenticated. Missing cookie credentials.');
    }

    if (this.identity?.csrfToken) {
      if (!this.socketCookieRefreshed) {
        this.identity = await this.refreshSocketCookies(this.identity);
        this.socketCookieRefreshed = true;
      }
      return this.identity;
    }

    const csrfToken = await this.fetchCsrfToken(this.credentials.cookie);
    this.identity = {
      cookies: this.credentials.cookie,
      csrfToken,
    };
    this.identity = await this.refreshSocketCookies(this.identity);
    this.socketCookieRefreshed = true;
    return this.identity;
  }

  private async refreshSocketCookies(identity: Identity): Promise<Identity> {
    try {
      const response = await fetch(`${this.baseUrl}/socket.io/socket.io.js`, {
        method: 'GET',
        headers: {
          'Cookie': identity.cookies,
        },
      });

      const raw = response.headers.raw();
      const setCookie = raw['set-cookie'] || [];
      if (setCookie.length === 0) {
        return identity;
      }

      const existing = parseCookiePairs(identity.cookies);
      for (const cookieLine of setCookie) {
        const pair = cookieLine.split(';')[0]?.trim();
        if (!pair || !pair.includes('=')) {
          continue;
        }
        const key = pair.split('=')[0];
        existing.set(key, pair);
      }

      identity.cookies = [...existing.values()].join('; ');
      return identity;
    } catch {
      return identity;
    }
  }

  private async fetchCsrfToken(cookies: string): Promise<string> {
    const fromCookie = extractCsrfFromCookie(cookies);
    if (fromCookie) {
      return fromCookie;
    }

    const candidateRoutes = [
      `/project/${this.projectId}`,
      '/project',
      '/login',
    ];

    for (const route of candidateRoutes) {
      try {
        const response = await fetch(`${this.baseUrl}${route}`, {
          method: 'GET',
          headers: {
            'Cookie': cookies,
          },
        });
        const html = await response.text();
        const csrfToken = extractCsrfFromHTML(html);
        if (csrfToken) {
          return csrfToken;
        }
      } catch {
        // try next route
      }
    }

    throw new Error('Failed to get CSRF token from Overleaf');
  }
}

function parseJoinProjectAck(args: any[]): { error?: string; project?: ProjectEntity } {
  if (args.length === 0) {
    return { error: 'Empty joinProject ack' };
  }

  if (looksLikeProject(args[0])) {
    return { project: args[0] as ProjectEntity };
  }

  const first = args[0];
  const second = args[1];
  if ((first === null || first === undefined) && looksLikeProject(second)) {
    return { project: second as ProjectEntity };
  }
  if (first && looksLikeProject(second)) {
    return { project: second as ProjectEntity };
  }

  const message = typeof first === 'string'
    ? first
    : (first?.message || JSON.stringify(first));

  return { error: message || 'Unknown joinProject error' };
}

function parseJoinDocAck(args: any[]): { error?: string; lines: string[] } {
  if (args.length === 0) {
    return { error: 'Empty joinDoc ack', lines: [] };
  }

  let linesPayload: unknown;

  if (Array.isArray(args[0])) {
    linesPayload = args[0];
  } else if (args.length >= 2 && Array.isArray(args[1])) {
    linesPayload = args[1];
  }

  if (!Array.isArray(linesPayload)) {
    const first = args[0];
    const message = typeof first === 'string'
      ? first
      : (first?.message || 'Invalid joinDoc payload');
    return { error: message, lines: [] };
  }

  const lines = (linesPayload as string[]).map((line) => {
    return Buffer.from(line, 'latin1').toString('utf-8');
  });

  return { lines };
}

function looksLikeProject(value: unknown): value is ProjectEntity {
  const project = value as ProjectEntity;
  return !!project && typeof project === 'object'
    && typeof project._id === 'string'
    && Array.isArray(project.rootFolder);
}

function extractCsrfFromCookie(cookie: string): string | null {
  const csrf = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('_csrf='));

  if (!csrf) {
    return null;
  }

  const raw = csrf.split('=').slice(1).join('=');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseCookiePairs(cookieHeader: string): Map<string, string> {
  const result = new Map<string, string>();
  cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx <= 0) {
        return;
      }
      const key = part.slice(0, idx);
      result.set(key, part);
    });
  return result;
}

function extractCsrfFromHTML(html: string): string | null {
  const metaMatch = html.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]+)">/i);
  if (metaMatch) {
    return decodeHtmlEntity(metaMatch[1]);
  }

  const inputMatch = html.match(/<input[^>]*name="_csrf"[^>]*value="([^"]+)"/i);
  if (inputMatch) {
    return decodeHtmlEntity(inputMatch[1]);
  }

  return null;
}

function decodeHtmlEntity(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&');
}

function extractProjectDataFromHTML(html: string): ProjectEntity {
  const projectIdMatch = html.match(/<meta\s+name="ol-project_id"\s+content="([^"]*)">/);
  const projectNameMatch = html.match(/<meta\s+name="ol-project_name"\s+content="([^"]*)">/);

  if (!projectIdMatch || !projectNameMatch) {
    throw new Error('Failed to extract project metadata from HTML');
  }

  return {
    _id: projectIdMatch[1],
    name: decodeHtmlEntity(projectNameMatch[1]),
    rootFolder: [],
  };
}
