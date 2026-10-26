#!/usr/bin/env node

import { access, chmod, mkdir, readlink, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Usage: node scripts/install-local.js --connector-data-dir DIR [--connector-url URL]`;

async function linkStatus(link) {
  if (link.path === link.target) return 'unchanged';
  let current;
  try {
    current = await readlink(link.path);
  } catch (error) {
    if (error.code === 'ENOENT') return 'create';
    throw new Error(`Refusing to replace existing path: ${link.path}`, { cause: error });
  }
  if (path.resolve(path.dirname(link.path), current) === link.target) return 'unchanged';
  throw new Error(`Refusing to replace existing path: ${link.path}`);
}

async function checkConnector(connectorUrl) {
  const url = `${connectorUrl.replace(/\/$/, '')}/local/v1/health`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(`Cannot reach the local Connector at ${url}`);
  }
  const health = await response.json();
  if (!response.ok || !health.ok || !health.hub_connected) {
    throw new Error(`The local Connector at ${url} is not connected to its Hub`);
  }
}

export async function installLocal(options = {}) {
  const home = options.home ?? os.homedir();
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  if (!options.connectorDataDir) throw new Error('connectorDataDir is required');
  if (options.checkHealth !== false) {
    await checkConnector(options.connectorUrl ?? 'http://127.0.0.1:8788');
  }
  const cli = path.join(projectRoot, 'bin', 'agent-hub.js');
  const skill = path.join(projectRoot, 'skills', 'agent-hub');
  const connector = path.resolve(options.connectorDataDir);
  await Promise.all([access(cli), access(skill), access(connector)]);
  await chmod(cli, 0o755);
  const links = [
    { target: cli, path: path.join(home, '.local', 'bin', 'agent-hub'), type: 'file' },
    { target: skill, path: path.join(home, '.agents', 'skills', 'agent-hub'), type: 'dir' },
    { target: skill, path: path.join(home, '.claude', 'skills', 'agent-hub'), type: 'dir' },
    { target: connector, path: path.join(home, '.agent-hub', 'connector'), type: 'dir' },
  ];
  const statuses = await Promise.all(links.map((link) => linkStatus(link)));
  for (const link of links) await mkdir(path.dirname(link.path), { recursive: true });
  const installed = [];
  for (const [index, link] of links.entries()) {
    if (statuses[index] === 'create') await symlink(link.target, link.path, link.type);
    installed.push({ path: link.path, target: link.target, status: statuses[index] === 'create' ? 'created' : 'unchanged' });
  }
  return { links: installed };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help') return { help: true };
    if (!['--connector-data-dir', '--connector-url'].includes(item)) {
      throw new Error(`Unknown argument: ${item}\n${HELP}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${item} requires a value\n${HELP}`);
    options[item === '--connector-data-dir' ? 'connectorDataDir' : 'connectorUrl'] = value;
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else console.log(JSON.stringify(await installLocal(options), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
