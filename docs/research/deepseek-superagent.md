# DeepSeek Super-agent 调研与对 Agent Hub 的启示

调研日期：2026-10-31（DeepSeek 发布当天）

## 1. 资料来源

| 资料 | 位置 | 可信度 |
| --- | --- | --- |
| 原型代码 `deepseek-ai/dsh-superagent-prototype`（MIT，TypeScript，1 个 commit，9 篇编号设计文档） | https://github.com/deepseek-ai/dsh-superagent-prototype | 一手，已逐篇读过 docs/000–005、007 和 prompts |
| 底座 `deepseek-ai/deepseek-harness`（`dsh`，基于 Cordis 插件运行时） | https://github.com/deepseek-ai/deepseek-harness | 一手，只看了 README 与目录结构 |
| 文章《Super-agent 设计探索：迈向更自主的智能体系统》（DeepSeek 产品团队） | 没有找到 DeepSeek 自己的官方链接；读的是 ChainCatcher 的英文转载 https://www.chaincatcher.com/en/article/2300676 ，量子位报道 https://mp.weixin.qq.com/s/CfHGwFAPzsTi6XSELQ9CoA | 转载。文中的实验数字以原文为准 |

README 明确说明：原型**不等于**内部版本，也不等于文章描述的实现；文章里有一部分只是未来方向。所以下文分开写「原型里确实有的」和「仅文章提出的」。

## 2. 它是什么

问题：今天的 agent 都是彼此独立的单个 Session。一个人同时能盯住的活跃 Session 只有 3–5 个，**瓶颈在人的注意力**，不在模型能力。

目标是四个特性：持续（跨 Session、跨平台保留上下文）、高效（并行 Worker）、主动（没人 @ 也会去发现问题、复现、提修复 PR）、常驻（24/7 在线，能自愈）。

核心原则（原型 docs/000）：**尽量少占用人的注意力，尽量多交付价值**。每条消息、通知、设置项、面板元素都要证明自己值这份注意力，否则删掉。

### 2.1 五个模块（文章）

1. **双层架构**：常驻的 Router（原型中叫 main Session / orchestrator）负责所有人机交互、全局调度和跨任务记忆，自己不干活，可以用较轻的模型、不给 shell。Worker 每个任务一个上下文隔离的 Session，拥有完整工具、用最强的模型，不直接对人说话，只向 Router 报告。
2. **事件驱动**：
   - 聊天、邮件、日历、代码评审、CI 都统一成 Trigger。
   - 两级过滤：先由程序做确定性 gate（来源、群范围、白名单），给出 explicit / inferred / ignore；再由 LLM 研判剩下的候选。
   - 同一个 PR、IM 话题或邮件串组成一个 Thread。Worker 订阅自己的 Thread 后，后续消息直达 Worker（快路径）；没有被订阅的才走 Router（慢路径）。
   - 上下文用 Inline & Spill：可能用到的内联进上下文，其余只留 ID 和摘要，模型沿 ID 按需召回（Chain of Recall）。
3. **以人为中心的交互**：全双工（异步 start/stop 工具，干活时也能接收新输入）。按渠道定规范：IM 每条回复不超过 100 字；GitHub、邮件、文档写结构化的详细内容。
4. **计算、状态、环境分离**：agent loop 跑在无状态的云容器里，会话状态存数据库；执行环境留在用户机器上，由一个不保存会话状态的轻量 edge daemon 执行命令（Bring Your Own Machine），设备断线后能继续。
5. **Watchdog**：一个独立的 Session，由定时消息驱动，形成外部控制回路。它既处理基础设施故障，也判断每个 Worker **是否在真实推进、是否偏离总目标**，抓的是进程监控发现不了的无效循环。发现问题就介入，并持续盯到恢复正常；维护者可以用自然语言问它，让它调整 prompt 和触发规则。

### 2.2 实验（文章，合成环境，初步结果）

- 每轮约 300 条消息、约 20 个工作请求，4 种配置各跑 5 次。
- Super-agent 的完成时间 p50 为 12.4 分钟、p95 为 15.7 分钟。单 Session + subagent、中性 prompt 时，5 次里模型一次都没有委派，p95 为 29.5 分钟；改成「委派优先」prompt 后 5 次委派了 4 次，仍然更慢。
- **去掉订阅直达（所有消息都过 Router）**：完成时间差不多，但 Router 决策次数增加约 30%，cache-read token 从 23.23M 涨到 31.77M（约 +37%）。
- Router 批处理：Trigger 到达速率从约 1 条/分钟升到约 40 条/分钟时，积压的事件合并成一次 LLM 调用，负载越高，单次决策的推理时间反而越低。

### 2.3 文章列出的未解问题

Router 什么时候分片、粒度和拓扑怎么定；什么时候允许 Worker 之间直接通信；跨月的长期记忆；GitHub Issue 之类非聊天界面上的人机协作；组织内的上下文边界和跨权限的 A2A；云到边缘的信任、prompt injection，以及「让 agent 用凭证但模型看不到凭证」。

## 3. 原型里真正实现了什么（代码和文档核实过）

领域模型（docs/001）：

`Source → Trigger → Thread → Eval（gate + assessment）→ Decision（accept/stop/ignore/unavailable）→ Ticket + Mandate → Assignment → Executor`，结果再经 Channel 写回原对话。

值得注意的设计取舍：

- **Mandate**：accept 时生成一份不可变授权，记录 Policy 版本、范围、强度（explicit / inferred）、命中的规则和发起人。范围要扩大就新开 Ticket。只有三种操作能改变 Mandate：accept 创建它，人发出的 stop 撤回它，复核失败吊销它。Policy 变更不取消运行中的工作，只给相关 Ticket 投递一条通知（取消会留下半截工作）。
- **Accept mode**：`off` / `observe`（默认）/ `auto`。主动类工作先在 observe 模式下只记录「本来会接单」，人审过这些记录后再切到 auto。
- **Subscription 只传上下文，不授予权限**：订阅进来的消息（包括 bot 和 CI）直达 Ticket，但不赋予新权限。Worker 判断消息超出范围时 handback 一次，交回 Eval 重新判断。
- **Report 分类**：`progress / waiting / ready / blocked / failed / dropped`，再加结构化的 **Attention**（一次只问一个具体问题）。面板按 stage 把「等人处理」的放最前面，健康的不占位置。他们明确拒绝「从报告的自由文本里推断是否在等人」。
- **执行细节**：每个 Ticket 一个 Executor Session，外加一个 git worktree 目录（由 prepare 命令创建，限时 10 分钟）。前台 shell 命令 5 秒后转入后台，让 Worker 在下一步就能收到新消息。每轮结束后，后台任务最多再跑 30 分钟。为人的消息**额外保留一个并发槽**，新工作不会挡住人继续推进已有工作。
- **Stored work（outbox）**：所有外部动作先落库再执行，退避重试（2 秒起，翻倍到 1 分钟），同一会话内的消息保序。重启时给 Assignment 一条 recovery note：「先检查目录、git 历史和 GitHub，再决定要不要重复外部动作」。
- **上下文预算**：Assignment 正文最多 1,500 字，每张 Trigger 卡片最多 600 字，只有被截断的内容才附读取指针。
- **Router prompt 的硬性约束**（prompts/orchestrator.md）：「Messages on a subscribed thread go directly to the workers」「Keep progress internal」「never wait with sleep/polling」。

原型里**没有**的：独立的 Watchdog Session（只有健康检查和 `retry-health`）、无状态云端 loop、edge daemon、长期记忆。

## 4. 与 Agent Hub 对照

| DeepSeek 设计 | Agent Hub 现状 | 判断 |
| --- | --- | --- |
| 计算/环境分离、edge daemon、BYOM | Connector 出站连接、本机执行、Hub 只做队列和回执 | **我们已经在他们的 Step 2 上**，方向得到验证 |
| Stored work + 退避 + 保序 | Durable command outbox、ACK、重放、去重、每 Worker 串行 | 已具备 |
| 重启后 recovery note | 运行中的命令一律 `failed + outcome_unknown`，不重跑 | 我们更保守；可以加「人点重试时附 recovery note」 |
| Router 不干活、轻模型 | Coordinator 是一个交互 Session，负责规划、终审和对话 | 基本一致 |
| 订阅快路径 | 中央对话每条消息都先经 coordinator_chat；即使单独 `@员工`，也是协调者先判定 `action=chat`，Hub 再转 worker_chat（`Coordinator.sendChat`） | **缺口**：没有任何快路径，见 P1-1 |
| Router 批处理 | 每条 chat 一条 coordinator_chat，串行处理 | **缺口**，见 P1-2 |
| Inline & Spill（1,500 / 600 字） | 步骤 prompt 内联最多 64,000 + 24,000 字的上游结果 | **差距最大的成本点**，见 P1-3 |
| Report 分类 + Attention | Command 只有 succeeded/failed；Task 有 blocked/review | **缺口**，见 P1-4 |
| Source/Trigger/Gate/observe | Hub 只接收人或 agent 主动创建的任务；飞书跟进是另外写的 watcher | P2 |
| 语义 Watchdog | 只有无活动超时（15/60 分钟，只看时间）；交互 Channel 运行中不回传任何输出 | **本次已实现**，见 §5 |
| Worker 间通信 | 已有邮箱，不授予权限 | 他们列为未解问题。我们要守住的底线是**邮件只是上下文，不是授权** |

不该照搬的部分：

- 他们**自己掌握 agent loop**（dsh），能做 5 秒转后台、轮中注入 inbox、全双工。我们跑在 Claude/Kimi/Codex 的交互 Session 上，做不到轮中控制，不必追。
- 他们的 Executor「以操作者 OS 用户身份免审批执行」。我们的底线是可见 Session、权限确认留在终端，这条要保持。
- 他们是一个仓库一个 agent、在团队规模内。文章自己也说更大规模需要分层过滤和分片，我们暂时用不到。

## 5. 本次落地：进展上报 + 语义看门狗

在 `huanghaibin` 分支上实现，未提交。设计细节见 [design.md §6.6](../design.md)。

1. `agent_hub_progress(command_id, note)`：交互 Session 在执行中途写一行进展，写入命令输出（`[progress] …`）并刷新 `last_activity_at`。顺带修掉一个副作用：健康的长任务不再被 60 分钟无活动超时误杀。
2. `watchdog_check`：管理员指定一个独立 Session 作为看门狗（不能是协调者）。Hub 每 10 分钟把运行超过 10 分钟的命令打成快照发给它，内容包括目标与验收、进展行、输出尾部、空闲时长，以及上次结论和之后有没有新活动。它返回 `{verdicts:[{state,action,evidence,message}]}`。
3. Hub 只做两种低风险动作：**nudge**（以看门狗身份发邮箱提醒，每条命令 30 分钟内最多一封）和 **escalate**（在中央对话里告警，等人处理）。**不取消、不重试、不改状态**；progressing 和 unclear 被强制为 none。每条结论都记成 `watchdog.verdict` 事件，可以回放审计，用来调 prompt。

上手方式：

```bash
# 1. 开一个专门的看门狗窗口（Claude 推荐），在窗口里登记
agent-hub session start --runtime claude --push --cwd ~/Workspace/agent-hub
#   窗口内：/agent-hub 把当前 Session 注册到 Agent Hub，职责是看门狗，只做判断不改代码

# 2. 管理员启用（worker_id 用登记返回的值）
curl -X PUT https://hub.findu.work/api/v1/watchdog -H "authorization: Bearer $AGENT_HUB_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"worker_id":"worker_...","enabled":true}'

# 3. 立即巡检一次 / 查看状态
curl -X POST https://hub.findu.work/api/v1/watchdog/check -H "authorization: Bearer $AGENT_HUB_ADMIN_TOKEN"
curl https://hub.findu.work/api/v1/watchdog -H "authorization: Bearer $AGENT_HUB_ADMIN_TOKEN"
```

注意：Hub 和各 Connector 都要更新到这个版本。旧 Channel 没有 `agent_hub_progress` 工具，看门狗只能看到空输出，多半会判为 unclear，不会采取动作。

## 6. 后续建议（按收益排序）

> 2026-10-31 更新：P1-1 至 P1-4 已在 `huanghaibin` 分支实现，并接入 youxian-qa 的飞书跟进（P2-1 的第一个 Source），见 [design.md §6.7](../design.md)。P2-2、P2-3 未做。

**P1-1 确定性快路径（订阅直达）。** 两种情况由 Hub 用规则直接路由，不花协调者的一次模型调用：只 @ 了一位员工、没有 @ 任务的消息，直接作为 worker_chat 发出；@ 了一个进行中的任务的追问，直接发给该任务当前的负责人。负责人判断超出范围时 handback，再交给协调者。依据：文章消融实验中，去掉直达后 Router 决策 +30%、cache token +37%。

**P1-2 协调者批处理。** 协调者忙的时候，新到的 chat 先排队；它空出来后把排队消息合并成**一条** coordinator_chat，让它一次给出多个动作。依据：文章 2.2 的批处理压测。

**P1-3 证据从内联改为摘要 + 指针。** 步骤 prompt 只内联上游结果摘要（例如每条 ≤1,500 字），附 `agent-hub command show <id>` 让 Worker 按需召回；终审也照此办理。现在的 64k + 24k 内联是最大的 token 成本，而且原型的预算低了一个数量级。

**P1-4 结构化 Report 与 Attention。** `agent_hub_report` 的 status 扩展出 `waiting`、`blocked`、`dropped`，并支持一个结构化的 `question` 字段（一次只问一个问题）。Dashboard 新增「等你处理」列表放在首屏，健康的员工不占位置。这样就不必从结果文本里猜是否在等人。

**P2-1 事件源 + Gate + observe 模式。** 把飞书群、GitHub PR 评论这类外部事件接成 Trigger：先确定性 gate（白名单、是否 @），再交协调者研判。主动类规则先跑 observe，只记录「本来会接单」，人审过后再开 auto。有闲的 QA 跟进看板和 @ 跟进 watcher 是现成的第一个 Source。

**P2-2 沟通规范写进 Skill 和协调者 prompt。** 确认只发一次，干活时保持安静，只在有结果、需要决策或失败时说话；IM 每条不超过 100 字。中央对话里逐步的 activity 消息可以按「是否需要人」再收敛一次。

**P2-3 人工重试附 recovery note。** 保留 `outcome_unknown` 不自动重跑。人在 Dashboard 点重试时，新命令带上「先检查工作目录、git log、PR 状态，再决定是否重复外部动作」。
