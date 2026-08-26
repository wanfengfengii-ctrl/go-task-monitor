# A/B 双机流水线标准流程

状态：当前系统执行标准。适用于 `GO_PIPELINE_NODE_ROLE=producer` 的 A 电脑和 `repair-worker` 的 B 电脑。

## 1. 总原则

- A 是控制面和项目生产机，负责把项目、Bug 题面和不可变 Git 基线准备到可交接状态。
- B 是修复执行机，负责从交接点开始完成每个 Bug 的修复、验证、上传和最终回传。
- A 的生产工作在“远程交接已持久化”时结束，不需要等待 B 领取或完成整个项目；交接成功后，A 可以按生产资源上限启动下一个项目。
- A 始终保存中央任务状态。B 的本地目录只是执行副本，不能替代 A 的任务记录。

## 2. A 电脑职责

### 2.1 A 必须执行的阶段

1. 项目准备：`project_plan`、`project_generate`、`project_validate`、`main_freeze`。
2. 全部 Bug 槽位准备：`bugN_bug_discovery`、`bugN_bug_source_prepare`、`bugN_user_query_review`。
3. 基线发布：`main_publish`，发布冻结的 main 和每个有效 Bug 的独立基线。
4. 生成远程交接记录，把第一个未完成的 B 阶段设为 `currentStage`。

A 还负责控制器 API、页面和队列、资源调度、Worker 注册与鉴权、租约管理、状态展示、检查点接收、停止请求、失败重排以及最终数据归档。

### 2.2 A 做到哪里才算本轮结束

以下条件必须同时满足：

1. `project_plan`、`project_generate`、`project_validate`、`main_freeze` 和 `main_publish` 均为 `passed`。
2. 每个有效 Bug 的 `bug_discovery`、`bug_source_prepare` 和 `user_query_review` 均为 `passed`；策略允许跳过的槽位必须有明确的 `skipped` 记录。
3. 不存在 `waiting_review`，也不存在仍为 `pending`、`running` 或 `failed` 的 A 阶段。
4. 每个有效 Bug 已保存确认后的 `user_query`、Bug 来源和不可变 `bugBaseCommit`，对应远程 Git 基线可被 B 拉取。
5. Job 已原子写入以下交接状态：
   - `status = waiting_resource`
   - `currentStage = bugN_task_prepare`，或另一个尚未完成的 B 阶段
   - `waitingResource.pool = remote-repair`
   - `remoteExecution.requiredRole = repair-worker`
   - `remoteExecution.status = waiting`
   - A 本地 `runnerPid` 和 `schedulerLease` 已释放
6. 最新 Job 已持久化到 A 的工作目录，B 的领取 API 能把它识别为可领取任务。

达到第 6 条就是 A 的明确交接点。此时 A 释放该项目占用的 producer 执行槽，可以立即调度下一个项目；无需等待 B 在线、领取或修复完成，但仍受 A 的并发上限、磁盘水位、质量熔断和队列策略约束。

以下情况不算 A 完成：题面仍待人工确认、Bug 基线未发布、`main_publish` 失败、Job 只写了日志但未写入远程交接状态，或者下一个阶段仍属于 A。

### 2.3 交接后 A 继续承担的控制职责

- 按排队时间向 B 分配最早的可领取项目。
- 校验 Worker token、协议版本和发布版本。
- 保存 B 的心跳、运行快照和任务检查点，并把 B 的本地路径映射回 A 的中央路径。
- 接收 B 的最终 `passed`、`failed` 或 `stopped` 回报，再更新页面、队列和最终统计。
- Worker 租约失效后允许任务重新排队；拒绝旧租约继续写入。
- A 不再本地执行 B 阶段，也不能因为 B 尚未领取而长期占住 producer 槽。

## 3. B 电脑职责

### 3.1 启动和领取

1. 以 repair-worker 身份运行 `npm run worker:repair`；B 不需要启动 UI 或控制器 API。
2. 使用与 A 相同的 `GO_PIPELINE_WORKER_TOKEN`、`GO_PIPELINE_RELEASE_ID` 和协议版本注册。
3. 空闲时轮询 A，只领取状态可领取且租约未被其他 Worker 持有的项目。
4. 领取后获得唯一 `leaseId`；没有有效租约时，B 不得回传或完成项目。

### 3.2 本地恢复

1. 按 A 提供的仓库地址和 `mainCommit` 拉取冻结项目。
2. 按每个 `bugBaseCommit` 建立独立 Bug 工作区。
3. 恢复 A 已保存的任务检查点，随后把中央路径转换为 B 的本地执行路径。
4. 从 A 指定的 `currentStage` 继续，不重复执行项目生成、Bug 搜索、Bug 注入或题面确认。

### 3.3 B 必须执行的阶段

B 从 `bugN_task_prepare` 开始，按任务类型执行当前阶段模板中存在的步骤：

1. `task_prepare`：建立隔离任务。
2. `claude_fix`：完成 Bug 修复或 diagnosis 诊断。
3. `trajectory_validate`：校验主轨迹。
4. `test_author`、`pre_verify`、`post_verify`：按任务类型完成独立测试和红绿证明；diagnosis 不要求绿测。
5. `docker_validation`、`git_publication`：需要时完成双架构验证和 Git 发布。
6. `cloud_upload`、`verification_finalize`：上传轨迹与证明并回填结果。
7. `platform_submit`：当前策略启用时提交质检平台。
8. `delivery_ready`：确认该 Bug 的全部交付字段就绪。

B 可以按系统配置并行处理同一项目的多个 Bug，但不能修改 A 已冻结的仓库地址、main 提交、Bug 选择和题面。

### 3.4 运行同步

- 默认每 15 秒向 A 续租一次，租约默认有效 90 秒。
- 默认每 5 秒向 A 回传一次 Job 快照。
- 在关键持久化阶段通过或失败后上传任务检查点，进程退出前再强制同步一次。
- A 发出停止请求或判定租约已丢失时，B 必须停止当前 Runner；旧租约的后续写入会被 A 拒绝。

### 3.5 B 做到哪里才算结束

1. 每个请求的 Bug 都达到 `bugN_delivery_ready = passed`；只要存在失败、跳过或未完成槽位，整个项目不能标记为 `passed`。
2. 最终任务检查点和 Job 快照已经回传。
3. B 调用 A 的完成接口，且 A 接受当前 `leaseId` 和最终状态。
4. A 中央 Job 已写为 `passed`、`failed` 或 `stopped`，Worker 状态恢复为 `idle`。

只有完成接口被 A 接受，B 才能释放当前项目并领取下一个项目。本地 Runner 退出但最终回报尚未成功，不算完成，B 会继续重试回报。

## 4. 标准状态流转

```text
A: draft/queued
  -> running（项目生成、验证、找 Bug、准备题面和基线）
  -> waiting_review（仅在需要人工确认或人工处理时）
  -> running（确认后继续发布）
  -> waiting_resource + remoteExecution.waiting   [A 交接完成，可开下一个项目]

B: claim
  -> remoteExecution.leased
  -> remoteExecution.running（心跳、快照、检查点持续回传）
  -> completed / failed / cancelled
  -> A 中央 Job: passed / failed / stopped        [B 本轮完成，可领下一个项目]
```

## 5. 异常处理标准

| 场景 | 处理标准 |
| --- | --- |
| B 未上线 | A 已完成交接的项目保持 `waiting_resource`；A 可以继续生产新项目，队列容量仍受资源策略限制。 |
| A 暂时不可达 | B 不领取新任务；当前任务暂存本地并继续尝试同步。恢复连接后若租约已失效，立即停止旧 Runner。 |
| B 心跳超时 | 90 秒租约到期后 A 可重新派单；原 B 的旧 `leaseId` 不能继续写入。 |
| token、协议或发布版本不一致 | A 拒绝注册或领取，先统一配置和代码版本，禁止带病运行。 |
| A 阶段失败 | 项目留在 A 侧重试或等待人工处理，不能提前交给 B。 |
| B 阶段失败 | B 回报 `failed`；A 按自动重试上限重新派单，超过上限后等待人工处理。 |
| 用户停止项目 | A 标记 `cancel_requested`；B 在心跳或快照响应中收到请求后终止 Runner 并回报 `stopped`。 |

## 6. 运维验收清单

### A 交接验收

- A 的所有项目阶段和全部 Bug 选择阶段已通过。
- 所有有效 Bug 的题面已确认，Git main/BUG_BASE 基线可拉取。
- 页面显示“等待 B 电脑 repair-worker 领取”。
- Job 的 `remoteExecution.status` 是 `waiting`，且没有 A 本地 Runner。
- A 已释放 producer 槽并开始补充下一个项目。

### B 完成验收

- B 页面状态持续在线，心跳和快照时间正常更新。
- 每个 Bug 的 `delivery_ready` 均已通过。
- 云盘、验证结果和启用的质检平台提交字段均已回填。
- A 中央 Job 收到最终完成回报，B 回到 `idle`。

## 7. 禁止事项

- 禁止 A 在 producer 模式本地执行 `task_prepare` 及后续修复阶段。
- 禁止 B 执行 `project_*`、`main_*`、`bug_discovery`、`bug_source_prepare` 或 `user_query_review`。
- 禁止用“B 已经开始运行”作为 A 才能开下一个项目的前置条件；A 的前置条件是交接记录已可靠持久化。
- 禁止 B 在租约丢失后继续上传，禁止 A 接受不匹配的 `workerId + leaseId`。
- 禁止把 B 本地目录当作唯一数据源；最终状态以 A 中央 Job 和已接收检查点为准。
