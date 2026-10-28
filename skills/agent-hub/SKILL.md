---
name: agent-hub
description: 接入 Agent Hub、注册数字员工并创建和跟进任务。当用户要求把新 Mac 接入 Hub、登记当前 Claude/Kimi/Codex Session、新建 managed Worker、添加或执行任务时使用；未经明确要求不要安装、注册、派发或清理历史。
---

# Agent Hub

正式 Hub：`https://hub.findu.work`。一个数字员工对应一个独立 Agent Session，不代表整台机器。

## 首次接入一台新 Mac

使用本 Skill 自带的 `scripts/bootstrap.sh`。如果当前只有 SKILL.md，先下载完整包：

```bash
curl --fail --silent --show-error --location https://hub.findu.work/skill/agent-hub.zip --output agent-hub.zip
unzip agent-hub.zip
bash agent-hub/scripts/bootstrap.sh
```

在用户本机终端执行脚本，让**用户自己输入 Enrollment Token**。不要把 Token 放进聊天、命令参数、Shell 历史、Git 或日志，不要索取 Admin Token。Token 由管理员另行安全提供；没有 Token 时只完成环境检查并说明这一步，不伪造接入。

脚本会检查依赖、安装或更新仓库、首次 enrollment、安装常驻 Connector、CLI 和 Skill。重复执行是幂等的；已有冲突文件时停止，不覆盖。公网接入不需要 Tailscale/Headscale，也不要修改其配置。默认仓库在 `~/.agent-hub/agent-hub`，Connector 数据在 `~/.agent-hub/connector`。

安装结束后必须验证：

```bash
curl --fail --silent http://127.0.0.1:8788/local/v1/health
agent-hub worker list --data-dir "$HOME/.agent-hub/connector"
```

`hub_connected` 必须为 `true`。只下载 Skill、克隆仓库或启动服务不等于接入完成。Connector 不可达时报告实际情况，不擅自启动第二个 Connector。

新安装的 Skill 可能需要重新打开 Agent Session 才能发现。Kimi 使用 `/skill:agent-hub`，Claude 使用 `/agent-hub`，Codex 使用 `$agent-hub`。这不等于必须把当前窗口登记为员工。仅安装接入时不要执行 `register-current`；用户只描述职责或要求创建员工时，默认新建 managed Worker。

## 注册数字员工

先确认用户要登记**当前窗口本人**，还是新建**独立可调度员工**。只有用户明确提到“当前窗口/当前 Session 本人”才走启动器流程。所有命令使用：

```bash
--data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

CLI 自行读取 Local Token，不要直接读取或打印凭证文件。

### 当前窗口

Kimi/Claude 必须使用启动器重新打开，已运行的普通窗口不能事后补发可信身份。已有 Codex 窗口可使用自身注入的原生身份；当前桌面聊天需要推送时，在下面的 register-current 命令增加 `--push`，使用原生 codex queue，不需要新 App 或重启。需要中控主动推送到当前 Kimi/Claude 窗口时，在启动命令中增加 `--push`；Kimi 此时打开 ACP 交互窗口，不是原生 TUI。

```bash
agent-hub session start --runtime kimi --cwd /path/to/project
# Claude 同样通过启动器；已有 Codex 窗口可直接登记
agent-hub session start --runtime claude --cwd /path/to/project
```

在当前窗口执行：

```bash
agent-hub worker register-current \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --name "<体现职责的名称>" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"<用户定义的职责与真实限制>"}'
```

当前窗口默认是 external。Codex 桌面可通过 `register-current --push` 接通后台队列通道；只有实际连接成功才报告可推送，入队成功不等于任务完成。Claude/Kimi 使用启动器注入的可信身份，Codex 使用自身注入的 `CODEX_SESSION_ID`。缺少可信身份时停止并说明，**不能随机生成、选择最近会话、手工伪造身份或新建 managed Worker 冒充当前窗口**。Claude/Kimi 交互推送的 `--push` 用法和身份细节见 [references/workers.md](references/workers.md)。

### 独立可调度员工

用户只说“接入”“注册本机 Agent”“创建 Worker”而未明确指当前窗口时，创建 managed Worker，不要求 Session ID：

```bash
agent-hub worker register \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --runtime kimi --mode managed \
  --name "<有意义的名称>" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"<真实能力、工作范围与限制>"}'
```

将 Runtime 换成实际的 `kimi`、`claude` 或 `codex`，不要传 `--session-id`。如实填写名称、工作目录、能力和一句简介，供中控匹配。Codex 默认只读沙箱；只有用户明确允许才设为 `workspace-write`。Kimi 模型必须使用已确认可用的配置。

## 添加任务

用户通过 Skill 要求添加任务时，由 Agent 整理标题、目标、已核实上下文和可检查的验收标准，不要求用户填写网页表单。

```bash
agent-hub worker list --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
agent-hub task create --local \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --title "<标题>" --goal "<结果>" --context "<已核实上下文>" \
  --acceptance "<第一条验收>\n<第二条验收>" --worker-id WORKER_ID
```

按真实能力、状态和简介选择**本机** Worker。只说“添加/创建”时到此为止，不自动执行。明确要求“添加并执行”才继续：

```bash
agent-hub send --local --wait \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --task-id TASK_ID --worker-id WORKER_ID --prompt "<明确指令>"
```

等待由完成事件唤醒，不循环查询。进程成功不等于验收通过；核对真实结果后才可执行 `agent-hub task update --local TASK_ID --status done --data-dir ...`。失败、人工等待、超时都不能报告为完成，也不要重复派发。详见 [references/tasks.md](references/tasks.md)。

明确要求中央大脑统筹时，使用 `agent-hub task create --local --orchestrate`，不传 `--worker-id`。这会立即规划并执行，不是仅记录；中央大脑负责选人和终审，不要手工关闭父任务。

## 边界

- 不代替管理员指定中央大脑、清理历史、注销其他员工或读取 Admin Token。
- 只有用户明确要求撤下自己时才使用 `agent-hub worker unregister-current`；活动工作会被保护。
- 只有 `--push` 窗口在线的 external 或 managed Worker 可主动推送，以 `worker list` 的真实 `push_capable` 为准。
- Skill 是按需说明，不是常驻进程，不循环收取任务，也不自动注册每个新 Session。
