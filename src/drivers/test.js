import { randomUUID } from 'node:crypto';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TestDriver {
  constructor() {
    this.executions = [];
    this.active = 0;
    this.maxActive = 0;
  }

  async prepareWorker(input) {
    return {
      runtime_session_id: input.runtime_session_id ?? randomUUID(),
      driver_state: { executions: 0 },
    };
  }

  async execute({ worker, command, onOutput, onState }) {
    const delay = Number(worker.metadata?.delay_ms ?? 5);
    this.executions.push(command.command_id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await sleep(delay);
      if (command.input.startsWith('fail:')) throw new Error(command.input.slice(5));
      const executions = (worker.driver_state?.executions ?? 0) + 1;
      await onState({ executions });
      const text = `${worker.name}: ${command.input}`;
      onOutput(`${text}\n`);
      return { text, session_id: worker.runtime_session_id, executions };
    } finally {
      this.active -= 1;
    }
  }

  async close() {}
}
