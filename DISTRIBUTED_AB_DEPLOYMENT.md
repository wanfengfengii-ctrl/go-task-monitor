# A/B 分布式流水线部署

当前电脑继续运行原来的 `all-in-one` 版本，不设置任何分布式环境变量。新电脑 A 和 B 必须拉取同一个 Git commit；A 保存新系统的唯一权威数据，B 的工作目录只是可恢复缓存。

## 阶段边界

- A：`project_plan`、项目生成与验证、`main_freeze`、四分区 Bug 搜索、受控注入、题面确认、`main_publish`。
- B：从 `task_prepare` 开始，执行 Claude 修复、Codex 独立测试、红绿证明、Docker、Git、云盘与最终交付。
- 源码通过项目 Git 仓库传递；状态和任务检查点通过 A 的 API 传递，不使用共享磁盘。

## 公共准备

两台新电脑都克隆同一个私有系统仓库，并固定到同一提交。系统代码建议放在 `$HOME/apps`，运行数据放在 `$HOME/go-task-monitor-data`；两个目录不要互相包含，这样 Claude 沙箱可以保护系统代码而不阻止项目生成：

```bash
mkdir -p "$HOME/apps"
git clone git@github.com:wanfengfengii-ctrl/go-task-monitor.git "$HOME/apps/go-task-monitor"
cd "$HOME/apps/go-task-monitor"
git checkout <release-commit>
npm ci
```

Windows 电脑在 WSL2 Ubuntu 中执行。A、B 都需要 Node 22、Go、Docker、Git、Codex CLI、Claude Code、`jq`、`rsync`、`tar` 和 Bubblewrap；A 额外需要已登录的 GitHub CLI，B 需要能克隆项目仓库的 SSH Key。Docker Desktop 必须开启 WSL 集成。Ubuntu 可先执行：

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap jq rsync tar git
bwrap --ro-bind / / --proc /proc --dev /dev true
```

生成一次 A/B 共用密钥，不提交到 Git：

```bash
openssl rand -hex 32
```

建议使用 Tailscale 地址连接 A，或只在可信局域网开放 `4174`。B 只主动连接 A，不开放入站端口。

## A 电脑

```bash
export GO_PIPELINE_NODE_ROLE=producer
export GO_TASK_MONITOR_API_HOST=0.0.0.0
export GO_TASK_MONITOR_API_PORT=4174
export GO_TASK_MONITOR_WORK_ROOT="$HOME/go-task-monitor-data"
export GO_PIPELINE_WORKER_TOKEN='<shared-token>'
export GO_PIPELINE_RELEASE_ID='<release-commit>'
export GO_TASK_MONITOR_CLOUD_USERNAME='<cloud-account>'
export GO_TASK_MONITOR_CLOUD_PASSWORD='<cloud-password>'
export GO_PIPELINE_CLAUDE_BIN="$(command -v claude)"
export GO_PIPELINE_CODEX_BIN="$(command -v codex)"
npm run api
```

另一个终端启动页面：

```bash
npm run dev
```

页面仍使用 `4173`，API 使用 `4174`。A 在 `main_publish` 后自动停止本地 Runner，并把项目放入 `remote-repair` 队列。

## B 电脑

```bash
export GO_TASK_MONITOR_API_URL='http://<A-address>:4174'
export GO_PIPELINE_WORKER_ID='repair-b'
export GO_PIPELINE_WORKER_ROOT="$HOME/go-task-runtime/repair-b"
export GO_PIPELINE_WORKER_TOKEN='<shared-token>'
export GO_PIPELINE_RELEASE_ID='<release-commit>'
export GO_PIPELINE_REMOTE_BUG_WORKER_LIMIT=4
export GO_PIPELINE_CLAUDE_BIN="$(command -v claude)"
export GO_PIPELINE_CODEX_BIN="$(command -v codex)"
npm run worker:repair
```

B 注册后会持续轮询。`GO_PIPELINE_WORKER_ROOT` 的父目录应只放流水线运行数据，不能直接设成 `$HOME`，否则隔离沙箱会同时隐藏用户目录里的 CLI。一个项目只能有一个有效租约；心跳默认每 15 秒发送，租约默认 90 秒过期。A 请求停止、B 掉线或租约被新 Worker 接管时，旧 Runner 会停止，已同步的阶段检查点可在同一台或替换 B 电脑上恢复。

## 首次灰度

1. A/B 页面与 Worker 都启动，但先暂停自动补题。
2. 在 A 创建一个标准项目并手动启动。
3. 确认 A 完成 `main_publish` 后显示 `B repair-b` 忙碌。
4. 确认 B 的本地缓存位于独立 `GO_PIPELINE_WORKER_ROOT`。
5. 确认 A 最终收到任务目录、红绿证明、Git 地址和云盘链接，并可正常导出 Excel。
6. 人工停止一次正在修复的测试项目，确认 B 在一个心跳周期内退出且 A 保留可重试状态。

灰度通过后再恢复 A 的闭环调度。当前电脑与新 A/B 系统没有共享数据、队列或槽位，互不影响。
