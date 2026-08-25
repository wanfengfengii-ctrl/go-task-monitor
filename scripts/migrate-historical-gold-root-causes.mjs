#!/usr/bin/env node

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { getGoldRootCauseRuleIssues } from '../src/review-rules.js';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const tasksRoot = path.resolve(process.env.GO_PIPELINE_TASKS_ROOT
  || path.join(projectRoot, '.task_work/go-task-library/tasks'));
const exportRecordsPath = path.resolve(process.env.GO_LABEL_EXPORT_RECORDS
  || path.join(import.meta.dirname, '../public/label_export_records.json'));
const archivedTasksPath = path.resolve(process.env.GO_ARCHIVED_TASKS
  || path.join(projectRoot, '.task_work/go-task-library/validation/archived_tasks.json'));
const shouldWrite = process.argv.includes('--write');

const taskCausalMarkers = new Map([
  ['abyssal-auv-release-gate-bug1-api-orchestration-001', ['。第二个', '；该缺陷最终导致第二个']],
  ['abyssal-auv-release-gate-bug10-bug-010', ['；后续任务', '；该缺陷最终导致后续任务']],
  ['abyssal-auv-release-gate-bug2-api-orchestration-002', ['。先完成', '；该缺陷最终导致先完成']],
  ['abyssal-auv-release-gate-bug3-api-orchestration-003', ['。相同 op_key', '；该缺陷最终导致相同 op_key']],
  ['abyssal-auv-release-gate-bug4-state-persistence-02', ['，完全相同的重试', '；该缺陷最终导致完全相同的重试']],
  ['aircipher-sector-resync-bug3-state-persistence-001', ['；第二次合法下发', '；该缺陷最终导致第二次合法下发']],
  ['aircipher-sector-resync-bug4-state-persistence-002', ['；终态任务', '；该缺陷最终导致终态任务']],
  ['dnssec-rotation-closure-bug2-protocol-recovery-001', ['；另一个任务', '；该缺陷最终导致另一个任务']],
  ['dnssec-rotation-closure-bug7-7', ['；HTTP 请求取消后', '；该缺陷最终导致 HTTP 请求取消后']],
  ['dnssec-rotation-closure-bug8-8', ['；两个使用不同', '；该缺陷最终导致两个使用不同']],
  ['orbitwake-telemetry-seal-bug6-ow-bug-011', ['；两个不同 telemetry', '；该缺陷最终导致两个不同 telemetry']],
  ['orbitwake-telemetry-seal-bug7-ow-bug-012', ['；第二份摘要', '；该缺陷最终导致第二份摘要']],
  ['windowproof-fenestration-triple-test-bug4-repair-generation-leaks-occupa', ['；终态任务', '；该缺陷最终导致终态任务']],
  ['windowproof-fenestration-triple-test-bug7-state-lifecycle-restart-token-', ['。旧任务仍占用', '；该缺陷最终导致旧任务仍占用']],
]);

const legacyExportRoots = new Map(Object.entries({
  'go-chi-streaming-tee-byte-accounting': 'middleware/wrap_writer.go 中的 (*httpFancyWriter).ReadFrom 根本原因是启用 Tee 后，该方法通过 io.Copy 调用 basicWriter.Write，后者已经写入响应和 Tee 并累加字节数，但 ReadFrom 返回后又把 n 累加一次；该重复累加最终导致流式写出与 Tee 同时启用时 BytesWritten 翻倍，而响应正文并未重复。',
  'fatih-color-fprint-byte-count': 'color.go 中的 (*Color).Fprint、(*Color).Fprintf、(*Color).setWriter、(*Color).unsetWriter 根本原因是 Fprint 和 Fprintf 只返回正文写入的字节数，前置 SGR 与末尾 reset 的写入计数和错误均被丢弃；该遗漏最终导致启用颜色时返回计数小于实际写入字节数，前后缀写入失败也无法传播。',
  'google-cmp-large-string-diff-context': 'cmp/report_compare.go 中的 FormatDiff、verbosityPreset 根本原因是最大 verbosity preset 只有 3，且 FormatDiff 对所有非 identical diff 无条件调用 WithVerbosity(3)，覆盖上层为长字符串选择的更高详细度；该覆盖最终导致格式器退回摘要层级，只显示大量相同字节而不显示真正变化的尾部。',
  'gorilla-websocket-client-subprotocol-order': 'server.go 中的 (*Upgrader).selectSubprotocol 根本原因是子协议选择逻辑先遍历服务端配置、再遍历客户端请求，错误地按服务端偏好返回第一个交集；该颠倒最终导致双方支持多个相同协议但顺序不同时，服务端没有按客户端声明顺序选择协议。',
  'hashicorp-multierror-nil-len': 'sort.go 中的 (*Error).Len 根本原因是 Len 使用值接收者，Go 在进入方法体前会为该调用隐式解引用 nil 的 *Error；该接收者定义最终导致对 nil *Error 调用 Len 时发生 nil pointer panic。',
  'mitchellh-mapstructure-array-to-slice-panic': 'mapstructure.go 中的 (*Decoder).decodeSlice 根本原因是该方法虽然同时接受 slice 和 array，却在两类输入共用的 nil 检查中无条件调用 reflect.Value.IsNil；该错误调用最终导致 array 输入在 IsNil 处直接 panic。',
  'spf13-cobra-completion-osargs-alias': 'completions.go 中的 (*Command).getCompletions 根本原因是代码错误地使用 args[:len(args)-1] 创建 trimmedArgs，使其继续与调用方参数共享底层数组，随后 TraverseChildren 路径向该切片 append("--")；该切片别名最终导致原数组有剩余容量时 os.Args 中的用户参数被原地覆盖为 "--"。',
  'urfave-cli-completion-before-terminator': 'command_run.go 中的 (*Command).run、runBefore、runCompletion 根本原因是 run 识别补全请求后无条件执行 runBefore，直到 runCompletion 内部才检查 "--" 终止符；该检查后置最终导致终止符后的补全请求虽然不产生建议，却已经执行带副作用的 Before 链。',
  'x-sync-semaphore-canceled-acquire': 'semaphore/semaphore.go 中的 (*Weighted).Acquire 根本原因是快速路径在检查 ctx.Done 前直接增加 cur 并返回 nil，排队路径在 ready 与 ctx.Done 同时可读时也可能接受许可且不再复查取消；该检查顺序最终导致取消先于资源可用时 Acquire 仍成功并让调用方意外持有许可。',
  'gjson-empty-string-query': 'gjson.go 中的 parseArrayPath 根本原因是数组查询解析只在带引号值长度大于 2 时去除首尾双引号，长度恰为 2 的空字符串因此仍携带引号进入比较器；该边界判断最终导致 #(!="")# 无法排除空字符串元素。',
  'sjson-escaped-dot-key-update': 'sjson.go 中的 parsePath、appendRawPaths 根本原因是 parsePath 拆出含转义点的真实键名后，appendRawPaths 回退查找仍把未保留转义符的 part 传给 gjson.Get；该路径丢失最终导致 gjson 把字面点解释为嵌套分隔符，Set 和 Delete 找不到目标并返回 no change。',
  'pflag-nil-default-ip-get': 'ip.go 中的 ipConv、(*FlagSet).GetIP 根本原因是 nil 默认值经 flag.Value.String 转为空字符串后，GetIP 再调用只接受非空地址的 ipConv，并把空字符串判为非法；该转换缺口最终导致 nil net.IP 默认值无法正常往返。',
  'testify-suite-skip-stats-panic': 'suite/suite.go 中的 Run、SuiteInformation.start、SuiteInformation.end 根本原因是 Run 在 SetupTest 之后才调用 stats.start，而测试的 defer 无条件调用 stats.end；该顺序错误最终导致 SetupTest 调用 T.Skip 时没有创建对应统计项，HandleStats 缺少该测试且结束统计时可能发生 nil 访问。',
  'cast-typed-nil-pointer-conversion': 'indirect.go 中的 indirect 根本原因是反射解引用循环只处理非 nil 指针，typed nil 指针因此保留为带 nil 值的具体指针类型，后续转换函数无法将其识别为 nil；该遗漏最终导致 ToBool、ToString 等返回错误而不是安全零值。',
  'zerolog-console-malformed-level-panic': 'console.go 中的 consoleDefaultFormatLevel、stripLevel 根本原因是格式化无法 ParseLevel 的额外 level 字段时，无条件执行 strings.ToUpper(value)[0:3]；该未校验切片最终导致空字符串或短字符串发生越界 panic。',
  'sqlx-fixbound-missing-values-panic': 'named.go 中的 fixBound 根本原因是该函数用 FindStringIndex 查找 ) VALUES ( 后只检查 len(loc) < 1，未找到时仍继续访问 loc[1]；该长度校验错误最终导致没有 VALUES 子句的批量 named query 发生切片越界 panic。',
  'flightcache-manual-clock-timer-repeat-fire': 'clock.go 中的 (*ManualClock).Advance、(*manualTimer).Stop、(*manualTimer).Reset 根本原因是一次性计时器到期并发送事件后，Advance 没有设置 manualTimer.active=false，使它继续保留在 ManualClock.timers；该状态遗漏最终导致后续 Advance 重复触发旧计时器，Stop 和 Reset 也按错误的活动状态处理。',
  'chronofold-chronofold-invalid-ingest-consumes-series-capacity': 'engine/engine.go 中的 (*Engine).ingestOne、engine/directory.go 中的 (*Directory).GetOrCreate、engine/series.go 中的 (*Series).Add 根本原因是 ingestOne 在 Series.Add 完成输入校验前调用 Directory.GetOrCreate，提前发布新 Series 并增加 metricCounter 基数，Add 返回 invalid_delta 后又没有回退；该执行顺序最终导致无效写入留下空序列并永久占用 max_series 配额。',
  'ackledger-bug1': 'internal/api/server.go 中的 writeLedgerError 根本原因是该函数把 ledger.ErrConflictResult 与 ledger.ErrConflict 合并到同一 switch 分支，并统一输出 code=conflict；该错误合并最终导致 Complete 使用相同 completion_key 提交不同 result_payload 时丢失 conflicting_result 错误契约。',
}));

const archivedTaskRoots = new Map(Object.entries({
  'nyh-go-0247-bug-03': 'cmd/torquechain/main.go、internal/ledger/service.go 中的 seedTokens、ledger.SeedTokens 根本原因是每次启动都调用 seedTokens，而 ledger.SeedTokens 在事务中无条件重复插入固定 TOK-001..TOK-010；该非幂等初始化最终导致已有数据库恢复时发生主键冲突，main 直接退出且服务无法完成启动。',
  'nyh-go-0246-bug-09': 'service/cure.go、cure/duty.go、store/repos_seam.go 中的 service.processCureAttempt 根本原因是窗口外读数被以 retryable/SENSOR_FORMAT 且不含 reading 数据的形式持久化，而完成判定只加载 accepted 读数，仍沿用此前的有效跨度和已到期 DueAt；该过滤缺口最终导致异常观测被忽略，duty 仍被错误标记为 completed。',
  'nyh-go-0250-bug-09': 'internal/store/sqlite.go、internal/service/pressure.go、internal/service/retry.go 中的 SubmitPressureStep、RetryAttempt 根本原因是 SubmitPressureStep 在写事务中保存 pending attempt 后调用仪器，请求取消时后续 SaveAttempt(ctx) 因 context.Done 失败，Write 又用同一取消 context 执行 ROLLBACK 且忽略错误；该事务清理失败最终导致连接关闭后 pending attempt 残留，run 返回 STORE_UNAVAILABLE，而 RetryAttempt 因只接受 failed 状态无法恢复该调用。',
  'nyh-go-0246-bug-10': 'service/cure.go、store/repos_seam.go、store/sqlite.go 中的 (*service.Service).processCureAttempt 根本原因是 completion 请求先计算证据并 Upsert 已完成义务，随后 SensorAttempt 的 INSERT 失败时错误被忽略，代码仍继续计算完成情况并提交事务；该错误吞掉最终导致接口返回 OK 和完成证据、义务状态已 completed，却没有对应的 completion 尝试记录。',
}));

async function readJson(filename, fallback = null) {
  return fsp.readFile(filename, 'utf8').then(JSON.parse).catch(() => fallback);
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, filename);
}

function rootMechanism(rootCause, fallback = '') {
  const text = String(rootCause || '').trim();
  const marker = '根本原因是';
  const markerIndex = text.indexOf(marker);
  return markerIndex >= 0 ? text.slice(markerIndex + marker.length).trim() : String(fallback || '').trim();
}

function structuredRoot(context, mechanism) {
  return `${context.gold_files.join('、')} 中的 ${context.gold_symbols.join('、')} 根本原因是${mechanism}`;
}

function migrateTaskRoot(taskName, publicRecord, context) {
  const structured = {
    gold_root_cause: publicRecord.gold_root_cause,
    gold_files: context?.gold_files,
    gold_symbols: context?.gold_symbols,
  };
  if (!getGoldRootCauseRuleIssues(structured).length) return publicRecord.gold_root_cause;
  if (!Array.isArray(context?.gold_files) || !context.gold_files.length
    || !Array.isArray(context?.gold_symbols) || !context.gold_symbols.length) return null;

  let mechanism = rootMechanism(publicRecord.gold_root_cause, context.failure_mechanism);
  let candidate = structuredRoot(context, mechanism);
  if (!getGoldRootCauseRuleIssues({ ...structured, gold_root_cause: candidate }).length) return candidate;

  const replacement = taskCausalMarkers.get(taskName);
  if (!replacement || !mechanism.includes(replacement[0])) return null;
  mechanism = mechanism.replace(replacement[0], replacement[1]);
  candidate = structuredRoot(context, mechanism);
  return getGoldRootCauseRuleIssues({ ...structured, gold_root_cause: candidate }).length ? null : candidate;
}

async function migrateTasks() {
  const result = { total: 0, valid: 0, changed: 0, unresolved: [] };
  for (const entry of await fsp.readdir(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    result.total += 1;
    const taskDir = path.join(tasksRoot, entry.name);
    const publicPath = path.join(taskDir, 'public.json');
    const [publicRecord, context] = await Promise.all([
      readJson(publicPath),
      readJson(path.join(taskDir, 'grader/v4-context.json')),
    ]);
    if (!publicRecord || !context) {
      result.unresolved.push({ task: entry.name, reason: '缺少 public.json 或 grader/v4-context.json' });
      continue;
    }
    const migrated = migrateTaskRoot(entry.name, publicRecord, context);
    if (!migrated) {
      result.unresolved.push({ task: entry.name, reason: '无法在不改变根因事实的前提下自动迁移' });
      continue;
    }
    if (migrated === publicRecord.gold_root_cause) {
      result.valid += 1;
      continue;
    }
    if (shouldWrite) {
      const latest = await readJson(publicPath);
      latest.gold_root_cause = migrated;
      await writeJsonAtomic(publicPath, latest);
    }
    result.changed += 1;
  }
  return result;
}

async function migrateExportRecords() {
  const records = await readJson(exportRecordsPath, []);
  const result = { total: records.length, valid: 0, changed: 0, unresolved: [] };
  for (const record of records) {
    if (!getGoldRootCauseRuleIssues(record.gold_root_cause).length) {
      result.valid += 1;
      continue;
    }
    const migrated = legacyExportRoots.get(String(record.bug_id || ''));
    const issues = getGoldRootCauseRuleIssues(migrated || '');
    if (!migrated || issues.length) {
      result.unresolved.push({ bug_id: record.bug_id, issues });
      continue;
    }
    record.gold_root_cause = migrated;
    result.changed += 1;
  }
  if (shouldWrite && result.changed) await writeJsonAtomic(exportRecordsPath, records);
  return result;
}

async function migrateArchivedTasks() {
  const records = await readJson(archivedTasksPath, []);
  const result = { total: records.length, valid: 0, changed: 0, unresolved: [] };
  for (const record of records) {
    if (!getGoldRootCauseRuleIssues(record.gold_root_cause).length) {
      result.valid += 1;
      continue;
    }
    const migrated = archivedTaskRoots.get(String(record.bug_id || ''));
    const issues = getGoldRootCauseRuleIssues(migrated || '');
    if (!migrated || issues.length) {
      result.unresolved.push({ bug_id: record.bug_id, issues });
      continue;
    }
    record.gold_root_cause = migrated;
    result.changed += 1;
  }
  if (shouldWrite && result.changed) await writeJsonAtomic(archivedTasksPath, records);
  return result;
}

const summary = {
  mode: shouldWrite ? 'write' : 'dry-run',
  tasks: await migrateTasks(),
  exportRecords: await migrateExportRecords(),
  archivedTasks: await migrateArchivedTasks(),
};
console.log(JSON.stringify(summary, null, 2));
if (summary.tasks.unresolved.length
  || summary.exportRecords.unresolved.length
  || summary.archivedTasks.unresolved.length) process.exitCode = 1;
