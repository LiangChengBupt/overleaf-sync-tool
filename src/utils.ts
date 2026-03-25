import * as DiffMatchPatch from 'diff-match-patch';
import { minimatch } from 'minimatch';

// Create a proper instance
const dmp: any = new (DiffMatchPatch as any).diff_match_patch();

/**
 * Returns a hash code from a string
 * @param  {String} str The string to hash.
 * @return {Number}    A 32bit integer
 */
export function hashCode(content?: Uint8Array): number {
  if (content === undefined) {
    return -1;
  }
  const str = new TextDecoder().decode(content);

  let hash = 0;
  for (let i = 0, len = str.length; i < len; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

export function matchIgnorePatterns(
  path: string,
  ignorePatterns: string[]
): boolean {
  for (const pattern of ignorePatterns) {
    if (minimatch(path, pattern, { dot: true })) {
      return true;
    }
  }
  return false;
}

export function mergeContent(
  baseContent: Uint8Array,
  localContent: Uint8Array,
  remoteContent: Uint8Array
): Uint8Array {
  const baseContentStr = new TextDecoder().decode(baseContent);
  const localContentStr = new TextDecoder().decode(localContent);
  const remoteContentStr = new TextDecoder().decode(remoteContent);

  // Merge local and remote changes
  const localPatches = dmp.patch_make(baseContentStr, localContentStr);
  const remotePatches = dmp.patch_make(baseContentStr, remoteContentStr);
  const [mergedContentStr] = dmp.patch_apply(remotePatches, localContentStr);

  return new TextEncoder().encode(mergedContentStr);
}

export function sanitizeProjectFolderName(projectName: string): string {
  let sanitized = projectName;
  if (process.platform === 'win32') {
    sanitized = projectName
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[. ]+$/g, '');
    if (
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)
    ) {
      sanitized = `${sanitized}_`;
    }
  } else {
    sanitized = projectName.replace(/[\/\x00]/g, '_');
  }
  if (
    sanitized === '' ||
    sanitized === '.' ||
    sanitized === '..'
  ) {
    sanitized = 'untitled-project';
  }
  return sanitized;
}
