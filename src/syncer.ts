import * as fs from 'fs/promises';
import * as path from 'path';
import { SyncOptions, SyncResult } from './types';
import { hashCode, matchIgnorePatterns, mergeContent } from './utils';
import {
  OverleafAPI,
  FileEntity,
  FolderEntity,
  ProjectEntity,
} from './overleaf-api';

const DEFAULT_IGNORE_PATTERNS = [
  '**/.*',
  '**/.*/**',
  '**/*.aux',
  '**/__latexindent*',
  '**/*.bbl',
  '**/*.bcf',
  '**/*.blg',
  '**/*.fdb_latexmk',
  '**/*.fls',
  '**/*.git',
  '**/*.lof',
  '**/*.log',
  '**/*.lot',
  '**/*.out',
  '**/*.run.xml',
  '**/*.synctex(busy)',
  '**/*.synctex.gz',
  '**/*.toc',
  '**/*.xdv',
  '**/main.pdf',
  '**/output.pdf',
];

const DOC_EXTENSIONS = new Set([
  '.tex',
  '.bib',
  '.sty',
  '.cls',
  '.bst',
  '.txt',
  '.md',
  '.latex',
  '.tikz',
  '.rnw',
]);

const CACHE_VERSION = 1;
const MAX_CACHE_CONTENT_BYTES = 2 * 1024 * 1024;

interface SyncCacheEntry {
  hash: number;
  base64?: string;
}

interface SyncCache {
  version: number;
  files: Record<string, SyncCacheEntry>;
}

interface RemoteFileRecord {
  _id: string;
  name: string;
  _type: 'doc' | 'file';
  parentFolderId: string;
}

interface RemoteState {
  files: Map<string, RemoteFileRecord>;
  folders: Map<string, string>; // path -> folder id
}

interface SyncDelta {
  uploaded: boolean;
  downloaded: boolean;
}

export class Syncer {
  private readonly ignorePatterns: string[];
  private readonly api?: OverleafAPI;
  private readonly cachePath: string;

  constructor(private readonly options: SyncOptions) {
    this.ignorePatterns =
      this.options.settings['ignore-patterns'] || DEFAULT_IGNORE_PATTERNS;
    this.cachePath = path.join(
      this.options.localPath,
      '.overleaf',
      'ov-sync-cache.json'
    );

    if (options.credentials) {
      this.api = new OverleafAPI(options.credentials);
    }
  }

  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      filesSynced: 0,
      filesUploaded: 0,
      filesDownloaded: 0,
      errors: [],
    };

    try {
      this.log('Starting sync...');
      this.log(`Local path: ${this.options.localPath}`);
      this.log(`Project: ${this.options.settings.projectName}`);

      const localFiles = new Set(await this.collectFiles('/'));
      this.log(`Found ${localFiles.size} local files`);

      if (!this.api) {
        this.log('No credentials found - local scan only');
        result.success = true;
        result.filesSynced = localFiles.size;
        return result;
      }

      this.log('Testing authentication...');
      const authValid = await this.api.testAuth();
      if (!authValid) {
        result.errors.push(
          'Authentication failed. Please run "ov login" to re-authenticate.'
        );
        return result;
      }
      this.log('Authentication successful');

      const cache = await this.loadCache();
      const remoteState = await this.loadRemoteState();
      const remoteContentCache = new Map<string, Uint8Array>();

      const allPaths = new Set<string>([
        ...localFiles,
        ...remoteState.files.keys(),
        ...Object.keys(cache.files),
      ]);
      const orderedPaths = [...allPaths].sort((a, b) => a.localeCompare(b));

      this.log(
        `Comparing ${orderedPaths.length} paths (${localFiles.size} local / ${remoteState.files.size} remote)`
      );

      for (let i = 0; i < orderedPaths.length; i++) {
        const relPath = orderedPaths[i];
        this.progress(relPath, i + 1, orderedPaths.length);

        try {
          const delta = await this.syncPath(
            relPath,
            localFiles,
            remoteState,
            remoteContentCache,
            cache
          );

          result.filesSynced++;
          if (delta.uploaded) {
            result.filesUploaded++;
          }
          if (delta.downloaded) {
            result.filesDownloaded++;
          }
        } catch (error) {
          const errorMsg = `Failed to sync ${relPath}: ${error}`;
          result.errors.push(errorMsg);
          this.log(errorMsg);
        }
      }

      await this.saveCache(cache);

      result.success = result.errors.length === 0;
      this.log('Sync complete:');
      this.log(`  Files synced: ${result.filesSynced}`);
      this.log(`  Files uploaded: ${result.filesUploaded}`);
      this.log(`  Files downloaded: ${result.filesDownloaded}`);

      if (result.errors.length > 0) {
        this.log(`  Errors: ${result.errors.length}`);
      }
    } catch (error) {
      result.errors.push(`Sync failed: ${error}`);
      this.log(`Sync failed: ${error}`);
    }

    return result;
  }

  private async syncPath(
    relPath: string,
    localFiles: Set<string>,
    remoteState: RemoteState,
    remoteContentCache: Map<string, Uint8Array>,
    cache: SyncCache
  ): Promise<SyncDelta> {
    const delta: SyncDelta = { uploaded: false, downloaded: false };

    let localExists = localFiles.has(relPath);
    let localContent: Uint8Array | undefined;
    if (localExists) {
      localContent = await this.readLocalContent(relPath);
      if (!localContent) {
        localExists = false;
        localFiles.delete(relPath);
      }
    }

    const remoteRecord = remoteState.files.get(relPath);
    const remoteExists = !!remoteRecord;
    const remoteContent = remoteExists
      ? await this.readRemoteContent(remoteRecord, relPath, remoteContentCache)
      : undefined;

    const baseEntry = cache.files[relPath];
    const baseHash = baseEntry?.hash;

    const localHash = localContent ? hashCode(localContent) : undefined;
    const remoteHash = remoteContent ? hashCode(remoteContent) : undefined;

    if (!localExists && !remoteExists) {
      this.deleteCacheEntry(cache, relPath);
      return delta;
    }

    if (localExists && !remoteExists) {
      if (baseHash !== undefined && localHash === baseHash) {
        await this.deleteLocalContent(relPath);
        localFiles.delete(relPath);
        this.deleteCacheEntry(cache, relPath);
        this.log(`  Removed local (deleted remotely): ${relPath}`);
        return delta;
      }

      await this.uploadLocalToRemote(
        relPath,
        localContent!,
        remoteState,
        remoteContentCache
      );
      this.updateCacheEntry(cache, relPath, localContent!);
      delta.uploaded = true;
      this.log(`  Uploaded: ${relPath}`);
      return delta;
    }

    if (!localExists && remoteExists) {
      if (baseHash !== undefined && remoteHash === baseHash) {
        await this.api!.deleteEntity(remoteRecord!._type, remoteRecord!._id);
        remoteState.files.delete(relPath);
        remoteContentCache.delete(relPath);
        this.deleteCacheEntry(cache, relPath);
        delta.uploaded = true;
        this.log(`  Removed remote (deleted locally): ${relPath}`);
        return delta;
      }

      await this.writeLocalContent(relPath, remoteContent!);
      localFiles.add(relPath);
      this.updateCacheEntry(cache, relPath, remoteContent!);
      delta.downloaded = true;
      this.log(`  Downloaded: ${relPath}`);
      return delta;
    }

    if (localHash === remoteHash) {
      this.updateCacheEntry(cache, relPath, localContent!);
      return delta;
    }

    const localChanged = baseHash === undefined ? true : localHash !== baseHash;
    const remoteChanged = baseHash === undefined ? true : remoteHash !== baseHash;

    if (localChanged && !remoteChanged) {
      await this.uploadLocalToRemote(
        relPath,
        localContent!,
        remoteState,
        remoteContentCache
      );
      this.updateCacheEntry(cache, relPath, localContent!);
      delta.uploaded = true;
      this.log(`  Uploaded: ${relPath}`);
      return delta;
    }

    if (!localChanged && remoteChanged) {
      await this.writeLocalContent(relPath, remoteContent!);
      localFiles.add(relPath);
      this.updateCacheEntry(cache, relPath, remoteContent!);
      delta.downloaded = true;
      this.log(`  Downloaded: ${relPath}`);
      return delta;
    }

    const baseContent = this.getBaseContent(cache, relPath);
    if (
      baseContent &&
      this.isTextContent(baseContent) &&
      this.isTextContent(localContent!) &&
      this.isTextContent(remoteContent!)
    ) {
      const mergedContent = mergeContent(baseContent, localContent!, remoteContent!);
      await this.writeLocalContent(relPath, mergedContent);
      await this.uploadLocalToRemote(
        relPath,
        mergedContent,
        remoteState,
        remoteContentCache
      );
      this.updateCacheEntry(cache, relPath, mergedContent);
      delta.uploaded = true;
      delta.downloaded = true;
      this.log(`  Merged: ${relPath}`);
      return delta;
    }

    throw new Error(
      'Conflict detected (both local and remote changed). Resolve manually, then run ov sync again.'
    );
  }

  private async collectFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const queue: string[] = [this.normalizeRelPath(root)];

    while (queue.length > 0) {
      const currentRoot = queue.shift()!;
      const localPath = path.join(this.options.localPath, currentRoot);

      try {
        const entries = await fs.readdir(localPath, { withFileTypes: true });

        for (const entry of entries) {
          const relPath = this.normalizeRelPath(
            path.join(currentRoot, entry.name)
          );

          if (this.matchIgnorePatterns(relPath)) {
            continue;
          }

          if (entry.isDirectory()) {
            queue.push(relPath);
          } else if (entry.isFile()) {
            files.push(relPath);
          }
        }
      } catch {
        // ignore unreadable path
      }
    }

    return files;
  }

  private matchIgnorePatterns(relPath: string): boolean {
    return matchIgnorePatterns(relPath, this.ignorePatterns);
  }

  private normalizeRelPath(relPath: string): string {
    let normalized = relPath.replace(/\\/g, '/');
    normalized = path.posix.normalize(normalized);

    if (normalized === '.' || normalized === '') {
      normalized = '/';
    }
    if (!normalized.startsWith('/')) {
      normalized = `/${normalized}`;
    }

    return normalized;
  }

  private async readLocalContent(relPath: string): Promise<Uint8Array | undefined> {
    const localPath = path.join(this.options.localPath, relPath);

    try {
      const buffer = await fs.readFile(localPath);
      return new Uint8Array(buffer);
    } catch {
      return undefined;
    }
  }

  private async writeLocalContent(relPath: string, content: Uint8Array): Promise<void> {
    const localPath = path.join(this.options.localPath, relPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, content);
  }

  private async deleteLocalContent(relPath: string): Promise<void> {
    const localPath = path.join(this.options.localPath, relPath);

    try {
      await fs.unlink(localPath);
    } catch {
      // ignore
    }
  }

  private async readRemoteContent(
    record: RemoteFileRecord,
    relPath: string,
    remoteContentCache: Map<string, Uint8Array>
  ): Promise<Uint8Array> {
    const cached = remoteContentCache.get(relPath);
    if (cached) {
      return cached;
    }

    let content: Uint8Array;
    if (record._type === 'doc') {
      const docText = await this.api!.getDoc(record._id);
      content = new TextEncoder().encode(docText);
    } else {
      const buffer = await this.api!.getFile(record._id);
      content = new Uint8Array(buffer);
    }

    remoteContentCache.set(relPath, content);
    return content;
  }

  private async loadRemoteState(): Promise<RemoteState> {
    const project = await this.api!.getProject();
    const rootFolder = this.resolveRootFolder(project);

    const remoteState: RemoteState = {
      files: new Map<string, RemoteFileRecord>(),
      folders: new Map<string, string>([['/', rootFolder._id]]),
    };

    this.walkRemoteFolder(rootFolder, '/', remoteState);
    return remoteState;
  }

  private resolveRootFolder(project: ProjectEntity): FolderEntity {
    if (!Array.isArray(project.rootFolder) || project.rootFolder.length === 0) {
      throw new Error(
        'Remote project tree is unavailable. Please verify login cookie and project permissions.'
      );
    }
    return project.rootFolder[0];
  }

  private walkRemoteFolder(
    folder: FolderEntity,
    folderPath: string,
    remoteState: RemoteState
  ) {
    const docs = folder.docs || [];
    for (const doc of docs) {
      const relPath = this.joinRemotePath(folderPath, doc.name);
      remoteState.files.set(relPath, {
        _id: doc._id,
        _type: 'doc',
        name: doc.name,
        parentFolderId: folder._id,
      });
    }

    const fileRefs = folder.fileRefs || [];
    for (const fileRef of fileRefs) {
      const relPath = this.joinRemotePath(folderPath, fileRef.name);
      remoteState.files.set(relPath, {
        _id: fileRef._id,
        _type: 'file',
        name: fileRef.name,
        parentFolderId: folder._id,
      });
    }

    const folders = folder.folders || [];
    for (const subFolder of folders) {
      const subFolderPath = this.joinRemotePath(folderPath, subFolder.name);
      remoteState.folders.set(subFolderPath, subFolder._id);
      this.walkRemoteFolder(subFolder, subFolderPath, remoteState);
    }
  }

  private joinRemotePath(parent: string, name: string): string {
    const base = parent === '/' ? '' : parent;
    return `${base}/${name}`;
  }

  private async uploadLocalToRemote(
    relPath: string,
    content: Uint8Array,
    remoteState: RemoteState,
    remoteContentCache: Map<string, Uint8Array>
  ): Promise<void> {
    const existing = remoteState.files.get(relPath);

    if (existing) {
      if (existing._type === 'doc' && this.isTextContent(content)) {
        await this.api!.updateDoc(existing._id, this.decodeTextContent(content));
        remoteContentCache.set(relPath, content);
        return;
      }

      await this.api!.deleteEntity(existing._type, existing._id);
      remoteState.files.delete(relPath);
      remoteContentCache.delete(relPath);
    }

    const parentFolderPath = path.posix.dirname(relPath);
    const parentFolderId = await this.ensureRemoteFolder(parentFolderPath, remoteState);
    const filename = path.posix.basename(relPath);

    let created: FileEntity;
    if (this.shouldCreateDoc(relPath, content)) {
      created = await this.api!.createDoc(parentFolderId, filename);
      if (content.length > 0) {
        await this.api!.updateDoc(created._id, this.decodeTextContent(content));
      }
    } else {
      created = await this.api!.uploadFile(parentFolderId, filename, content);
    }

    const type = created._type === 'doc' ? 'doc' : 'file';
    remoteState.files.set(relPath, {
      _id: created._id,
      _type: type,
      name: filename,
      parentFolderId,
    });
    remoteContentCache.set(relPath, content);
  }

  private async ensureRemoteFolder(
    folderPath: string,
    remoteState: RemoteState
  ): Promise<string> {
    const rootFolderId = remoteState.folders.get('/');
    if (!rootFolderId) {
      throw new Error('Remote root folder ID is missing');
    }

    const normalizedFolderPath = this.normalizeRelPath(folderPath);
    if (normalizedFolderPath === '/') {
      return rootFolderId;
    }

    const segments = normalizedFolderPath.split('/').filter(Boolean);
    let currentPath = '/';
    let currentFolderId = rootFolderId;

    for (const segment of segments) {
      const nextPath = currentPath === '/' ? `/${segment}` : `${currentPath}/${segment}`;
      const existingFolderId = remoteState.folders.get(nextPath);

      if (existingFolderId) {
        currentPath = nextPath;
        currentFolderId = existingFolderId;
        continue;
      }

      const newFolder = await this.api!.createFolder(currentFolderId, segment);
      remoteState.folders.set(nextPath, newFolder._id);
      currentPath = nextPath;
      currentFolderId = newFolder._id;
    }

    return currentFolderId;
  }

  private async loadCache(): Promise<SyncCache> {
    try {
      const content = await fs.readFile(this.cachePath, 'utf-8');
      const parsed = JSON.parse(content) as SyncCache;

      if (parsed.version !== CACHE_VERSION || typeof parsed.files !== 'object') {
        return { version: CACHE_VERSION, files: {} };
      }

      return parsed;
    } catch {
      return { version: CACHE_VERSION, files: {} };
    }
  }

  private async saveCache(cache: SyncCache): Promise<void> {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  }

  private updateCacheEntry(cache: SyncCache, relPath: string, content: Uint8Array) {
    const entry: SyncCacheEntry = {
      hash: hashCode(content),
    };

    if (content.length <= MAX_CACHE_CONTENT_BYTES && this.isTextContent(content)) {
      entry.base64 = Buffer.from(content).toString('base64');
    }

    cache.files[relPath] = entry;
  }

  private getBaseContent(cache: SyncCache, relPath: string): Uint8Array | undefined {
    const base64 = cache.files[relPath]?.base64;
    if (!base64) {
      return undefined;
    }

    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  private deleteCacheEntry(cache: SyncCache, relPath: string) {
    delete cache.files[relPath];
  }

  private shouldCreateDoc(relPath: string, content: Uint8Array): boolean {
    if (!this.isTextContent(content)) {
      return false;
    }

    const ext = path.posix.extname(relPath).toLowerCase();
    return DOC_EXTENSIONS.has(ext);
  }

  private isTextContent(content: Uint8Array): boolean {
    if (content.includes(0)) {
      return false;
    }

    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
      return true;
    } catch {
      return false;
    }
  }

  private decodeTextContent(content: Uint8Array): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  }

  private progress(file: string, current: number, total: number) {
    if (this.options.onProgress) {
      this.options.onProgress(file, current, total);
    }
  }

  private log(message: string) {
    if (this.options.onLog) {
      this.options.onLog(message);
    }
  }
}
