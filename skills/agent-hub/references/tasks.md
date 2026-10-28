# 任务与中央编排

所有命令使用本机 Connector 数据目录 `--data-dir "${AGENT_HUB_CONNECTOR_DATA_DIR:-$HOME/.agent-hub/connector}"`。Local Token 只能处理本机 Worker 和分配给本机的任务，不能读取管理员对话或跨 Connector 调度。

## 普通任务

先执行 `agent-hub worker list --data-dir ...`，按能力、简介、Runtime、在线和忙碌状态选择本机 Worker。用户未指定时没有合适员工就如实说明，不编造 ID。

从用户原话整理：

- `title`：可区分的短标题。
- `goal`：需要交付的结果，不扩大范围。
- `context`：用户提供或已核实的事实、路径和约束。
- `acceptance`：每条可独立判断通过与否，用 `\n` 分隔。

```bash
agent-hub task create --local --data-dir "$HOME/.agent-hub/connector" \
  --title "<标题>" --goal "<结果>" --context "<上下文>" \
  --acceptance "<验收一>\n<验收二>" --worker-id WORKER_ID
```

用户只说“添加”“创建”就停止在记录任务，返回编号、ID 和负责人。明确要求“添加并执行”才派发：

```bash
agent-hub send --local --wait --data-dir "$HOME/.agent-hub/connector" \
  --task-id TASK_ID --worker-id WORKER_ID --prompt "<结合目标、上下文和验收的指令>"
```

`--wait` 使用一次性完成事件，最长默认等待 10 分钟，不循环查询：

- `succeeded`：读取真实 result，逐条核对验收。
- `failed`：报告错误，不标为完成。
- `waiting_manual`：需要当前交互窗口人工处理，不声称已主动执行。
- `wait_timed_out`：仍在执行，报告状态，不重复派发，不当作成功或失败。

只有验收确实通过才关闭：

```bash
agent-hub task update --local TASK_ID --status done --data-dir "$HOME/.agent-hub/connector"
```

未满足则保持真实状态并说明缺口。最后简要返回 `task_number`、`task_id`、`command_id`、负责人、命令状态、实际结果和验收结论。中控会自动更新，不要求用户补填网页。

## 中央大脑

用户明确要求统筹多个 Worker 或机器时，不要自行拆任务，改用：

```bash
agent-hub task create --local --orchestrate --data-dir "$HOME/.agent-hub/connector" \
  --title "<总目标>" --goal "<整体结果>" --context "<已核实背景>" \
  --acceptance "<整体第一条验收>\n<整体第二条验收>"
```

这会立即规划并执行。仅记录或仅规划时不要用这个命令；管理员可在网页对话要求“先只规划”。不要给父任务发送普通命令，不手工关闭父任务，不重复创建相同任务冒充恢复。中央大脑选人、依赖拆解和终审由 Hub 校验；未通过会保留原因，修正轮次有限。

按需执行一次 `agent-hub orchestration list --local --data-dir ...` 查询进展，不循环查询。`blocked`、`review` 都不是完成。若返回 `coordinator_disabled`，说明管理员尚未启用中央大脑，不能改用普通派发冒充编排。

作为 Worker 收到编排步骤时，输入已携带依赖与 `@任务` 引用的真实结果。若标记 `result_truncated` 或 `result_incomplete`，不能声称完整阅读；证据不足必须报告。命令成功只代表进程成功，不代表业务验收通过。
