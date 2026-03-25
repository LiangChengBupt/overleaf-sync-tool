#!/usr/bin/env node
/**
 * Helper script to generate Overleaf URI from project URL
 */

const PROJECT_URL_REGEX = /https?:\/\/([^\/]+)\/project\/([a-f0-9]+)/;

function generateUri(
  projectUrl: string,
  projectName?: string
): string {
  const match = projectUrl.match(PROJECT_URL_REGEX);

  if (!match) {
    console.error('Invalid Overleaf project URL');
    console.error('Expected format: https://www.overleaf.com/project/xxxxx');
    process.exit(1);
  }

  const [, serverName, projectId] = match;

  // userId 需要从浏览器获取或手动提供
  console.log('\nTo complete the URI, you need your userId.');
  console.log('\nHow to get userId:');
  console.log('1. Open your Overleaf project in browser');
  console.log('2. Press F12 to open Developer Tools');
  console.log('3. Go to Console tab');
  console.log('4. Type: window.user_id');
  console.log('5. Copy the returned value\n');

  const userId = process.env.USER_ID || '';
  const name = projectName || 'my-project';

  const uri = `overleaf-workshop://${serverName}/${userId}/${projectId}/${name}`;

  console.log('Generated URI:');
  console.log(uri);
  console.log('\nAdd this to .overleaf/settings.json:');
  console.log(JSON.stringify({
    uri,
    serverName,
    projectName: name,
  }, null, 2));

  return uri;
}

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: ov uri <project-url> [project-name]');
    console.log('');
    console.log('Examples:');
    console.log('  ov uri https://www.overleaf.com/project/1234567890abcdef');
    console.log('  ov uri https://www.overleaf.com/project/1234567890abcdef "My Paper"');
    console.log('');
    console.log('You can also set USER_ID environment variable:');
    console.log('  USER_ID=abc123 ov uri https://www.overleaf.com/project/1234567890abcdef');
    process.exit(0);
  }

  const [projectUrl, projectName] = args;
  generateUri(projectUrl, projectName);
}

export { generateUri };
