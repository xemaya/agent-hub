# 数字员工身份与推送

## 当前交互 Session

先在一个目标项目目录打开：

```bash
agent-hub session start --runtime kimi --cwd /path/to/project
agent-hub session start --runtime claude --cwd /path/to/project
agent-hub session start --runtime codex --cwd /path/to/project
```

在打开的窗口中说明职责，再用 `worker register-current`。启动器不提前注册或创建任务。Kimi 使用原生 Session ID，Claude 使用启动器 UUID，Codex 使用原生工具环境中的 `CODEX_SESSION_ID`；已有 Codex 窗口也可直接登记。Runtime 原生参数可放在启动命令 `--` 后。

登记当前窗口默认 `--mode external`，不能声称它已经被中控接管。若缺少启动器变量或 Codex 原生变量，不能使用随机 ID、最近会话或 managed Worker 冒充。只有可信 Runtime 或用户明确提供的真实 ID 才能通过 `worker register --mode external --session-id ...` 登记旧窗口。不要手工伪造环境变量。

Claude 可主动推送的交互窗口：

```bash
agent-hub session start --runtime claude --push --cwd /path/to/project
agent-hub session start --runtime claude --push --resume <session-id> --cwd /path/to/project
```

在窗口中按 external 注册。Channel 接通后，命令以 `<channel source="agent-hub" command_id="...">` 到达；先调用 `agent_hub_ack`，完成工作后调用 `agent_hub_report` 返回完整结果，每个 command_id 一次。终端文字不会自动回传。首次启动选择“本地开发”，权限确认仍在终端处理。关闭窗口会退回人工协作。

Kimi 使用：

```bash
agent-hub session start --runtime kimi --push --cwd /path/to/project
agent-hub session start --runtime kimi --push --resume <session-id> --cwd /path/to/project
```

这是 ACP 交互窗口，不是原生全屏 TUI。正常回答即可，桥接自动回执；用户输入与 Hub 命令串行使用同一条连接。`/exit` 退出后退回 `waiting_manual`，不接受 `--` 后的 Runtime 参数。Codex 交互推送仍需 app-server 适配，不能声称已支持。

只有用户明确要求主动执行，且交互实例已退出或 Runtime 支持共享，才可把当前窗口设为 managed。不要同时向同一 Session 发另一条 Prompt。

## 独立 managed Worker

```bash
agent-hub worker register \
  --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}" \
  --runtime codex --mode managed \
  --name "<有意义的-worker-名称>" --cwd "$PWD" \
  --capabilities "coding,review,analysis" \
  --metadata '{"description":"<真实职责、模型与权限限制>"}'
```

可替换 Runtime 为 `claude` 或 `kimi`。不要传 `--session-id`。Kimi 在注册时创建独立原生 Session；Claude/Codex 在第一条命令到达时创建或恢复 Session。managed Worker 不是发起注册的当前窗口。

Codex 未指定模型时沿用本机配置，默认 `codex_sandbox:"read-only"`；只有明确允许工作区写入才设置 `"workspace-write"`。Kimi 可在 metadata 设置已验证的 `kimi_model`，例如本机已确认的配置；不确定时不要虚构。

注册前核实：名称体现角色，`cwd` 是真实工作目录，能力和简介反映实际范围。同一 `runtime + runtime_session_id` 重复注册幂等，不要把同一身份分给多个员工。

```bash
agent-hub worker list --data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"
```

保存返回的 `worker_id`，不展示凭证。以实际 `presence`、`push_capable` 和 `work_state` 判断可调度性，不仅看 Connector 在线或 external/managed 标签。

external 状态真实变化时：

```bash
agent-hub worker status WORKER_ID working --task-id TASK_ID --data-dir "$HOME/.agent-hub/connector"
agent-hub worker status WORKER_ID idle --data-dir "$HOME/.agent-hub/connector"
```

也可使用 `waiting` 或 `blocked`，不能虚报。managed 的状态主要由 Connector 回报。

只有用户明确要求撤下自己时才执行：

```bash
agent-hub worker unregister-current --data-dir "$HOME/.agent-hub/connector"
```

软注销保留任务、命令和原生历史，活动工作或当前协调者身份会拒绝；显式重新注册同一身份可恢复。普通 Agent 不得读取 Admin Token 或注销其他员工。
