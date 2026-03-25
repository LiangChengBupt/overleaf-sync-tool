#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import { loadConfig, getLocalPath } from './config';
import { Syncer } from './syncer';
import { SyncOptions, OverleafCredentials } from './types';
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

      // Setup logging
      const syncOptions: SyncOptions = {
        localPath,
        settings: config,
        credentials,
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
        process.stdout.write('Syncing...');
        const dots = ['.', '..', '...'];
        let dotIndex = 0;
        const interval = setInterval(() => {
          process.stdout.write(`\rSyncing${dots[dotIndex % dots.length]}`);
          dotIndex++;
        }, 500);

        process.on('exit', () => clearInterval(interval));
        process.on('SIGINT', () => {
          clearInterval(interval);
          process.exit();
        });
      }

      // Perform sync
      const syncer = new Syncer(syncOptions);
      const result = await syncer.sync();

      // Show results
      if (!options.verbose) {
        process.stdout.write('\r\x1b[K'); // Clear line
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
      } else {
        console.error(`\n❌ Sync completed with errors:`);
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
    } catch (error) {
      console.error(`Error: ${error}`);
      process.exit(1);
    }
  });

program.parse();
