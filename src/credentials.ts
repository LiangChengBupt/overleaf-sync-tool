import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { OverleafCredentials } from './types';

interface Identity {
  csrfToken: string;
  cookies: string;
}

interface ServerLogin {
  userId: string;
  username: string;
  identity: Identity;
}

interface ServerPersist {
  name: string;
  url: string;
  login?: ServerLogin;
}

type ServerPersistMap = { [name: string]: ServerPersist };

/**
 * VS Code stores global state in a JSON file
 * Location varies by platform:
 * - macOS: ~/Library/Application Support/Code/User/globalStorage/<extension-id>/state.vscdb
 * - Linux: ~/.config/Code/User/globalStorage/<extension-id>/state.vscdb
 * - Windows: %APPDATA%\Code\User\globalStorage\<extension-id>\state.vscdb
 *
 * But we can also try to read from the simpler JSON storage
 */
export async function loadVsCodeCredentials(
  serverName: string
): Promise<OverleafCredentials | null> {
  const extensionId = 'iamhyc.overleaf-workshop';

  // Try different possible locations for VS Code storage
  const possiblePaths = getVsCodeStoragePaths(extensionId);

  for (const storagePath of possiblePaths) {
    try {
      // Try to read the global state
      const statePath = path.join(storagePath, 'state.vscdb');

      // Check if SQLite database exists
      try {
        await fs.access(statePath);
        // For SQLite database, we'd need better-sqlite3 or similar
        // For now, skip this
        continue;
      } catch {
        // Not a database, try JSON
      }

      // Try JSON storage (used by some VS Code versions)
      const jsonPath = path.join(storagePath, 'state.json');
      try {
        const content = await fs.readFile(jsonPath, 'utf-8');
        const state = JSON.parse(content);
        const credentials = extractCredentialsFromState(state, serverName);
        if (credentials) {
          return credentials;
        }
      } catch {
        // Try next path
        continue;
      }
    } catch (error) {
      // Try next path
      continue;
    }
  }

  // Fallback: Try to read from workspace storage
  const workspaceCredentials = await loadFromWorkspaceStorage(serverName);
  if (workspaceCredentials) {
    return workspaceCredentials;
  }

  return null;
}

function getVsCodeStoragePaths(extensionId: string): string[] {
  const home = os.homedir();
  const platform = os.platform();

  const paths: string[] = [];

  if (platform === 'darwin') {
    // macOS
    paths.push(
      path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', extensionId),
      path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
    );
  } else if (platform === 'linux') {
    // Linux
    paths.push(
      path.join(home, '.config', 'Code', 'User', 'globalStorage', extensionId),
      path.join(home, '.config', 'Code', 'User', 'workspaceStorage')
    );
  } else if (platform === 'win32') {
    // Windows
    const appdata = process.env.APPDATA;
    if (appdata) {
      paths.push(
        path.join(appdata, 'Code', 'User', 'globalStorage', extensionId),
        path.join(appdata, 'Code', 'User', 'workspaceStorage')
      );
    }
  }

  return paths;
}

function extractCredentialsFromState(
  state: any,
  serverName: string
): OverleafCredentials | null {
  try {
    // Look for the server persists key
    const keyServerPersists = 'overleaf-servers';
    const serverPersists: ServerPersistMap = state[keyServerPersists];

    if (!serverPersists || !serverPersists[serverName]) {
      return null;
    }

    const server = serverPersists[serverName];
    if (!server.login) {
      return null;
    }

    return {
      userId: server.login.userId,
      projectId: '', // Will be set later
      serverName: server.name,
      cookie: server.login.identity.cookies,
    };
  } catch (error) {
    return null;
  }
}

async function loadFromWorkspaceStorage(
  serverName: string
): Promise<OverleafCredentials | null> {
  // This is a fallback that looks for credentials in the current workspace
  // Users would need to manually export credentials from VS Code
  const home = os.homedir();
  const configPath = path.join(home, '.overleaf-sync', 'credentials.json');

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const credentials = JSON.parse(content);

    if (credentials.serverName === serverName) {
      return credentials;
    }
  } catch {
    // File doesn't exist
  }

  return null;
}

/**
 * Save credentials to a local file for CLI use
 */
export async function saveCredentials(
  credentials: OverleafCredentials
): Promise<void> {
  const home = os.homedir();
  const configDir = path.join(home, '.overleaf-sync');

  await fs.mkdir(configDir, { recursive: true });

  const configPath = path.join(configDir, 'credentials.json');
  await fs.writeFile(
    configPath,
    JSON.stringify(credentials, null, 2),
    'utf-8'
  );

  // Set restrictive permissions
  await fs.chmod(configPath, 0o600);
}

/**
 * Manual credential entry for users who can't use VS Code integration
 */
export function createCredentialsFromCookie(
  serverName: string,
  userId: string,
  projectId: string,
  cookie: string
): OverleafCredentials {
  return {
    userId,
    projectId,
    serverName,
    cookie,
  };
}