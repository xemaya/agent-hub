import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from './build-info.js';

const execFileAsync = promisify(execFile);

export const SERVICE_LABEL = 'com.agent-hub.connector';

const INHERITED_ENV = ['AGENT_HUB_AUTO_UPDATE'];

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function plistValue(value, indent) {
  const pad = ' '.repeat(indent);
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
  if (Array.isArray(value)) {
    return [`${pad}<array>`, ...value.map((item) => plistValue(item, indent + 2)), `${pad}</array>`].join('\n');
  }
  if (value && typeof value === 'object') {
    return [
      `${pad}<dict>`,
      ...Object.entries(value).flatMap(([key, item]) => [
        `${pad}  <key>${escapeXml(key)}</key>`,
        plistValue(item, indent + 2),
      ]),
      `${pad}</dict>`,
    ].join('\n');
  }
  return `${pad}<string>${escapeXml(value)}</string>`;
}

export function connectorServiceSpec({
  hubUrl,
  name,
  dataDir,
  localPort,
  logFile,
  nodePath = process.execPath,
  rootDir = PROJECT_ROOT,
  env = process.env,
}) {
  if (!hubUrl) throw new Error('--hub-url is required');
  const args = [nodePath, path.join(rootDir, 'bin/agent-hub.js'), 'connector', '--hub-url', hubUrl, '--data-dir', dataDir];
  if (name) args.push('--name', name);
  if (localPort !== undefined) args.push('--local-port', String(localPort));
  return {
    Label: SERVICE_LABEL,
    ProgramArguments: args,
    WorkingDirectory: rootDir,
    EnvironmentVariables: {
      // Self-update needs the same git, node and pnpm PATH as the installing shell.
      PATH: env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: env.HOME ?? os.homedir(),
      AGENT_HUB_SUPERVISED: '1',
      ...Object.fromEntries(INHERITED_ENV.filter((key) => env[key] !== undefined).map((key) => [key, env[key]])),
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    StandardOutPath: logFile,
    StandardErrorPath: logFile,
  };
}

export function renderPlist(spec) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(spec, 0),
    '</plist>',
    '',
  ].join('\n');
}

export function servicePaths(home = os.homedir()) {
  return {
    plist: path.join(home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`),
    logFile: path.join(home, '.agent-hub/connector.log'),
  };
}

async function launchctl(args) {
  return execFileAsync('launchctl', args, { timeout: 15000 });
}

export async function installConnectorService(options, { exec = launchctl, home = os.homedir() } = {}) {
  const paths = servicePaths(home);
  const spec = connectorServiceSpec({ ...options, logFile: options.logFile ?? paths.logFile });
  await mkdir(path.dirname(paths.plist), { recursive: true });
  await mkdir(path.dirname(spec.StandardOutPath), { recursive: true });
  await writeFile(paths.plist, renderPlist(spec), { mode: 0o644 });
  const domain = `gui/${process.getuid()}`;
  await exec(['bootout', `${domain}/${SERVICE_LABEL}`]).catch(() => {});
  await exec(['bootstrap', domain, paths.plist]);
  return { label: SERVICE_LABEL, plist: paths.plist, log: spec.StandardOutPath };
}

export async function uninstallConnectorService({ exec = launchctl, home = os.homedir() } = {}) {
  const paths = servicePaths(home);
  await exec(['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`]).catch(() => {});
  await rm(paths.plist, { force: true });
  return { label: SERVICE_LABEL, removed: paths.plist };
}

export async function connectorServiceStatus({ exec = launchctl } = {}) {
  try {
    const { stdout } = await exec(['print', `gui/${process.getuid()}/${SERVICE_LABEL}`]);
    const state = /^\s*state = (.+)$/m.exec(stdout)?.[1] ?? 'unknown';
    const pid = /^\s*pid = (\d+)$/m.exec(stdout)?.[1];
    return { label: SERVICE_LABEL, loaded: true, state, pid: pid ? Number(pid) : null };
  } catch {
    return { label: SERVICE_LABEL, loaded: false };
  }
}
