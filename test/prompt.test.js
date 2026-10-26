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
