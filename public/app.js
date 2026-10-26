const state = {
  token: null,
  connected: false,
  view: 'orchestrations',
  workers: [],
  tasks: [],
  orchestrations: [],
  coordinator: null,
  messages: [],
  selectedTaskId: null,
  taskFilter: 'active',
  sending: false,
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
  review: '等待评审',
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
const badge = (status) => `<span class="status status-${String(status).replace(/[^a-z_]/g, '')}">${escapeHtml(labels[status] ?? status)}</span>`;
const empty = (message) => `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;

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
    ? '计划已就绪，尚未执行。你可以在中央大脑里说“开始执行”。'
    : '已经记录，等待制定计划。';
  if (status === 'in_progress') {
    const running = orchestration.steps.find((step) => step.status === 'running');
    if (running) return `${running.worker_name ?? '数字员工'} 正在执行「${running.title}」`;
    if (orchestration.steps.some((step) => step.status === 'ready')) return '正在等待前置步骤完成，或合适的员工空闲。';
    return '执行结果正在汇集，准备核对验收。';
  }
  if (status === 'review') return orchestration.error
    ? `需要复核：${orchestration.error.message}`
    : '执行结果已返回，中央大脑正在核对每一步与整体验收。';
  if (status === 'blocked') return `任务已停止：${orchestration.error?.message ?? '存在未解决的问题'}。不会自动重试。`;
  if (status === 'done') return orchestration.review_reason || '所有步骤和整体验收均已通过。';
  return task.status;
}

function renderTaskDetail(entry) {
  const { task, orchestration } = entry;
  const steps = orchestration?.steps ?? [];
  const stepTitles = new Map(steps.map((step) => [step.key, step.title]));
  return `
    <div class="task-detail-grid">
      <section><h4>要达成什么</h4><p>${escapeHtml(task.goal || '未补充目标')}</p></section>
      ${task.context ? `<section><h4>已知上下文</h4><p>${escapeHtml(task.context)}</p></section>` : ''}
      <section><h4>怎样算完成</h4>${task.acceptance.length
        ? `<ul class="acceptance-list">${task.acceptance.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join('')}</ul>`
        : '<p class="muted">尚未设置整体验收标准</p>'}</section>
    </div>
    ${orchestration?.summary ? `<div class="plan-note"><strong>中央大脑的安排</strong><p>${escapeHtml(orchestration.summary)}</p></div>` : ''}
    ${steps.length ? `<ol class="step-list">${steps.map((step, index) => `
      <li class="step-${escapeHtml(step.status)}">
        <span class="step-index">${String(index + 1).padStart(2, '0')}</span>
        <div class="step-body">
          <div class="step-title"><h4>${escapeHtml(step.title)}</h4>${badge(step.status)}</div>
          <p class="step-owner">${escapeHtml(step.worker_name ?? '等待匹配员工')}${step.depends_on.length
            ? ` · 需先完成 ${escapeHtml(step.depends_on.map((key) => stepTitles.get(key) ?? key).join('、'))}`
            : ''}</p>
          <p>${escapeHtml(step.goal)}</p>
          ${step.rationale ? `<p class="step-rationale">为什么交给 TA：${escapeHtml(step.rationale)}</p>` : ''}
          ${step.error?.message ? `<p class="inline-error">${escapeHtml(step.error.message)}</p>` : ''}
          ${step.review?.reason ? `<p class="review-note">${step.review.pass ? '终审通过' : '需要复核'}：${escapeHtml(step.review.reason)}</p>` : ''}
          ${step.result?.text ? `<details class="evidence"><summary>查看实际返回</summary><pre>${escapeHtml(clip(step.result.text, 6000))}</pre></details>` : ''}
        </div>
      </li>`).join('')}</ol>` : ''}
    ${orchestration?.review_reason ? `<div class="review-note final-review"><strong>中央大脑的终审</strong><p>${escapeHtml(orchestration.review_reason)}</p></div>` : ''}`;
}

function renderTaskCard(entry, expanded = false) {
  const { task, orchestration } = entry;
  const steps = orchestration?.steps ?? [];
  const completed = steps.filter((step) => step.status === 'done').length;
  const status = taskStatus(entry);
  const group = taskGroup(entry);
  return `
    <article class="task-card task-${group}" data-task-card="${escapeHtml(task.task_id)}">
      <div class="task-heading">
        <div><p class="section-index">${orchestration ? orchestration.auto_start ? '中央编排' : '对话计划' : '独立任务'}</p><h3>${escapeHtml(task.title)}</h3></div>
        ${badge(status)}
      </div>
      ${task.goal ? `<p class="task-goal">${escapeHtml(clip(task.goal))}</p>` : ''}
      <div class="task-stage"><span>当前进展</span><p>${escapeHtml(taskStage(entry))}</p></div>
      ${steps.length ? `
        <div class="step-progress">
          <div class="progress-track" role="progressbar" aria-label="通过终审的步骤" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${completed}"><i style="width:${completed / steps.length * 100}%"></i></div>
          <span>${completed} / ${steps.length} 步通过终审</span>
        </div>` : `<p class="direct-owner">负责人：${escapeHtml(task.assignee_name ?? '尚未分配')}</p>`}
      <div class="task-meta-line"><span>${orchestration ? `${steps.length} 个步骤` : task.created_by === 'coordinator' ? '中央大脑创建' : '任务记录'}</span><time datetime="${escapeHtml(task.updated_at)}">更新于 ${escapeHtml(dateTime(task.updated_at))}</time></div>
      ${expanded ? renderTaskDetail(entry) : `<details class="task-details"><summary>目标、步骤与验收</summary>${renderTaskDetail(entry)}</details>`}
    </article>`;
}

function renderFocus() {
  const entries = taskEntries();
  let entry = entries.find((item) => item.task.task_id === state.selectedTaskId);
  const label = $('.focus-heading span');
  if (!entry && state.selectedTaskId) {
    label.textContent = 'REGISTERING / 正在登记';
    $('#focus-task').innerHTML = '<div class="focus-empty"><h3>正在登记这项工作</h3><p class="muted">任务和计划返回后，这里会自动显示进展。</p></div>';
    return;
  }
  if (!entry) {
    entry = entries.find((item) => taskGroup(item) === 'active')
      ?? entries.find((item) => taskGroup(item) === 'ready')
      ?? entries[0];
    state.selectedTaskId = entry?.task.task_id ?? null;
  }
  if (!entry) {
    label.textContent = 'HOW IT WORKS / 这里显示什么';
    $('#focus-task').innerHTML = `
      <div class="focus-empty">
        <div class="focus-lines" aria-hidden="true"><i></i><i></i><i></i></div>
        <h3>看见中央大脑怎样工作</h3>
        <p>你在左侧说出目标后，这里会用中文解释：</p>
        <ul><li>它准备怎样拆任务</li><li>每一步交给谁，为什么</li><li>现在进行到哪里，结果是否通过</li></ul>
        <p class="muted">不需要理解命令、回执或事件记录。</p>
      </div>`;
    return;
  }
  const group = taskGroup(entry);
  label.textContent = group === 'active' ? 'NOW / 当前工作' : group === 'ready' ? 'WAITING / 等待启动' : group === 'done' ? 'RESULT / 最近结果' : 'ATTENTION / 需要关注';
  $('#focus-task').innerHTML = renderTaskCard(entry, true);
}

function syncComposer() {
  const available = Boolean(state.coordinator?.enabled && state.coordinator.worker?.push_capable);
  const input = $('#chat-input');
  input.disabled = !available;
  input.readOnly = state.sending;
  $('#send-chat').disabled = !available || state.sending || !input.value.trim();
  $('#send-chat').textContent = state.sending ? '发送中' : '发送';
}

function renderCoordinator() {
  const coordinator = state.coordinator;
  const worker = coordinator?.worker;
  const available = Boolean(coordinator?.enabled && worker?.push_capable);
  const online = worker?.presence === 'online';
  const live = state.workers.find((item) => item.worker_id === worker?.worker_id);
  const activePhase = live?.activity && !['idle', 'offline'].includes(live.activity.phase);
  const description = !available
    ? '尚未启用。需要管理员指定一个可调度的协调者。'
    : !online
      ? '当前离线；消息会等待连接恢复后再处理。'
      : activePhase
        ? live.activity.detail
        : '在线，可以回答问题、规划并安排工作。';
  $('#coordinator-status').innerHTML = `
    <div class="coordinator-presence">
      <span class="brain-symbol" aria-hidden="true"></span>
      <div><h3>${escapeHtml(worker?.name ?? '中央大脑')}</h3><p>${escapeHtml(description)}</p></div>
      ${badge(available ? online ? 'online' : 'offline' : 'blocked')}
    </div>`;
  syncComposer();
}

function renderChat() {
  const container = $('#chat-messages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  if (!state.messages.length) {
    container.innerHTML = `
      <div class="conversation-intro">
        <p class="section-index">可以这样开始</p>
        <h3>像交代一位同事一样，直接说。</h3>
        <p>“现在大家分别在做什么？”</p>
        <p>“先只规划一次代码审查，不要执行。”</p>
        <p>“安排合适的员工完成这个小任务，并核对结果。”</p>
      </div>`;
    return;
  }
  container.innerHTML = state.messages.map((message) => {
    if (message.role === 'activity') {
      return `
        <article class="chat-activity">
          <div><p class="message-meta">任务进展 · ${escapeHtml(time(message.created_at))}</p><p class="message-content">${escapeHtml(message.content)}</p>
          ${message.task_id ? `<button class="text-button" type="button" data-focus-task="${escapeHtml(message.task_id)}">查看这项任务 <span aria-hidden="true">→</span></button>` : ''}</div>
        </article>`;
    }
    const own = message.role === 'user';
    const pending = message.status === 'pending';
    const failed = message.status === 'failed';
    return `
      <article class="chat-message ${own ? 'own' : 'assistant'} ${pending ? 'pending' : ''} ${failed ? 'failed' : ''}">
        <p class="message-meta">${own ? '你' : '中央大脑'} · ${escapeHtml(time(message.created_at))}</p>
        ${pending
          ? `<div class="thinking"><i></i><i></i><i></i><span>${state.coordinator?.worker?.presence === 'offline' ? '等待中央大脑上线' : '正在理解你的消息'}</span></div>`
          : `<p class="message-content">${escapeHtml(message.content)}</p>`}
        ${message.task_id ? `<button class="text-button" type="button" data-focus-task="${escapeHtml(message.task_id)}">查看这项任务 <span aria-hidden="true">→</span></button>` : ''}
      </article>`;
  }).join('');
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

function renderTasks() {
  const entries = taskEntries();
  const counts = { active: 0, ready: 0, attention: 0, done: 0, all: entries.length };
  for (const entry of entries) counts[taskGroup(entry)] += 1;
  for (const button of $$('[data-task-filter]')) {
    const selected = button.dataset.taskFilter === state.taskFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.querySelector('b').textContent = counts[button.dataset.taskFilter];
  }
  const filtered = state.taskFilter === 'all' ? entries : entries.filter((entry) => taskGroup(entry) === state.taskFilter);
  const emptyMessages = {
    active: '现在没有正在推进的任务。告诉中央大脑下一件要做的事。',
    ready: '没有等待启动的计划。你可以说“先只规划……”。',
    attention: '没有需要关注的任务。',
    done: '还没有已完成的任务。',
    all: '还没有任务。从中央大脑的对话框开始。',
  };
  $('#tasks-list').innerHTML = filtered.length
    ? filtered.map((entry) => renderTaskCard(entry)).join('')
    : empty(emptyMessages[state.taskFilter]);
}

function renderWorkers() {
  const online = state.workers.filter((worker) => worker.presence === 'online').length;
  const working = state.workers.filter((worker) => worker.activity?.phase && !['idle', 'offline', 'queued', 'waiting_manual'].includes(worker.activity.phase)).length;
  $('#workforce-summary').innerHTML = `<strong>${online} / ${state.workers.length}</strong> 位在线 <span></span> <strong>${working}</strong> 位正在工作`;
  $('#workers-list').innerHTML = state.workers.length ? state.workers.map((worker) => {
    const activity = worker.activity ?? { phase: worker.work_state, detail: worker.work_state };
    const coordinator = state.coordinator?.worker_id === worker.worker_id;
    const active = !['idle', 'offline'].includes(activity.phase);
    const result = activity.recent_result && !activity.output_text
      ? `<details class="worker-output"><summary>最近一次返回</summary><pre>${escapeHtml(activity.recent_result)}</pre></details>`
      : '';
    return `
      <article class="worker-card ${escapeHtml(activity.phase)}">
        <div class="worker-heading">
          <div class="worker-monogram" aria-hidden="true">${escapeHtml(worker.runtime.slice(0, 2).toUpperCase())}</div>
          <div><p class="section-index">${coordinator ? '中央协调者' : '数字员工'}</p><h3>${escapeHtml(worker.name)}</h3></div>
          <div class="status-row">${badge(worker.presence)}${badge(activity.phase)}</div>
        </div>
        <p class="worker-description">${escapeHtml(worker.metadata?.description || '尚未填写职责说明')}</p>
        <div class="capabilities">${worker.capabilities.map((capability) => `<span>${escapeHtml(capability)}</span>`).join('')}</div>
        <div class="worker-current">
          <span>${active ? '当前工作' : '当前状态'}</span>
          <strong>${escapeHtml(activity.task_title ?? activity.detail)}</strong>
          <p>${escapeHtml(activity.parent_task_title && activity.parent_task_title !== activity.task_title ? `所属：${activity.parent_task_title}` : activity.detail)}</p>
        </div>
        ${activity.output_text ? `<details class="worker-output" open><summary>实时返回${activity.output_truncated ? '（仅显示最近部分）' : ''}</summary><pre>${escapeHtml(activity.output_text)}</pre></details>` : ''}
        ${result}
        <div class="worker-footer"><span>${escapeHtml(worker.connector_name ?? '未知机器')} · ${escapeHtml(worker.runtime)} · ${worker.mode === 'external' ? '原会话人工协作' : '可主动调度'}</span>${activity.updated_at ? `<time datetime="${escapeHtml(activity.updated_at)}" title="连接心跳：${escapeHtml(dateTime(worker.last_seen_at))}">${active ? activity.command_status === 'running' ? '开始' : '更新' : '最近返回'} ${escapeHtml(dateTime(activity.updated_at))}</time>` : ''}</div>
      </article>`;
  }).join('') : empty('还没有数字员工。让本机 Agent 通过 Agent Hub Skill 注册。');
  for (const output of $$('.worker-output[open] pre')) output.scrollTop = output.scrollHeight;
}

function render() {
  const entries = taskEntries();
  $('[data-count="workers"]').textContent = state.workers.length;
  $('[data-count="tasks"]').textContent = entries.length;
  $('[data-count="orchestrations"]').textContent = entries.filter((entry) => taskGroup(entry) === 'active').length;
  renderCoordinator();
  renderChat();
  renderFocus();
  renderTasks();
  renderWorkers();
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
  render();
}

function scheduleRefresh() {
  if (!state.token) return;
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refresh().catch((error) => toast(error.message, true)), 120);
}

function upsertMessage(message) {
  const index = state.messages.findIndex((item) => item.message_id === message.message_id);
  if (index === -1) state.messages.push(message);
  else state.messages[index] = message;
  if (message.task_id) state.selectedTaskId = message.task_id;
  renderChat();
  renderFocus();
}

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  $$('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  if (view === 'orchestrations') {
    const messages = $('#chat-messages');
    messages.scrollTop = messages.scrollHeight;
  }
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
    if (message.type === 'worker.updated') {
      const worker = message.payload.worker;
      const index = state.workers.findIndex((item) => item.worker_id === worker.worker_id);
      if (index === -1) state.workers.push(worker);
      else state.workers[index] = worker;
      renderWorkers();
      renderCoordinator();
      return;
    }
    if (message.type === 'command.updated') {
      scheduleRefresh();
      return;
    }
    if (message.type === 'event') {
      if (message.payload.event.event_type === 'coordinator.started') state.selectedTaskId = message.payload.event.task_id;
      scheduleRefresh();
    }
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
    setView('orchestrations');
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
$('.dispatch-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});
$('#task-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-task-filter]');
  if (!button) return;
  state.taskFilter = button.dataset.taskFilter;
  renderTasks();
});
$('#main').addEventListener('click', (event) => {
  const button = event.target.closest('[data-focus-task]');
  if (!button) return;
  state.selectedTaskId = button.dataset.focusTask;
  renderFocus();
  if (window.matchMedia('(max-width: 1080px)').matches) {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    $('.focus-panel').scrollIntoView({ behavior, block: 'start' });
  }
});
$('#chat-input').addEventListener('input', syncComposer);
$('#chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (!$('#send-chat').disabled) $('#chat-form').requestSubmit();
  }
});
$('#chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#chat-input');
  const message = input.value.trim();
  if (!message || state.sending) return;
  state.sending = true;
  syncComposer();
  const requestId = globalThis.crypto?.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const response = await api('/api/v1/coordinator/chat', {
      method: 'POST',
      body: { message, request_id: requestId },
    });
    upsertMessage(response.user);
    upsertMessage(response.message);
    input.value = '';
    scheduleRefresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.sending = false;
    syncComposer();
    if (!$('#chat-input').disabled) $('#chat-input').focus();
  }
});

const savedToken = sessionStorage.getItem('agent-hub-admin-token');
if (savedToken) {
  $('#admin-token').value = savedToken;
  connect(savedToken);
}
