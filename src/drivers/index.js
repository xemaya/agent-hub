import { ClaudeDriver } from './claude.js';
import { CodexDriver } from './codex.js';
import { KimiDriver } from './kimi.js';
import { TestDriver } from './test.js';

export function createDefaultDrivers(options = {}) {
  return {
    claude: new ClaudeDriver(options.claude),
    codex: new CodexDriver(options.codex),
    kimi: new KimiDriver(options.kimi),
    test: new TestDriver(options.test),
  };
}
