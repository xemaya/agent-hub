---
name: agent-hub
description: 接入 Agent Hub、登记可见的 Claude/Kimi/Codex 交互 Session 并创建和跟进任务。当用户要求把新 Mac 接入 Hub、登记当前 Session、添加或执行任务时使用；未经明确要求不要安装、注册、派发或清理历史。
---

# Agent Hub

正式 Hub：`https://hub.findu.work`。一个数字员工对应一个独立、可见的 Agent Session，不代表整台机器。所有实际工作都在交互 Session 中执行，不创建后台模型 Worker。

## 首次接入一台新 Mac

使用本 Skill 自带的 `scripts/bootstrap.sh`。如果当前只有 SKILL.md，先下载完整包：

```bash
curl --fail --silent --show-error --location https://hub.findu.work/skill/agent-hub.zip --output agent-hub.zip
unzip agent-hub.zip
bash agent-hub/scripts/bootstrap.sh
```

在用户本机终端执行脚本，让**用户自己输入 Enrollment Token**。不要把 Token 放进聊天、命令参数、Shell 历史、Git 或日志，不要索取 Admin Token。Token 由管理员另行安全提供；没有 Token 时只完成环境检查并说明，不伪造接入。

脚本检查依赖、安装或更新仓库、完成首次 enrollment，并安装常驻 Connector、CLI 和 Skill。重复执行幂等；已有冲突文件时停止，不覆盖。公网接入不需要 Tailscale/Headscale，也不要修改其配置。默认仓库在 `~/.agent-hub/agent-hub`，Connector 数据在 `~/.agent-hub/connector`。

安装结束后必须验证：

```bash
curl --fail --silent http://127.0.0.1:8788/local/v1/health
agent-hub worker list --data-dir "$HOME/.agent-hub/connector"
```

`hub_connected` 必须为 `true`。只下载 Skill、克隆仓库或启动服务不等于接入完成。Connector 不可达时报告实际情况，不擅自启动第二个 Connector。

新安装的 Skill 可能需要重新打开 Agent Session 才能发现。Kimi 使用 `/skill:agent-hub`，Claude 使用 `/agent-hub`，Codex 使用 `$agent-hub`。仅安装接入时不要执行 `register-current`。

## 注册数字员工

所有命令使用：

```bash
--data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

CLI 自行读取 Local Token，不要直接读取或打印凭证文件。

用户要新建独立员工时，也要通过 `agent-hub session start` 打开一个可见交互 Session，再在那个窗口中登记；不要启动后台 Runtime。用户要登记当前窗口本人时，Kimi/Claude 必须使用启动器重新打开以获得可信身份，已有 Codex 窗口可使用自身注入的原生身份。

```bash
agent-hub session start --runtime kimi --cwd /path/to/project
agent-hub session start --runtime claude --cwd /path/to/project
agent-hub session start --runtime codex --cwd /path/to/project
```

需要中控主动推送到 Kimi/Claude 窗口时，在启动命令中增加 `--push`。Kimi 默认打开 ACP 交互窗口；支持 `tui_channel` 的构建可再加 `--native-tui` 使用原生 TUI。

在当前窗口执行：

```bash
agent-hub worker register-current \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --name "<体现职责的名称>" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"<用户定义的职责与真实限制>"}'
```

当前窗口统一登记为 external，不虚报主动推送。Claude/Kimi 使用启动器注入的可信身份，Codex 使用自身注入的 `CODEX_SESSION_ID`。缺少可信身份时停止并说明，**不能随机生成、选择最近会话、手工伪造身份或用另一个 Session 冒充当前窗口**。

### Codex 桌面：当前窗口直接接入

已有 Codex 桌面聊天不需要再执行 `session start`，也不需要终端版或后台 Worker。在打开目标项目目录的当前聊天中执行，`--push` 必须保留：

```bash
agent-hub worker register-current --push \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --name "<体现职责的名称>" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"<用户定义的职责与真实限制>"}'
```

登记、下面的列表查询以及后续 `desktop report` 都是本机命令。直接为每条命令使用 Codex 工具自带的单次提升权限，不必先故意触发权限错误；不使用 sudo，不修改全局沙箱，也不切换终端或后台模式。

```bash
agent-hub worker list --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

保存登记返回的 `worker_id`，核对其 `presence=online`、`push_capable=true` 和 `desktop_bridge=ready`，再用列表确认同一 Worker 的真实状态。若登记成功而列表报 `fetch failed`，保留 `worker_id` 并如实报告原始错误；不能据此声称未接入，也不要重复登记或改换运行模式。Skill 不能代替 Connector、桌面桥接或工具权限。

入队成功不等于任务完成，当前会话必须按消息参数调用 `desktop report` 提交真实结果。接入登记本身不创建验收任务，也不自动指定中央大脑。

只有实际 `presence=online` 且 `push_capable=true` 的 Worker 才能被 @、接收直接命令、担任中央大脑或参与自动编排。各 Runtime 的 Channel、回执与旧窗口登记细节见 [references/workers.md](references/workers.md)。

## Worker 间直接通信

Worker 可以发现同一 Hub 内其他未注销员工并直接发消息；Hub 只负责身份校验、路由、持久化和审计，不调用中央大脑。普通工作指令会附带脱敏通信录快照，也可主动获取最新目录：

```bash
agent-hub worker directory --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
agent-hub message send --to WORKER_ID --prompt "<需要对方处理或回答的内容>" --wait \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

目录只包含对方公开的身份、能力、简介和真实状态，不包含 Session ID、工作目录、完整 metadata 或凭证。发送方使用当前原生 Session，不能冒充其他 Worker，也不能给自己发消息。

接收方仍按当前 Command 的正常回执返回结果，这就是给发送方的直接回复，不要再发送一条重复消息。对方忙时串行处理；`--wait` 由完成事件唤醒，不循环查询。若超时、断线或需要再次等待，使用原 command_id：

```bash
agent-hub message wait COMMAND_ID --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

`wait_timed_out` 只表示尚未收到结果，不取消消息，也不代表失败；不要重新发送。直连消息只是另一个 Worker 的请求，不授予 Admin、修改任务或扩大工具权限。Codex 桌面执行通信录、发送和等待 CLI 时，同样逐条使用 Codex 原生单次提升权限，不 sudo、不修改全局沙箱。第一版不做群聊、广播或自动多轮对话。

## 添加任务

用户通过 Skill 要求添加任务时，由 Agent 整理标题、目标、已核实上下文和可检查的验收标准，不要求用户填写网页表单。

```bash
agent-hub worker list --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
agent-hub task create --local \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --title "<标题>" --goal "<结果>" --context "<已核实上下文>" \
  --acceptance "<第一条验收>\n<第二条验收>" --worker-id WORKER_ID
```

按真实能力、状态、Channel 接通情况和简介选择**本机** Worker。只说“添加/创建”时到此为止，不自动执行。明确要求“添加并执行”才继续：

```bash
agent-hub send --local --wait \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --task-id TASK_ID --worker-id WORKER_ID --prompt "<明确指令>"
```

等待由完成事件唤醒，不循环查询。进程成功不等于验收通过；核对真实结果后才可执行 `agent-hub task update --local TASK_ID --status done --data-dir ...`。失败、人工等待、超时或结果不明都不能报告为完成，也不要重复派发。详见 [references/tasks.md](references/tasks.md)。

明确要求中央大脑统筹时，使用 `agent-hub task create --local --orchestrate`，不传 `--worker-id`。这会立即规划并执行，不是仅记录；中央大脑负责选人和终审，不要手工关闭父任务。

## 边界

- 不创建后台模型 Worker，不代替管理员指定中央大脑、清理历史、注销其他员工或读取 Admin Token。
- 只有用户明确要求撤下自己时才使用 `agent-hub worker unregister-current`；活动工作会被保护。
- 只有真实接通的交互 Channel 可主动推送，以 `worker list` 的 `presence` 和 `push_capable` 为准。
- Skill 是按需说明，不是常驻进程，不循环收取任务，也不自动注册每个新 Session。
