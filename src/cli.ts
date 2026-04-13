#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'child_process';
import { loadConfig, getLocalPath } from './config';
import { Syncer } from './syncer';
import {
  ConflictResolutionResult,
  SyncConflict,
  SyncOptions,
  OverleafCredentials,
} from './types';
import { extractProjectInfo } from './uri-parser';
import { loadVsCodeCredentials, saveCredentials } from './credentials';

const program = new Command();

program
  .name('ov')
  .description('CLI tool to sync local and remote Overleaf repositories')
  .version('1.0.0');

program
  .command('sync')
  .description('Sync local and remote Overleaf project')
  .option('-c, --config <path>', 'Path to .overleaf/settings.json')
  .option(
    '--merge-editor <editor>',
    'Handle text conflicts in a merge editor (supported: vscode)'
  )
  .option('-v, --verbose', 'Show detailed sync progress')
  .action(async (options) => {
    try {
      // Load configuration
      const { config, configPath } = await loadConfig(options.config);
      const localPath = getLocalPath(configPath);

      // Extract project info from URI
      const projectInfo = extractProjectInfo(config);
      console.log(`\n📋 Project: ${projectInfo.projectName}`);
      console.log(`   Server: ${projectInfo.serverName}`);
      console.log(`   ID: ${projectInfo.projectId}\n`);

      // Try to load credentials
      let credentials: OverleafCredentials | undefined;
      try {
        console.log('🔐 Loading credentials...');
        credentials = (await loadVsCodeCredentials(projectInfo.serverName)) || undefined;

        if (credentials) {
          credentials.projectId = projectInfo.projectId;
          console.log('✓ Credentials loaded from VS Code Workshop\n');
        } else {
          console.log('⚠️  No credentials found');
          console.log('   Run "ov login" to authenticate first\n');
        }
      } catch (error) {
        console.log(`⚠️  Failed to load credentials: ${error}\n`);
      }

      let mergeEditor: 'vscode' | undefined;
      if (options.mergeEditor) {
        if (options.mergeEditor !== 'vscode') {
          throw new Error(
            `Unsupported merge editor "${options.mergeEditor}". Supported values: vscode`
          );
        }
        mergeEditor = 'vscode';
      }

      let progressInterval: NodeJS.Timeout | undefined;
      const stopProgressIndicator = () => {
        if (!progressInterval) {
          return;
        }
        clearInterval(progressInterval);
        progressInterval = undefined;
        process.stdout.write('\r\x1b[K');
      };

      const startProgressIndicator = () => {
        if (options.verbose || progressInterval) {
          return;
        }
        process.stdout.write('Syncing...');
        const dots = ['.', '..', '...'];
        let dotIndex = 0;
        progressInterval = setInterval(() => {
          process.stdout.write(`\rSyncing${dots[dotIndex % dots.length]}`);
          dotIndex++;
        }, 500);
      };

      let codeAvailable = false;
      if (mergeEditor === 'vscode') {
        codeAvailable = await isCommandAvailable('code', ['--version']);
        if (!codeAvailable) {
          console.log('⚠️  VS Code CLI "code" was not found in PATH.');
          console.log('   Conflicts will still be written to .overleaf/conflicts/');
          console.log('   Install it from VS Code: Command Palette -> "Shell Command: Install \'code\' command in PATH"\n');
        }
      }

      // Setup logging
      const syncOptions: SyncOptions = {
        localPath,
        settings: config,
        credentials,
        mergeEditor,
        conflictResolver: mergeEditor
          ? async (conflict: SyncConflict): Promise<ConflictResolutionResult> => {
              stopProgressIndicator();
              return await resolveVSCodeConflict(conflict, codeAvailable, () => {
                if (!options.verbose) {
                  startProgressIndicator();
                }
              });
            }
          : undefined,
        onLog: (message: string) => {
          if (options.verbose) {
            console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
          }
        },
        onProgress: options.verbose
          ? (file: string, current: number, total: number) => {
              console.log(`[${current}/${total}] ${file}`);
            }
          : undefined,
      };

      // Show progress indicator if not verbose
      if (!options.verbose) {
        startProgressIndicator();
        process.on('exit', () => stopProgressIndicator());
        process.on('SIGINT', () => {
          stopProgressIndicator();
          process.exit();
        });
      }

      // Perform sync
      const syncer = new Syncer(syncOptions);
      const result = await syncer.sync();

      // Show results
      if (!options.verbose) {
        stopProgressIndicator();
      }

      if (result.success) {
        console.log(`\n✅ Sync complete:`);
        console.log(`   Files synced: ${result.filesSynced}`);

        if (result.filesUploaded > 0) {
          console.log(`   Files uploaded: ${result.filesUploaded}`);
        }
        if (result.filesDownloaded > 0) {
          console.log(`   Files downloaded: ${result.filesDownloaded}`);
        }
        if (result.conflictsResolved > 0) {
          console.log(`   Conflicts resolved: ${result.conflictsResolved}`);
        }
      } else {
        console.error(`\n❌ Sync completed with errors:`);
        if (result.conflictsResolved > 0) {
          console.error(`   Conflicts resolved: ${result.conflictsResolved}`);
        }
        if (result.conflictsUnresolved > 0) {
          console.error(`   Conflicts unresolved: ${result.conflictsUnresolved}`);
        }
        result.errors.forEach((error) => console.error(`  - ${error}`));
        process.exit(1);
      }
    } catch (error) {
      console.error(`\n❌ Error: ${error}`);
      process.exit(1);
    }
  });

program
  .command('login')
  .description('Login to Overleaf and save credentials')
  .option('-s, --server <server>', 'Overleaf server (default: www.overleaf.com)', 'www.overleaf.com')
  .option('-c, --cookie <cookie>', 'Overleaf session cookie (from browser)')
  .action(async (options) => {
    try {
      console.log('\n🔐 Overleaf Authentication\n');

      if (!options.cookie) {
        console.log('To authenticate, you need to provide your Overleaf session cookie.\n');
        console.log('How to get your cookie:');
        console.log('  1. Open https://' + options.server + ' in your browser');
        console.log('  2. Login to your account');
        console.log('  3. Press F12 to open Developer Tools');
        console.log('  4. Go to Application > Cookies');
        console.log('  5. Find "overleaf_session2" cookie');
        console.log('  6. Copy its value\n');
        console.log('Then run:');
        console.log(`  ov login --cookie "overleaf_session2=YOUR_COOKIE_VALUE"\n`);
        process.exit(0);
      }

      console.log('Authenticating...');

      const credentials: OverleafCredentials = {
        userId: '',
        projectId: '',
        serverName: options.server,
        cookie: options.cookie,
      };

      await saveCredentials(credentials);

      console.log('\n✅ Credentials saved successfully!');
      console.log('   You can now run "ov sync" to synchronize your projects.\n');
    } catch (error) {
      console.error(`\n❌ Login failed: ${error}\n`);
      process.exit(1);
    }
  });

program
  .command('uri <project-url> [project-name]')
  .description('Generate Overleaf URI from project URL')
  .option('-u, --user-id <id>', 'Your Overleaf user ID')
  .action((projectUrl, projectName, options) => {
    const PROJECT_URL_REGEX = /https?:\/\/([^\/]+)\/project\/([a-f0-9]+)/;
    const match = projectUrl.match(PROJECT_URL_REGEX);

    if (!match) {
      console.error('❌ Invalid Overleaf project URL');
      console.error('Expected format: https://www.overleaf.com/project/xxxxx');
      process.exit(1);
    }

    const [, serverName, projectId] = match;

    console.log('\n📋 URI Generator\n');

    if (!options.userId) {
      console.log('To generate the URI, you need your userId.');
      console.log('\nHow to get userId:');
      console.log('  1. Open your Overleaf project in browser');
      console.log('  2. Press F12 to open Developer Tools');
      console.log('  3. Go to Console tab');
      console.log('  4. Type: window.user_id');
      console.log('  5. Copy the returned value\n');
      console.log('Then run with --user-id option:');
      console.log(`  ov uri "${projectUrl}" "${projectName || 'my-project'}" --user-id YOUR_USER_ID\n`);
      process.exit(0);
    }

    const name = projectName || 'my-project';
    const encodedQuery = encodeURIComponent(`user=${options.userId}&project=${projectId}`);
    const uri = `overleaf-workshop://${serverName}/${encodeURIComponent(name)}?${encodedQuery}`;

    console.log('✅ Generated URI:');
    console.log(uri);
    console.log('\n📝 Add this to .overleaf/settings.json:');
    console.log(JSON.stringify({
      uri,
      serverName,
      projectName: name,
      enableCompileNPreview: false,
    }, null, 2));
  });

program
  .command('config')
  .description('Show current configuration')
  .option('-c, --config <path>', 'Path to .overleaf/settings.json')
  .action(async (options) => {
    try {
      const { config, configPath } = await loadConfig(options.config);
      const localPath = getLocalPath(configPath);

      console.log('Configuration:');
      console.log(`  Config file: ${configPath}`);
      console.log(`  Local path: ${localPath}`);
      console.log(`  Project: ${config.projectName}`);
      console.log(`  Server: ${config.serverName}`);
      console.log(`  URI: ${config.uri}`);

      if (config['ignore-patterns']) {
        console.log(`  Ignore patterns: ${config['ignore-patterns'].length} patterns`);
      }
      if (config['sync-rules-file']) {
        console.log(`  Sync rules file: ${config['sync-rules-file']}`);
      } else {
        console.log('  Sync rules file: .overleaf/sync-rules.json (optional)');
      }
    } catch (error) {
      console.error(`Error: ${error}`);
      process.exit(1);
    }
  });

program.parse();

async function isCommandAvailable(
  command: string,
  args: string[] = []
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
    });

    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function resolveVSCodeConflict(
  conflict: SyncConflict,
  codeAvailable: boolean,
  onFinish: () => void
): Promise<ConflictResolutionResult> {
  console.log(`\n⚠️  Conflict detected: ${conflict.relPath}`);
  console.log(`   Conflict files: ${conflict.artifactsDir}`);

  if (!conflict.isText) {
    onFinish();
    return {
      resolved: false,
      message: `Conflict detected for ${conflict.relPath}: file is not valid UTF-8 text. Conflict artifacts written to ${conflict.artifactsDir}`,
    };
  }

  if (!conflict.hasBase) {
    console.log('   Base content is unavailable; using an empty base file.');
  }

  if (!codeAvailable) {
    console.log('   VS Code CLI is unavailable, so the merge editor was not opened.');
    console.log('   Open the files manually in VS Code after installing the "code" command.\n');
    onFinish();
    return {
      resolved: false,
      message: `Conflict detected for ${conflict.relPath}: VS Code CLI "code" was not found. Conflict artifacts written to ${conflict.artifactsDir}`,
    };
  }

  console.log('   Opening VS Code Merge Editor...');
  console.log(`   Result file: ${conflict.localPath}\n`);

  try {
    const exitCode = await runCommand('code', [
      '--wait',
      '--merge',
      conflict.incomingPath,
      conflict.currentPath,
      conflict.basePath,
      conflict.localPath,
    ]);

    onFinish();

    if (exitCode !== 0) {
      return {
        resolved: false,
        message: `Conflict detected for ${conflict.relPath}: VS Code Merge Editor exited with code ${exitCode}. Conflict artifacts written to ${conflict.artifactsDir}`,
      };
    }

    return { resolved: true };
  } catch (error) {
    onFinish();
    return {
      resolved: false,
      message: `Conflict detected for ${conflict.relPath}: failed to open VS Code Merge Editor (${error}). Conflict artifacts written to ${conflict.artifactsDir}`,
    };
  }
}

async function runCommand(command: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`terminated by signal ${signal}`));
        return;
      }

      resolve(code ?? 0);
    });
  });
}
