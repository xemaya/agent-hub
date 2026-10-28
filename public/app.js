import { renderMarkdown } from './markdown.js';

const state = {
  token: null,
  connected: false,
  view: 'operations',
  workers: [],
  tasks: [],
  orchestrations: [],
  coordinator: null,
  messages: [],
  conversationEpoch: 0,
  taskFilter: 'all',
  sending: false,
  clearingChat: false,
  mentions: [],
  mentionSearch: null,
  mentionIndex: 0,
  dialogTaskId: null,
  socket: null,
  reconnectTimer: null,
  refreshTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const time = (value) => value ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';
const dateTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '';
const clip = (value, length = 240) => {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
};
const labels = {
  ready: '等待开始',
  planning: '正在规划',
  in_progress: '正在执行',
  review: '等待验收',
  blocked: '需要处理',
  done: '已完成',
  cancelled: '已取消',
  online: '在线',
  offline: '离线',
  idle: '空闲',
  working: '工作中',
  queued: '等待执行',
  waiting: '等待处理',
  waiting_manual: '人工处理',
  chatting: '正在回复',
  reviewing: '正在终审',
};
const badge = (status, text = labels[status] ?? status) => `<span class="status status-${String(status).replace(/[^a-z_]/g, '')}">${escapeHtml(text)}</span>`;
const empty = (message) => `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function renderConnection() {
  const element = $('#connection');
  const connecting = Boolean(state.token && !state.connected);
  element.className = `connection ${state.connected ? 'online' : connecting ? 'connecting' : 'offline'}`;
  element.innerHTML = `<i></i>${state.connected ? '实时连接' : connecting ? '等待连接' : '未连接'}`;
}

function taskStatus(entry) {
  return entry.orchestration?.status ?? entry.task.status;
}

function taskRef(task) {
  return Number.isInteger(task.task_number) ? `#${String(task.task_number).padStart(4, '0')}` : '';
}

function taskName(task) {
  return [taskRef(task), task.title].filter(Boolean).join(' · ');
}

function taskBadge(entry) {
  const status = taskStatus(entry);
  if (status === 'review' && entry.orchestration) {
    return entry.orchestration.error
      ? badge('blocked', '验收未通过')
      : badge('reviewing', '正在验收');
  }
  return badge(status, status === 'blocked' ? '未完成' : undefined);
}

function resultText(result) {
  if (typeof result?.text === 'string') return result.text;
  return result == null ? '' : JSON.stringify(result, null, 2);
}

function deliverableSteps(entry) {
  return (entry.orchestration?.steps ?? []).filter((step) => resultText(step.result).trim());
}

function taskGroup(entry) {
  const status = taskStatus(entry);
  if (status === 'blocked' || status === 'cancelled' || (status === 'review' && entry.orchestration?.error)) return 'attention';
  if (status === 'done') return 'done';
  if (status === 'ready') return 'ready';
  return 'active';
}

function taskEntries() {
  const childIds = new Set(state.orchestrations.flatMap((orchestration) => (
    orchestration.steps.map((step) => step.task_id).filter(Boolean)
  )));
  const orchestrations = new Map(state.orchestrations.map((orchestration) => [orchestration.parent_task_id, orchestration]));
  return state.tasks.filter((task) => !childIds.has(task.task_id)).map((task) => ({
    task,
    orchestration: orchestrations.get(task.task_id) ?? null,
  }));
}

function taskEntry(taskId) {
  return taskEntries().find((entry) => entry.task.task_id === taskId) ?? null;
}

function taskStage(entry) {
  const { task, orchestration } = entry;
  if (!orchestration) {
    const stages = {
      ready: task.assignee_name ? `等待 ${task.assignee_name} 开始` : '尚未分配负责人',
      in_progress: `${task.assignee_name ?? '负责人'} 正在处理`,
      review: '结果已返回，等待核对验收',
      blocked: '任务已暂停，需要处理阻塞',
      done: '任务已完成',
      cancelled: '任务已取消',
    };
    return stages[task.status] ?? task.status;
  }
  const status = orchestration.status;
  if (status === 'planning') return '中央大脑正在理解目标，安排合适的员工。';
  if (status === 'ready') return orchestration.steps.length
    ? '计划已就绪，尚未执行。'
    : '已经记录，等待制定计划。';
  if (status === 'in_progress') {
    const running = orchestration.steps.find((step) => step.status === 'running');
    if (running) return `${orchestration.recovery_count ? '修正中 · ' : ''}${running.worker_name ?? '数字员工'} 正在执行「${running.title}」`;
    if (orchestration.steps.some((step) => step.status === 'ready')) {
      return orchestration.recovery_count
        ? '中央大脑已根据终审意见安排修正，正在等待前置步骤或员工。'
        : '正在等待前置步骤完成，或合适的员工空闲。';
    }
    return '执行结果正在汇集，准备核对验收。';
  }
  if (status === 'review') return orchestration.error
    ? `${orchestration.recovery_count ? '自动修正后仍未通过' : '验收未通过'}：${orchestration.error.message}。可在对话中 @任务 补充信息或调整验收。`
    : '执行结果已返回，中央大脑正在核对每一步与整体验收。';
  if (status === 'blocked') return `未完成：${orchestration.error?.message ?? '存在未解决的问题'}。不会自动重试。`;
  if (status === 'done') {
    const count = deliverableSteps(entry).length;
    const criteria = task.acceptance.length;
    const recovery = orchestration.recovery_count ? ` · 经 ${orchestration.recovery_count} 轮修正` : '';
    return count
      ? `${count} 项交付结果${criteria ? ` · ${criteria} 条整体验收通过` : ' · 终审通过'}${recovery}`
      : `终审通过${criteria ? ` · ${criteria} 条整体验收符合要求` : ''}${recovery}`;
  }
  return task.status;
}

function renderDeliverables(entry) {
  const { task, orchestration } = entry;
  const steps = deliverableSteps(entry);
  return `
    <section class="task-delivery" aria-label="交付结果">
      <div class="delivery-heading">
        <div><h3>交付结果</h3><p>${steps.length} 项结果${task.acceptance.length ? ` · ${task.acceptance.length} 条整体验收通过` : ' · 终审通过'}</p></div>
        <button class="button button-quiet" type="button" data-copy-all-results="${escapeHtml(task.task_id)}" ${steps.length ? '' : 'disabled'}>复制全部结果</button>
      </div>
      <div class="review-note final-review"><strong>整体验收通过</strong><p>${escapeHtml(orchestration.review_reason || '所有步骤已完成。')}</p></div>
      ${steps.map((step, index) => `
        <article class="deliverable" id="result-${escapeHtml(step.task_id)}">
          <div class="deliverable-heading">
            <span class="step-index">${String(index + 1).padStart(2, '0')}</span>
            <div><h4>${escapeHtml(step.title)}</h4><p>${escapeHtml(step.worker_name ?? '数字员工')}</p></div>
            <button class="button button-quiet" type="button" data-copy-result="${escapeHtml(step.task_id)}">复制结果</button>
          </div>
          ${renderMarkdown(resultText(step.result))}
        </article>`).join('')}
    </section>`;
}

function renderTaskDetail(entry) {
  const { task, orchestration } = entry;
  const steps = orchestration?.steps ?? [];
  const complete = taskStatus(entry) === 'done' && Boolean(orchestration);
  const group = taskGroup(entry);
  const stepTitles = new Map(steps.map((step) => [step.key, step.title]));
  return `
    ${complete ? renderDeliverables(entry) : `<div class="task-stage detail-stage task-${group}"><p>${escapeHtml(taskStage(entry))}</p></div>`}
    ${orchestration?.status === 'ready' && steps.length ? `<button class="button button-primary start-task" type="button" data-start-task="${escapeHtml(task.task_id)}">开始执行</button>` : ''}
    <details class="task-context" ${complete ? '' : 'open'}>
      <summary>目标与验收</summary>
      <div class="task-detail-grid">
        <section><h4>要达成什么</h4><p>${escapeHtml(task.goal || '未补充目标')}</p></section>
        ${task.context ? `<section><h4>已知上下文</h4><p>${escapeHtml(task.context)}</p></section>` : ''}
        <section><h4>验收标准${complete ? ' · 已通过' : ''}</h4>${task.acceptance.length
          ? `<ul class="acceptance-list">${task.acceptance.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join('')}</ul>`
          : '<p class="muted">尚未设置整体验收标准</p>'}</section>
      </div>
    </details>
    ${steps.length ? `<details class="execution-details" ${complete ? '' : 'open'}>
      <summary>执行过程 · ${steps.length} 步</summary>
      ${orchestration?.summary ? `<div class="plan-note"><strong>中央大脑的安排</strong><p>${escapeHtml(orchestration.summary)}</p></div>` : ''}
      <ol class="step-list">${steps.map((step, index) => `
        <li class="step-${escapeHtml(step.status)}">
          <span class="step-index">${String(index + 1).padStart(2, '0')}</span>
          <div class="step-body">
            <div class="step-title"><h4>${escapeHtml(step.title)}</h4>${badge(step.status, step.status === 'review' ? '等待验收' : undefined)}</div>
            <p class="step-owner">${escapeHtml(step.worker_name ?? '等待匹配员工')}${(step.attempt ?? 1) > 1 ? ` · 第 ${step.attempt} 次执行` : ''}${step.depends_on.length
              ? ` · 需先完成 ${escapeHtml(step.depends_on.map((key) => stepTitles.get(key) ?? key).join('、'))}`
              : ''}</p>
            <p>${escapeHtml(step.goal)}</p>
            ${step.rationale ? `<p class="step-rationale">为什么交给 TA：${escapeHtml(step.rationale)}</p>` : ''}
            ${step.error?.message ? `<p class="inline-error">${escapeHtml(step.error.message)}</p>` : ''}
            ${(step.previous_attempts ?? []).map((attempt) => `<details class="evidence previous-attempt"><summary>第 ${attempt.attempt ?? 1} 次执行结果</summary>${attempt.review?.reason ? `<p class="review-note ${attempt.review.pass ? '' : 'rejected'}">${attempt.review.pass ? '上轮验收通过' : '上轮验收未通过'}：${escapeHtml(attempt.review.reason)}</p>` : ''}${renderMarkdown(resultText(attempt.result))}</details>`).join('')}
            ${step.review?.reason ? `<p class="review-note ${step.review.pass ? '' : 'rejected'}">${step.review.pass ? '验收通过' : '验收未通过'}：${escapeHtml(step.review.reason)}</p>` : ''}
            ${!complete && resultText(step.result).trim() ? `<details class="evidence" open><summary>此步实际返回</summary>${renderMarkdown(resultText(step.result))}</details>` : ''}
          </div>
        </li>`).join('')}</ol>
    </details>` : ''}
    ${!complete && orchestration?.review_reason ? `<div class="review-note final-review ${orchestration.error ? 'rejected' : ''}"><strong>终审结论</strong><p>${escapeHtml(orchestration.review_reason)}</p></div>` : ''}
    <div class="dialog-reference task-detail-actions"><button class="button button-quiet task-delete" type="button" data-delete-task="${escapeHtml(task.task_id)}">删除任务</button><button class="text-button" type="button" data-reference-task="${escapeHtml(task.task_id)}">在对话中继续这个任务 →</button></div>`;
}

function renderProgress(entry) {
  const steps = entry.orchestration?.steps ?? [];
  if (!steps.length) return `<p class="direct-owner">负责人：${escapeHtml(entry.task.assignee_name ?? '尚未分配')}</p>`;
  const completed = steps.filter((step) => step.status === 'done').length;
  return `
    <div class="step-progress">
      <div class="progress-track" role="progressbar" aria-label="通过终审的步骤" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${completed}"><i style="width:${completed / steps.length * 100}%"></i></div>
      <span>${completed} / ${steps.length} 步通过终审</span>
    </div>`;
}

function taskActions(taskId) {
  const entry = taskEntry(taskId);
  if (!entry) return '';
  const group = taskGroup(entry);
  const canStart = entry.orchestration?.status === 'ready' && entry.orchestration.steps.length > 0;
  const label = group === 'done' && entry.orchestration
    ? '查看结果'
    : group === 'attention'
      ? '查看未通过原因'
      : canStart
        ? '查看计划'
        : group === 'active'
          ? '查看进展'
          : '查看任务';
  return `<div class="task-actions"><button class="text-button" type="button" data-task-detail="${escapeHtml(taskId)}">${label} →</button>${canStart ? `<button class="button button-primary" type="button" data-start-task="${escapeHtml(taskId)}">开始执行</button>` : ''}</div>`;
}

function renderTaskCard(entry) {
  const { task, orchestration } = entry;
  const group = taskGroup(entry);
  const steps = orchestration?.steps ?? [];
  const category = orchestration ? orchestration.auto_start ? '中央编排' : '对话计划' : '独立任务';
  return `
    <article class="task-card task-${group}" data-task-card="${escapeHtml(task.task_id)}">
      <div class="task-heading">
        <div><p class="section-index">${[taskRef(task), category].filter(Boolean).join(' · ')}</p><h3>${escapeHtml(task.title)}</h3></div>
        ${taskBadge(entry)}
      </div>
      ${task.goal ? `<p class="task-goal">${escapeHtml(clip(task.goal))}</p>` : ''}
      <div class="task-stage"><span>${group === 'done' ? '完成情况' : '当前进展'}</span><p>${escapeHtml(taskStage(entry))}</p></div>
      ${renderProgress(entry)}
      <div class="task-meta-line"><span>${orchestration ? `${steps.length} 个步骤` : task.created_by === 'coordinator' ? '中央大脑创建' : '任务记录'}</span><time datetime="${escapeHtml(task.updated_at)}">更新于 ${escapeHtml(dateTime(task.updated_at))}</time></div>
      ${taskActions(task.task_id)}
    </article>`;
}

function renderInlineTask(taskId) {
  const entry = taskEntry(taskId);
  if (!entry) return '<div class="chat-task-pending">正在同步这项工作的最新进展……</div>';
  const complete = taskStatus(entry) === 'done';
  return `
    <article class="chat-task ${complete ? 'is-complete' : ''}" data-inline-task="${escapeHtml(taskId)}">
      <div class="chat-task-top"><span>${complete ? '任务完成' : '工作进展'}</span>${taskBadge(entry)}</div>
      <button class="chat-task-title" type="button" data-task-detail="${escapeHtml(taskId)}">${escapeHtml(taskName(entry.task))}</button>
      <p class="chat-task-stage">${escapeHtml(taskStage(entry))}</p>
      ${renderProgress(entry)}
      ${taskActions(taskId)}
    </article>`;
}

function canMentionWorker(worker) {
  return worker.push_capable
    && !worker.retired_at
    && worker.presence === 'online'
    && worker.worker_id !== state.coordinator?.worker_id;
}

function activeMentions() {
  const content = $('#chat-input').value;
  return state.mentions.filter((mention) => content.includes(mention.marker));
}

function renderComposerMentions() {
  $('#composer-mentions').innerHTML = activeMentions().map((mention) => `
    <span class="composer-chip"><span>${escapeHtml(mention.marker)}</span><button type="button" data-remove-mention-type="${escapeHtml(mention.type)}" data-remove-mention-id="${escapeHtml(mention.id)}" aria-label="移除 ${escapeHtml(mention.marker)}">×</button></span>
  `).join('');
}

function syncComposer() {
  const available = Boolean(state.coordinator?.enabled && state.coordinator.worker?.push_capable && !state.coordinator.worker?.retired_at);
  const input = $('#chat-input');
  input.disabled = !available;
  input.readOnly = state.sending;
  $('#send-chat').disabled = !available || state.sending || !input.value.trim();
  $('#send-chat').textContent = state.sending ? '发送中' : '发送';
  $('#clear-chat').disabled = state.clearingChat || !state.messages.length;
  $('#clear-chat').textContent = state.clearingChat ? '清空中' : '清空对话';
  for (const button of $$('[data-start-task]')) {
    button.disabled = state.sending || taskEntry(button.dataset.startTask)?.orchestration?.status !== 'ready';
  }
  renderComposerMentions();
}

function coordinatorCandidates() {
  return state.workers.filter((worker) => worker.push_capable && worker.presence === 'online' && !worker.retired_at);
}

function renderCoordinator() {
  const coordinator = state.coordinator;
  const worker = coordinator?.worker?.retired_at ? null : coordinator?.worker;
  const available = Boolean(coordinator?.enabled && worker?.push_capable);
  const online = worker?.presence === 'online';
  const live = state.workers.find((item) => item.worker_id === worker?.worker_id);
  const activePhase = live?.activity && !['idle', 'offline'].includes(live.activity.phase);
  const description = !available
    ? '未启用'
    : !online
      ? '离线'
      : activePhase
        ? live.activity.detail
        : '空闲';
  $('#coordinator-status').innerHTML = `
    <div class="coordinator-presence">
      <span class="brain-symbol" aria-hidden="true"></span>
      <div><h3>${escapeHtml(worker?.name ?? '中央大脑')}</h3><p>${escapeHtml(description)}</p></div>
      ${badge(available ? online ? 'online' : 'offline' : 'blocked')}
      <button class="button button-quiet coordinator-configure" type="button" data-configure-coordinator ${coordinatorCandidates().length ? '' : 'disabled'}>${worker ? '更换' : '指定'}</button>
      ${worker ? `<button class="button button-quiet coordinator-retire" type="button" data-retire-coordinator="${escapeHtml(worker.worker_id)}">注销</button>` : ''}
    </div>`;
  syncComposer();
}

function openCoordinatorDialog() {
  const candidates = coordinatorCandidates();
  if (!candidates.length) return;
  $('#coordinator-worker').innerHTML = candidates.map((worker) => `
    <option value="${escapeHtml(worker.worker_id)}">${escapeHtml(worker.name)} · ${escapeHtml(worker.connector_name)} · ${escapeHtml(worker.runtime)}${worker.presence === 'offline' ? '（离线）' : ''}</option>
  `).join('');
  if (candidates.some((worker) => worker.worker_id === state.coordinator?.worker_id)) {
    $('#coordinator-worker').value = state.coordinator.worker_id;
  }
  $('#coordinator-error').textContent = '';
  $('#coordinator-dialog').showModal();
}

async function retireWorker(worker, button, coordinator = false) {
  if (!worker || !window.confirm(`确认注销「${worker.name}」？\n\n该员工将从列表和调度中移除，任务与对话历史会保留。`)) return;
  button.disabled = true;
  const wasEnabled = coordinator && state.coordinator?.enabled;
  try {
    if (wasEnabled) await api('/api/v1/coordinator', { method: 'PUT', body: { enabled: false } });
    await api(`/api/v1/workers/${encodeURIComponent(worker.worker_id)}`, { method: 'DELETE' });
    toast(`已注销 ${worker.name}`);
  } catch (error) {
    let message = `注销失败：${error.message}`;
    if (wasEnabled) {
      try {
        await api('/api/v1/coordinator', { method: 'PUT', body: { enabled: true, worker_id: worker.worker_id } });
      } catch {
        message += '；中央大脑仍处于停用状态';
      }
    }
    toast(message, true);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function applyTaskDeletion(taskIds) {
  const deleted = new Set(taskIds);
  state.tasks = state.tasks.filter((task) => !deleted.has(task.task_id));
  state.orchestrations = state.orchestrations.filter((orchestration) => !deleted.has(orchestration.parent_task_id));
  for (const mention of state.mentions.filter((item) => item.type === 'task' && deleted.has(item.id))) {
    removeMention('task', mention.id);
  }
  render();
}

async function deleteTask(taskId, button) {
  const entry = taskEntry(taskId);
  if (!entry || !window.confirm(`确认删除「${taskName(entry.task)}」？\n\n任务将从看板移除，执行与对话历史会保留。`)) return;
  button.disabled = true;
  try {
    const deleted = await api(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    applyTaskDeletion(deleted.deleted_task_ids);
    toast(`已删除 ${taskName(entry.task)}`);
  } catch (error) {
    toast(`删除失败：${error.message}`, true);
    if (button.isConnected) button.disabled = false;
  }
}

function mentionCandidates() {
  const query = (state.mentionSearch?.query ?? '').toLocaleLowerCase();
  const matches = (...values) => values.join(' ').toLocaleLowerCase().includes(query);
  const rank = (label) => {
    const name = label.toLocaleLowerCase();
    if (name === query) return 0;
    if (name.startsWith(query)) return 1;
    if (name.includes(query)) return 2;
    return 3;
  };
  const workers = state.workers.filter((worker) => (
    canMentionWorker(worker) && matches(worker.name, worker.runtime, worker.connector_name, worker.metadata?.description ?? '', ...worker.capabilities)
  )).sort((a, b) => rank(a.name) - rank(b.name)).slice(0, 6).map((worker) => ({
    type: 'worker',
    id: worker.worker_id,
    label: worker.name,
    secondary: `${worker.connector_name ?? '未知机器'} · ${worker.runtime} · ${worker.metadata?.description || '尚未填写职责'}`,
    status: labels[worker.activity?.phase] ?? labels[worker.work_state] ?? worker.work_state,
  }));
  const tasks = taskEntries().filter((entry) => (
    matches(taskRef(entry.task), entry.task.title, entry.task.goal, entry.task.task_id)
  )).sort((a, b) => rank(a.task.title) - rank(b.task.title)).slice(0, 6).map((entry) => ({
    type: 'task',
    id: entry.task.task_id,
    label: taskName(entry.task),
    secondary: clip(entry.task.goal || '没有补充目标', 100),
    status: labels[taskStatus(entry)] ?? taskStatus(entry),
  }));
  return { workers, tasks };
}

function renderMentionPicker() {
  const picker = $('#mention-picker');
  const input = $('#chat-input');
  const open = Boolean(state.mentionSearch && !state.sending);
  picker.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  if (!open) {
    picker.innerHTML = '';
    input.removeAttribute('aria-activedescendant');
    return;
  }
  const groups = mentionCandidates();
  const candidates = [...groups.workers, ...groups.tasks];
  if (!candidates.length) {
    picker.innerHTML = '<div class="mention-empty">没有匹配的员工或任务</div>';
    input.removeAttribute('aria-activedescendant');
    return;
  }
  state.mentionIndex = Math.min(state.mentionIndex, candidates.length - 1);
  let index = 0;
  const renderGroup = (title, entries) => entries.length ? `
    <div class="mention-group">${title}</div>
    ${entries.map((candidate) => {
      const optionIndex = index++;
      const selected = optionIndex === state.mentionIndex;
      return `<button id="mention-option-${optionIndex}" class="mention-option ${selected ? 'active' : ''}" type="button" role="option" tabindex="-1" aria-selected="${selected}" data-mention-type="${candidate.type}" data-mention-id="${escapeHtml(candidate.id)}"><span><strong>${escapeHtml(candidate.label)}</strong><small>${escapeHtml(candidate.secondary)}</small></span><b>${escapeHtml(candidate.status)}</b></button>`;
    }).join('')}` : '';
  picker.innerHTML = renderGroup('数字员工 / 点名派活', groups.workers) + renderGroup('任务 / 引用上下文', groups.tasks);
  input.setAttribute('aria-activedescendant', `mention-option-${state.mentionIndex}`);
}

function closeMentionPicker() {
  state.mentionSearch = null;
  state.mentionIndex = 0;
  renderMentionPicker();
}

function updateMentionSearch() {
  const input = $('#chat-input');
  if (input.disabled || state.sending) {
    closeMentionPicker();
    return;
  }
  const caret = input.selectionStart;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(input.value.slice(0, caret));
  if (!match) {
    closeMentionPicker();
    return;
  }
  const query = match[1];
  if (state.mentionSearch?.query !== query) state.mentionIndex = 0;
  state.mentionSearch = {
    start: caret - match[0].length + match[0].lastIndexOf('@'),
    end: caret,
    query,
  };
  renderMentionPicker();
}

function handleMentionKey(event) {
  if (!state.mentionSearch || event.isComposing) return false;
  const groups = mentionCandidates();
  const candidates = [...groups.workers, ...groups.tasks];
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMentionPicker();
    return true;
  }
  if (!candidates.length) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    state.mentionIndex = (state.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length;
    renderMentionPicker();
    $(`#mention-option-${state.mentionIndex}`)?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    const candidate = candidates[state.mentionIndex];
    insertMention(candidate.type, candidate.id);
    return true;
  }
  return false;
}

function insertMention(type, id) {
  const input = $('#chat-input');
  if (input.disabled) {
    toast('中央大脑尚未可用，暂时不能派活。', true);
    return;
  }
  const entity = type === 'worker'
    ? state.workers.find((worker) => worker.worker_id === id)
    : state.tasks.find((task) => task.task_id === id);
  if (!entity || (type === 'worker' && !canMentionWorker(entity))) {
    toast(type === 'worker' ? '这位员工当前不能接收主动派单。' : '这项任务已不存在。', true);
    return;
  }
  const marker = `@${type === 'worker' ? entity.name : entity.title}`;
  const range = state.mentionSearch ?? {
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.value.length,
  };
  input.setRangeText(`${marker} `, range.start, range.end, 'end');
  if (!state.mentions.some((mention) => mention.type === type && mention.id === id)) {
    state.mentions.push({ type, id, marker });
  }
  state.mentionSearch = null;
  state.mentionIndex = 0;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  if (window.matchMedia('(max-width: 880px)').matches) {
    $('#chat-form').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  }
}

function removeMention(type, id) {
  const index = state.mentions.findIndex((mention) => mention.type === type && mention.id === id);
  if (index < 0) return;
  const [mention] = state.mentions.splice(index, 1);
  const input = $('#chat-input');
  const start = input.value.indexOf(mention.marker);
  if (start >= 0) {
    let end = start + mention.marker.length;
    if (input.value[end] === ' ') end += 1;
    input.setRangeText('', start, end, 'start');
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

async function copyText(value) {
  const content = String(value ?? '');
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  const input = document.createElement('textarea');
  input.value = content;
  input.setAttribute('readonly', '');
  input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  document.body.append(input);
  input.focus();
  input.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    input.remove();
  }
  if (!copied) throw new Error('Copy failed');
}

function copyButton(message) {
  return message.status === 'pending' ? '' : `<button class="copy-message" type="button" data-copy-message="${escapeHtml(message.message_id)}" aria-label="复制这条消息">复制</button>`;
}

function messageContent(message) {
  if (message.role === 'activity' && message.source_key?.includes(':step:') && message.content.length > 600) {
    return '一项步骤结果已返回，完整结果见任务详情。';
  }
  return message.content;
}

function pendingMessageLabel(message) {
  if (message.speaker?.type === 'worker') {
    const worker = state.workers.find((item) => item.worker_id === message.speaker.worker_id);
    const name = message.speaker.name;
    if (worker?.presence === 'offline') return `等待 ${name} 上线`;
    const activity = worker?.activity;
    if (activity && !['idle', 'offline'].includes(activity.phase) && activity.command_id !== message.command_id) {
      return `${name} 正在忙，你的问题已排队`;
    }
    if (['queued', 'accepted'].includes(activity?.command_status)) return `${name} 已收到问题，等待本人回复`;
    return `正在等待 ${name} 本人回复`;
  }
  const worker = state.workers.find((item) => item.worker_id === state.coordinator?.worker_id);
  const presence = worker?.presence ?? state.coordinator?.worker?.presence;
  if (presence === 'offline') return '等待中央大脑上线';
  const activity = worker?.activity;
  if (activity && !['idle', 'offline'].includes(activity.phase) && activity.command_id !== message.command_id) {
    return '消息已排队，等待中央大脑完成当前工作';
  }
  if (['queued', 'accepted'].includes(activity?.command_status)) return '消息已收到，等待中央大脑开始回复';
  return '正在理解你的消息';
}

function renderChat(forceScroll = false) {
  const container = $('#chat-messages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  if (!state.messages.length) {
    container.innerHTML = '<div class="conversation-empty">暂无对话</div>';
    syncComposer();
    return;
  }
  const lastTaskMessage = new Map();
  state.messages.forEach((message, index) => {
    if (message.task_id && taskEntry(message.task_id)) lastTaskMessage.set(message.task_id, index);
  });
  container.innerHTML = state.messages.map((message, index) => {
    let content;
    if (message.role === 'activity') {
      const phase = message.source_key?.endsWith(':completed')
        ? 'completed'
        : message.source_key?.endsWith(':blocked') || message.source_key?.includes(':review-required')
          ? 'attention'
          : '';
      const label = phase === 'completed' ? '任务完成' : phase === 'attention' ? '需要处理' : '任务进展';
      content = `
        <article class="chat-activity ${phase ? `activity-${phase}` : ''}">
          <p class="message-meta">${label} · ${escapeHtml(time(message.created_at))}</p><p class="message-content">${escapeHtml(messageContent(message))}</p>
          ${message.task_id && taskEntry(message.task_id) ? `<button class="text-button" type="button" data-task-detail="${escapeHtml(message.task_id)}">查看这项任务 <span aria-hidden="true">→</span></button>` : ''}
          ${copyButton(message)}
        </article>`;
    } else {
      const own = message.role === 'user';
      const pending = message.status === 'pending';
      const failed = message.status === 'failed';
      content = `
        <article class="chat-message ${own ? 'own' : 'assistant'} ${pending ? 'pending' : ''} ${failed ? 'failed' : ''}">
          <p class="message-meta">${own ? '你' : escapeHtml(message.speaker?.name ?? '中央大脑')} · ${escapeHtml(time(message.created_at))}</p>
          ${pending
            ? `<div class="thinking"><i></i><i></i><i></i><span>${escapeHtml(pendingMessageLabel(message))}</span></div>`
            : `<p class="message-content">${escapeHtml(message.content)}</p>`}
          ${message.task_id && taskEntry(message.task_id) ? `<button class="text-button" type="button" data-task-detail="${escapeHtml(message.task_id)}">查看这项任务 <span aria-hidden="true">→</span></button>` : ''}
          ${copyButton(message)}
        </article>`;
    }
    return content + (lastTaskMessage.get(message.task_id) === index ? renderInlineTask(message.task_id) : '');
  }).join('');
  if (nearBottom || forceScroll) container.scrollTop = container.scrollHeight;
  syncComposer();
}

function renderTasks() {
  const entries = taskEntries();
  const counts = { active: 0, ready: 0, attention: 0, done: 0, all: entries.length };
  $('[data-count="tasks"]').textContent = entries.length;
  for (const entry of entries) counts[taskGroup(entry)] += 1;
  for (const button of $$('[data-task-filter]')) {
    const selected = button.dataset.taskFilter === state.taskFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('b').textContent = counts[button.dataset.taskFilter];
  }
  const filtered = state.taskFilter === 'all' ? entries : entries.filter((entry) => taskGroup(entry) === state.taskFilter);
  const emptyMessages = {
    active: '暂无进行中的任务',
    ready: '暂无等待开始的任务',
    attention: '暂无需要关注的任务',
    done: '暂无已完成任务',
    all: '暂无任务',
  };
  $('#tasks-list').innerHTML = filtered.length
    ? filtered.map((entry) => renderTaskCard(entry)).join('')
    : empty(emptyMessages[state.taskFilter]);
}

function renderWorkers() {
  const expanded = new Map($$('#workers-list [data-worker-card]').map((element) => [element.dataset.workerCard, element.open]));
  const visibility = new Map($$('#workers-list [data-output-key]').map((element) => [element.dataset.outputKey, element.open]));
  const workers = state.workers;
  const online = workers.filter((worker) => worker.presence === 'online').length;
  const working = workers.filter((worker) => !['idle', 'offline'].includes(worker.activity?.phase ?? worker.work_state)).length;
  $('#workforce-summary').textContent = `${online} / ${workers.length} 在线${working ? ` · ${working} 忙碌` : ''}`;
  $('#workers-list').innerHTML = workers.length ? workers.map((worker) => {
    const activity = worker.activity ?? { phase: worker.work_state, detail: worker.work_state };
    const active = !['idle', 'offline'].includes(activity.phase);
    const phase = worker.presence === 'offline' ? 'offline' : activity.phase;
    const phaseClass = String(phase).replace(/[^a-z_]/g, '');
    const canMention = canMentionWorker(worker);
    const liveKey = `live-${worker.worker_id}`;
    const recentKey = `recent-${worker.worker_id}`;
    const description = worker.metadata?.description || '暂无简介';
    const mentionHint = canMention ? `@ ${worker.name}` : '人工协作（会话未接通）';
    return `
      <details class="worker-row ${active ? 'is-working' : ''}" data-worker-card="${escapeHtml(worker.worker_id)}" ${expanded.get(worker.worker_id) ? 'open' : ''}>
        <summary class="worker-summary">
          <span class="worker-monogram" aria-hidden="true">${escapeHtml(worker.runtime.slice(0, 2).toUpperCase())}</span>
          <span class="worker-summary-text">
            <span class="worker-name-line"><strong>${escapeHtml(worker.name)}</strong><span class="worker-state phase-${phaseClass}"><i></i>${escapeHtml(labels[phase] ?? phase)}</span></span>
            <span class="worker-description" title="${escapeHtml(description)}">${escapeHtml(description)}</span>
          </span>
          <button class="worker-mention" type="button" data-mention-worker="${escapeHtml(worker.worker_id)}" title="${escapeHtml(mentionHint)}" aria-label="${escapeHtml(mentionHint)}" ${canMention ? '' : 'disabled'}>@</button>
        </summary>
        <div class="worker-details">
          <p class="worker-runtime">${escapeHtml(worker.connector_name ?? '未知机器')} · ${escapeHtml(worker.runtime)} · ${state.coordinator?.enabled && worker.worker_id === state.coordinator.worker_id ? '中央大脑' : worker.push_capable ? '交互会话 · 已接通' : '人工协作 · 会话未接通'}</p>
          <div class="capabilities">${worker.capabilities.map((capability) => `<span>${escapeHtml(capability)}</span>`).join('')}</div>
          ${active ? `<div class="worker-current">
            <strong>${escapeHtml(activity.task_title ?? activity.detail)}</strong>
            <p>${escapeHtml(activity.parent_task_title && activity.parent_task_title !== activity.task_title ? `所属：${activity.parent_task_title}` : activity.detail)}</p>
            ${activity.task_id ? `<button class="text-button" type="button" data-task-detail="${escapeHtml(activity.task_id)}">查看任务 →</button>` : ''}
          </div>` : ''}
          ${activity.output_text ? `<details class="worker-output" data-output-key="${liveKey}" open><summary>实时输出${activity.output_truncated ? '（最近部分）' : ''}</summary><pre>${escapeHtml(activity.output_text)}</pre></details>` : ''}
          ${!activity.output_text && activity.recent_result ? `<details class="worker-output" data-output-key="${recentKey}"><summary>最近一次返回</summary><pre>${escapeHtml(activity.recent_result)}</pre></details>` : ''}
          ${activity.updated_at ? `<time class="worker-updated" datetime="${escapeHtml(activity.updated_at)}">${escapeHtml(dateTime(activity.updated_at))}</time>` : ''}
          <button class="button button-quiet worker-retire" type="button" data-retire-worker="${escapeHtml(worker.worker_id)}">注销员工</button>
        </div>
      </details>`;
  }).join('') : empty('暂无数字员工');
  for (const details of $$('#workers-list [data-output-key]')) {
    if (visibility.has(details.dataset.outputKey)) details.open = visibility.get(details.dataset.outputKey);
  }
  for (const output of $$('.worker-output[open] pre')) output.scrollTop = output.scrollHeight;
}

function setView(view) {
  state.view = view;
  for (const button of $$('.workspace-nav [data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('#view-operations').hidden = view !== 'operations';
  $('#view-tasks').hidden = view !== 'tasks';
}

function openTaskDetail(taskId) {
  if (!taskEntry(taskId)) {
    toast('任务详情还没有同步过来，请稍候。');
    return;
  }
  state.dialogTaskId = taskId;
  renderTaskDialog();
  const dialog = $('#task-dialog');
  if (!dialog.open) {
    dialog.scrollTop = 0;
    dialog.showModal();
  }
}

function renderTaskDialog() {
  if (!state.dialogTaskId) return;
  const entry = taskEntry(state.dialogTaskId);
  const dialog = $('#task-dialog');
  if (!entry) {
    if (dialog.open) dialog.close();
    state.dialogTaskId = null;
    return;
  }
  const content = $('#task-dialog-content');
  const status = taskStatus(entry);
  const detailKey = (element, index) => element.classList.contains('task-context')
    ? 'context'
    : element.classList.contains('execution-details')
      ? 'execution'
      : `evidence-${index}`;
  const preserve = dialog.open && dialog.dataset.taskId === entry.task.task_id && dialog.dataset.taskStatus === status;
  const expanded = new Map(preserve
    ? [...content.querySelectorAll('details')].map((element, index) => [detailKey(element, index), element.open])
    : []);
  $('#task-dialog-title').textContent = taskName(entry.task);
  $('#task-dialog-status').innerHTML = taskBadge(entry);
  content.innerHTML = renderTaskDetail(entry);
  [...content.querySelectorAll('details')].forEach((element, index) => {
    const key = detailKey(element, index);
    if (expanded.has(key)) element.open = expanded.get(key);
  });
  if (dialog.open && dialog.dataset.taskStatus !== status) dialog.scrollTop = 0;
  dialog.dataset.taskId = entry.task.task_id;
  dialog.dataset.taskStatus = status;
}

function render() {
  renderCoordinator();
  renderChat();
  renderTasks();
  renderWorkers();
  renderTaskDialog();
  renderMentionPicker();
  renderConnection();
}

async function refresh() {
  const [workers, tasks, orchestrations, coordinator, chat] = await Promise.all([
    api('/api/v1/workers'),
    api('/api/v1/tasks'),
    api('/api/v1/orchestrations'),
    api('/api/v1/coordinator'),
    api('/api/v1/coordinator/chat'),
  ]);
  state.workers = workers.workers;
  state.tasks = tasks.tasks;
  state.orchestrations = orchestrations.orchestrations;
  state.coordinator = coordinator.coordinator;
  state.messages = chat.messages;
  state.conversationEpoch = Number(chat.epoch ?? 0);
  render();
}

function scheduleRefresh() {
  if (!state.token) return;
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refresh().catch((error) => toast(error.message, true)), 120);
}

function upsertMessage(message) {
  if (Number(message.conversation_epoch ?? 0) !== state.conversationEpoch) return;
  const index = state.messages.findIndex((item) => item.message_id === message.message_id);
  if (index === -1) state.messages.push(message);
  else state.messages[index] = message;
  renderChat(message.role === 'user');
  renderTaskDialog();
}

function connectSocket() {
  if (!state.token || state.socket?.readyState === WebSocket.OPEN) return;
  clearTimeout(state.reconnectTimer);
  const url = new URL('/ws/dashboard', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  state.socket = socket;
  renderConnection();
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'dashboard.hello', payload: { token: state.token } })));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'dashboard.ready') {
      state.connected = true;
      renderConnection();
      refresh().catch((error) => toast(error.message, true));
      return;
    }
    if (message.type === 'chat.updated') {
      upsertMessage(message.payload.message);
      scheduleRefresh();
      return;
    }
    if (message.type === 'task.deleted') {
      applyTaskDeletion(message.payload.deleted_task_ids);
      return;
    }
    if (message.type === 'worker.unregistered') {
      const workerId = message.payload.worker.worker_id;
      state.workers = state.workers.filter((worker) => worker.worker_id !== workerId);
      for (const mention of state.mentions.filter((item) => item.type === 'worker' && item.id === workerId)) {
        removeMention('worker', workerId);
      }
      renderWorkers();
      renderCoordinator();
      renderChat();
      renderMentionPicker();
      scheduleRefresh();
      return;
    }
    if (message.type === 'worker.updated') {
      const worker = message.payload.worker;
      if (worker.retired_at) {
        state.workers = state.workers.filter((item) => item.worker_id !== worker.worker_id);
      } else {
        const index = state.workers.findIndex((item) => item.worker_id === worker.worker_id);
        if (index === -1) state.workers.push(worker);
        else state.workers[index] = worker;
      }
      renderWorkers();
      renderCoordinator();
      renderChat();
      renderMentionPicker();
      return;
    }
    if (message.type === 'coordinator.updated') {
      state.coordinator = message.payload.coordinator;
      renderCoordinator();
      renderWorkers();
      renderChat();
      renderMentionPicker();
      return;
    }
    if (message.type === 'chat.cleared') {
      state.conversationEpoch = Number(message.payload.epoch);
      state.messages = [];
      state.clearingChat = false;
      renderChat();
      return;
    }
    if (message.type === 'history.cleared') {
      state.mentions = [];
      state.messages = [];
      state.tasks = [];
      state.orchestrations = [];
      state.taskFilter = 'all';
      if ($('#task-dialog').open) $('#task-dialog').close();
      closeMentionPicker();
      syncComposer();
      scheduleRefresh();
      toast('历史已清理，员工和中央协调者保持不变。');
      return;
    }
    if (message.type === 'command.updated' || message.type === 'event') scheduleRefresh();
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.connected = false;
    renderConnection();
    if (state.token) state.reconnectTimer = setTimeout(connectSocket, 1500);
  });
  socket.addEventListener('error', () => {
    state.connected = false;
    renderConnection();
  });
}

async function connect(token) {
  state.token = token;
  $('#auth-error').textContent = '';
  try {
    await refresh();
    sessionStorage.setItem('agent-hub-admin-token', token);
    $('#auth-view').hidden = true;
    $('#app').hidden = false;
    setView('operations');
    $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
    connectSocket();
  } catch (error) {
    state.token = null;
    sessionStorage.removeItem('agent-hub-admin-token');
    $('#auth-error').textContent = error.message;
  }
}

function logout() {
  state.token = null;
  state.connected = false;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.refreshTimer);
  state.socket?.close();
  state.socket = null;
  state.mentions = [];
  closeMentionPicker();
  if ($('#task-dialog').open) $('#task-dialog').close();
  sessionStorage.removeItem('agent-hub-admin-token');
  $('#app').hidden = true;
  $('#auth-view').hidden = false;
  renderConnection();
}

$('#auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  connect($('#admin-token').value.trim()).finally(() => { button.disabled = false; });
});
$('#logout').addEventListener('click', logout);
$('#refresh').addEventListener('click', () => refresh().then(() => toast('已更新为最新状态')).catch((error) => toast(error.message, true)));
$('.workspace-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});
$('#task-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-task-filter]');
  if (!button) return;
  state.taskFilter = button.dataset.taskFilter;
  renderTasks();
});
$('#close-coordinator-dialog').addEventListener('click', () => $('#coordinator-dialog').close());
$('#cancel-coordinator').addEventListener('click', () => $('#coordinator-dialog').close());
$('#coordinator-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#save-coordinator');
  if (button.disabled) return;
  button.disabled = true;
  $('#coordinator-error').textContent = '';
  try {
    const { coordinator } = await api('/api/v1/coordinator', {
      method: 'PUT',
      body: { enabled: true, worker_id: $('#coordinator-worker').value },
    });
    state.coordinator = coordinator;
    $('#coordinator-dialog').close();
    render();
    toast(`已指定 ${coordinator.worker.name} 为中央大脑`);
  } catch (error) {
    $('#coordinator-error').textContent = `指定失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});
$('#close-task-dialog').addEventListener('click', () => $('#task-dialog').close());
$('#task-dialog').addEventListener('close', () => { state.dialogTaskId = null; });
$('#task-dialog').addEventListener('click', (event) => {
  if (event.target !== $('#task-dialog')) return;
  const bounds = event.target.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
});
$('#mention-picker').addEventListener('pointerdown', (event) => {
  if (event.target.closest('[data-mention-type]')) event.preventDefault();
});
$('#chat-input').addEventListener('input', () => {
  syncComposer();
  updateMentionSearch();
});
$('#chat-input').addEventListener('click', updateMentionSearch);
$('#chat-input').addEventListener('keyup', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateMentionSearch();
});
$('#chat-input').addEventListener('keydown', (event) => {
  if (handleMentionKey(event)) return;
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    const input = event.currentTarget;
    input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (!$('#send-chat').disabled) $('#chat-form').requestSubmit();
});
function taskResultCopy(taskId, stepTaskId = null) {
  const entry = taskEntry(taskId);
  if (!entry) return '';
  const steps = deliverableSteps(entry).filter((step) => !stepTaskId || step.task_id === stepTaskId);
  if (stepTaskId) return steps.length ? resultText(steps[0].result) : '';
  return [
    `# ${taskName(entry.task)}`,
    entry.orchestration?.review_reason ? `整体验收：${entry.orchestration.review_reason}` : '',
    ...steps.map((step, index) => `## ${index + 1}. ${step.title}\n负责人：${step.worker_name ?? '数字员工'}\n\n${resultText(step.result)}`),
  ].filter(Boolean).join('\n\n');
}

async function sendChatMessage(message, { mentions = [], clearComposer = false } = {}) {
  if (!message || state.sending) return false;
  state.sending = true;
  closeMentionPicker();
  syncComposer();
  const requestId = globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const response = await api('/api/v1/coordinator/chat', {
      method: 'POST',
      body: { message, request_id: requestId, mentions },
    });
    upsertMessage(response.user);
    upsertMessage(response.message);
    if (clearComposer) {
      $('#chat-input').value = '';
      state.mentions = [];
    }
    scheduleRefresh();
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  } finally {
    state.sending = false;
    syncComposer();
    if (!$('#chat-input').disabled) $('#chat-input').focus();
  }
}

async function startTask(taskId) {
  const entry = taskEntry(taskId);
  if (!entry || entry.orchestration?.status !== 'ready' || !entry.orchestration.steps.length || state.sending) return;
  setView('operations');
  if ($('#task-dialog').open) $('#task-dialog').close();
  await sendChatMessage(`@${taskName(entry.task)} 开始执行，只启动这份已有计划。`, {
    mentions: [{ type: 'task', id: taskId }],
  });
}

$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#chat-input').value.trim();
  if (!message || state.sending) return;
  const mentions = activeMentions().map(({ type, id }) => ({ type, id }));
  await sendChatMessage(message, { mentions, clearComposer: true });
});
$('#clear-chat').addEventListener('click', async () => {
  if (!state.messages.length || state.clearingChat) return;
  if (!window.confirm('清空当前对话？不会取消任务，新的进展仍会显示。')) return;
  state.clearingChat = true;
  syncComposer();
  try {
    const result = await api('/api/v1/coordinator/chat', { method: 'DELETE' });
    state.conversationEpoch = Number(result.epoch);
    state.messages = [];
    renderChat();
    toast('对话已清空');
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.clearingChat = false;
    syncComposer();
  }
});
document.addEventListener('click', async (event) => {
  const start = event.target.closest('[data-start-task]');
  if (start) {
    await startTask(start.dataset.startTask);
    return;
  }
  const result = event.target.closest('[data-copy-result], [data-copy-all-results]');
  if (result) {
    const taskId = result.dataset.copyResult ?? result.dataset.copyAllResults;
    const content = taskResultCopy(taskId, result.dataset.copyResult ? result.dataset.copyResult : null);
    if (!content) {
      toast('这项任务还没有可复制的文本结果。', true);
      return;
    }
    try {
      await copyText(content);
      toast(result.dataset.copyResult ? '结果已复制' : '全部结果已复制');
    } catch {
      toast('复制失败，请手动选择文本', true);
    }
    return;
  }
  const copy = event.target.closest('[data-copy-message]');
  if (copy) {
    const message = state.messages.find((item) => item.message_id === copy.dataset.copyMessage);
    if (message) {
      try {
        await copyText(messageContent(message));
        toast('已复制');
      } catch {
        toast('复制失败，请手动选择文本', true);
      }
    }
    return;
  }
  const mention = event.target.closest('[data-mention-type]');
  if (mention) {
    insertMention(mention.dataset.mentionType, mention.dataset.mentionId);
    return;
  }
  const worker = event.target.closest('[data-mention-worker]');
  if (worker) {
    event.preventDefault();
    event.stopPropagation();
    insertMention('worker', worker.dataset.mentionWorker);
    return;
  }
  if (event.target.closest('[data-configure-coordinator]')) {
    openCoordinatorDialog();
    return;
  }
  const retire = event.target.closest('[data-retire-worker], [data-retire-coordinator]');
  if (retire) {
    const coordinator = retire.hasAttribute('data-retire-coordinator');
    const workerId = coordinator ? retire.dataset.retireCoordinator : retire.dataset.retireWorker;
    const selected = state.workers.find((item) => item.worker_id === workerId) ?? state.coordinator?.worker;
    retireWorker(selected, retire, coordinator);
    return;
  }
  const deletion = event.target.closest('[data-delete-task]');
  if (deletion) {
    deleteTask(deletion.dataset.deleteTask, deletion);
    return;
  }
  const reference = event.target.closest('[data-reference-task]');
  if (reference) {
    setView('operations');
    if ($('#task-dialog').open) $('#task-dialog').close();
    insertMention('task', reference.dataset.referenceTask);
    return;
  }
  const detail = event.target.closest('[data-task-detail]');
  if (detail) {
    openTaskDetail(detail.dataset.taskDetail);
    return;
  }
  const remove = event.target.closest('[data-remove-mention-id]');
  if (remove) {
    removeMention(remove.dataset.removeMentionType, remove.dataset.removeMentionId);
    return;
  }
  if (!event.target.closest('.chat-composer')) closeMentionPicker();
});

const savedToken = sessionStorage.getItem('agent-hub-admin-token');
if (savedToken) {
  $('#admin-token').value = savedToken;
  connect(savedToken);
}
