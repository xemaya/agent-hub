// Workspaces page: one team per workspace, its seats' real state, the group
// thread, the brief, the notebook and the file area. Talks only to the Admin
// API; updates arrive over the dashboard WebSocket, with a slow poll as backup.

const TOKEN_KEY = 'agent-hub-admin-token';
const $ = (selector) => document.querySelector(selector);
const state = { token: sessionStorage.getItem(TOKEN_KEY), selected: decodeURIComponent(location.hash.slice(1)) || null, socket: null, detail: null, list: [], doors: [], timer: null, pending: null };

const STATE_TEXT = { invited: '等加入', requested: '等门房', launching: '拉起中', launched: '已拉起，等报到', joined: '已报到', failed: '失败', left: '已离开' };
const WAKE_TEXT = { delivered: '门铃已送到', resumed: '已叫醒（重启后台会话）', door: '交给门房', unreachable: '叫不醒', failed: '投递失败', sending: '投递中' };
const KIND_TEXT = { handoff: '交棒', owner: '业主', system: '系统', chat: '群聊' };
const RUNTIME_TEXT = { claude: 'Claude', codex: 'Codex', antigravity: '反重力', kimi: 'Kimi', other: '其他' };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const time = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const ago = (iso) => {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
};
const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(pathname, {
    method,
    headers: { authorization: `Bearer ${state.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) {
    logout('Admin Token 无效');
    throw new Error('Admin Token 无效');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function setConnection(text, kind) {
  const node = $('#connection');
  node.className = `connection ${kind}`;
  node.replaceChildren(el('i'), text);
}

function logout(message = '') {
  state.token = null;
  sessionStorage.removeItem(TOKEN_KEY);
  state.socket?.close();
  clearInterval(state.timer);
  $('#app').hidden = true;
  $('#auth-view').hidden = false;
  $('#auth-error').textContent = message;
}

// ---- rendering --------------------------------------------------------------------

function renderList() {
  const list = $('#ws-list');
  if (!state.list.length) {
    list.replaceChildren(el('p', { class: 'ws-empty' }, '还没有工作区。在任意一个 agent 里说「开工」，它会用 agent-hub ws start 建一个。'));
    return;
  }
  list.replaceChildren(...state.list.map((workspace) => el('button', {
    class: `ws-item${workspace.workspace_id === state.selected ? ' selected' : ''}${workspace.status !== 'active' ? ' closed' : ''}`,
    type: 'button',
    onclick: () => select(workspace.workspace_id),
  },
  el('strong', {}, workspace.title),
  el('small', {}, `${workspace.name} · ${workspace.status === 'active' ? '进行中' : '已收工'} · 队长 ${workspace.leader ?? '?'}`),
  el('small', {}, `${workspace.joined}/${workspace.members} 已报到${workspace.invited ? ` · ${workspace.invited} 等加入` : ''}${workspace.launching ? ` · ${workspace.launching} 拉起中` : ''}${workspace.failed ? ` · ${workspace.failed} 失败` : ''} · ${ago(workspace.updated_at)}`))));
}

function renderDoors() {
  const box = $('#ws-doors');
  if (!state.doors.length) {
    box.replaceChildren(el('span', { class: 'ws-muted' }, '没有机器开门房'));
    return;
  }
  box.replaceChildren(...state.doors.map((door) => el('span', { class: `ws-door${door.online ? '' : ' off'}`, title: door.kind === 'connector' ? 'Connector 用 claude --bg 起后台会话' : '门房桥' },
    `${door.machine} · ${RUNTIME_TEXT[door.runtime] ?? door.runtime}${door.online ? '' : '（离线）'}`)));
}

function memberCard(member) {
  const problems = [];
  if (member.state === 'failed' && member.state_detail) problems.push(member.state_detail);
  if (member.state === 'joined' && ['unreachable', 'failed'].includes(member.wake_status) && member.unread) problems.push(`${WAKE_TEXT[member.wake_status]}：${member.wake_detail ?? ''}`);
  const facts = [];
  if (member.state === 'joined') {
    facts.push(member.unread ? `未读 ${member.unread}` : '没有未读');
    if (member.wake_status) facts.push(WAKE_TEXT[member.wake_status] ?? member.wake_status);
    if (member.runtime === 'claude') facts.push(member.listening ? '在等信' : '没在等信');
    if (member.wake_due_at) facts.push(`攒信中，${time(member.wake_due_at)} 响`);
    if (member.last_active_at) facts.push(`上次动作 ${ago(member.last_active_at)}`);
  } else if (member.state_detail && member.state !== 'failed') {
    facts.push(member.state_detail);
  }
  return el('article', { class: `ws-card${member.role === 'leader' ? ' leader' : ''}` },
    el('div', { class: 'ws-card-top' },
      el('strong', {}, member.seat, member.role === 'leader' ? '（队长）' : ''),
      el('span', { class: `ws-chip ${member.state}` }, STATE_TEXT[member.state] ?? member.state)),
    el('div', { class: 'ws-runtime' }, `${RUNTIME_TEXT[member.runtime] ?? member.runtime}${member.model ? ` / ${member.model}` : ''}`),
    el('div', { class: 'ws-machine' }, el('i', { class: `ws-dot${member.machine_online ? ' on' : ''}` }), member.machine ?? (member.state === 'invited' ? '哪台机器都行' : '未知机器')),
    member.job ? el('div', { class: 'ws-job' }, member.job) : null,
    facts.length ? el('div', { class: 'ws-detail' }, facts.join(' · ')) : null,
    problems.length ? el('div', { class: 'ws-detail bad' }, problems.join('；')) : null);
}

function messageItem(message, seats) {
  const tags = [el('span', { class: `ws-tag ${message.kind}` }, KIND_TEXT[message.kind] ?? message.kind)];
  if (message.kind !== 'handoff' && message.recipients?.length) tags.push(el('span', { class: 'ws-tag private' }, `私信 → ${message.recipient_seats.join('、')}`));
  if (message.kind === 'handoff' && message.mentions?.length) {
    const targets = message.mentions.map((id) => seats.get(id)).filter(Boolean);
    if (targets.length) tags.push(el('span', { class: 'ws-tag' }, `→ ${targets.join('、')}`));
  }
  return el('div', { class: `ws-msg ${message.kind}` },
    el('div', { class: 'ws-msg-head' }, ...tags, el('b', {}, message.sender), el('time', { datetime: message.created_at }, time(message.created_at))),
    el('pre', { class: 'ws-body' }, message.body));
}

async function download(file) {
  const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(file.workspace_id)}/files/${encodeURIComponent(file.file_id)}`, {
    headers: { authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const link = el('a', { href: url, download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function skeleton(detail) {
  const { workspace } = detail;
  const main = $('#ws-main');
  const active = workspace.status === 'active';
  main.replaceChildren(
    el('div', { class: 'ws-head' },
      el('div', {},
        el('div', { class: 'ws-eyebrow' }, `${workspace.name} · ${active ? '进行中' : `已收工 ${time(workspace.closed_at)}`}`),
        el('h1', {}, workspace.title),
        workspace.goal ? el('p', { class: 'ws-goal' }, workspace.goal) : null,
        el('div', { class: 'ws-meta', id: 'ws-meta' })),
      active
        ? el('button', { class: 'button', type: 'button', onclick: () => closeWorkspace(workspace) }, '收工')
        : el('button', { class: 'button button-ghost', type: 'button', onclick: () => deleteWorkspace(workspace) }, '删除')),
    el('div', { class: 'ws-section-title' }, '团队'),
    el('div', { class: 'ws-team', id: 'ws-team' }),
    el('div', { class: 'ws-columns' },
      el('section', {},
        el('div', { class: 'ws-section-title' }, '群聊'),
        el('div', { class: 'ws-feed', id: 'ws-feed', role: 'log' }),
        active ? el('form', { class: 'ws-composer', id: 'ws-composer', onsubmit: (event) => { event.preventDefault(); sendOwnerMessage(workspace); } },
          el('label', { class: 'sr-only', for: 'ws-text' }, '以业主身份说话'),
          el('textarea', { id: 'ws-text', placeholder: '以业主身份说话。默认先叫醒队长；写座位名就直接找他们。Cmd/Ctrl+Enter 发送', maxlength: '20000',
            onkeydown: (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendOwnerMessage(workspace); } } }),
          el('div', { class: 'ws-composer-row' },
            el('input', { id: 'ws-to', placeholder: '给谁（座位名，逗号分隔；空 = 队长）' }),
            el('button', { class: 'button button-primary', type: 'submit', id: 'ws-send' }, '发出'))) : null),
      el('aside', { class: 'ws-side' },
        el('div', { class: 'ws-section-title' }, '简报'),
        el('div', { class: 'ws-box', id: 'ws-brief' }),
        el('div', { class: 'ws-section-title' }, '记事本'),
        el('div', { class: 'ws-box', id: 'ws-notes' }),
        el('div', { class: 'ws-section-title' }, '文件区'),
        el('div', { class: 'ws-box', id: 'ws-files' }))));
}

function renderDetail(detail) {
  const previous = state.detail;
  if (!previous || previous.workspace.workspace_id !== detail.workspace.workspace_id || previous.workspace.status !== detail.workspace.status) skeleton(detail);
  state.detail = detail;
  const { workspace, members, messages, notes, files, project } = detail;
  const meta = [`队长 ${detail.leader ?? '?'}`, `攒信 ${Math.round(workspace.gather_ms / 6000) / 10} 分钟`, `开工 ${time(workspace.created_at)}`];
  if (project) meta.push(`项目 ${project.project_key}${project.git_remote ? `（${project.git_remote}）` : ''}`, `分支 ${workspace.branch}`);
  $('#ws-meta').replaceChildren(...meta.map((item) => el('span', {}, item)));
  $('#ws-team').replaceChildren(...members.map(memberCard));

  const seats = new Map(members.map((member) => [member.member_id, member.seat]));
  const feed = $('#ws-feed');
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  feed.replaceChildren(...(messages.length ? messages.map((message) => messageItem(message, seats)) : [el('p', { class: 'ws-empty' }, '还没有消息。')]));
  if (atBottom || !previous) feed.scrollTop = feed.scrollHeight;

  $('#ws-brief').replaceChildren(workspace.brief
    ? el('div', {}, el('small', { class: 'ws-muted' }, `第 ${workspace.brief_version} 版`), el('pre', {}, workspace.brief))
    : el('span', { class: 'ws-muted' }, '队长还没写简报。'));
  $('#ws-notes').replaceChildren(...(notes.length ? notes.map((note) => el('div', { class: 'ws-note' },
    el('small', {}, `[${note.kind}] ${note.author} · ${time(note.created_at)}`), el('div', {}, note.body))) : [el('span', { class: 'ws-muted' }, '记事本是空的。')]));
  $('#ws-files').replaceChildren(...(files.length ? files.map((file) => el('div', { class: 'ws-file' },
    el('div', {}, el('div', {}, file.name), el('small', {}, `${size(file.size)} · ${file.uploader} · ${time(file.created_at)}${file.note ? ` · ${file.note}` : ''}`)),
    el('button', { class: 'button button-ghost', type: 'button', onclick: () => download(file).catch((error) => alert(error.message)) }, '下载'))) : [el('span', { class: 'ws-muted' }, '文件区是空的。')]));
}

// ---- actions -------------------------------------------------------------------------

async function sendOwnerMessage(workspace) {
  const text = $('#ws-text').value.trim();
  if (!text) return;
  const to = $('#ws-to').value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
  const button = $('#ws-send');
  button.disabled = true;
  try {
    await api(`/api/v1/workspaces/${encodeURIComponent(workspace.workspace_id)}/messages`, { method: 'POST', body: { text, to } });
    $('#ws-text').value = '';
    await refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function closeWorkspace(workspace) {
  const summary = prompt(`收工「${workspace.title}」？可以写一句总结（队员会收到通知，留着不关）：`, '');
  if (summary === null) return;
  try {
    await api(`/api/v1/workspaces/${encodeURIComponent(workspace.workspace_id)}/close`, { method: 'POST', body: { summary } });
    await refresh();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteWorkspace(workspace) {
  if (!confirm(`删除「${workspace.title}」？群聊、记事本、文件都会删掉，不能恢复。队员的会话不受影响。`)) return;
  try {
    await api(`/api/v1/workspaces/${encodeURIComponent(workspace.workspace_id)}`, { method: 'DELETE' });
    state.selected = null;
    await refresh();
  } catch (error) {
    alert(error.message);
  }
}

function select(workspaceId) {
  state.selected = workspaceId;
  history.replaceState(null, '', `#${encodeURIComponent(workspaceId)}`);
  state.detail = null;
  refresh().catch((error) => console.error(error));
}

async function refresh() {
  const [list, doors] = await Promise.all([api('/api/v1/workspaces'), api('/api/v1/workspace-doors')]);
  state.list = list.workspaces;
  state.doors = doors.doors;
  if (!state.selected || !state.list.some((workspace) => workspace.workspace_id === state.selected)) {
    state.selected = state.list.find((workspace) => workspace.status === 'active')?.workspace_id ?? state.list[0]?.workspace_id ?? null;
  }
  renderList();
  renderDoors();
  if (!state.selected) {
    state.detail = null;
    $('#ws-main').replaceChildren(el('p', { class: 'ws-empty' }, '选一个工作区。'));
    return;
  }
  renderDetail(await api(`/api/v1/workspaces/${encodeURIComponent(state.selected)}`));
}

function scheduleRefresh() {
  clearTimeout(state.pending);
  state.pending = setTimeout(() => refresh().catch((error) => console.error(error)), 250);
}

function connectSocket() {
  if (!state.token) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/dashboard`);
  state.socket = socket;
  setConnection('连接中', 'connecting');
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'dashboard.hello', payload: { token: state.token } })));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'dashboard.ready') setConnection('实时', 'online');
    if (message.type === 'workspace.updated' || message.type === 'workspace.doors' || message.type === 'worker.updated') scheduleRefresh();
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    setConnection('未连接', 'offline');
    if (state.token) setTimeout(connectSocket, 2000);
  });
}

async function start(token) {
  state.token = token;
  try {
    await refresh();
  } catch (error) {
    if (!state.token) return;
    throw error;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
  $('#auth-view').hidden = true;
  $('#app').hidden = false;
  connectSocket();
  clearInterval(state.timer);
  state.timer = setInterval(() => refresh().catch(() => {}), 15000);
}

$('#auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('#auth-error').textContent = '';
  start($('#admin-token').value.trim()).catch((error) => { $('#auth-error').textContent = error.message; });
});
$('#logout').addEventListener('click', () => logout());
window.addEventListener('hashchange', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && id !== state.selected) select(id);
});

if (state.token) start(state.token).catch(() => logout('请重新输入 Admin Token'));
else $('#auth-view').hidden = false;
