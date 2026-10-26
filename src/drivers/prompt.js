export function commandPrompt(command) {
  const task = command.task_snapshot ?? command.task;
  if (!task) return command.input;
  const context = {
    task_id: task.task_id,
    title: task.title,
    goal: task.goal,
    context: task.context,
    acceptance: task.acceptance,
    status: task.status,
  };
  return [
    'Agent Hub task context (JSON):',
    JSON.stringify(context, null, 2),
    '',
    `Agent Hub command (${command.kind}):`,
    command.input,
  ].join('\n');
}
