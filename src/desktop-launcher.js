import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from './build-info.js';
import { desktopServerOptions, startDesktopServer } from './desktop-session.js';

const execute = promisify(execFile);
export const DEFAULT_DESKTOP_APP = '/Applications/ChatGPT.app';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function desktopProcessIds(appPath = DEFAULT_DESKTOP_APP) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,comm=']);
  const prefix = `${path.resolve(appPath)}/Contents/MacOS/`;
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && match[2].startsWith(prefix) ? [Number(match[1])] : [];
  });
}

export async function verifiedDesktopPid(pid, appPath = DEFAULT_DESKTOP_APP) {
  const pids = await desktopProcessIds(appPath);
  if (pid !== undefined) {
    if (!Number.isInteger(Number(pid)) || !pids.includes(Number(pid))) throw new Error('--desktop-pid must identify the actual desktop App process');
    return Number(pid);
  }
  if (pids.length !== 1) throw new Error('Exactly one desktop App process must be running; use --desktop-pid for an explicitly identified instance');
  return pids[0];
}

// Called by the user's launcher. Never terminates a running desktop instance.
export async function openHubDesktop({ dataDir, appPath = DEFAULT_DESKTOP_APP, url,
  processes = desktopProcessIds, openApp = (args => execute('/usr/bin/open', args)), startServer = startDesktopServer }) {
  const existing = await processes(appPath);
  const options = await desktopServerOptions({ dataDir, url });
  if (existing.length) {
    if (existing.length !== 1 || existing[0] !== options.desktop_pid) {
      throw new Error('Codex desktop is already running outside this launcher. Finish its current work and fully quit it before switching; it has not been closed or restarted.');
    }
  }
  let backend = options;
  let running = false;
  if (Number.isInteger(options.pid)) { try { process.kill(options.pid, 0); running = true; } catch {} }
  if (!running) backend = await startServer({ dataDir, url: options.url,
    executable: path.join(appPath, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
  });
  if (existing.length) {
    await openApp(['-a', appPath]);
    const result = { ...backend, desktop_pid: existing[0], app_path: appPath };
    await writeFile(path.join(dataDir, 'desktop', 'server.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    return { status: 'focused', ...result };
  }
  await openApp(['-a', appPath, '--env', `CODEX_APP_SERVER_WS_URL=${backend.url}`]);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pids = await processes(appPath);
    if (pids.length === 1) {
      const result = { ...backend, desktop_pid: pids[0], app_path: appPath };
      await writeFile(path.join(dataDir, 'desktop', 'server.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
      return { status: 'launched', ...result };
    }
    if (pids.length > 1) throw new Error('Multiple desktop instances appeared; refusing to select one');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Desktop App did not start within 15 seconds');
}

// A double-clickable macOS entry point; the user never needs a console window.
export async function installDesktopLauncher({ output, dataDir, appPath = DEFAULT_DESKTOP_APP, nodePath = process.execPath, rootDir = PROJECT_ROOT }) {
  if (!output || !path.isAbsolute(output) || !output.endsWith('.app')) throw new Error('--output must be a new absolute .app path');
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output); // Refuse to overwrite any existing application.
  const contents = path.join(output, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>work.findu.agent-hub-codex</string>
<key>CFBundleName</key><string>Codex Hub</string>
<key>CFBundleExecutable</key><string>launch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSHumanReadableCopyright</key><string>${xml('Agent Hub desktop launcher')}</string>
</dict></plist>\n`;
  await writeFile(path.join(contents, 'Info.plist'), plist);
  const log = path.join(dataDir, 'desktop', 'launcher.log');
  const script = `#!/bin/sh
set -eu
umask 077
mkdir -p ${quote(path.dirname(log))}
if ! ${quote(nodePath)} ${quote(path.join(rootDir, 'bin/agent-hub.js'))} desktop open --data-dir ${quote(dataDir)} --app-path ${quote(appPath)} >>${quote(log)} 2>&1; then
  /usr/bin/osascript -e 'on run argv' -e 'display alert "Codex Hub" message (item 1 of argv)' -e 'end run' ${quote(`Codex could not open through Agent Hub. If the desktop is already running, finish its work and fully quit it first. Details: ${log}`)}
fi
`;
  await writeFile(path.join(contents, 'MacOS', 'launch'), script, { mode: 0o755 });
  return { launcher: output, desktop_app: appPath, data_dir: dataDir };
}
