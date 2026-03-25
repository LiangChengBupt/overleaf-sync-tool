#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function applyPatch(filePath, transforms) {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  for (const transform of transforms) {
    if (transform.skipIf && transform.skipIf(content)) {
      continue;
    }
    const next = content.replace(transform.from, transform.to);
    if (next === content) {
      throw new Error(`Patch failed for ${filePath}: ${transform.name}`);
    }
    content = next;
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

function main() {
  const root = process.cwd();
  const socketFile = path.join(
    root,
    'node_modules',
    'socket.io-client',
    'lib',
    'socket.js'
  );
  const wsFile = path.join(
    root,
    'node_modules',
    'socket.io-client',
    'lib',
    'transports',
    'websocket.js'
  );

  if (!fs.existsSync(socketFile) || !fs.existsSync(wsFile)) {
    console.log('[ov] socket.io-client files not found, skip patch.');
    return;
  }

  let patched = false;
  patched = applyPatch(socketFile, [
    {
      name: 'xhr extraHeaders',
      skipIf: (text) => text.includes('setDisableHeaderCheck'),
      from: /if \(this\.isXDomain\(\)\) \{\n\s+xhr\.withCredentials = true;\n\s+\}/,
      to: `if (this.isXDomain()) {\n        xhr.withCredentials = true;\n      }\n      if (this.options['extraHeaders']) {\n        xhr.setDisableHeaderCheck(true);\n        Object.entries(this.options['extraHeaders']).forEach(([key, value]) => {\n          xhr.setRequestHeader(key, value);\n        });\n      }`,
    },
    {
      name: 'merge set-cookie',
      skipIf: (text) => text.includes('extract set-cookie headers'),
      from: /if \(xhr\.status == 200\) \{\n\s+complete\(xhr\.responseText\);/,
      to: `if (xhr.status == 200) {\n            // extract set-cookie headers\n            const matches = xhr.getAllResponseHeaders().match(/set-cookie:\\\\s*([^\\\\r\\\\n]+)/gi);\n            matches && matches.forEach(function (header) {\n              const newCookie = header.split(':')[1].split(';')[0].trim();\n              const optCookie = self.options['extraHeaders']['Cookie'];\n              const mergedCookie = optCookie ? \`\${optCookie}; \${newCookie}\` : newCookie;\n              self.options['extraHeaders'] = self.options['extraHeaders'] || {};\n              self.options['extraHeaders']['Cookie'] = mergedCookie;\n            });\n\n            complete(xhr.responseText);`,
    },
    {
      name: 'open with extraHeaders',
      skipIf: (text) => text.includes("self.transport.open(self.options['extraHeaders']);"),
      from: /self\.transport\.open\(\);/,
      to: `self.transport.open(self.options['extraHeaders']);`,
    },
    {
      name: 'disconnect extraHeaders',
      skipIf: (text) =>
        text.includes("xhr.setDisableHeaderCheck(true);") &&
        text.includes("xhr.setRequestHeader(key, value);"),
      from: /xhr\.open\('GET', uri, false\);\n\s+xhr\.send\(null\);/,
      to: `xhr.open('GET', uri, false);\n    if (this.options['extraHeaders']) {\n      xhr.setDisableHeaderCheck(true);\n      Object.entries(this.options['extraHeaders']).forEach(([key, value]) => {\n        xhr.setRequestHeader(key, value);\n      });\n    }\n    xhr.send(null);`,
    },
  ]) || patched;

  patched = applyPatch(wsFile, [
    {
      name: 'websocket open signature',
      skipIf: (text) => text.includes('WS.prototype.open = function (extraHeaders)'),
      from: /WS\.prototype\.open = function \(\) \{/,
      to: `WS.prototype.open = function (extraHeaders) {`,
    },
    {
      name: 'websocket headers',
      skipIf: (text) => text.includes('headers: extraHeaders || {}'),
      from: /this\.websocket = new Socket\(this\.prepareUrl\(\) \+ query\);/,
      to: `this.websocket = new Socket(this.prepareUrl() + query, {\n      headers: extraHeaders || {}\n    });`,
    },
  ]) || patched;

  if (patched) {
    console.log('[ov] socket.io-client patched for extraHeaders support.');
  } else {
    console.log('[ov] socket.io-client already patched.');
  }
}

main();
