import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { KimiAcpDriver } from '../src/drivers/kimi-acp.js';

function fakeAcpProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.requests = [];
  child.promptCalls = [];
  child.kill = () => {
    process.nextTick(() => child.emit('close', 0, null));
    return true;
  };
  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on('data', (chunk) => {
    const message = JSON.parse(chunk.toString());
    child.requests.push(message);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    }
    if (message.method === 'session/load') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: message.params.sessionId } });
    }
    if (message.method === 'session/prompt') {
      child.promptCalls.push(message.params);
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP ' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } } } });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    }
  });
  return child;
}

test('KimiAcpDriver sends Hub and interactive prompts through one native Session', async () => {
  const child = fakeAcpProcess();
  const output = new PassThrough();
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk.toString(); });
  const driver = new KimiAcpDriver({
    sessionId: 'session-acp-1',
    cwd: process.cwd(),
    env: { AGENT_HUB_RUNTIME: 'kimi', AGENT_HUB_SESSION_ID: 'session-acp-1' },
    spawn(executable, args, options) {
      assert.equal(executable, 'kimi');
      assert.deepEqual(args, ['acp']);
      assert.equal(options.env.AGENT_HUB_SESSION_ID, 'session-acp-1');
      return child;
    },
    output,
  });
  await driver.start();
  const states = [];
  let streamed = '';
  const hub = await driver.execute({
    command: { command_id: 'cmd-acp-1', input: 'Hub task' },
    onState: (state) => states.push(state),
    onOutput: (chunk) => { streamed += chunk; },
  });
  assert.equal(hub.text, 'ACP reply');
  assert.equal(hub.session_id, 'session-acp-1');
  assert.equal(hub.output_gap, false);
  assert.deepEqual(states, [{ started: true, prompt_id: 'cmd-acp-1' }]);
  assert.equal(streamed, 'ACP reply');

  const interactive = await driver.prompt('User follow-up');
  assert.equal(interactive.text, 'ACP reply');
  assert.equal(child.promptCalls.length, 2);
  assert.ok(child.promptCalls.every((call) => call.sessionId === 'session-acp-1'));
  assert.deepEqual(child.promptCalls.map((call) => call.prompt[0].text), ['Hub task', 'User follow-up']);
  assert.equal(rendered, 'ACP reply\nACP reply\n');
  await driver.close();
});
