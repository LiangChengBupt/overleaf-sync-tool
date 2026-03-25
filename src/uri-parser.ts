import { ParsedURI, SyncSettings } from './types';

/**
 * Parse Overleaf Workshop URI to extract metadata
 *
 * URI format: overleaf-workshop://serverName/projectName?user=userId&project=projectId
 * Example: overleaf-workshop://www.overleaf.com/Interactive%20Agent%20Benchmark?user%3D65ab6f751af053d945c71f7d%26project%3D69c347b40846881a70d6af39
 */
export function parseURI(uri: string): ParsedURI {
  try {
    const url = new URL(uri);
    const serverName = url.host;
    let userId = '';
    let projectId = '';
    let projectName = '';

    if (url.search) {
      // New style:
      // overleaf-workshop://server/Project%20Name?user%3Dxxx%26project%3Dyyy
      projectName = decodeURIComponent(url.pathname.slice(1));
      const query = url.search.slice(1);
      const params = new URLSearchParams(decodeURIComponent(query));
      userId = params.get('user') || '';
      projectId = params.get('project') || '';
    } else {
      // Legacy style:
      // overleaf-workshop://server/userId/projectId/projectName
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 3) {
        userId = decodeURIComponent(parts[0]);
        projectId = decodeURIComponent(parts[1]);
        projectName = decodeURIComponent(parts.slice(2).join('/'));
      }
    }

    if (!userId || !projectId) {
      throw new Error('Invalid URI: missing userId or projectId');
    }

    return {
      serverName,
      userId,
      projectId,
      projectName,
    };
  } catch (error) {
    throw new Error(`Failed to parse URI: ${error}`);
  }
}

/**
 * Validate if the URI is a valid Overleaf Workshop URI
 */
export function isValidURI(uri: string): boolean {
  try {
    const parsed = parseURI(uri);
    return parsed.userId.length > 0 && parsed.projectId.length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract project info from settings
 */
export function extractProjectInfo(settings: SyncSettings): ParsedURI {
  return parseURI(settings.uri);
}
