const state = {
  token: null,
  connected: false,
  view: 'workers',
  workers: [],
  tasks: [],
  orchestrations: [],
  coordinator: null,
  commands: [],
  events: [],
  connectors: [],
  selectedCommand: null,
  socket: null,
  reconnectTimer: null,
  refreshTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const shortId = (value) => value ? `${String(value).slice(0, 20)}${String(value).length > 20 ? '…' : ''}` : '—';
const time = (value) => value ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
const dateTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : '—';
const badge = (value) => `<span class="status status-${String(value).replace(/[^a-z_]/g, '')}">${escapeHtml(value)}</span>`;
const empty = (message) => `<p class="empty-state">${escapeHtml(message)}</p>`;

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

function workerOptions(includeEmpty = true) {
  return `${includeEmpty ? '<option value="">暂不分配</option>' : ''}${state.workers.map((worker) => (
    `<option value="${escapeHtml(worker.worker_id)}">${escapeHtml(worker.name)} · ${escapeHtml(worker.runtime)} · ${escapeHtml(worker.presence)}</option>`
  )).join('')}`;
}

function taskOptions() {
  return `<option value="">不关联任务</option>${state.tasks.map((task) => (
    `<option value="${escapeHtml(task.task_id)}">${escapeHtml(task.title)} · ${escapeHtml(task.status)}</option>`
  )).join('')}`;
}

function renderSelects() {
  const assignee = $('#task-assignee');
  const worker = $('#command-worker');
  const task = $('#command-task');
  const values = [assignee.value, worker.value, task.value];
  assignee.innerHTML = workerOptions();
  worker.innerHTML = `<option value="">跟随任务负责人</option>${workerOptions(false)}`;
  task.innerHTML = taskOptions();
  [assignee.value, worker.value, task.value] = values;
}

function renderWorkers() {
  $('#workers-list').innerHTML = state.workers.length ? state.workers.map((worker) => `
    <article class="record-card ${escapeHtml(worker.presence)}">
      <div>
        <p class="record-kicker">${escapeHtml(worker.runtime)} / ${escapeHtml(worker.mode)}</p>
        <h3>${escapeHtml(worker.name)}</h3>
        <code>${escapeHtml(worker.worker_id)}</code>
        <div class="capabilities">${worker.capabilities.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      </div>
      <div class="status-row">${badge(worker.presence)}${badge(worker.work_state)}${badge(worker.mode)}</div>
      <dl class="record-meta">
        <dt>节点</dt><dd>${escapeHtml(worker.connector_name ?? worker.connector_id)}</dd>
        <dt>Session</dt><dd>${escapeHtml(shortId(worker.runtime_session_id))}</dd>
        <dt>当前任务</dt><dd>${escapeHtml(shortId(worker.current_task_id))}</dd>
        <dt>目录</dt><dd>${escapeHtml(worker.cwd)}</dd>
        <dt>最后活跃</dt><dd>${escapeHtml(dateTime(worker.last_seen_at))}</dd>
      </dl>
    </article>`).join('') : empty('还没有 Worker。通过本机 Connector CLI 自注册第一个数字员工。');
}

function renderTasks() {
  const statuses = ['ready', 'in_progress', 'blocked', 'review', 'done', 'cancelled'];
  $('#tasks-list').innerHTML = state.tasks.length ? state.tasks.map((task) => `
    <article class="record-card">
      <div class="task-title">
        <p class="record-kicker">${escapeHtml(task.task_id)}</p>
        <h3>${escapeHtml(task.title)}</h3>
        <div class="status-row">${badge(task.status)}</div>
      </div>
      <dl class="record-meta">
        <dt>负责人</dt><dd>${escapeHtml(task.assignee_name ?? '未分配')}</dd>
        <dt>创建者</dt><dd>${escapeHtml(task.created_by)}</dd>
        <dt>更新时间</dt><dd>${escapeHtml(dateTime(task.updated_at))}</dd>
      </dl>
      <div class="task-controls">
        <label>状态<select data-task-status="${escapeHtml(task.task_id)}">${statuses.map((status) => `<option value="${status}" ${status === task.status ? 'selected' : ''}>${status}</option>`).join('')}</select></label>
        <label>负责人<select data-task-assignee="${escapeHtml(task.task_id)}"><option value="">未分配</option>${state.workers.map((worker) => `<option value="${escapeHtml(worker.worker_id)}" ${worker.worker_id === task.assignee_worker_id ? 'selected' : ''}>${escapeHtml(worker.name)}</option>`).join('')}</select></label>
      </div>
      <div class="task-context">
        <div><strong>目标</strong><p>${escapeHtml(task.goal || '—')}</p></div>
        <div><strong>上下文</strong><p>${escapeHtml(task.context || '—')}</p></div>
        <div><strong>完成标准</strong><p>${escapeHtml(task.acceptance.join('\n') || '—')}</p></div>
      </div>
    </article>`).join('') : empty('任务黑板为空。从右侧创建第一项任务。');
}

function renderCommands() {
  $('#commands-list').innerHTML = state.commands.length ? state.commands.map((command) => `
    <button class="command-row ${command.command_id === state.selectedCommand ? 'selected' : ''}" data-command="${escapeHtml(command.command_id)}">
      <div><strong>${escapeHtml(command.input)}</strong><code>${escapeHtml(command.worker_name ?? command.worker_id)} · ${escapeHtml(command.kind)}</code></div>
      <div>${badge(command.status)}<time>${escapeHtml(time(command.created_at))}</time></div>
    </button>`).join('') : empty('还没有命令。');
  const command = state.commands.find((item) => item.command_id === state.selectedCommand);
  const detail = $('#command-detail');
  if (!command) {
    detail.innerHTML = '<p class="empty-state">选择一条命令查看输出。</p>';
    return;
  }
  detail.innerHTML = `
    <h3>${escapeHtml(command.input)}</h3>
    <span class="detail-id">${escapeHtml(command.command_id)}</span>
    <div class="status-row" style="margin-top:14px">${badge(command.status)}${command.output_truncated ? badge('truncated') : ''}</div>
    <dl class="record-meta" style="margin-top:18px;color:#cbd0c7">
      <dt>Worker</dt><dd>${escapeHtml(command.worker_name ?? command.worker_id)}</dd>
      <dt>Task</dt><dd>${escapeHtml(shortId(command.task_id))}</dd>
      <dt>Created</dt><dd>${escapeHtml(dateTime(command.created_at))}</dd>
      <dt>Finished</dt><dd>${escapeHtml(dateTime(command.finished_at))}</dd>
    </dl>
    <pre id="command-output"></pre>
    ${command.result ? `<pre class="result-json">${escapeHtml(JSON.stringify(command.result, null, 2))}</pre>` : ''}
    ${command.error ? `<pre class="result-json">${escapeHtml(JSON.stringify(command.error, null, 2))}</pre>` : ''}`;
  $('#command-output').textContent = command.output_text || '暂无输出';
}

function renderEvents() {
  $('#events-list').innerHTML = state.events.length ? state.events.map((event) => `
    <div class="event-row">
      <time title="${escapeHtml(dateTime(event.created_at))}">${escapeHtml(time(event.created_at))}</time>
      <strong>${escapeHtml(event.event_type)}</strong>
      <span>${escapeHtml(event.actor_type)}:${escapeHtml(shortId(event.actor_id))} · ${escapeHtml(shortId(event.worker_id ?? event.connector_id))}</span>
    </div>`).join('') : empty('还没有事件。');
}

function renderConnectors() {
  $('#connectors-list').innerHTML = state.connectors.length ? state.connectors.map((connector) => `
    <article class="record-card ${connector.online ? 'online' : 'offline'}">
      <div><p class="record-kicker">CONNECTOR</p><h3>${escapeHtml(connector.name)}</h3><code>${escapeHtml(connector.connector_id)}</code></div>
      <div class="status-row">${badge(connector.online ? 'online' : 'offline')}</div>
      <dl class="record-meta">
        <dt>主机</dt><dd>${escapeHtml(connector.hostname ?? '—')}</dd>
        <dt>连接时间</dt><dd>${escapeHtml(dateTime(connector.connected_at))}</dd>
        <dt>最后活跃</dt><dd>${escapeHtml(dateTime(connector.last_seen_at))}</dd>
      </dl>
    </article>`).join('') : empty('还没有 Connector。');
}

function renderCoordinator() {
  const coordinator = state.coordinator ?? { enabled: false, worker: null, active_orchestrations: 0 };
  $('#coordinator-status').innerHTML = `
    <article class="coordinator-console">
      <div>
        <p class="record-kicker">COORDINATOR</p>
        <h3>${escapeHtml(coordinator.worker?.name ?? '尚未启用中央大脑')}</h3>
        <p>${coordinator.worker
          ? `${escapeHtml(coordinator.worker.runtime)} · ${escapeHtml(coordinator.worker.presence)} · 每个计划最多 ${escapeHtml(coordinator.max_steps)} 步`
          : '由管理员指定一个 managed Worker 后，才能开始全局编排。'}</p>
      </div>
      <div class="status-row">
        ${badge(coordinator.enabled ? 'enabled' : 'disabled')}
        ${badge(`${coordinator.active_orchestrations} active`)}
      </div>
    </article>`;
  $('#orchestrations-list').innerHTML = state.orchestrations.length ? state.orchestrations.map((orchestration) => `
    <article class="record-card orchestration-card">
      <div class="orchestration-head">
        <div>
          <p class="record-kicker">${escapeHtml(orchestration.orchestration_id)}</p>
          <h3>${escapeHtml(orchestration.parent_task?.title ?? '未命名编排')}</h3>
          <p class="orchestration-summary">${escapeHtml(orchestration.summary || '等待中央大脑生成计划。')}</p>
        </div>
        <div class="status-row">${badge(orchestration.status)}</div>
      </div>
      <dl class="record-meta">
        <dt>协调者</dt><dd>${escapeHtml(orchestration.coordinator_worker?.name ?? '—')}</dd>
        <dt>父任务</dt><dd><code>${escapeHtml(orchestration.parent_task_id)}</code></dd>
        <dt>更新时间</dt><dd>${escapeHtml(dateTime(orchestration.updated_at))}</dd>
      </dl>
      ${orchestration.error ? `<p class="orchestration-error">${escapeHtml(orchestration.error.message)}</p>` : ''}
      <ol class="orchestration-steps">
        ${orchestration.steps.map((step) => `
          <li>
            <div class="step-heading">
              <strong>${escapeHtml(step.key)} · ${escapeHtml(step.title)}</strong>
              ${badge(step.status)}
            </div>
            <p>${escapeHtml(step.goal)}</p>
            <dl class="record-meta">
              <dt>负责人</dt><dd>${escapeHtml(step.worker_name ?? step.worker_id)}</dd>
              <dt>依赖</dt><dd>${escapeHtml(step.depends_on.length ? step.depends_on.join(', ') : '无')}</dd>
              <dt>Task</dt><dd><code>${escapeHtml(step.task_id ?? '待生成')}</code></dd>
              <dt>Command</dt><dd><code>${escapeHtml(step.command_id ?? '待派发')}</code></dd>
            </dl>
            ${step.review?.reason ? `<p class="step-review">评审：${escapeHtml(step.review.reason)}</p>` : ''}
            ${step.error?.message ? `<p class="orchestration-error">${escapeHtml(step.error.message)}</p>` : ''}
            ${step.result?.text ? `<details class="step-evidence"><summary>执行证据</summary><p>${escapeHtml(step.result.text)}</p></details>` : ''}
          </li>`).join('')}
      </ol>
    </article>`).join('') : empty('还没有编排任务。通过 --orchestrate 把总目标交给中央大脑。');
}

function render() {
  for (const resource of ['workers', 'tasks', 'orchestrations', 'commands', 'events', 'connectors']) {
    $(`[data-count="${resource}"]`).textContent = state[resource].length;
  }
  renderSelects();
  renderWorkers();
  renderTasks();
  renderCoordinator();
  renderCommands();
  renderEvents();
  renderConnectors();
  renderConnection();
}

async function refresh() {
  const [workers, tasks, commands, events, connectors, coordinator, orchestrations] = await Promise.all([
    api('/api/v1/workers'),
    api('/api/v1/tasks'),
    api('/api/v1/commands'),
    api('/api/v1/events'),
    api('/api/v1/connectors'),
    api('/api/v1/coordinator'),
    api('/api/v1/orchestrations'),
  ]);
  state.workers = workers.workers;
  state.tasks = tasks.tasks;
  state.commands = commands.commands;
  state.events = events.events;
  state.connectors = connectors.connectors;
  state.coordinator = coordinator.coordinator;
  state.orchestrations = orchestrations.orchestrations;
  if (!state.selectedCommand && state.commands.length) state.selectedCommand = state.commands[0].command_id;
  render();
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refresh().catch((error) => toast(error.message, true)), 120);
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
    if (message.type === 'command.updated') {
      const command = message.payload.command;
      const index = state.commands.findIndex((item) => item.command_id === command.command_id);
      if (index === -1) state.commands.unshift(command);
      else state.commands[index] = command;
      renderCommands();
      return;
    }
    if (message.type === 'command.output') {
      const command = state.commands.find((item) => item.command_id === message.payload.command_id);
      if (command) {
        command.output_text = `${command.output_text ?? ''}${message.payload.chunk}`;
        command.output_truncated = message.payload.output_truncated;
        if (command.command_id === state.selectedCommand) renderCommands();
      }
      return;
    }
    if (message.type === 'worker.updated') {
      const worker = message.payload.worker;
      const index = state.workers.findIndex((item) => item.worker_id === worker.worker_id);
      if (index !== -1) state.workers[index] = worker;
      renderWorkers();
      return;
    }
    if (message.type === 'event') scheduleRefresh();
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
$('#refresh').addEventListener('click', () => refresh().then(() => toast('数据已刷新')).catch((error) => toast(error.message, true)));

$('.dispatch-nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  state.view = button.dataset.view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
  $$('.view').forEach((view) => { view.hidden = view.id !== `view-${state.view}`; });
});

$('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/v1/tasks', {
      method: 'POST',
      body: {
        title: data.get('title'),
        goal: data.get('goal'),
        context: data.get('context'),
        acceptance: String(data.get('acceptance')).split('\n').map((item) => item.trim()).filter(Boolean),
        assignee_worker_id: data.get('assignee') || null,
      },
    });
    form.reset();
    await refresh();
    toast('任务已写入黑板');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const response = await api('/api/v1/commands', {
      method: 'POST',
      body: {
        task_id: data.get('task') || null,
        worker_id: data.get('worker') || null,
        kind: data.get('kind'),
        input: data.get('input'),
      },
    });
    state.selectedCommand = response.command.command_id;
    form.reset();
    await refresh();
    toast(response.command.status === 'waiting_manual' ? '已登记为人工待处理' : '命令已持久化并进入推送队列');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#command-task').addEventListener('change', (event) => {
  const task = state.tasks.find((item) => item.task_id === event.target.value);
  if (task?.assignee_worker_id) $('#command-worker').value = task.assignee_worker_id;
});

$('#main').addEventListener('click', (event) => {
  const row = event.target.closest('[data-command]');
  if (!row) return;
  state.selectedCommand = row.dataset.command;
  renderCommands();
});

$('#main').addEventListener('change', async (event) => {
  const status = event.target.dataset.taskStatus;
  const assignee = event.target.dataset.taskAssignee;
  if (!status && !assignee) return;
  try {
    await api(`/api/v1/tasks/${encodeURIComponent(status ?? assignee)}`, {
      method: 'PATCH',
      body: status ? { status: event.target.value } : { assignee_worker_id: event.target.value || null },
    });
    await refresh();
    toast('任务已更新');
  } catch (error) {
    toast(error.message, true);
    await refresh();
  }
});

const savedToken = sessionStorage.getItem('agent-hub-admin-token');
if (savedToken) {
  $('#admin-token').value = savedToken;
  connect(savedToken);
}
