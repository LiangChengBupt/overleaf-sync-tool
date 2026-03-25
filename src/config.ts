import * as fs from 'fs/promises';
import * as path from 'path';
import { SyncSettings } from './types';

export async function findConfigFile(
  startPath: string = process.cwd()
): Promise<string | null> {
  let currentPath = startPath;

  while (currentPath !== path.dirname(currentPath)) {
    const configPath = path.join(currentPath, '.overleaf', 'settings.json');
    try {
      await fs.access(configPath);
      return configPath;
    } catch {
      currentPath = path.dirname(currentPath);
    }
  }

  return null;
}

export async function readConfig(configPath: string): Promise<SyncSettings> {
  const content = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(content);

  // Validate required fields
  if (!config.uri || !config.serverName || !config.projectName) {
    throw new Error(
      'Invalid config file. Must contain uri, serverName, and projectName'
    );
  }

  return config;
}

export async function loadConfig(
  customPath?: string
): Promise<{ config: SyncSettings; configPath: string }> {
  const configPath = customPath || (await findConfigFile());

  if (!configPath) {
    throw new Error(
      'Could not find .overleaf/settings.json. Please run this command in a project with Overleaf configuration.'
    );
  }

  const config = await readConfig(configPath);
  return { config, configPath };
}

export function getLocalPath(configPath: string): string {
  // The local path is the parent directory of .overleaf
  return path.dirname(path.dirname(configPath));
}
