import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTestContext, waitFor } from './helpers.js';
import { readServerSentEvents } from '../src/channel.js';
import { saveDoorConfig } from '../src/workspace-connector.js';
import { codexAllowRules, inviteLines, parseSeatSpec, parseWorkspaceArgs, workspaceCommand, workspaceIdentity } from '../src/workspace-cli.js';
import { antigravityCreate, codexDoorInstruction, codexQueued } from '../src/workspace-bridges.js';

const LEADER = { runtime: 'claude', session_id: 'leader-session' };
const CC = { runtime: 'claude', session_id: 'cc-session' };

function fakeClaude() {
  const calls = [];
  const state = { sessions: [] };
  const run = async (executable, args, options = {}) => {
    calls.push({ executable, args, options });
    if (args[0] === 'agents') return { code: 0, stdout: JSON.stringify(state.sessions), stderr: '' };
    if (args[0] === 'stop') return { code: 0, stdout: `stopped ${args[1]}\n`, stderr: '' };
    if (args[0] === '--bg') return { code: 0, stdout: 'backgrounded · abcd1234 · seat\n  claude agents  list sessions\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { calls, state, run };
}

async function context(t, { claude = fakeClaude(), hub = {} } = {}) {
  const ctx = await createTestContext(t, {
    hub: { workspace: { gatherMs: 150, tickMs: 25, retryMs: 150, ringMs: 60000, ...hub } },
    connector: { workspace: { run: claude.run, keepaliveMs: 1000 } },
  });
  ctx.claude = claude;
  ctx.rpc = async (op, identity, args = {}) => {
    const { response, payload } = await ctx.local('/local/v1/workspaces/rpc', { method: 'POST', body: { op, identity, args } });
    if (!response.ok) throw Object.assign(new Error(payload.error), { status: response.status });
    return payload;
  };
  ctx.enableClaudeDoor = async () => {
    await saveDoorConfig(ctx.connector.store.dataDir, {
      claude: { enabled: true, executable: 'claude-fake', args: ['--dangerously-skip-permissions'], default_cwd: ctx.root },
    });
    const { payload } = await ctx.local('/local/v1/workspaces/doors/refresh', { method: 'POST', body: {} });
    return payload;
  };
  // A listener stream as `agent-hub ws wait` (mode wait) or a bridge (mode stream) holds it.
  ctx.listen = async (identity, { mode = 'wait', pathname = '/local/v1/workspaces/listen', query = {} } = {}) => {
    const abort = new AbortController();
    const params = new URLSearchParams({ ...(identity ? { runtime: identity.runtime, session_id: identity.session_id } : {}), mode, ...query });
    const response = await fetch(`${ctx.connector.localUrl}${pathname}?${params}`, {
      headers: { authorization: `Bearer ${ctx.connector.store.credentials.localToken}` }, signal: abort.signal,
    });
    const events = [];
    const pump = (async () => {
      try { for await (const event of readServerSentEvents(response.body)) events.push(event); } catch {}
    })();
    ctx.onClose?.(() => abort.abort());
    t.after(() => abort.abort());
    return { events, pump, close: () => abort.abort(), next: (type) => waitFor(() => events.find((event) => event.type === type && !event.taken && (event.taken = true))) };
  };
  return ctx;
}

async function startTeam(ctx) {
  await ctx.enableClaudeDoor();
  const created = await ctx.rpc('ws.create', LEADER, {
    name: 'search-v2',
    title: '搜索第二版',
    goal: '把搜索办成率做上去',
    seats: [{ seat: 'cc-1', runtime: 'claude', machine: 'test-mac', job: '写代码' }],
  });
  const launch = await waitFor(() => ctx.claude.calls.find((call) => call.args[0] === '--bg' && call.args.includes('search-v2-cc-1')));
  const prompt = launch.args.at(-1);
  const ticket = /agent-hub ws join (wst_\S+)/.exec(prompt)[1];
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(created.workspace.workspace_id, 'cc-1').state === 'launched');
  return { created, launch, ticket, workspaceId: created.workspace.workspace_id };
}

test('开工：门房用 claude --bg 拉起座位，报到单只在第一句话里', async (t) => {
  const ctx = await context(t);
  assert.equal((await ctx.rpc('doors.list', null)).doors.length, 0, 'no door until a machine opens one');
  await ctx.enableClaudeDoor();
  const doors = await waitFor(async () => {
    const value = await ctx.rpc('doors.list', null);
    return value.doors.length ? value : null;
  });
  assert.equal(doors.doors.length, 1);
  assert.deepEqual([doors.doors[0].runtime, doors.doors[0].kind, doors.doors[0].online, doors.doors[0].machine], ['claude', 'connector', true, 'test-mac']);

  const { created, launch, ticket, workspaceId } = await startTeam(ctx);
  assert.equal(created.me.seat, 'leader');
  assert.equal(created.me.role, 'leader');
  assert.equal(created.wake.mode, 'wait');
  assert.equal(launch.executable, 'claude-fake');
  assert.ok(launch.args.includes('--dangerously-skip-permissions'));
  assert.equal(launch.args[launch.args.indexOf('--name') + 1], 'search-v2-cc-1');
  // The seat talks to the Connector that opened it, runs its agent-hub, and does not inherit this session's identity.
  assert.equal(launch.options.env.AGENT_HUB_CONNECTOR_URL, ctx.connector.localUrl);
  assert.ok(launch.options.env.PATH.startsWith(path.join(ctx.connector.store.dataDir, 'workspace-bin')));
  assert.equal(launch.options.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(launch.options.env.CLAUDECODE, undefined);
  assert.equal(launch.options.cwd, ctx.root);
  assert.match(launch.args.at(-1), /座位是 cc-1，分工：写代码/);
  const stored = ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1');
  assert.equal(stored.launch.detail.short_id, 'abcd1234');
  assert.notEqual(stored.ticket_hash, ticket, 'only the hash of the ticket is stored');

  const briefing = await ctx.rpc('ws.join', CC, { ticket });
  assert.equal(briefing.rejoined, false);
  assert.equal(briefing.me.seat, 'cc-1');
  assert.equal(briefing.me.state, 'joined');
  assert.equal(briefing.wake.mode, 'wait');
  assert.match(briefing.rules, /agent-hub ws handoff/);
  assert.equal(briefing.members.length, 2);

  // The ticket is single-use; the joined session can still re-read its briefing.
  const again = await ctx.rpc('ws.join', CC, { ticket });
  assert.equal(again.rejoined, true);
  await assert.rejects(ctx.rpc('ws.join', { runtime: 'claude', session_id: 'someone-else' }, { ticket }), /报到单无效/);

  // One session, one workspace.
  await assert.rejects(ctx.rpc('ws.create', CC, { name: 'other', seats: [] }), /已经在工作区/);
});

test('攒信：群聊攒一会再响一次，交棒和 @ 马上响，自己说的话不响自己', async (t) => {
  const ctx = await context(t);
  const { ticket, workspaceId } = await startTeam(ctx);
  await ctx.rpc('ws.join', CC, { ticket });

  const leaderWait = await ctx.listen(LEADER);
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'leader').listening);
  // The join notice was gathered for the leader; let that ring pass first.
  const first = await leaderWait.next('wake');
  assert.match(first.text, /cc-1（claude@test-mac）报到了/);

  const leaderWait2 = await ctx.listen(LEADER);
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'leader').listening);
  const sentAt = Date.now();
  await ctx.rpc('ws.say', CC, { text: '第一条：开始读代码' });
  await ctx.rpc('ws.say', CC, { text: '第二条：找到入口了' });
  const gathered = await leaderWait2.next('wake');
  assert.ok(Date.now() - sentAt >= 100, 'a plain group message waits for the gather window');
  assert.match(gathered.text, /2 条新消息/);
  assert.match(gathered.text, /第一条/);
  assert.match(gathered.text, /第二条/);
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'leader').wake_status === 'delivered');

  // A handoff rings the next runner at once and stays readable by the whole team.
  const ccWait = await ctx.listen(CC);
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').listening);
  const handedAt = Date.now();
  const handoff = await ctx.rpc('ws.say', LEADER, { kind: 'handoff', to: ['cc-1'], text: '先把搜索入口改成两段式' });
  const ring = await ccWait.next('wake');
  assert.ok(Date.now() - handedAt < 140, 'a handoff does not wait for the gather window');
  assert.match(ring.text, /\[交棒给你\] leader（队长）：先把搜索入口改成两段式/);
  assert.deepEqual(handoff.message.recipients, []);
  assert.deepEqual(handoff.message.mentions.length, 1);

  const inbox = await ctx.rpc('ws.inbox', CC);
  assert.ok(inbox.messages.some((message) => message.kind === 'handoff' && message.to_me));
  assert.ok(!inbox.messages.some((message) => message.sender === 'cc-1'), 'own messages are not unread');
  const empty = await ctx.rpc('ws.inbox', CC);
  assert.equal(empty.messages.length, 0);

  // @seat is urgent too; a private line is only visible to the two sides.
  const leaderWait3 = await ctx.listen(LEADER);
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'leader').listening);
  await ctx.rpc('ws.say', CC, { text: '这里要业主定 @队长', to: [] });
  const mention = await leaderWait3.next('wake');
  assert.match(mention.text, /\[找你\] cc-1：这里要业主定 @队长/);
  await ctx.rpc('ws.say', LEADER, { text: '只给你看的', to: ['cc-1'] });
  const ccHistory = await ctx.rpc('ws.history', CC);
  assert.ok(ccHistory.messages.some((message) => message.body === '只给你看的'));
});

test('没在等信的 Claude 后台座位：闲着就重启并带上消息，忙着就稍后再试', async (t) => {
  const ctx = await context(t);
  const { ticket, workspaceId } = await startTeam(ctx);
  await ctx.rpc('ws.join', CC, { ticket });
  ctx.claude.state.sessions = [{ sessionId: CC.session_id, id: 'abcd1234', kind: 'background', status: 'busy' }];
  await ctx.rpc('ws.say', LEADER, { kind: 'handoff', to: ['cc-1'], text: '交给你写' });
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').wake_status === 'unreachable');
  assert.match(ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').wake_detail, /busy/);
  assert.ok(!ctx.claude.calls.some((call) => call.args[0] === 'stop'));

  ctx.claude.state.sessions = [{ sessionId: CC.session_id, id: 'abcd1234', kind: 'background', status: 'idle' }];
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').wake_status === 'resumed', { timeout: 4000 });
  const stop = ctx.claude.calls.find((call) => call.args[0] === 'stop');
  assert.deepEqual(stop.args, ['stop', 'abcd1234']);
  const resume = ctx.claude.calls.find((call) => call.args[0] === '--bg' && call.args[1] === '--resume');
  assert.equal(resume.args[2], CC.session_id);
  assert.match(resume.args.at(-1), /交给你写/);
  assert.match(resume.args.at(-1), /agent-hub ws wait/);

  // A leader that is a plain window (not door-launched) is never restarted.
  await ctx.rpc('ws.say', CC, { text: '好的 @队长' });
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'leader').wake_status === 'unreachable');
  assert.match(ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'leader').wake_detail, /没在等信/);
});

test('门房不在线时座位先等着；反重力门房上线后开对话、用 send-message 叫醒', async (t) => {
  const ctx = await context(t);
  const created = await ctx.rpc('ws.create', LEADER, {
    name: 'docs', title: '写需求', seats: [{ seat: 'ag-1', runtime: 'antigravity', model: 'pro', machine: 'test-mac', job: '写需求文档' }],
  });
  const workspaceId = created.workspace.workspace_id;
  assert.equal(created.members.find((member) => member.seat === 'ag-1').state, 'requested');

  const door = await ctx.listen(null, { pathname: '/local/v1/workspaces/door', query: { runtime: 'antigravity', detail: '{"project_id":"p1"}' } });
  const launch = await door.next('launch');
  assert.equal(launch.runtime, 'antigravity');
  assert.equal(launch.model, 'pro');
  const ticket = /agent-hub ws join (wst_\S+)/.exec(launch.prompt)[1];
  await ctx.local('/local/v1/workspaces/result', { method: 'POST', body: { kind: 'launch', member_id: launch.member_id, status: 'launched', detail: { conversation_id: 'conv-1' } } });
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'ag-1').state === 'launched');

  const AG = { runtime: 'antigravity', session_id: 'conv-1' };
  const briefing = await ctx.rpc('ws.join', AG, { ticket });
  assert.equal(briefing.wake.mode, 'door');
  await assert.rejects(ctx.rpc('ws.join', { runtime: 'codex', session_id: 'x' }, { ticket: 'wst_nope' }), /报到单无效/);

  await ctx.rpc('ws.say', LEADER, { kind: 'handoff', to: ['ag-1'], text: '写第一版需求' });
  const wake = await door.next('wake');
  assert.equal(wake.conversation_id, 'conv-1');
  assert.match(wake.text, /写第一版需求/);
  await ctx.local('/local/v1/workspaces/result', { method: 'POST', body: { kind: 'wake', wake_id: wake.wake_id, member_id: wake.member_id, status: 'delivered' } });
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'ag-1').wake_status === 'delivered');

  // A failed native delivery forgets the ring, so the same message is offered again.
  await ctx.rpc('ws.say', LEADER, { kind: 'handoff', to: ['ag-1'], text: '再补一节' });
  const failed = await door.next('wake');
  await ctx.local('/local/v1/workspaces/result', { method: 'POST', body: { kind: 'wake', wake_id: failed.wake_id, member_id: failed.member_id, status: 'failed', detail: 'agentapi down' } });
  const retried = await door.next('wake');
  assert.match(retried.text, /再补一节/);
});

test('拉起失败（目录没确认信任）马上告诉队长；超时没报到算失败', async (t) => {
  const claude = fakeClaude();
  const original = claude.run;
  claude.run = async (executable, args, options) => (args[0] === '--bg'
    ? { code: 1, stdout: 'Workspace not trusted. Run `claude` in /x once and accept the trust prompt, then retry.\n', stderr: '' }
    : original(executable, args, options));
  const ctx = await context(t, { claude, hub: { launchTimeoutMs: 400 } });
  await ctx.enableClaudeDoor();
  const leaderWait = await ctx.listen(LEADER);
  const created = await ctx.rpc('ws.create', LEADER, {
    name: 'trust', seats: [{ seat: 'cc-1', runtime: 'claude', machine: 'test-mac' }, { seat: 'cx-1', runtime: 'codex', machine: 'test-mac' }],
  });
  const workspaceId = created.workspace.workspace_id;
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').state === 'failed');
  assert.match(ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').state_detail, /确认过信任/);
  const ring = await leaderWait.next('wake');
  assert.match(ring.text, /cc-1（claude@test-mac）没能拉起/);
  // No Codex door ever came online: the seat times out.
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cx-1').state === 'failed', { timeout: 4000 });
  assert.match(ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cx-1').state_detail, /门房一直没上线/);
});

test('文件区、记事本、简报、业主插话和收工', async (t) => {
  const ctx = await context(t);
  const { ticket, workspaceId } = await startTeam(ctx);
  await ctx.rpc('ws.join', CC, { ticket });

  const content = Buffer.alloc(900 * 1024, 7); // more than two chunks
  const source = path.join(ctx.root, 'design.png');
  await writeFile(source, content);
  const params = new URLSearchParams({ runtime: CC.runtime, session_id: CC.session_id, name: 'design.png', size: String(content.length), note: '首页设计稿' });
  const upload = await fetch(`${ctx.connector.localUrl}/local/v1/workspaces/files?${params}`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.connector.store.credentials.localToken}` }, body: await readFile(source),
  });
  assert.equal(upload.status, 201);
  const { file } = await upload.json();
  assert.equal(file.size, content.length);
  // Your own upload is not news to you.
  assert.ok(!(await ctx.rpc('ws.inbox', CC)).messages.some((message) => /上传了文件/.test(message.body)));
  const download = await fetch(`${ctx.connector.localUrl}/local/v1/workspaces/files/${file.file_id}?${new URLSearchParams({ runtime: LEADER.runtime, session_id: LEADER.session_id })}`, {
    headers: { authorization: `Bearer ${ctx.connector.store.credentials.localToken}` },
  });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  const adminDownload = await fetch(`${ctx.hub.url}/api/v1/workspaces/${workspaceId}/files/${file.file_id}`, { headers: { authorization: 'Bearer test-admin' } });
  assert.equal(adminDownload.status, 200);
  assert.equal((await adminDownload.arrayBuffer()).byteLength, content.length);

  await ctx.rpc('ws.note', CC, { kind: 'decision', text: '入口改两段式' });
  await assert.rejects(ctx.rpc('ws.note', CC, { kind: 'bogus', text: 'x' }), /记事本条目类型/);
  await assert.rejects(ctx.rpc('ws.brief', CC, { text: '我来改简报' }), /只有队长/);
  const brief = await ctx.rpc('ws.brief', LEADER, { text: '第一版：先改入口，再测' });
  assert.equal(brief.brief_version, 1);
  const inbox = await ctx.rpc('ws.inbox', LEADER);
  assert.ok(inbox.notes.some((note) => note.body === '入口改两段式'));
  assert.ok(inbox.messages.some((message) => /上传了文件 design.png/.test(message.body)));
  assert.ok(!inbox.messages.some((message) => /队长更新了简报/.test(message.body)), 'the leader is not told about its own brief');

  // The owner speaks from the dashboard; the leader is rung at once.
  const leaderWait = await ctx.listen(LEADER);
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'leader').listening);
  const owner = await ctx.admin(`/api/v1/workspaces/${workspaceId}/messages`, { method: 'POST', body: { text: '进度怎么样' } });
  assert.equal(owner.response.status, 201);
  const ring = await leaderWait.next('wake');
  assert.match(ring.text, /\[业主\] 业主：进度怎么样/);

  const list = await ctx.admin('/api/v1/workspaces');
  assert.equal(list.payload.workspaces[0].joined, 2);
  const detail = await ctx.admin(`/api/v1/workspaces/${workspaceId}`);
  assert.equal(detail.payload.members.length, 2);
  assert.ok(detail.payload.messages.length >= 4);
  assert.equal(detail.payload.files.length, 1);
  const page = await fetch(`${ctx.hub.url}/workspaces`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /工作区/);
  const doorPage = await fetch(`${ctx.hub.url}/door`);
  assert.equal(doorPage.status, 200);
  assert.match(await doorPage.text(), /\/door\.md/);
  const doorText = await fetch(`${ctx.hub.url}/door.md`);
  assert.equal(doorText.status, 200);
  assert.match(doorText.headers.get('content-type'), /^text\/plain/);
  const doorBody = await doorText.text();
  assert.match(doorBody, /ws door enable claude/);
  assert.match(doorBody, /ws door start --runtime codex/);
  assert.match(doorBody, /ws door start --runtime antigravity --foreground/);
  assert.doesNotMatch(doorBody, /ah_(admin|enroll|connector|local)_[A-Za-z0-9_-]{8,}/);

  await assert.rejects(ctx.rpc('ws.close', CC, {}), /只有队长/);
  const closed = await ctx.rpc('ws.close', LEADER, { summary: '入口改完' });
  assert.equal(closed.workspace.status, 'closed');
  await assert.rejects(ctx.rpc('ws.say', CC, { text: '还在吗' }), /不在任何进行中的工作区/);
  // A closed workspace frees its name and its sessions.
  const reopened = await ctx.rpc('ws.create', LEADER, { name: 'search-v2', seats: [] });
  assert.equal(reopened.workspace.status, 'active');
});

test('工作区 skill 装到三个地方，已有同名文件不覆盖', async (t) => {
  const { mkdtemp, mkdir: makeDir, writeFile: write, readFile: read } = await import('node:fs/promises');
  const home = await mkdtemp(path.join(path.resolve('.test-tmp'), 'home-'));
  t.after(async () => (await import('node:fs/promises')).rm(home, { recursive: true, force: true }));
  await makeDir(path.join(home, '.gemini', 'config'), { recursive: true });
  await makeDir(path.join(home, '.agents', 'skills', 'agent-hub-workspace'), { recursive: true });
  await write(path.join(home, '.agents', 'skills', 'agent-hub-workspace', 'SKILL.md'), 'mine');
  const { installWorkspaceSkill } = await import('../src/workspace-cli.js');
  const first = await installWorkspaceSkill({ home });
  assert.deepEqual(first.links.map((link) => link.status), ['created', 'conflict', 'created']);
  assert.match(await read(path.join(home, '.claude', 'skills', 'agent-hub-workspace', 'SKILL.md'), 'utf8'), /name: agent-hub-workspace/);
  assert.equal(await read(path.join(home, '.agents', 'skills', 'agent-hub-workspace', 'SKILL.md'), 'utf8'), 'mine');
  const second = await installWorkspaceSkill({ home });
  assert.deepEqual(second.links.map((link) => link.status), ['unchanged', 'conflict', 'unchanged']);
});

test('座位写法、参数和会话身份', () => {
  assert.deepEqual(parseSeatSpec('cc-1=claude@MacBook:写代码'), { seat: 'cc-1', runtime: 'claude', machine: 'MacBook', job: '写代码' });
  assert.deepEqual(parseSeatSpec('ag=antigravity/pro:review 需求: 看边界'), { seat: 'ag', runtime: 'antigravity', model: 'pro', machine: 'auto', job: 'review 需求: 看边界' });
  assert.deepEqual(parseSeatSpec('cx=codex'), { seat: 'cx', runtime: 'codex', machine: 'auto', job: '' });
  assert.throws(() => parseSeatSpec('cc-1 claude'), /座位写法不对/);
  const parsed = parseWorkspaceArgs(['start', 'x', '--seat', 'a=claude', '--seat', 'b=codex', '--json', '--title', 't']);
  assert.deepEqual(parsed.flags.seat, ['a=claude', 'b=codex']);
  assert.equal(parsed.flags.json, true);
  assert.deepEqual(parsed.positionals, ['start', 'x']);
  assert.equal(parseWorkspaceArgs(['door', 'enable', 'claude', '--args', '--dangerously-skip-permissions --model x']).flags.args, '--dangerously-skip-permissions --model x');
  assert.deepEqual(workspaceIdentity({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' }), { runtime: 'claude', session_id: 's1' });
  assert.deepEqual(workspaceIdentity({ CODEX_SESSION_ID: 'c1' }), { runtime: 'codex', session_id: 'c1' });
  assert.deepEqual(workspaceIdentity({ ANTIGRAVITY_CONVERSATION_ID: 'a1' }), { runtime: 'antigravity', session_id: 'a1' });
  assert.equal(workspaceIdentity({}), null);
});

test('Codex 门房请求原文和反重力开对话', async () => {
  assert.ok(codexQueued('Queued message 1 for thread t-1.', 't-1'));
  assert.ok(!codexQueued('Queued message 1 for thread t-2.', 't-1'));
  const instruction = codexDoorInstruction({ member_id: 'wsm_1', cwd: '/repo', prompt: 'agent-hub ws join wst_x' });
  assert.match(instruction, /独立的 Codex 对话/);
  assert.match(instruction, /-----\nagent-hub ws join wst_x\n-----/);
  assert.match(instruction, /工作目录 \/repo/);
  assert.match(codexDoorInstruction({ member_id: 'wsm_1', cwd: null, prompt: 'p' }, { defaultCwd: '/door-dir' }), /工作目录 \/door-dir/);
  assert.doesNotMatch(codexDoorInstruction({ member_id: 'wsm_1', cwd: null, prompt: 'p' }), /工作目录/);

  const requests = [];
  const created = await antigravityCreate({
    prompt: 'hello', model: 'pro', projectId: 'p1',
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1234', ANTIGRAVITY_CSRF_TOKEN: 'csrf' },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ conversation: { id: 'c-1' } }) };
    },
    run: async () => ({ code: 1, stdout: '', stderr: 'should not run' }),
  });
  assert.deepEqual(created, { ok: true, conversation_id: 'c-1', via: 'CreateConversation' });
  assert.equal(requests[0].url, 'http://127.0.0.1:1234/product.v1.ConversationService/CreateConversation');
  assert.equal(requests[0].init.headers['x-antigravity-csrf-token'], 'csrf');
  assert.deepEqual(JSON.parse(requests[0].init.body), { prompt: [{ text: 'hello' }], projectId: 'p1', model: 'pro' });

  const fallback = await antigravityCreate({
    prompt: 'hello', env: {}, agentapi: 'agentapi',
    run: async (executable, args) => ({ code: 0, stdout: `{"conversation":{"id":"0a1b2c3d-1111-2222-3333-444455556666"}} ${args.at(-1)}`, stderr: '' }),
  });
  assert.equal(fallback.conversation_id, '0a1b2c3d-1111-2222-3333-444455556666');
});

test('队长自己的开工消息不算未读', async (t) => {
  const ctx = await context(t);
  const created = await ctx.rpc('ws.create', LEADER, { name: 'solo', seats: [] });
  assert.equal(created.me.unread, 0);
  const member = ctx.hub.workspaces.store.getMemberBySeat(created.workspace.workspace_id, 'leader');
  assert.equal(member.wake_due_at, null);
  assert.equal((await ctx.rpc('ws.inbox', LEADER)).messages.length, 0);
});

test('所属会话已退出的等信不再收门铃，改走接着原对话拉起', async (t) => {
  const ctx = await context(t);
  const { ticket, workspaceId } = await startTeam(ctx);
  await ctx.rpc('ws.join', CC, { ticket });
  const { spawn } = await import('node:child_process');
  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => gone.once('exit', resolve));
  const orphan = await ctx.listen(CC, { query: { owner_pid: String(gone.pid) } });
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').listening);
  ctx.claude.state.sessions = [];
  await ctx.rpc('ws.say', LEADER, { kind: 'handoff', to: ['cc-1'], text: '第三轮' });
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').wake_status === 'resumed');
  assert.ok(!orphan.events.some((event) => event.type === 'wake'), 'the orphan wait got nothing');
  const resume = ctx.claude.calls.find((call) => call.args[1] === '--resume');
  assert.match(resume.args.at(-1), /第三轮/);
  assert.equal(resume.args[resume.args.indexOf('--name') + 1], 'search-v2-cc-1', 'the resumed seat keeps its name');
  // `--resume` may come back under a new session id: the seat reattaches with the ticket in its prompt.
  const rejoin = /agent-hub ws join (wst_\S+)/.exec(resume.args.at(-1))[1];
  const NEW = { runtime: 'claude', session_id: 'cc-session-2' };
  await assert.rejects(ctx.rpc('ws.inbox', NEW), /不在任何进行中的工作区/);
  const again = await ctx.rpc('ws.join', NEW, { ticket: rejoin });
  assert.equal(again.rejoined, true);
  assert.equal(ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').session_id, 'cc-session-2');
  const inbox = await ctx.rpc('ws.inbox', NEW);
  assert.ok(inbox.messages.some((message) => message.body === '第三轮'), 'read position survives the reattach');
  await assert.rejects(ctx.rpc('ws.inbox', CC), /不在任何进行中的工作区/);
  await assert.rejects(ctx.rpc('ws.join', { runtime: 'claude', session_id: 'x' }, { ticket: rejoin }), /报到单无效/);
});

test('Connector 查到重新拉起后的新会话编号就直接告诉 Hub', async (t) => {
  const ctx = await context(t);
  const { ticket, workspaceId } = await startTeam(ctx);
  await ctx.rpc('ws.join', CC, { ticket });
  const original = ctx.claude.run;
  let resumed = false;
  ctx.claude.state.sessions = [];
  ctx.connector.workspace.run = async (executable, args, options) => {
    if (args[0] === '--bg' && args[1] === '--resume') resumed = true;
    if (args[0] === 'agents' && resumed) return { code: 0, stdout: JSON.stringify([{ id: 'abcd1234', sessionId: 'abcd1234-new', kind: 'background', status: 'busy' }]), stderr: '' };
    return original(executable, args, options);
  };
  await ctx.rpc('ws.say', LEADER, { kind: 'handoff', to: ['cc-1'], text: '新编号' });
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').session_id === 'abcd1234-new');
  assert.equal(ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').wake_status, 'resumed');
});

test('要改代码的工作区：座位所在机器没登记项目目录，开工就提醒队长，报到说明教队员自己找到并登记', async (t) => {
  const ctx = await context(t);
  await ctx.enableClaudeDoor();
  await ctx.rpc('project.set', null, { key: 'youxian', git_remote: 'https://github.com/keman-ai/youxian.git', default_branch: 'master' });
  const created = await ctx.rpc('ws.create', LEADER, {
    name: 'fix-1', project: 'youxian', seats: [{ seat: 'cc-1', runtime: 'claude', machine: 'test-mac', job: '写代码' }],
  });
  assert.equal(created.warnings.length, 1);
  assert.match(created.warnings[0], /cc-1.*没登记项目 youxian 的目录.*agent-hub ws project set youxian/);
  const launch = await waitFor(() => ctx.claude.calls.find((call) => call.args[0] === '--bg' && call.args.includes('fix-1-cc-1')));
  const ticket = /agent-hub ws join (wst_\S+)/.exec(launch.args.at(-1))[1];
  const briefing = await ctx.rpc('ws.join', CC, { ticket });
  assert.match(briefing.rules, /这台机器还没登记项目目录.*git clone 到 ~\/Workspace\/youxian.*agent-hub ws project set youxian/);

  // Registered on that machine: no warning, and the member is told where it is.
  await ctx.rpc('project.set', null, { key: 'youxian', path: ctx.root });
  const closed = await ctx.rpc('ws.close', LEADER, {});
  assert.ok(closed.workspace);
  const again = await ctx.rpc('ws.create', LEADER, {
    name: 'fix-2', project: 'youxian', seats: [{ seat: 'cc-2', runtime: 'claude', machine: 'test-mac' }],
  });
  assert.deepEqual(again.warnings, []);
  const second = await waitFor(() => ctx.claude.calls.find((call) => call.args[0] === '--bg' && call.args.includes('fix-2-cc-2')));
  assert.equal(second.options.cwd, ctx.root);
});

test('codex-allow 只放行 agent-hub ws，用 codex execpolicy 核对，核对不过就删掉规则文件', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ah-codex-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => { process.env.HOME = savedHome; await rm(home, { recursive: true, force: true }); });
  const fake = async (allowWs) => {
    const file = path.join(home, `codex-${allowWs ? 'ok' : 'bad'}`);
    await writeFile(file, `#!/bin/sh\ncase "$*" in\n  *"agent-hub ws "*) echo '{"decision":"${allowWs ? 'allow' : 'prompt'}","matchedRules":[]}' ;;\n  *) echo '{"matchedRules":[]}' ;;\nesac\n`);
    await chmod(file, 0o755);
    return file;
  };
  const rules = codexAllowRules({ absolute: '/opt/x/agent-hub' });
  assert.match(rules, /pattern = \["agent-hub", "ws"\],\n    decision = "allow"/);
  assert.match(rules, /pattern = \["\/opt\/x\/agent-hub", "ws"\]/);
  assert.doesNotMatch(rules, /pattern = \["agent-hub"\]/, 'never the whole agent-hub command');

  const target = path.join(home, '.codex', 'rules', 'agent-hub.rules');
  await workspaceCommand(['codex-allow', '--executable', await fake(true)]);
  assert.match(await readFile(target, 'utf8'), /prefix_rule\(/);
  await assert.rejects(workspaceCommand(['codex-allow', '--executable', await fake(false)]), /核对没通过，已删掉/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  await workspaceCommand(['codex-allow', '--executable', await fake(true)]);
  await workspaceCommand(['codex-allow', '--remove']);
  await assert.rejects(stat(target), { code: 'ENOENT' });
});

test('已有会话凭工作区名字加入：不用报到单，座位按类型自动取名，队长马上知道', async (t) => {
  const ctx = await context(t);
  const created = await ctx.rpc('ws.create', LEADER, { name: 'talk', title: '临时讨论', seats: [] });
  const workspaceId = created.workspace.workspace_id;
  const leaderWait = await ctx.listen(LEADER);
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'leader').listening);

  const CX = { runtime: 'codex', session_id: 'existing-codex-thread' };
  const briefing = await ctx.rpc('ws.join', CX, { workspace: 'talk', job: '讲讲之前查到的' });
  assert.equal(briefing.rejoined, false);
  assert.equal(briefing.me.seat, 'codex-1');
  assert.equal(briefing.me.unread, 0, 'its own arrival is not news to it');
  const ring = await leaderWait.next('wake');
  assert.match(ring.text, /codex-1（codex@test-mac）自己加入了.*讲讲之前查到的/);

  // Asking again is a rejoin, not a second seat.
  assert.equal((await ctx.rpc('ws.join', CX, { workspace: 'talk' })).rejoined, true);
  const AG = { runtime: 'antigravity', session_id: 'existing-ag-conversation' };
  await assert.rejects(ctx.rpc('ws.join', AG, { workspace: 'talk', seat: 'codex-1' }), /座位 codex-1 已经有人了/);
  assert.equal((await ctx.rpc('ws.join', AG, { workspace: 'talk' })).me.seat, 'ag-1');
  await assert.rejects(ctx.rpc('ws.join', CC, { workspace: 'nope' }), /没有叫 nope 的进行中工作区/);
  await assert.rejects(ctx.rpc('ws.join', { runtime: 'kimi', session_id: 'k' }, { workspace: 'talk' }), /只有 claude、codex、antigravity/);
  await assert.rejects(ctx.rpc('ws.create', CX, { name: 'other', seats: [] }), /已经在工作区/);

  // Members talk to it like any other seat.
  await ctx.rpc('ws.say', LEADER, { kind: 'handoff', to: ['codex-1'], text: '把你上午查的结论贴一下' });
  const inbox = await ctx.rpc('ws.inbox', CX);
  assert.ok(inbox.messages.some((message) => /上午查的结论/.test(message.body)));
});

test('业主删工作区：进行中的不能删，收工后连消息、记事本、文件一起删掉', async (t) => {
  const ctx = await context(t);
  const { ticket, workspaceId } = await startTeam(ctx);
  await ctx.rpc('ws.join', CC, { ticket });
  const params = new URLSearchParams({ runtime: CC.runtime, session_id: CC.session_id, name: 'a.txt', size: '5' });
  const upload = await fetch(`${ctx.connector.localUrl}/local/v1/workspaces/files?${params}`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.connector.store.credentials.localToken}` }, body: 'hello',
  });
  const { file } = await upload.json();
  await ctx.rpc('ws.note', CC, { kind: 'fact', text: '记一笔' });

  const early = await ctx.admin(`/api/v1/workspaces/${workspaceId}`, { method: 'DELETE' });
  assert.equal(early.response.status, 409);
  await ctx.rpc('ws.close', LEADER, {});
  const deleted = await ctx.admin(`/api/v1/workspaces/${workspaceId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.payload.files, 1);
  assert.equal((await ctx.admin(`/api/v1/workspaces/${workspaceId}`)).response.status, 404);
  assert.ok(!(await ctx.admin('/api/v1/workspaces')).payload.workspaces.some((item) => item.workspace_id === workspaceId));
  await assert.rejects(stat(path.join(ctx.hub.workspaces.filesDir, file.file_id)), { code: 'ENOENT' });
  const store = ctx.hub.workspaces.store;
  assert.equal(store.getMemberBySeat(workspaceId, 'cc-1'), null);
  // The same sessions can start over.
  assert.ok((await ctx.rpc('ws.create', LEADER, { name: 'search-v2', seats: [] })).workspace);
});

test('预留座位（--invite）：不叫门房，业主开好的会话来了按类型坐进去；没人来的可以改由门房拉起', async (t) => {
  const ctx = await context(t);
  await ctx.enableClaudeDoor();
  const created = await ctx.rpc('ws.create', LEADER, {
    name: 'by-owner', invite: true, brief: '先读需求',
    seats: [
      { seat: 'cc-1', runtime: 'claude', job: '写代码' },
      { seat: 'codex-1', runtime: 'codex', job: '测试' },
      { seat: 'cc-2', runtime: 'claude', job: '备用' },
    ],
  });
  const workspaceId = created.workspace.workspace_id;
  assert.deepEqual(created.members.filter((member) => member.role !== 'leader').map((member) => member.state), ['invited', 'invited', 'invited']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(ctx.claude.calls.filter((call) => call.args[0] === '--bg').length, 0, 'no door is asked for an invited seat');
  assert.equal((await ctx.admin('/api/v1/workspaces')).payload.workspaces[0].invited, 3);

  // The owner's Codex session says 「加入工作区 by-owner」: it takes the Codex seat and its job.
  const CX = { runtime: 'codex', session_id: 'owner-opened-codex' };
  const codex = await ctx.rpc('ws.join', CX, { workspace: 'by-owner' });
  assert.equal(codex.me.seat, 'codex-1');
  assert.equal(codex.me.job, '测试');
  assert.match(codex.workspace.brief, /先读需求/);
  // A named seat is taken as asked.
  assert.equal((await ctx.rpc('ws.join', CC, { workspace: 'by-owner', seat: 'cc-2' })).me.seat, 'cc-2');
  const history = await ctx.rpc('ws.history', LEADER);
  assert.ok(history.messages.some((message) => /codex-1（codex@test-mac）加入了，坐进预留的座位/.test(message.body)));

  // Nobody came for cc-1: the leader hands it to the door after all.
  await ctx.rpc('ws.relaunch', LEADER, { seat: 'cc-1' });
  await waitFor(() => ctx.claude.calls.find((call) => call.args[0] === '--bg' && call.args.includes('by-owner-cc-1')));
  const seat = ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1');
  assert.ok(['launching', 'launched'].includes(seat.state));
});

test('先开工后补简报：业主没说要谁就不留座位，给一句通用的加入话；后补的简报马上叫醒已加入的人', async (t) => {
  const ctx = await context(t, { hub: { gatherMs: 5000 } });
  const created = await ctx.rpc('ws.create', LEADER, { name: 'quick', title: '先开再说', invite: true, seats: [] });
  const workspaceId = created.workspace.workspace_id;
  const lines = inviteLines(created.workspace, created.members).join('\n');
  assert.match(lines, /没留座位/);
  assert.match(lines, /加入 Agent Hub 工作区 quick」/);

  // Whoever the owner brings takes a seat by type, with no job until the leader hands one over.
  const joined = await ctx.rpc('ws.join', CC, { workspace: 'quick' });
  assert.equal(joined.me.seat, 'cc-1');
  assert.ok(!joined.me.job);

  const ccWait = await ctx.listen(CC);
  await waitFor(() => ctx.hub.workspaces.store.getMemberBySeat(workspaceId, 'cc-1').listening);
  const briefedAt = Date.now();
  await ctx.rpc('ws.brief', LEADER, { text: '目标：先把入口改了；分工按加入的人再分' });
  const ring = await ccWait.next('wake');
  assert.ok(Date.now() - briefedAt < 2000, 'a brief written after people joined does not wait for the gather window');
  assert.match(ring.text, /队长更新了简报（第 1 版）/);

  // With seats reserved, each gets its own line and the plain line is still offered.
  const added = await ctx.rpc('ws.add', LEADER, { invite: true, seats: [{ seat: 'codex-1', runtime: 'codex', job: '测试' }] });
  const reserved = inviteLines(created.workspace, added.members).join('\n');
  assert.match(reserved, /codex-1（codex）：加入 Agent Hub 工作区 quick，座位 codex-1/);
  assert.match(reserved, /别的会话想加入，说「加入 Agent Hub 工作区 quick」/);
  // Seats the door launches need no line for the owner.
  assert.deepEqual(inviteLines(created.workspace, [{ seat: 'cc-2', role: 'member', state: 'launching' }]), []);
});
