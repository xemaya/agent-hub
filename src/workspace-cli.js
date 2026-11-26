import { access, lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { readServerSentEvents } from './channel.js';
import { PROJECT_ROOT } from './build-info.js';
import { checkNativeQueue, currentDesktopPid } from './codex-queue-channel.js';
import { loadDoorConfig, saveDoorConfig } from './workspace-connector.js';
import {
  bridgeDirectory, runAntigravityDoor, runCodexDoor, runCodexMemberBridge, spawnDetached,
} from './workspace-bridges.js';

export const WORKSPACE_HELP = `agent-hub ws — 工作区：一组 agent 一起做一件事

队长（说「开工」的那个会话）：
  agent-hub ws doors                                   看哪些机器能拉人
  agent-hub ws project set KEY [--remote URL] [--branch main] [--path DIR] [--title T] [--antigravity-project ID]
  agent-hub ws projects
  agent-hub ws start NAME --title 标题 --goal 目标 [--project KEY] [--brief 文字|--brief-file F]
                  [--gather-minutes 3] [--invite] --seat SEAT=RUNTIME[/MODEL][@机器][:分工] [--seat …]
        例：--invite --seat cc-1=claude:写代码 --seat codex-1=codex:测试 --seat ag-1=antigravity:review
        --invite：座位等业主开好会话来加入（默认做法）；不带它就由门房拉起新会话
  agent-hub ws add [--invite] --seat SPEC [--seat …]  加人
  agent-hub ws relaunch SEAT                           重新拉起没报到或失败的座位；等加入的座位改由门房拉起
  agent-hub ws brief "新简报" | --file F               改简报（不带参数是看）
  agent-hub ws close [--summary 总结]                  收工

所有成员：
  agent-hub ws join TICKET                             报到（第一句话里给的报到单）
  agent-hub ws join NAME [--seat 座位] [--job 分工]     业主让已有会话加入工作区 NAME（不用报到单；先坐同类型的预留座位，没有就按类型新开一个）
  agent-hub ws status                                  队伍状态
  agent-hub ws say "话" [--to SEAT,SEAT]               群聊（--to 是私下说；话里 @座位 会优先叫醒对方）
  agent-hub ws handoff --to SEAT "交棒说明"            交棒给下一棒
  agent-hub ws inbox [--peek]                          读新消息（--peek 不标已读）
  agent-hub ws history [--limit 50]
  agent-hub ws note [--kind decision|fact|link|note] "内容"   记进记事本
  agent-hub ws notes
  agent-hub ws file put PATH [--note 说明] | file list | file get ID [--out PATH]
  agent-hub ws wait [--timeout-minutes N]             Claude 收信：用 Bash run_in_background 运行，来信时结束
  agent-hub ws leave

门房（每台机器）：
  agent-hub ws install-skill                            把工作区用法（skill）装给 Claude、Codex、反重力
  agent-hub ws door enable claude [--cwd 信任过的目录] [--executable PATH] [--args "--dangerously-skip-permissions"]
  agent-hub ws door disable claude
  agent-hub ws door start --runtime codex [--cwd DIR]   在常驻的 Codex 桌面对话里运行；没登记项目时新对话开在 DIR（默认当前目录）
  agent-hub ws door start --runtime antigravity [--foreground]   在反重力 Sidecar 或对话里运行
  agent-hub ws door status
  agent-hub ws codex-allow [--remove]                  让 Codex 跑 agent-hub ws 命令不再每次请业主批准（写 ~/.codex/rules/agent-hub.rules）

通用：--json 输出原始数据；--data-dir 指定 Connector 数据目录（默认 ~/.agent-hub/connector）
`;

const BOOLEAN = new Set(['json', 'peek', 'foreground', 'help', 'remove', 'invite']);
const REPEATABLE = new Set(['seat']);
// These always take the next word, even when it starts with -- (claude flags).
const TAKES_VALUE = new Set(['args']);

export function parseWorkspaceArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--') || item === '--') {
      positionals.push(item);
      continue;
    }
    let key = item.slice(2);
    let value;
    const equal = key.indexOf('=');
    if (equal !== -1) {
      value = key.slice(equal + 1);
      key = key.slice(0, equal);
    } else if (BOOLEAN.has(key)) {
      value = true;
    } else if (TAKES_VALUE.has(key) && argv[index + 1] !== undefined) {
      value = argv[index + 1];
      index += 1;
    } else {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) value = true;
      else {
        value = next;
        index += 1;
      }
    }
    if (REPEATABLE.has(key)) (flags[key] ??= []).push(value);
    else flags[key] = value;
  }
  return { positionals, flags };
}

// SEAT=RUNTIME[/MODEL][@MACHINE][:JOB]
export function parseSeatSpec(spec) {
  const match = /^([^=\s]+)=([A-Za-z]+)(?:\/([^@:]+))?(?:@([^:]+))?(?::([\s\S]*))?$/.exec(String(spec).trim());
  if (!match) throw new Error(`座位写法不对：${spec}（应为 座位=类型[/模型][@机器][:分工]，例 cc-1=claude@MacBook:写代码）`);
  return {
    seat: match[1],
    runtime: match[2].toLowerCase(),
    ...(match[3] ? { model: match[3].trim() } : {}),
    machine: match[4]?.trim() || 'auto',
    job: match[5]?.trim() ?? '',
  };
}

// Which native session is running this command. Explicit AGENT_HUB_WS_* wins (tests, other runtimes).
export function workspaceIdentity(env = process.env) {
  if (env.AGENT_HUB_WS_RUNTIME && env.AGENT_HUB_WS_SESSION_ID) return { runtime: env.AGENT_HUB_WS_RUNTIME, session_id: env.AGENT_HUB_WS_SESSION_ID };
  if (env.CLAUDECODE === '1' && env.CLAUDE_CODE_SESSION_ID) return { runtime: 'claude', session_id: env.CLAUDE_CODE_SESSION_ID };
  if (env.CODEX_SESSION_ID) return { runtime: 'codex', session_id: env.CODEX_SESSION_ID };
  if (env.ANTIGRAVITY_CONVERSATION_ID) return { runtime: 'antigravity', session_id: env.ANTIGRAVITY_CONVERSATION_ID };
  if (env.AGENT_HUB_RUNTIME && env.AGENT_HUB_SESSION_ID) return { runtime: env.AGENT_HUB_RUNTIME, session_id: env.AGENT_HUB_SESSION_ID };
  return null;
}

function requireIdentity() {
  const identity = workspaceIdentity();
  if (!identity) throw new Error('读不到当前会话身份：这条命令要在 Claude Code、Codex 或反重力的会话里运行');
  return identity;
}

async function dataDirOf(flags) {
  const chosen = flags['data-dir'] ?? process.env.AGENT_HUB_CONNECTOR_DATA_DIR;
  if (chosen) return path.resolve(chosen);
  // A checkout-local Connector only counts inside an agent-hub checkout. Elsewhere a stray
  // .runtime/connector (an old `agent-hub connector` run without --data-dir) must not win
  // over the installed Connector, or every command fails local authentication.
  const checkout = path.resolve('.runtime/connector');
  try {
    await access(path.join(checkout, 'connector.json'));
    await access(path.resolve('bin/agent-hub.js'));
    return checkout;
  } catch {
    return path.join(process.env.HOME ?? '.', '.agent-hub/connector');
  }
}

async function localOptions(flags) {
  const dataDir = await dataDirOf(flags);
  let stored = {};
  try {
    stored = JSON.parse(await readFile(path.join(dataDir, 'connector.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const token = process.env.AGENT_HUB_LOCAL_TOKEN ?? stored.localToken;
  if (!token) throw new Error(`这台机器没装 Agent Hub Connector（${dataDir} 里没有本机令牌）`);
  return { dataDir, token, baseUrl: (flags['connector-url'] ?? process.env.AGENT_HUB_CONNECTOR_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '') };
}

async function local(flags, pathname, { method = 'GET', body } = {}) {
  const options = await localOptions(flags);
  const response = await fetch(`${options.baseUrl}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${options.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error ?? `Connector 返回 HTTP ${response.status}`), { statusCode: response.status });
  return payload;
}

async function rpc(flags, op, args = {}, { identity = workspaceIdentity() } = {}) {
  return local(flags, '/local/v1/workspaces/rpc', { method: 'POST', body: { op, identity, args } });
}

// ---- formatting ----------------------------------------------------------------

const STATE_TEXT = { invited: '等加入', requested: '等门房', launching: '拉起中', launched: '已拉起，等报到', joined: '已报到', failed: '失败', left: '已离开' };
const WAKE_TEXT = { delivered: '已送到', resumed: '已叫醒', door: '交给门房', unreachable: '叫不醒', failed: '投递失败', sending: '投递中' };
const time = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '');
const clip = (value, max) => {
  const flat = String(value ?? '');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

function memberLine(member) {
  const where = `${member.runtime}${member.model ? `/${member.model}` : ''}${member.machine ? `@${member.machine}` : member.state === 'invited' ? '（哪台机器都行）' : '@?'}`;
  const bits = [STATE_TEXT[member.state] ?? member.state];
  if (member.state_detail) bits.push(member.state_detail);
  if (member.state === 'joined') {
    if (member.unread) bits.push(`未读 ${member.unread}`);
    if (member.wake_status) bits.push(`门铃：${WAKE_TEXT[member.wake_status] ?? member.wake_status}${member.wake_detail && ['unreachable', 'failed'].includes(member.wake_status) ? `（${member.wake_detail}）` : ''}`);
    if (member.runtime === 'claude' && !member.listening) bits.push('没在等信');
  }
  return `  - ${member.seat}${member.role === 'leader' ? '（队长）' : ''}  ${where}  ${member.job ? `分工：${member.job}  ` : ''}[${bits.join('，')}]`;
}

function messageLine(message, max = 400) {
  const tag = message.kind === 'handoff' ? '交棒' : message.kind === 'owner' ? '业主' : message.kind === 'system' ? '系统' : message.private ? '私信' : '群聊';
  return `  [${time(message.created_at)}][${tag}] ${message.sender}：${clip(message.body, max)}`;
}

function printBriefing(result) {
  const { workspace, me, members, project, recent, notes, files, wake, rules } = result;
  const lines = [
    `${result.rejoined ? '已在' : '报到成功：'}工作区「${workspace.title}」（${workspace.name}），你是 ${me.seat}，分工：${me.job || '听队长安排'}`,
    workspace.goal ? `目标：${workspace.goal}` : null,
    workspace.brief ? `简报（第 ${workspace.brief_version} 版）：\n${workspace.brief}` : '简报：队长还没写，先按目标和分工做，有疑问 @队长。',
    '队伍：',
    ...members.map(memberLine),
    project ? `项目：${project.project_key}${project.git_remote ? `（${project.git_remote}）` : ''}；这台机器上的目录：${project.path_here ?? '没登记'}；工作区分支：${workspace.branch}` : null,
    recent.length ? '最近的消息：' : null,
    ...recent.map((message) => messageLine(message, 300)),
    notes.length ? '记事本：' : null,
    ...notes.map((note) => `  - [${note.kind}] ${note.author}：${clip(note.body, 300)}`),
    files.length ? '文件区：' : null,
    ...files.map((file) => `  - ${file.file_id}  ${file.name}（${file.size} 字节，${file.uploader}）${file.note ? `：${clip(file.note, 120)}` : ''}`),
    '',
    rules,
    '',
    wake.text,
  ];
  console.log(lines.filter((line) => line !== null).join('\n'));
}

function printStatus(result) {
  const { workspace, members } = result;
  console.log([
    `工作区「${workspace.title}」（${workspace.name}，${workspace.status === 'active' ? '进行中' : '已收工'}），你是 ${result.me}`,
    workspace.goal ? `目标：${workspace.goal}` : null,
    `队伍（${members.length} 个座位）：`,
    ...members.map(memberLine),
    `记事本 ${result.notes} 条，文件 ${result.files} 个，消息 ${result.messages ?? result.latest_seq} 条`,
  ].filter(Boolean).join('\n'));
}

function printInbox(result) {
  if (!result.messages.length && !result.notes.length) {
    console.log(`工作区「${result.workspace.title}」：没有新消息。`);
    return;
  }
  console.log([
    `工作区「${result.workspace.title}」，你是 ${result.me}${result.peek ? '（只看，没标已读）' : ''}：`,
    ...result.messages.map((message) => `${messageLine(message, 20000)}${message.to_me ? '  ← 找你' : ''}`),
    result.notes.length ? '记事本新增：' : null,
    ...result.notes.map((note) => `  - [${note.kind}] ${note.author}：${note.body}`),
  ].filter(Boolean).join('\n'));
}

function out(flags, value, printer) {
  if (flags.json || !printer) console.log(JSON.stringify(value, null, 2));
  else printer(value);
}

async function readText(flags, key = 'file') {
  if (flags[key] && flags[key] !== true) return readFile(path.resolve(flags[key]), 'utf8');
  return null;
}

// What the owner says in each session they open: one line per seat still waiting, and
// the plain line any session can use (a seat is made for it by type).
export function inviteLines(workspace, members) {
  const seats = (members ?? []).filter((member) => member.role !== 'leader');
  const waiting = seats.filter((member) => member.state === 'invited');
  const plain = `加入 Agent Hub 工作区 ${workspace.name}`;
  if (waiting.length) {
    return ['', '这些座位等业主开好会话来加入。把下面的话转告业主，请业主在对应类型的会话里各说一句：',
      ...waiting.map((member) => `  - ${member.seat}（${member.runtime}）：${plain}，座位 ${member.seat}`),
      `别的会话想加入，说「${plain}」就行，按类型自动分座位。`];
  }
  if (seats.length) return [];
  return ['', `没留座位，谁来由业主定。把这句话转告业主：在要加入的会话里说「${plain}」（cc、codex、反重力都行，座位按类型自动分）。`];
}

function warningLines(warnings) {
  return warnings?.length ? ['', '注意：', ...warnings.map((warning) => `  - ${warning}`)] : [];
}

// Where a seat lands when its project has no directory registered on that machine.
function doorPlace(door) {
  const detail = door.detail ?? {};
  if (detail.default_cwd) return `，没登记项目时在 ${detail.default_cwd}`;
  if (detail.project_id) return `，没登记项目时在反重力项目 ${detail.project_id}`;
  return '';
}

// ---- Codex allow rule -------------------------------------------------------------

export const CODEX_RULES_FILE = 'agent-hub.rules';

// One prefix rule per spelling of the command. `decision = "allow"` makes Codex run a
// matching command outside its sandbox without asking: only `agent-hub ws …`, nothing else.
export function codexAllowRules({ absolute = null } = {}) {
  const heads = ['agent-hub', ...(absolute && absolute !== 'agent-hub' ? [absolute] : [])];
  return [
    '# Agent Hub workspace: let Codex run `agent-hub ws ...` without an approval prompt.',
    '# Written by `agent-hub ws codex-allow`; remove with `agent-hub ws codex-allow --remove`.',
    ...heads.map((head) => [
      'prefix_rule(',
      `    pattern = [${JSON.stringify(head)}, "ws"],`,
      '    decision = "allow",',
      '    justification = "Agent Hub workspace commands talk to the local Connector (127.0.0.1:8788) and start inbox bridges; the owner approved them once for all.",',
      ')',
    ].join('\n')),
    '',
  ].join('\n');
}

function findDecision(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.decision === 'string') return value.decision;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findDecision(item);
    if (found) return found;
  }
  return null;
}

async function codexAllowCommand(flags) {
  const home = process.env.HOME ?? '.';
  const directory = path.join(home, '.codex', 'rules');
  const file = path.join(directory, CODEX_RULES_FILE);
  if (flags.remove) {
    await rm(file, { force: true });
    out(flags, { removed: file }, () => console.log(`已删掉 ${file}。重启 Codex 后生效。`));
    return;
  }
  const absolute = await whichExecutable('agent-hub');
  await mkdir(directory, { recursive: true });
  await writeFile(file, codexAllowRules({ absolute }), { mode: 0o644 });
  const codex = flags.executable && flags.executable !== true ? String(flags.executable) : 'codex';
  const probes = [
    { argv: ['agent-hub', 'ws', 'inbox'], want: 'allow' },
    ...(absolute && absolute !== 'agent-hub' ? [{ argv: [absolute, 'ws', 'inbox'], want: 'allow' }] : []),
    { argv: ['agent-hub', 'worker', 'list'], want: null },
  ];
  const checked = [];
  for (const probe of probes) {
    const result = await runCommand(codex, ['execpolicy', 'check', '--rules', file, '--', ...probe.argv]);
    if (result.missing) {
      out(flags, { file, verified: false }, () => console.log([
        `已写好 ${file}，但这里找不到 codex 命令，没法核对规则。`,
        '重启 Codex 后，新对话跑 agent-hub ws 命令时如果还要批准，告诉业主。',
      ].join('\n')));
      return;
    }
    let decision = null;
    try { decision = findDecision(JSON.parse(result.stdout)); } catch {}
    if (result.code !== 0 || (probe.want && decision !== probe.want) || (!probe.want && decision === 'allow')) {
      await rm(file, { force: true });
      throw new Error(`规则核对没通过，已删掉 ${file}，没有改动 Codex：${probe.argv.join(' ')} → ${decision ?? '无匹配'}（退出码 ${result.code}）${(result.stderr || result.stdout).trim().slice(0, 400)}`);
    }
    checked.push(`${probe.argv.join(' ')} → ${decision ?? '不放行（照常批准）'}`);
  }
  out(flags, { file, verified: true, checked }, () => console.log([
    `已写好 ${file}，核对通过：`,
    ...checked.map((line) => `  - ${line}`),
    '要重启 Codex 才生效（请业主退出 Codex 再打开）。重启后门房要在门房对话里再运行一次 agent-hub ws door start --runtime codex。',
    '以后 Codex 里的 agent-hub ws 命令要单独一条跑：不接管道、重定向、&&，不加环境变量前缀，否则规则对不上，还会弹批准。',
  ].join('\n')));
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 20000 }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') return resolve({ missing: true });
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: `${stdout}`, stderr: `${stderr}` });
    });
  });
}

// ---- Codex bridges ---------------------------------------------------------------

async function startCodexBridge(flags, identity, { cwd = process.cwd() } = {}) {
  const options = await localOptions(flags);
  let desktopPid;
  try {
    desktopPid = await currentDesktopPid();
    await checkNativeQueue(flags.executable ?? 'codex');
  } catch (error) {
    return { status: 'not_started', reason: `没起收信桥：${error.message}。新消息不会自动送进来，要靠自己 agent-hub ws inbox。` };
  }
  return spawnDetached({
    dataDir: options.dataDir,
    name: `codex-member-${identity.session_id}`,
    args: ['_member-bridge', '--session-id', identity.session_id, '--cwd', cwd, '--desktop-pid', String(desktopPid),
      ...(flags.executable ? ['--executable', flags.executable] : []), ...(flags['connector-url'] ? ['--connector-url', flags['connector-url']] : [])],
  });
}

async function afterJoin(flags, identity, result) {
  if (identity.runtime !== 'codex') return;
  const bridge = await startCodexBridge(flags, identity);
  if (flags.json) return;
  if (bridge.status === 'not_started') console.log(`\n注意：${bridge.reason}`);
  else console.log(`\n收信桥：${bridge.status === 'already_running' ? '已在运行' : '已启动'}（PID ${bridge.pid}，日志 ${bridge.log}）`);
}

// ---- commands -------------------------------------------------------------------

async function doorCommand(positionals, flags) {
  const action = positionals[0];
  const options = await localOptions(flags);
  if (action === 'enable' || action === 'disable') {
    if (positionals[1] !== 'claude') throw new Error('只有 Claude 门房用 enable/disable；Codex 和反重力用 agent-hub ws door start --runtime …');
    const config = await loadDoorConfig(options.dataDir);
    if (action === 'disable') {
      config.claude = { ...(config.claude ?? {}), enabled: false };
    } else {
      const executable = flags.executable && flags.executable !== true ? path.resolve(flags.executable) : await whichExecutable('claude');
      if (!executable) throw new Error('找不到 claude 命令；用 --executable 指定');
      const args = flags.args && flags.args !== true ? String(flags.args).split(/\s+/).filter(Boolean) : ['--dangerously-skip-permissions'];
      config.claude = { enabled: true, executable, args, default_cwd: path.resolve(flags.cwd && flags.cwd !== true ? flags.cwd : process.cwd()) };
    }
    await saveDoorConfig(options.dataDir, config);
    const refreshed = await local(flags, '/local/v1/workspaces/doors/refresh', { method: 'POST', body: {} });
    out(flags, { claude: config.claude, doors: refreshed.doors }, () => console.log(action === 'enable'
      ? `Claude 门房已开：${config.claude.executable} ${config.claude.args.join(' ')}\n默认目录：${config.claude.default_cwd}（必须是这台机器上 claude 确认过信任的目录；项目登记的目录优先）`
      : 'Claude 门房已关。'));
    return;
  }
  if (action === 'start') {
    const runtime = flags.runtime;
    if (runtime === 'codex') {
      const identity = workspaceIdentity();
      if (identity?.runtime !== 'codex') throw new Error('Codex 门房要在常驻的 Codex 桌面对话里运行');
      const desktopPid = await currentDesktopPid();
      await checkNativeQueue(flags.executable ?? 'codex');
      const started = await spawnDetached({ dataDir: options.dataDir, name: `codex-door-${identity.session_id}`,
        args: ['_door', '--runtime', 'codex', '--session-id', identity.session_id, '--cwd', path.resolve(flags.cwd && flags.cwd !== true ? String(flags.cwd) : process.cwd()), '--desktop-pid', String(desktopPid),
          ...(flags.executable ? ['--executable', flags.executable] : [])] });
      out(flags, started, () => console.log(`Codex 门房${started.status === 'already_running' ? '已在运行' : '已启动'}（PID ${started.pid}）。这个对话以后会收到「开新对话」的请求，按请求开新对话即可。日志：${started.log}`));
      return;
    }
    if (runtime === 'antigravity') {
      if (!process.env.ANTIGRAVITY_LS_ADDRESS) console.error('提醒：没有 ANTIGRAVITY_LS_ADDRESS；门房要在反重力 Sidecar 或反重力对话的终端里运行，否则开不了对话。');
      if (flags.foreground) {
        await runAntigravityDoor({ connectorUrl: options.baseUrl, token: options.token, agentapi: flags.agentapi,
          lockFile: path.join(bridgeDirectory(options.dataDir), 'antigravity-door.lock') });
        return;
      }
      const started = await spawnDetached({ dataDir: options.dataDir, name: 'antigravity-door',
        args: ['_door', '--runtime', 'antigravity', ...(flags.agentapi ? ['--agentapi', flags.agentapi] : [])] });
      out(flags, started, () => console.log(`反重力门房${started.status === 'already_running' ? '已在运行' : '已启动'}（PID ${started.pid}）。日志：${started.log}`));
      return;
    }
    throw new Error('用法：agent-hub ws door start --runtime codex|antigravity');
  }
  if (action === 'report') {
    const result = await local(flags, '/local/v1/workspaces/result', { method: 'POST', body: {
      kind: 'launch', member_id: flags.member, status: flags.status === 'failed' ? 'failed' : 'queued', error: flags.error && flags.error !== true ? String(flags.error) : undefined,
    } });
    out(flags, result, () => console.log('已回报。'));
    return;
  }
  if (action === 'status' || !action) {
    const here = await local(flags, '/local/v1/workspaces/doors');
    const all = await rpc(flags, 'doors.list');
    out(flags, { here: here.doors, all: all.doors }, () => console.log([
      `这台机器：${here.doors.length ? here.doors.map((door) => `${door.runtime}（${door.kind}）`).join('、') : '没开门房'}`,
      '所有机器：',
      ...all.doors.map((door) => `  - ${door.machine}：${door.runtime}（${door.kind}）${door.online ? '在线' : '离线'}`),
    ].join('\n')));
    return;
  }
  throw new Error('用法：agent-hub ws door enable|disable|start|status');
}

async function whichExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function waitCommand(flags) {
  const identity = requireIdentity();
  const me = await rpc(flags, 'ws.me', {}, { identity });
  const options = await localOptions(flags);
  const deadline = flags['timeout-minutes'] ? Date.now() + Number(flags['timeout-minutes']) * 60000 : null;
  // The Claude process that owns this session: if it exits, nobody would read what this wait prints.
  const ownerPid = Number(process.env.CLAUDE_PID) || null;
  const query = new URLSearchParams({ runtime: identity.runtime, session_id: identity.session_id, mode: 'wait', ...(ownerPid ? { owner_pid: String(ownerPid) } : {}) });
  if (ownerPid) {
    const watch = setInterval(() => {
      try { process.kill(ownerPid, 0); } catch (error) {
        if (error.code === 'ESRCH') {
          console.error('所属的会话已经退出，停止等信。');
          process.exit(3);
        }
      }
    }, 2000);
    watch.unref();
  }
  let failures = 0;
  while (true) {
    const abort = new AbortController();
    const timer = deadline ? setTimeout(() => abort.abort(), Math.max(0, deadline - Date.now())) : null;
    try {
      const response = await fetch(`${options.baseUrl}/local/v1/workspaces/listen?${query}`, {
        headers: { authorization: `Bearer ${options.token}` }, signal: abort.signal,
      });
      if (!response.ok) throw new Error(`Connector 返回 HTTP ${response.status}`);
      failures = 0;
      for await (const event of readServerSentEvents(response.body)) {
        if (event.type !== 'wake') continue;
        clearTimeout(timer);
        console.log(event.text);
        console.log('\n处理完以后，再用 Bash 工具的 run_in_background 运行 `agent-hub ws wait` 继续等信。');
        return;
      }
    } catch (error) {
      if (deadline && Date.now() >= deadline) {
        console.log(`等了 ${flags['timeout-minutes']} 分钟，工作区「${me.workspace.title}」没有新消息。`);
        return;
      }
      failures += 1;
      if (failures > 200) throw new Error(`收信连接一直连不上（${error.message}）；确认 Connector 在运行后，再后台运行 agent-hub ws wait`);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function fileCommand(positionals, flags) {
  const action = positionals[0];
  const identity = requireIdentity();
  const options = await localOptions(flags);
  if (action === 'put') {
    const file = positionals[1];
    if (!file) throw new Error('用法：agent-hub ws file put PATH [--note 说明]');
    const absolute = path.resolve(file);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`${file} 不是文件`);
    const query = new URLSearchParams({ runtime: identity.runtime, session_id: identity.session_id, name: path.basename(absolute),
      size: String(info.size), ...(flags.note && flags.note !== true ? { note: String(flags.note) } : {}),
      ...(flags['content-type'] ? { content_type: String(flags['content-type']) } : {}) });
    const response = await fetch(`${options.baseUrl}/local/v1/workspaces/files?${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/octet-stream' },
      body: Readable.toWeb(createReadStream(absolute)),
      duplex: 'half',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `上传失败 HTTP ${response.status}`);
    out(flags, payload, () => console.log(`已上传 ${payload.file.name}（${payload.file.size} 字节），编号 ${payload.file.file_id}`));
    return;
  }
  if (action === 'get') {
    const fileId = positionals[1];
    if (!fileId) throw new Error('用法：agent-hub ws file get ID [--out PATH]');
    const query = new URLSearchParams({ runtime: identity.runtime, session_id: identity.session_id });
    const response = await fetch(`${options.baseUrl}/local/v1/workspaces/files/${encodeURIComponent(fileId)}?${query}`, {
      headers: { authorization: `Bearer ${options.token}` },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? `下载失败 HTTP ${response.status}`);
    }
    const name = decodeURIComponent(response.headers.get('x-agent-hub-file-name') ?? fileId);
    const target = path.resolve(flags.out && flags.out !== true ? flags.out : name);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
    out(flags, { file_id: fileId, path: target }, () => console.log(`已保存到 ${target}`));
    return;
  }
  if (action === 'list' || !action) {
    const result = await rpc(flags, 'ws.files', {}, { identity });
    out(flags, result, () => console.log(result.files.length
      ? result.files.map((file) => `- ${file.file_id}  ${file.name}（${file.size} 字节，${file.uploader}，${time(file.created_at)}）${file.note ? `：${file.note}` : ''}`).join('\n')
      : '文件区是空的。'));
    return;
  }
  throw new Error('用法：agent-hub ws file put|get|list');
}

// Links the workspace Skill where Claude Code, Codex/Kimi and Antigravity look for skills. Never overwrites.
export async function installWorkspaceSkill({ home = process.env.HOME ?? '.', projectRoot = PROJECT_ROOT } = {}) {
  const target = path.join(projectRoot, 'skills', 'agent-hub-workspace');
  await access(path.join(target, 'SKILL.md'));
  const places = [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills')];
  try {
    await access(path.join(home, '.gemini', 'config'));
    places.push(path.join(home, '.gemini', 'config', 'skills'));
  } catch {}
  const results = [];
  for (const place of places) {
    const link = path.join(place, 'agent-hub-workspace');
    let status;
    try {
      const info = await lstat(link);
      status = info.isSymbolicLink() && path.resolve(place, await readlink(link)) === target ? 'unchanged' : 'conflict';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(place, { recursive: true });
      await symlink(target, link, 'dir');
      status = 'created';
    }
    results.push({ path: link, target, status });
  }
  return { links: results };
}

async function internalCommand(command, flags) {
  const options = await localOptions(flags);
  const directory = bridgeDirectory(options.dataDir);
  if (command === '_member-bridge') {
    await runCodexMemberBridge({ connectorUrl: options.baseUrl, token: options.token, sessionId: flags['session-id'], cwd: flags.cwd,
      desktopPid: Number(flags['desktop-pid']) || null, executable: flags.executable ?? 'codex',
      lockFile: path.join(directory, `codex-member-${flags['session-id']}.lock`) });
    return;
  }
  if (command === '_door' && flags.runtime === 'codex') {
    await runCodexDoor({ connectorUrl: options.baseUrl, token: options.token, sessionId: flags['session-id'], cwd: flags.cwd,
      desktopPid: Number(flags['desktop-pid']) || null, executable: flags.executable ?? 'codex',
      lockFile: path.join(directory, `codex-door-${flags['session-id']}.lock`) });
    return;
  }
  if (command === '_door' && flags.runtime === 'antigravity') {
    await runAntigravityDoor({ connectorUrl: options.baseUrl, token: options.token, agentapi: flags.agentapi,
      lockFile: path.join(directory, 'antigravity-door.lock') });
    return;
  }
  throw new Error(`unknown internal command ${command}`);
}

export async function workspaceCommand(argv) {
  const { positionals, flags } = parseWorkspaceArgs(argv);
  const command = positionals[0];
  const rest = positionals.slice(1);
  if (!command || command === 'help' || flags.help) {
    console.log(WORKSPACE_HELP);
    return;
  }
  if (command.startsWith('_')) return internalCommand(command, flags);
  if (command === 'door') return doorCommand(rest, flags);
  if (command === 'codex-allow') return codexAllowCommand(flags);
  if (command === 'install-skill') {
    const result = await installWorkspaceSkill();
    out(flags, result, () => console.log(result.links.map((link) => `${link.status === 'created' ? '已装' : link.status === 'unchanged' ? '已有' : '有同名文件，没覆盖'}：${link.path}`).join('\n')));
    return;
  }
  if (command === 'file') return fileCommand(rest, flags);
  if (command === 'wait') return waitCommand(flags);
  if (command === 'doors') {
    const result = await rpc(flags, 'doors.list');
    out(flags, result, () => console.log(result.doors.length
      ? ['能拉人的机器：', ...result.doors.map((door) => `  - ${door.machine}：${door.runtime}（${door.kind === 'connector' ? '命令起后台会话' : '门房桥'}）${door.online ? '在线' : '离线'}${doorPlace(door)}`)].join('\n')
      : '还没有任何机器开门房。'));
    return;
  }
  if (command === 'projects') {
    const result = await rpc(flags, 'projects.list');
    out(flags, result, () => console.log(result.projects.length
      ? result.projects.map((project) => `- ${project.project_key}  ${project.title || ''}  ${project.git_remote ?? ''}  默认分支 ${project.default_branch ?? '?'}  登记了 ${Object.keys(project.paths).length} 台机器`).join('\n')
      : '还没有登记项目。'));
    return;
  }
  if (command === 'project') {
    if (rest[0] !== 'set' || !rest[1]) throw new Error('用法：agent-hub ws project set KEY [--remote URL] [--branch main] [--path DIR] [--title T] [--antigravity-project ID]');
    const args = { key: rest[1] };
    if (flags.title && flags.title !== true) args.title = String(flags.title);
    if (flags.remote && flags.remote !== true) args.git_remote = String(flags.remote);
    if (flags.branch && flags.branch !== true) args.default_branch = String(flags.branch);
    args.path = path.resolve(flags.path && flags.path !== true ? flags.path : process.cwd());
    if (flags['antigravity-project'] && flags['antigravity-project'] !== true) args.antigravity_project = String(flags['antigravity-project']);
    else if (process.env.ANTIGRAVITY_PROJECT_ID && workspaceIdentity()?.runtime === 'antigravity') args.antigravity_project = process.env.ANTIGRAVITY_PROJECT_ID;
    const result = await rpc(flags, 'project.set', args);
    out(flags, result, () => console.log(`项目 ${result.project.project_key} 已登记，这台机器的目录：${args.path}`));
    return;
  }
  if (command === 'start') {
    const identity = requireIdentity();
    const name = rest[0];
    if (!name) throw new Error('用法：agent-hub ws start NAME --title 标题 --goal 目标 --seat …');
    const seats = flags['seats-json'] ? JSON.parse(flags['seats-json']) : (flags.seat ?? []).map(parseSeatSpec);
    const brief = (await readText(flags, 'brief-file')) ?? (flags.brief && flags.brief !== true ? String(flags.brief) : undefined);
    const result = await rpc(flags, 'ws.create', {
      name,
      title: flags.title && flags.title !== true ? String(flags.title) : undefined,
      goal: flags.goal && flags.goal !== true ? String(flags.goal) : undefined,
      brief,
      project: flags.project && flags.project !== true ? String(flags.project) : undefined,
      leader_seat: flags['leader-seat'] && flags['leader-seat'] !== true ? String(flags['leader-seat']) : undefined,
      ...(flags['gather-minutes'] !== undefined ? { gather_ms: Math.round(Number(flags['gather-minutes']) * 60000) } : {}),
      ...(flags.invite ? { invite: true } : {}),
      seats,
    }, { identity });
    out(flags, result, () => console.log([
      `开工：工作区「${result.workspace.title}」（${result.workspace.name}），你是队长 ${result.me.seat}。`,
      `攒信时间 ${Math.round(result.workspace.gather_ms / 60000 * 10) / 10} 分钟；工作区分支 ${result.workspace.branch}。`,
      '座位：',
      ...result.members.map(memberLine),
      '',
      result.workspace.brief
        ? '简报已发出，队员报到时就能看到。队员报到后会在工作区里说，用 agent-hub ws status 看进度。'
        : '下一步：先把下面加入的话告诉业主，再用 agent-hub ws brief --file 简报.md 写简报（目标、约束、谁做什么、怎么验收），已经加入的人会马上收到。用 agent-hub ws status 看进度。',
      result.wake.text,
      ...inviteLines(result.workspace, result.members),
      ...warningLines(result.warnings),
    ].join('\n')));
    await afterJoin(flags, identity, result);
    return;
  }
  if (command === 'add') {
    const seats = flags['seats-json'] ? JSON.parse(flags['seats-json']) : (flags.seat ?? []).map(parseSeatSpec);
    const result = await rpc(flags, 'ws.add', { seats, ...(flags.invite ? { invite: true } : {}) });
    const workspace = flags.invite ? (await rpc(flags, 'ws.status')).workspace : null;
    out(flags, result, () => console.log(['已加座位：', ...result.members.map(memberLine), ...(workspace ? inviteLines(workspace, result.members) : []), ...warningLines(result.warnings)].join('\n')));
    return;
  }
  if (command === 'relaunch') {
    const result = await rpc(flags, 'ws.relaunch', { seat: rest[0] });
    out(flags, result, () => console.log([`已重新拉起：`, memberLine(result.member), ...warningLines(result.warnings)].join('\n')));
    return;
  }
  if (command === 'join') {
    const identity = requireIdentity();
    // A door-launched seat brings a ticket (wst_…); an existing session the owner sends in
    // names the workspace instead.
    const target = rest[0];
    const args = !target ? {} : target.startsWith('wst_') ? { ticket: target } : {
      workspace: target,
      ...([flags.seat].flat()[0] && [flags.seat].flat()[0] !== true ? { seat: String([flags.seat].flat()[0]) } : {}),
      ...(flags.job && flags.job !== true ? { job: String(flags.job) } : {}),
    };
    const result = await rpc(flags, 'ws.join', args, { identity });
    out(flags, result, printBriefing);
    await afterJoin(flags, identity, result);
    return;
  }
  if (command === 'status') {
    out(flags, await rpc(flags, 'ws.status'), printStatus);
    return;
  }
  if (command === 'say' || command === 'handoff') {
    const body = (await readText(flags)) ?? rest.join(' ');
    const to = flags.to && flags.to !== true ? String(flags.to).split(',').map((seat) => seat.trim()).filter(Boolean) : [];
    const result = await rpc(flags, 'ws.say', { text: body, to, kind: command === 'handoff' ? 'handoff' : 'chat' });
    out(flags, result, () => console.log(`${command === 'handoff' ? '已交棒' : '已发出'}（第 ${result.message.seq} 条）${result.delivered_to.length ? `，${command === 'handoff' ? '全队都能看到，交给' : '收件人'}：${(command === 'handoff' ? to : result.delivered_to).join('、')}` : '，现在没有已报到的收件人'}`));
    return;
  }
  if (command === 'inbox') {
    out(flags, await rpc(flags, 'ws.inbox', { peek: Boolean(flags.peek), ...(flags.limit ? { limit: Number(flags.limit) } : {}) }), printInbox);
    return;
  }
  if (command === 'history') {
    const result = await rpc(flags, 'ws.history', { limit: Number(flags.limit) || 50 });
    out(flags, result, () => console.log(result.messages.map((message) => messageLine(message, 2000)).join('\n') || '还没有消息。'));
    return;
  }
  if (command === 'note') {
    const body = (await readText(flags)) ?? rest.join(' ');
    const result = await rpc(flags, 'ws.note', { text: body, kind: flags.kind && flags.kind !== true ? String(flags.kind) : 'note' });
    out(flags, result, () => console.log(`已记进记事本（${result.note.kind}）。`));
    return;
  }
  if (command === 'notes') {
    const result = await rpc(flags, 'ws.notes');
    out(flags, result, () => console.log(result.notes.map((note) => `- [${note.kind}] ${note.author}（${time(note.created_at)}）：${note.body}`).join('\n') || '记事本是空的。'));
    return;
  }
  if (command === 'brief') {
    const body = (await readText(flags)) ?? (rest.length ? rest.join(' ') : undefined);
    const result = await rpc(flags, 'ws.brief', body === undefined ? {} : { text: body });
    out(flags, result, () => console.log(body === undefined
      ? `${result.goal ? `目标：${result.goal}\n` : ''}简报（第 ${result.brief_version} 版）：\n${result.brief || '（还没写）'}`
      : `简报已更新到第 ${result.brief_version} 版，已加入的队员马上会收到，之后加入的报到时就能看到。`));
    return;
  }
  if (command === 'close') {
    const result = await rpc(flags, 'ws.close', { summary: flags.summary && flags.summary !== true ? String(flags.summary) : rest.join(' ') || undefined });
    out(flags, result, () => console.log([`已收工：${result.workspace.title}。队员留着不关。`, result.merge ? `代码：${result.merge}` : null].filter(Boolean).join('\n')));
    return;
  }
  if (command === 'leave') {
    out(flags, await rpc(flags, 'ws.leave'), () => console.log('已离开工作区。'));
    return;
  }
  if (command === 'list') {
    const result = await rpc(flags, 'ws.list');
    out(flags, result, () => console.log(result.workspaces.length
      ? result.workspaces.map((item) => `- ${item.name}「${item.title}」队长 ${item.leader ?? '?'}，${item.members} 个座位${item.workspace_id === result.member_of ? '  ← 你在这里' : ''}`).join('\n')
      : '没有进行中的工作区。'));
    return;
  }
  throw new Error(`不认识的命令 ws ${command}；agent-hub ws help 看用法`);
}
