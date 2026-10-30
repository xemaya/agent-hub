# Agent Hub

轻量级的 Session 级 Agent 协作中控。每台 Mac 运行一个 Connector，每个独立的 Claude Code、Kimi Code 或 Codex 交互 Session 对应一个数字员工 Worker。

**所有实际工作都在用户可见的交互 Session 中执行。** Connector 和投递桥接只负责连接、队列与回执，不在后台启动模型任务。提供任务、中央编排、命令回执、事件记录、断线重放和 Web 中控页面。

详细设计与验证记录见 [`docs/design.md`](docs/design.md)。

## 组成

- **Hub**：保存 Workers、Tasks、Commands、Events，提供 Admin REST 和 Dashboard。
- **Connector**：每台 Mac 一个，主动出站连接 Hub，通过本地 API 接收注册和交互 Channel。
- **Worker**：一个真实交互 Session。只有 Channel 接通且在线时才可推送；未接通时命令为 `waiting_manual`。
- **Agent Skill**：让 Agent 知道怎样登记当前 Session、自描述、接收任务和回报状态。

## 前置条件

- Worker Mac：macOS、Node.js **22.5+**、pnpm。
- Hub：已在 Amazon Linux 2023 上验证；开发时也可在 macOS 运行。
- 相应的 Claude、Kimi 或 Codex 客户端已安装并完成自己的模型鉴权。

本工具不会替代 Runtime 登录。公网接入不要求 Tailscale/Headscale，也不会自动修改网络配置。

## 接入一台 Mac

正式 Hub 为 `https://hub.findu.work`。其他部署以管理员提供的 HTTPS 地址为准。

### 推荐：通过公网 Skill

```bash
curl -fsSL https://hub.findu.work/skill/agent-hub.zip -o agent-hub.zip
unzip agent-hub.zip
bash agent-hub/scripts/bootstrap.sh
```

按提示由用户在本机终端输入管理员另行安全提供的 Enrollment Token。脚本检查依赖，默认把仓库安装到 `~/.agent-hub/agent-hub`，完成 Connector enrollment 后安装常驻服务、全局 CLI 和 Skill。重复运行幂等，已有修改或冲突会停止，不自动注册 Worker。

安装后验证：

```bash
curl --fail --silent http://127.0.0.1:8788/local/v1/health
agent-hub worker list --data-dir "$HOME/.agent-hub/connector"
```

`hub_connected` 必须为 `true`。只启动 Connector 不等于登记了员工。

### 手动安装备选

```bash
git clone https://github.com/xemaya/agent-hub.git
cd agent-hub
pnpm install --frozen-lockfile
curl --fail --silent --show-error --max-time 10 https://hub.findu.work/healthz
```

Enrollment Token 由管理员安全提供，不要提交到 Git、发到聊天或写入日志。首次启动 Connector：

```bash
read -s -p "Enrollment Token: " AGENT_HUB_ENROLLMENT_TOKEN; echo
export AGENT_HUB_ENROLLMENT_TOKEN
node bin/agent-hub.js connector \
  --hub-url "https://hub.findu.work" \
  --name "<这台Mac的名称>" \
  --data-dir "$HOME/.agent-hub/connector"
```

首次注册后，Connector Token 保存在本机权限为 `0600` 的状态文件中。本地 API 默认只监听 `127.0.0.1:8788`。需要常驻时，停掉前台 Connector 后执行：

```bash
node bin/agent-hub.js service install \
  --hub-url "https://hub.findu.work" \
  --name "<这台Mac的名称>" \
  --data-dir "$HOME/.agent-hub/connector"
agent-hub service status
node scripts/install-local.js --connector-data-dir "$HOME/.agent-hub/connector"
```

服务日志写入 `~/.agent-hub/connector.log`，plist 不包含 Token。安装器链接全局 CLI 和 Skill，不覆盖冲突文件。确保 `~/.local/bin` 在 `PATH` 中。

Connector 自动维持连接并交换版本。自更新只做 fast-forward；脏、领先或分叉的检出不会改动。作为服务运行时，会等交互命令结束再重启。开发检出可用 `--no-auto-update` 或 `AGENT_HUB_AUTO_UPDATE=0` 关闭自更新。

## 登记可见交互 Session

启动器不提前注册或创建任务。登记时使用真实原生身份，不能随机生成 ID、选择最近会话或伪造环境变量。重复注册同一 `runtime + runtime_session_id` 会复用 Worker。

通用启动方式：

```bash
agent-hub session start --runtime claude --cwd /path/to/project
agent-hub session start --runtime kimi --cwd /path/to/project
agent-hub session start --runtime codex --cwd /path/to/project
```

在打开的窗口里说明职责，然后调用 Skill：

```text
/skill:agent-hub 把当前 Session 注册到 Agent Hub，职责是……
```

Claude 使用 `/agent-hub`，Codex 使用 `$agent-hub`。实际命令为：

```bash
agent-hub worker register-current \
  --data-dir "$HOME/.agent-hub/connector" \
  --name "<体现职责的名称>" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"<真实职责与权限限制>"}'
```

只登记不代表可推送。需要中控主动把命令送进窗口时，使用下面的 Runtime 对应通道。

### Claude Code Channel

```bash
agent-hub session start --runtime claude --push --cwd /path/to/project
agent-hub session start --runtime claude --push --resume <session-id> --cwd /path/to/project
```

首次启动选择 **I am using this for local development**。在窗口中执行 `register-current` 后，Channel 接通，员工显示「交互会话 · 已接通」。命令在终端显示为 `← agent-hub: …`，Claude 使用 `agent_hub_ack` 和 `agent_hub_report` 回执。

工具权限确认仍在终端中处理。执行中关闭窗口会记录 `failed` 且 `outcome_unknown=true`，不会自动重跑。该功能依赖 Claude Code 的研究预览 Channels 能力。

### Kimi ACP 或原生 TUI

ACP 交互窗口：

```bash
agent-hub session start --runtime kimi --push --cwd /path/to/project
agent-hub session start --runtime kimi --push --resume <session-id> --cwd /path/to/project
```

用户输入与 Hub 命令共用一条 ACP 连接和同一个原生 Session，权限询问在窗口中处理，桥接自动回执。`/exit` 退出后退回 `waiting_manual`。ACP 路径不接受 `--` 后的 Runtime 参数。

支持实验性 `tui_channel` 的 Kimi 构建可打开原生 TUI：

```bash
agent-hub session start --runtime kimi --push --native-tui --cwd /path/to/project
agent-hub session start --runtime kimi --push --native-tui --resume <session-id> --cwd /path/to/project
```

原生模式通过本机 Unix Socket 进入原生发送队列和权限面板，不启动 ACP 或第二个 Runtime。需要时用 `AGENT_HUB_KIMI_EXECUTABLE` 指定支持该能力的构建，不替换用户已有二进制。

### Codex 桌面原生队列

在当前 Codex 桌面聊天内部执行：

```bash
agent-hub worker register-current --push \
  --data-dir "$HOME/.agent-hub/connector" \
  --name "Codex 桌面开发者" --cwd "$PWD" --capabilities coding,review,analysis
```

也可使用 `agent-hub desktop attach --push`。桥接调用 `codex queue --thread <真实原生 ID> --message ...`，不启动新 App、不重启桌面，也不在其他 Runtime 中恢复当前线程。

入队只表示接受投递。收到指令的当前会话必须按消息参数提交回执：

```bash
agent-hub desktop report --command-id COMMAND_ID --status succeeded \
  --data-dir "$HOME/.agent-hub/connector" < complete-result.txt
```

完整结果走 stdin，本机令牌由 CLI 读取。登记、列表查询和回执分别使用 Codex 工具自带的单次提升权限执行，不必先触发 `spawn EPERM` 或 `fetch failed`；不使用 sudo，不修改全局沙箱。登记后保存返回的 `worker_id` 并核对在线、推送和桥接状态；后续列表失败不等于登记失败，不要重复登记或改换运行模式。重复、超时或断线结果不明时不重投。详见 [原生队列接入与验收](docs/codex-desktop-queue.md)。

### 登记已有旧窗口

Claude/Kimi 普通旧窗口需要真实原生 Session ID；Codex 使用自身注入工具进程的 `CODEX_SESSION_ID`。只有已核实的 ID 才能显式登记：

```bash
agent-hub worker register \
  --data-dir "$HOME/.agent-hub/connector" \
  --runtime kimi --session-id "<已核实的真实ID>" \
  --name "<职责名称>" --cwd "$PWD"
```

登记后仍需对应的交互 Channel 接通，否则只提供人工协作。

### 查看状态与撤下

```bash
agent-hub worker list --data-dir "$HOME/.agent-hub/connector"
agent-hub worker unregister-current --data-dir "$HOME/.agent-hub/connector"
```

以 `presence`、`push_capable` 和 `work_state` 判断真实可用性。软注销保留 Task、Command、Event 和原生 Session 历史；活动工作或当前协调者身份会拒绝注销。显式重新注册同一身份可恢复 Worker ID。普通 Agent 只能撤下自己，不能读取 Admin Token 或注销其他员工。

## Worker 通信录与直接通信

同一 Hub 内未注销 Worker 可以发现彼此并直接请求/回复，消息经过 Hub 的身份校验、持久化和路由，**不调用中央大脑**，也不创建后台 Runtime。

```bash
agent-hub worker directory --data-dir "$HOME/.agent-hub/connector"
agent-hub message send --to WORKER_ID --prompt "请提供刚才的复现结果" --wait \
  --data-dir "$HOME/.agent-hub/connector"
agent-hub message wait COMMAND_ID --data-dir "$HOME/.agent-hub/connector"
```

`worker directory` 和普通工作指令携带的目录快照只包含公开身份、能力、简介及状态，不暴露 Session ID、cwd、完整 metadata 或凭证。Hub 根据当前原生 Session 和 Connector 确定真实发送方，目标不能是本人；普通 Command API 不能伪造 `worker_message`。

接收方完成当前 Command 的正常回执就是直接回复，每个 Worker 仍串行处理。等待由完成事件唤醒；超时返回 `wait_timed_out` 和真实 command_id，不取消执行。断线或超时后按原 command_id 再等待，不重新发送。直连请求不授予 Admin、任务修改或额外工具权限。第一版不做群聊、广播或自动多轮对话。

## 任务与中央大脑

只有**在线、未注销且交互 Channel 已接通**的 Worker 才能被 @、接收直接命令、担任中央大脑或参与自动编排。未接通员工的新命令保持 `waiting_manual`，不会转入后台执行。

### 添加任务

直接对装好 Skill 的 Agent 说“添加任务”或“添加并执行”。Agent 整理标题、目标、已核实上下文和可检查的验收标准；只说添加时不自动执行。

```bash
agent-hub task create --local \
  --data-dir "$HOME/.agent-hub/connector" \
  --title "任务标题" --goal "目标" --context "已核实的上下文" \
  --acceptance "第一条验收\n第二条验收" --worker-id WORKER_ID

agent-hub send --local --wait \
  --data-dir "$HOME/.agent-hub/connector" \
  --task-id TASK_ID --worker-id WORKER_ID --prompt "明确指令"
```

等待由完成事件唤醒，不循环查询。即使命令成功，也必须核对验收后才能把任务更新为 `done`。失败、人工等待、超时或结果不明都不能报告完成。

### 命令取消与无活动超时

管理员可以终止任何仍处于 queued、accepted、running 或 waiting_manual 的 Command：

```bash
agent-hub command cancel COMMAND_ID \
  --reason "桌面执行已人工停止" \
  --hub-url "https://hub.findu.work" --hub-data-dir .runtime/hub
```

取消将 Command 持久化为 `failed`、`outcome_unknown=true`，保留审计记录，独立任务或编排按规则阻塞，不自动重试。接收方 Connector 丢弃未开始的命令及等待中的回执，晚到 report 不再被接受；已结束命令返回 409。**取消不等于证明模型进程已被杀死**，它终止的是 Hub 追踪和结果接收，桌面进程仍由用户或对应 Runtime 控制。

运行中的 Command 以 `last_activity_at` 做无活动看门狗，ACK、开始执行和输出会刷新时间，机器心跳不冒充 Agent 进展。默认协调者命令 15 分钟、其他命令 60 分钟无活动后以 `inactivity_timeout` 和结果未知收尾；排队或等待人工接入不算正在执行超时。重启后仍按数据库时间判断。可通过 `AGENT_HUB_COORDINATOR_INACTIVITY_TIMEOUT_MS` 和 `AGENT_HUB_COMMAND_INACTIVITY_TIMEOUT_MS` 调整，设为 0 禁用对应看门狗。

### 指定中央大脑

先在一个可见交互 Session 中登记并接通目标 Worker，再由管理员在中控点击“指定/更换”，或执行：

```bash
agent-hub coordinator enable \
  --worker-id WORKER_ID --max-steps 4 \
  --hub-url "https://hub.findu.work" \
  --hub-data-dir .runtime/hub
agent-hub coordinator status --hub-url "https://hub.findu.work" --hub-data-dir .runtime/hub
```

中央大脑本身也只是已接通的交互 Worker，不需要独立后台进程。它负责规划、选择员工和审查证据；Hub 负责校验、依赖调度和状态变更，模型不能直接操作 Admin API 或数据库。

交给中央大脑：

```bash
agent-hub task create --local --orchestrate \
  --data-dir "$HOME/.agent-hub/connector" \
  --title "总目标" --goal "需要协调完成的结果" \
  --context "已核实背景" --acceptance "整体验收"
```

`--orchestrate` 会立即规划并执行；只想先出计划时使用管理员网页对话。每个计划默认最多 4 步，依赖不能成环。步骤成功后先进入评审，终审通过才完成。失败、证据不足或结果不明不会伪装成功，也不会无限重试。

### 中控页面

打开 `https://hub.findu.work/` 并输入 Admin Token。操作台显示中央对话和员工真实状态；任务看板支持编号、状态、计划、结果和依赖查看。单独 `@员工` 提问不创建任务；明确派活时会约束后续规划不能改派他人。`@任务` 只引用真实上下文。

“清空对话”只隐藏当前对话批次，不取消任务或删除执行记录。历史清理由管理员显式执行，先创建 SQLite 备份，保留 Connector、Worker、协调者与接入凭证：

```bash
agent-hub history clear --yes \
  --hub-url "https://hub.findu.work" \
  --hub-data-dir .runtime/hub
```

## 旧版本数据升级

数据库迁移到 `user_version=9` 时，旧后台 Worker 统一转为 `external` 且 `push_capable=false`，Connector 本地状态同步规范化。Worker ID、任务、命令、事件和协调者配置保留。旧身份必须重新打开可见 Session 并接通 Channel，才能再次接收推送；不会自动恢复后台执行。

## 部署中控

整个团队只运行一个 Hub，不要在每台 Worker Mac 上重复启动。

当前正式 Hub 在 AWS `findu-staging-router`（Amazon Linux 2023）运行：

- 代码与 Node 24 LTS：`/opt/agent-hub/app`、`/opt/agent-hub/node`。
- systemd：`agent-hub-hub.service`。
- 持久化：`/var/lib/agent-hub/hub`，数据库与凭证均为 `0600`。
- Hub 仅监听 `127.0.0.1:8787`；Caddy 将 `https://hub.findu.work` 反向代理到回环地址并维护 TLS。
- 服务器不需要模型账号或 Runtime 凭证，中央大脑位于某台 Mac 的可见交互 Session 中。

```caddy
hub.findu.work {
  reverse_proxy 127.0.0.1:8787
}
```

服务器管理通过 AWS SSM。修改 Caddy 前备份并验证配置；公网只开放 80/443，不直接暴露 8787。迁移或清理前确认没有活动工作，通过 `HubStore.backup()` 创建 SQLite 一致性快照，数据库与 `credentials.json` 一起迁移，保持单写者。

本机开发：

```bash
node bin/agent-hub.js hub --host 127.0.0.1 --port 8787 --data-dir .runtime/hub
```

首次启动会生成 Admin Token 和 Enrollment Token，保护好数据目录。

## 验证

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm check
```

自动化使用真实 Hub、Connector、WebSocket 与 SSE Channel 验证交互大脑、编排、回执、重连和迁移。Claude、Kimi、Codex 各原生交互通道的历史实测见 [`docs/design.md`](docs/design.md)。

## 当前边界

- 不启动后台模型执行，不接管无法核验身份的窗口，不模拟键盘输入。
- 只有真实接通的交互 Channel 才提供 push 能力；Connector 在线不等于员工可调度。
- 工具权限确认留在对应交互窗口中，不默认放开模型权限。
- 中央大脑需管理员显式启用；不包含无限重试、自由群聊或 Worker 自主跨机互派。
- 公网使用 HTTPS/WSS 和 Admin/Connector/Local Token；不得把 8787 直接暴露公网，不公开 Runtime 数据目录或凭证。
