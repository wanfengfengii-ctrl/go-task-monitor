# 新题目生产流程

## V3 流程（仅后续新建作业）

1. Claude 在本地生成 0-1 Go 项目，完成项目、`go.mod`、`linux/arm64` 和 `linux/amd64` Docker 验证。
2. 脚本在本地冻结唯一的初始 `main_commit`，但暂不向远程 Git 上传项目代码。
3. 项目级 Bug 定位按四个互补分区并行完成：公开入口与编排、状态与持久化、并发与资源、协议与恢复。每个分区从自己的主要包族开始，标准项目通常最多返回 3 个候选，超大型项目每分区最多返回 4 个；候选不足时允许返回零，不为数量追逐弱候选。网关、进程、沙箱或超时失败属于基础设施失败，不会被当成“无自然 Bug”并转入注入，已完成分区会保留并在恢复时复用。
4. 四个分区的候选先经过确定性字段校验，并按 Bug ID、文件、符号、标准运行机制做跨分区语义去重，再由一个新的只读 Codex session 批量完成难度、可达性和证据复核。只有明确批准且难度评分至少为 3/5 的候选才进入排序；超过项目 Bug 槽位时按评分从高到低选取，同分按 `bug_id` 稳定排序。自然候选不足或为零时不逐槽重新搜索：系统使用一个新的只读 Session 一次规划全部剩余注入槽位。Diagnosis 只需保留合法的定向命令形状，真正的 `pre_fix=red` 在 Claude 轨迹完成后由隔离验证层生成。持久化计划后最多同时写入和复核 4 个独立 BUG_BASE。候选完成注入和范围复核后只执行一次项目级 `go test ./...` 与 `go vet ./...` 确认；候选确认失败时只替换当前槽位。
5. 所有通过批量复核的 BUG_BASE 确定后才统一推送 Git。`bugN_main` 和自然 Bug 的 `BUG_BASEN` 都等于同一个初始 `main_commit`；注入 Bug 的 `BUG_BASEN` 是该提交的独立直接子提交，不同 Bug 不得串行叠加。
6. Claude 只获得系统临时目录中的无 `.git` BUG_BASE 文件快照。不向 Claude 提供仓库地址、SHA、注入报告、原始 diff、Gold、grader 或其他 Bug；运行时禁用 Git/GitHub CLI 和网络搜索工具，并通过 macOS sandbox 禁止读取 `go-task-library`。
7. BUG 注入/Gold 校准执行分层稳定性验证：确认公开回归测试在 BUG_BASE 总计 20 次 red、Gold 修复后 `-count=20` green。Claude 修复结束后不重复这 20 次稳定性验证，只执行 Docker 前快速门禁：确认提交仓库中存在 `TestModel_*`，`verify_cmds` 的包和测试名真实且可编译，并在 BUG_BASE 执行一次 red、修复 workspace 执行一次 green；通过后直接进入双架构 Docker。导出的 `verify_cmds` 始终保留可独立复跑的原始 `-count=1` 定向命令，不被内部稳定性参数改写。测试必须验证公开可观察行为，但不强制使用外部 `_test` 包；同包测试在通过安全边界扫描后还要接受一次只读 Sol 语义复核。若 Gold 回归测试与项目公开契约冲突、过度限定实现细节或未覆盖题面要求，系统归档当前 Gold workspace，保留已有生产修复，只重新生成 Gold 测试；最多自动重试 3 次，连续失败后只暂停当前 Bug，不中断另一个 Bug worker。

V3 任务写入 `workflowVersion: 3`、`bug_source: natural|injected` 和 `bug_discovery_stage: before_git_main_publish`。旧作业继续按创建时的工作流恢复，不迁移、不重写、不修改已有分支。

## V1 历史流程（仅用于保留已有作业）

后续题目不再从 Git 仓库检索项目。每道题必须按截图执行下面的双修复流程：

1. Codex 设计 0-1 项目题目，并把项目生成要求保存为生产证据。
2. Codex 调用 Claude Code CLI 按题目生成完整的 0-1 项目；必须记录生成 session。项目必须包含可实际编译的 Go 源码、`go.mod`、同时支持 `linux/arm64` 与 `linux/amd64` 的 Docker 文件和项目说明；这些文件提交到 Git，但不再打项目 ZIP。
3. 检查项目基线后提交并推送远端 `main`，记录 `main_commit`。从这一步开始 `main` 保持不变。
4. Codex 只检查 Claude 生成并推送到 `main` 的原始项目，从中寻找已经存在、可重复复现的 bug。Codex 不得为了出题修改项目代码或注入 bug。每个项目最多选择 5 个 bug，分别使用 `bug_index` 1-5；相同仓库不得重复使用同一个编号。
5. 每个 bug 使用一组编号分支：`bugN_main`、`BUG_BASEN`、`bug-NN/gold_model_fix`、`bug-NN/test_model_fix`。`bugN_main` 与 `BUG_BASEN` 必须指向原始 `main_commit`，三者之间不得有代码修改。Codex 在 `bug-NN/gold_model_fix` 修复，Claude 测试模型在 `bug-NN/test_model_fix` 修复。Claude 运行时只能看到去掉 `.git` 的当前 BUG_BASE workspace，不能看到其他 bug 编号、Gold 分支、补丁、grader 或隐藏测试。
6. 导入任务时为每个 bug 选择一个任务类型：`bugfix` 或 `diagnosis`，只能选择一个。相同 `bug_id` 不得再创建第二条轨迹；一个项目最多 5 个 bug 和 5 条轨迹，每条轨迹对应一个独立编号分支组。
7. Git 提交必须按截图中的分支流程完成，不再生成或上传项目 ZIP：

   ```bash
   main
     |-- bug1_main = BUG_BASE1 -- bug-01/test_model_fix / bug-01/gold_model_fix
     |-- bug2_main = BUG_BASE2 -- bug-02/test_model_fix / bug-02/gold_model_fix
     |-- bug3_main = BUG_BASE3 -- bug-03/test_model_fix / bug-03/gold_model_fix
     |-- bug4_main = BUG_BASE4 -- bug-04/test_model_fix / bug-04/gold_model_fix
     `-- bug5_main = BUG_BASE5 -- bug-05/test_model_fix / bug-05/gold_model_fix
   测试模型修复提交               高阶模型修复提交
   ```

   `main`、`bugN_main` 与 `BUG_BASEN` 必须指向同一个原始项目提交；三者之间不得存在代码修改。每组两个修复分支都从对应 `BUG_BASEN` 创建。Codex 修复先准备并填写 `gold_patch`。点击系统启动按钮后，Claude 在隔离 workspace 中运行；测试通过后，系统才把该 workspace 提交并推送到对应 `bug-NN/test_model_fix`，自动把该分支页面地址回填到 `repo_url`。

   diagnosis 任务仍不得修改 workspace。系统会在对应 `bug-NN/test_model_fix` 上创建一个无代码差异的诊断结果提交，用于记录本次 Claude session；`bug-NN/gold_model_fix` 仍保存 Codex 的实际代码修复。同一仓库的所有 Bug 必须共享同一个 `project_generation_session_id` 和 `main_commit`。

新任务的 `public.json` 应至少包含：

```json
{
  "production_flow": "codex_design_claude_generate_then_discover_one_bug_then_dual_fix",
  "project_origin": "generated_0to1",
  "project_prompt_author": "codex",
  "project_generator": "claude_code_cli",
  "project_generation_session_id": "Claude 生成项目的 session ID",
  "bug_discovery_stage": "in_generated_main_before_trajectory",
  "bug_discovery_author": "codex",
  "bug_discovery_id": "唯一的 Bug 发现记录标识",
  "bug_index": 1,
  "trajectory_count": 1,
  "task_type": "bugfix",
  "git_flow": "main_numbered_bug_bases_parallel_model_fixes",
  "repository": "https://git.example.com/team/project",
  "clone_url": "https://git.example.com/team/project.git",
  "main_branch": "main",
  "main_commit": "Claude 生成项目的 main 40 位 commit SHA",
  "main_pushed": true,
  "bug_main_branch": "bug1_main",
  "bug_main_commit": "必须与 main_commit 完全相同",
  "bug_main_pushed": true,
  "bug_main_unchanged": true,
  "bug_base_branch": "BUG_BASE1",
  "bug_base_commit": "必须与 bug_main_commit 完全相同",
  "bug_base_pushed": true,
  "main_unchanged": true,
  "test_model_fix_branch": "bug-01/test_model_fix",
  "test_model_fix_actor": "claude_code_cli",
  "test_model_fix_base_commit": "与 bug_base_commit 完全相同",
  "gold_model_fix_branch": "bug-01/gold_model_fix",
  "gold_model_fix_actor": "codex",
  "gold_model_fix_base_commit": "与 bug_base_commit 完全相同",
  "gold_model_fix_commit": "高阶模型的 40 位 commit SHA",
  "gold_model_fix_pushed": true,
  "gold_patch": "https://git.example.com/team/project/commit/高阶模型 SHA"
}
```

Claude 修复成功并推送后，系统自动追加：

```json
{
  "test_model_fix_commit": "Claude 修复的 40 位 commit SHA",
  "test_model_fix_pushed": true,
  "test_model_fix_session_id": "本次轨迹 session ID",
  "repo_url": "https://git.example.com/team/project/tree/bug-01/test_model_fix"
}
```

`verify_result` 不允许只写“修复前失败、修复后通过”的模板句。bugfix 必须依次写清 `问题情况`、`处理过程`、`解决情况`、`验证结论`，其中解决情况必须同时包含 BUG_BASE 修复前失败、Gold 修复后成功，以及 Claude workspace 按同一套目标验收和全量测试通过的证据；适用的静态检查作为补充证据，不要求位于唯一的命令顺序。diagnosis 必须依次写清 `问题情况`、`处理过程`、`诊断结论`、`验证结论`，并记录重复复现和由系统外部写入审计确认的 workspace 无差异证据，不要求 Claude 执行固定的目录比较命令。系统在发布 `test_model_fix` 时根据真实 commit 与系统验收结果生成该字段，缺少任一分段的当前流水线任务不得判为合格或导出。

V5 Claude-only bugfix 不再由系统额外重复执行一遍红绿目标测试。Claude 修复结束后系统先完成 `verify_cmds`、测试文件和覆盖清单的结构预检，再由两个不同的新 Claude Session 分别直接执行 `pre_fix` 和 `post_fix`；这两个证明 Session 的逐条退出码和结果是最终红绿证据。两个证明在命令不依赖 Docker 时可并行运行，`public.json` 的证明回填使用串行合并，避免并发覆盖。证明期间复用任务级 Go 编译/模块缓存，post-fix 的相同 commit 复用干净副本；完成云盘上传和 `verify_result` 回填后清理缓存。所有 Session、源码 commit、命令数组哈希、轨迹哈希和逐条结果校验保持不变，Docker 或旧版证明仍按原顺序执行。

下午确定的 Go 项目规范继续完整执行：0-1 项目也必须包含可编译的 Go 基础代码；项目生成先由 Codex 形成并扩写业务规格，再固化为根目录 `PROJECT_SPEC.md`，Claude 基础骨架、完整实现和定向修复都必须以该文档为唯一业务来源，生成阶段不得改写或删除它。规格至少包含端到端流程、核心组件、领域不变量、数据模型、公开接口、失败边界、验收标准、确定性测试场景和组件追踪关系。生成后的门禁除编译和测试外，还必须证明生产包从 `package main` 入口可达；未被生产代码或测试引用的内部声明、大段重复实现、与规格无关的文件和代码不得用来凑 2000/5000 行规模。Git 项目根目录必须包含 `go.mod`、`benzhi.Dockerfile`、`build_benzhi_docker.sh` 和 `BENZHI_README.md`，依赖、前端锁文件、`go build ./...`、测试或运行命令、禁止提交构建产物等规则保持不变。`benzhi.Dockerfile` 必须设置 `ENV GOTOOLCHAIN=local`；`go.mod` 可以声明 `toolchain`，但必须与 `go` 语言版本及 Docker 工具链一致。README 只校验用途与必需命令，不设置字符数门槛。新项目不得在任何目录包含 `BUG_REPRO.md`；`BENZHI_README.md` 第一行必须是与规划元数据完全一致的单句项目简介，明确写出 Go 技术、项目业务、`CLI` 或 `Web` 类型以及工具形态。题目刻意保留的预期失败命令只保存在任务元数据中，不写入项目文件。历史项目继续按创建时的包规则校验。任务入队前执行 Git 工作区静态校验；Claude 完成后、推送 `bug-NN/test_model_fix` 前，系统必须分别实际构建 `linux/arm64` 和 `linux/amd64` 镜像，并在两个无网络容器中执行外置隐藏目标测试、全量测试，以及 bugfix 的静态检查。隐藏 grader 仅在 Claude 退出后以只读挂载方式进入容器。导出的 `harness` 必须如实填写 `backend=docker-target`；验证只保存文本日志，不要求截图。

新项目不得选择查账、记账、财务对账或订单、下单、履约类业务。自动补题由系统在 12 个项目领域中按最近 60 个项目的低频领域优先分配，批次内不得重复，模型必须返回并遵守系统指定的 `projectDomain`；项目创建和项目规划阶段都会再次执行禁止领域门禁。领域扫描只按项目的正向业务描述判定，模型在 `uniqueness` 中写“不是订单/财务/前端”等排除说明不会造成误报；材料、资源等非财务语境的 `accounting` 也不会被当作查账。项目规划是一次性检查点，生成、验证或 Bug 阶段开始后恢复流水线不得重新规划或替换既有项目。该规则只约束新建项目，不追溯废弃已生成或正在运行的历史项目。

### 当前项目规模策略

项目规模由系统明确分配。标准项目要求生产 Go 代码至少 2000 行且低于 5000 行、至少 20 个生产 Go 文件、最多 10 个 Bug；超大型项目要求生产 Go 代码至少 5000 行、至少 50 个生产 Go 文件、固定 30 个 Bug。前端仍按项目需求单独分配，不计入 Go 行数。手工入口可选择超大型；自动补题默认创建标准项目，仅在设置了持久化超大型试跑额度时，按额度把接下来实际创建成功的项目提升为超大型，额度用完后自动恢复标准规格。模型必须遵守系统逐题分配的规模，不能自行升级或降级。

超大型试跑会按作业记录自动统计排队时间、实际运行时间、项目生成耗时、双架构校验耗时、已交付 Bug 数和两题总墙钟时间；服务重启不会清空试跑额度或计时来源。项目外层校验在进入 Docker 前会移除生成目录中的 `node_modules` 与 `dist`，支持文件只在内容变化时重写。静态校验、`linux/arm64` 和 `linux/amd64` 分别保存源码指纹检查点；重试只执行未通过的平台。Docker daemon、镜像租约、Registry 网络与超时故障只重试当前平台，不触发 Claude 代码返修。Docker 缓存维护只等待正在使用 Docker 的阶段，纯分析、题面复核和云盘上传不再阻塞维护。

已经创建的历史大型项目不会被删除、缩小或重生成，仍按其持久化配额继续恢复，以免破坏已有主线、BUG_BASE 和交付记录。只有端到端流程稳定、Gold 契约复核和云盘交付连续通过后，才重新开放大型项目入口。

没有完整运行前证据的历史仓库题目仍会保留在任务列表中，但不会进入新的待运行队列。只有当前编号的 `bugN_main + BUG_BASEN + bug-NN/gold_model_fix` 已推送且 Git 项目规范通过的任务可以启动 Claude；只有 `bug-NN/test_model_fix + bug-NN/gold_model_fix` 都已推送且地址完整的任务可以审核与导出。新标准项目超过 10 个 Bug、历史大型项目超过其已持久化的 30 个 Bug 配额，或出现重复 `bug_index`，才会被标记为流程冲突。项目 ZIP 不再生成、上传或交付；Go 项目规范和 Docker 双架构验证仍是交付条件。

## 系统中的流水线操作

管理页面的“流水线作业”区把生产过程保存为持久化作业。创建草稿和启动执行是两个独立动作：填写项目要求、Bug 数量、唯一任务类型及最大轨迹尝试次数后，系统通过本机已授权的 GitHub CLI 查询账号中的 `go-NNNN` 仓库，串行分配最大编号加一的公开空仓库并写入公开 HTTPS 地址与 SSH Clone 地址。当前 `go-0001` 已存在，因此下一道新题自动创建 `go-0002`，之后依次递增；编号分配同时参考远端仓库和本地历史作业，避免并发草稿或已删除仓库造成重复。建仓成功后只创建 `draft`，不会调用任何模型；人工点击该作业的“启动”后才开始执行。

自动建仓不添加 README、`.gitignore` 或 License，并在写入作业前验证仓库为 Public、Empty 且 SSH 地址匹配。GitHub 凭据保存在本机 GitHub CLI 的系统凭据存储中，不进入前端、作业 JSON 或导出文件。可通过 `GO_PIPELINE_GH_BIN` 指定 CLI 路径，通过 `GO_PIPELINE_GITHUB_OWNER` 固定仓库所属账号。

每次 Codex 调用和 Claude 调用都创建新 session。项目生成阶段可以通过 `GO_PIPELINE_PROJECT_GENERATOR_PROVIDER=deepseek` 单独使用 Claude Code CLI 的 DeepSeek Anthropic 兼容后端；Base URL、Token、模型和 effort 只注入项目生成子进程，不进入 Claude 修复、主轨迹或 V5 红绿验证阶段。默认未配置时仍使用机器当前 Claude 配置。DeepSeek 模式需要配置 `GO_PIPELINE_PROJECT_GENERATOR_AUTH_TOKEN`，可选配置 `GO_PIPELINE_PROJECT_GENERATOR_BASE_URL`、`GO_PIPELINE_PROJECT_GENERATOR_MODEL`、`GO_PIPELINE_PROJECT_GENERATOR_SUBAGENT_MODEL` 和 `GO_PIPELINE_PROJECT_GENERATOR_EFFORT`。一个生产作业在项目级阶段通过后，由四个互补分区并行建立自然 Bug 候选池，再通过一次批量复核统一完成去重、难度和证据确认；自然候选不足时由一次批量计划填满剩余注入槽位，最多同时准备 4 个独立 BUG_BASE。人工指定自然搜索恢复时可临时使用 `naturalBugOnly`：保留已通过的 BUG_BASE，并用新的 retry nonce 避免复用旧 Codex 输出；候选池为空或基础设施失败时不创建注入计划，阶段回到可重试的自然发现状态，候选不足由人工决定是否结束。全部 BUG_BASE 准备完成后，流程一次性进入 `waiting_review`，由人工在 Bug 工作台批量编辑并确认全部 `user_query`。未确认完之前不发布 main/BUG_BASE、不创建 Claude 修复任务，也不占用 Runner；最后一个题面确认后才发布基线。发布后同一项目最多同时运行 2 个独立 Bug worker，每个 worker 使用自己的 workspace、分支、Session、阶段状态和红绿证明；Git 发布与项目级最终状态仍串行合并。资源池已满时当前 worker 原地等待，不把项目退回中央调度，也不打断另一个 worker。轨迹失败时系统保留可用 checkpoint，并按失败类型只重试 Claude、Docker、Git 发布或云盘上传所需阶段。合格后自动上传轨迹 JSON 到已连接的云盘，把永久 HTTPS 链接回填到任务 `trajectory` 字段，最后标记为可导出。

生产机推荐把 DeepSeek Key 保存在 macOS 钥匙串服务 `go-task-monitor.deepseek-project-generator`，然后用 `npm run api:deepseek` 启动 API。启动脚本只把钥匙串中的 Key 注入 API 进程，不写入源码、作业 JSON、日志或前端。

固定轨迹策略要求 Claude 在写入前先复现并定位；bugfix 禁止无依据反复试错、反复改撤、重引入故障或修改测试规避问题，但一次有证据的清理仅记录为警告。bugfix 必须有真实的修复前目标失败、最终补丁后的目标成功和全量测试成功；适用的静态检查是补充证据，不规定目标、全量与静态检查的唯一先后顺序。diagnosis 必须执行可重复的公开行为复现或读取已有日志/栈证据，并由系统外部写入审计证明全程零代码修改，不要求轨迹内出现固定 `diff` 命令。探索命令可以格式化输出，但不能作为最终验收；用于红、绿和全量结论的决定性命令必须保留真实退出码。已恢复的权限拒绝、短暂 API 重试和单次合理还原只记录为警告，最终会话不完整、决定性验证被掩盖、反复还原或未恢复错误仍判失败。该策略通过 Claude CLI 系统提示生效，不写入导出的原生 JSONL；轨迹只保留用户题面和真实执行过程。

生产流水线与原任务队列互斥。项目级规划、生成、验证、冻结、发布和最终交付保持有序；BUG_BASE 注入和 Bug 修复各自允许每项目最多 2 路并发，全局实际并发仍由动态资源池限制。一个项目完成或重试耗尽后，系统自动补入下一个待运行项目。流水线执行期间不能启动旧任务队列或批量重新生成轨迹，停止按钮只终止对应项目的流水线进程组并把作业保留为可重试状态。

批量运行使用 4-worker 池，并对 manifest 写入进行快照和串行落盘，避免并发覆盖。单个项目失败会在自己的 worker 内按上限重试；重试耗尽只标记该项目失败，不会中断其他正在运行或等待执行的项目。`GO_PIPELINE_BATCH_CONCURRENCY` 可以把并发数调低，但不能超过 4。

作业记录保存在 `go-task-library/pipeline-jobs/<pipeline-id>/job.json`，页面只返回公开 Git 地址和阶段状态，不返回 Clone 凭据或本地工作目录。runner 可用于受控排障：

```bash
npm run pipeline:run -- /absolute/path/to/job.json
```

确定性轨迹校验直接调用已集成的脚本：

```bash
npm run validate:trajectories -- --json --task-name=<task> --task-type=bugfix trajectory_<session>.jsonl
```

只有确定性脚本通过且 Sol 二次只读质检批准的任务才会自动标记合格；系统随后上传完整 JSON 轨迹、把永久 HTTPS 链接写入可导出的 `trajectory` 字段，并完成交付就绪阶段。
