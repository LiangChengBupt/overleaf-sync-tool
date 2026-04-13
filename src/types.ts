export interface FileCache {
  date: number;
  hash: number;
}

export interface SyncSettings {
  uri: string;
  serverName: string;
  projectName: string;
  enableCompileNPreview?: boolean;
  'ignore-patterns'?: string[];
  'sync-rules-file'?: string;
}

export interface ParsedURI {
  serverName: string;
  userId: string;
  projectId: string;
  projectName: string;
}

export interface OverleafCredentials {
  userId: string;
  projectId: string;
  serverName: string;
  cookie?: string;
}

export interface SyncOptions {
  localPath: string;
  settings: SyncSettings;
  credentials?: OverleafCredentials;
  mergeEditor?: 'vscode';
  conflictResolver?: (
    conflict: SyncConflict
  ) => Promise<ConflictResolutionResult>;
  onProgress?: (file: string, current: number, total: number) => void;
  onLog?: (message: string) => void;
}

export interface SyncResult {
  success: boolean;
  filesSynced: number;
  filesUploaded: number;
  filesDownloaded: number;
  conflictsResolved: number;
  conflictsUnresolved: number;
  errors: string[];
}

export interface SyncConflict {
  relPath: string;
  localPath: string;
  incomingPath: string;
  currentPath: string;
  basePath: string;
  artifactsDir: string;
  hasBase: boolean;
  isText: boolean;
}

export interface ConflictResolutionResult {
  resolved: boolean;
  message?: string;
}

export interface RemoteFile {
  _id: string;
  name: string;
  _type: 'doc' | 'file' | 'folder';
  content?: string;
}

export interface ProjectMetadata {
  projectId: string;
  projectName: string;
  rootDocId: string;
}
