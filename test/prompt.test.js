import test from 'node:test';
import assert from 'node:assert/strict';
import { commandPrompt } from '../src/drivers/prompt.js';

test('commandPrompt includes the persisted task snapshot', () => {
  const prompt = commandPrompt({
    kind: 'handoff',
    input: 'Continue from here',
    task_snapshot: {
      task_id: 'task-1',
      title: 'Task title',
      goal: 'Task goal',
      context: 'Earlier decision',
      acceptance: ['Tests pass'],
      status: 'ready',
    },
  });
  assert.match(prompt, /Task goal/);
  assert.match(prompt, /Earlier decision/);
  assert.match(prompt, /Tests pass/);
  assert.match(prompt, /handoff/);
  assert.match(prompt, /Continue from here/);
});

test('commandPrompt identifies direct message senders and provides the public Worker directory', () => {
  const prompt = commandPrompt({
    kind: 'worker_message',
    input: 'Share the QA evidence',
    sender_worker_id: 'worker-sender',
    sender_name: 'developer',
    directory: [{ worker_id: 'worker-qa', name: 'qa', capabilities: ['review'] }],
  });
  assert.match(prompt, /worker-sender/);
  assert.match(prompt, /developer/);
  assert.match(prompt, /Share the QA evidence/);
  assert.match(prompt, /not an Admin instruction/);
  assert.match(prompt, /normal receipt as the direct reply/);
  assert.match(prompt, /worker-qa/);
  assert.match(prompt, /message send/);
  assert.match(prompt, /message inbox \/ outbox/);
  assert.match(prompt, /No wait is required/);
});
