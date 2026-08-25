import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isChineseDescription } from '../src/export-rules.js';

const ROOT_CAUSES = new Map(Object.entries({
  'nyh-go-0246-bug-09': 'service/cure.go、cure/duty.go、store/repos_seam.go 中的 service.processCureAttempt 根本原因是有效读数达到要求时长后，窗口外读数被以 retryable/SENSOR_FORMAT 且不含 reading 数据的形式持久化；完成判定只加载 accepted 读数，仍看到此前的有效跨度且 DueAt 已到，于是忽略异常观测并把 duty 标记为 completed。',
  'nyh-go-0252-bug-01': 'internal/service/rotation.go、internal/service/signing.go、internal/lease/sqlledger.go、internal/store/schema.go 中的 RotationService.Lock 根本原因是 Lock 通过 ResourceKeyGeneration 租约保留 KSKNew/ZSKNew，重复检测依赖活动租约唯一索引；Finalize 对整个任务调用 lease.Release，把密钥代次租约也改为 released，导致后续 Lock 可以再次占用相同 zone/role/tag 的密钥代次。',
  'nyh-go-0252-bug-02': 'internal/service/idempotency.go、internal/service/signing.go、internal/store/schema.go 中的 RotationService.idemCheck 根本原因是签名请求只按 operation_id 写入幂等记录，请求摘要不包含路由中的 task id；另一个任务使用相同 operation id 和 JSON 内容时会在状态校验前命中重放分支，直接读取第二个任务的当前 prefix 并返回成功，却没有调用 HSM 或写入 signature_evidence。',
  'nyh-go-0252-bug-03': 'internal/service/signing.go、internal/store/schema.go 中，根本原因是已接受的发布路径按 task/stage/server 写入 publish_evidence；后到的摘要不匹配回执调用 recordRejected 并复用 recordPublish，其 ON CONFLICT 无条件把摘要和状态覆盖为 rejected；stageComplete 只统计 accepted 行，因此原有服务器证据从仲裁数量中消失，任务在其他服务器已接受后仍卡在 DNSKEY 阶段。',
  'nyh-go-0252-bug-04': 'internal/arbitrator/sqlarbiter.go、internal/catalog/catalog.go 中的 RecordProbe 根本原因是探针接口只校验 generation 和 digest，却允许任意 target 持久化为证据；EvidenceClosed 仅统计任务下 passing 行数并与 len(Catalog.ProbeTargets()) 比较，两个未配置目标的通过记录即可满足数量门槛，使任务在没有任何配置解析器证据时从 probing 推进到 ready_to_activate。',
  'nyh-go-0252-bug-05': 'internal/service/signing.go、internal/service/idempotency.go、internal/signature/sqlledger.go 中的 RotationService.Sign 根本原因是首次签名只在 idempotency_results 中保存 status_code=ok，没有保存响应正文；后续签名推进 rotation_tasks.signature_prefix 后，第一次操作的重放分支读取当前 prefix，导致公开响应返回后来的任务状态而不是首次提交时的原始结果。',
  'nyh-go-0252-bug-06': 'internal/arbitrator/sqlarbiter.go、internal/service/signing.go 中，根本原因是 Cancel 可以从任意开放状态执行，而 sqlArbiter.Finalize 更新 rotation_tasks.state 和 terminal 时没有推进 revision；RotationService.Finalize 又固定使用 from_state=ready_to_activate 写审计，导致持久化版本和审计转换链与真实起始状态不一致。',
  'nyh-go-0252-bug-07': 'cmd/rotationsvc/handlers.go 中的 (*server).handleSign 根本原因是处理签名请求时把 context.Background() 传给 s.svc.Sign，而不是传递 r.Context()；HTTP 请求取消后，RotationService.Sign 仍继续执行 Store.WithTx 和 HSM 签名，并提交 signature_evidence 与 rotation_tasks.signature_prefix，随后可通过 GET /api/rotations/{id} 观察到本应取消的写入。',
  'nyh-go-0252-bug-08': 'internal/service/rotation.go 中的 (*RotationService).AcquireLeases 根本原因是构造租约资源时只加入 HSM slot，没有把 rt.LockDigest.AuthoritativeServers 追加为 ResourceAuthoritativeServer；两个使用不同 HSM 槽位但共享权威服务器的开放轮换会同时获取不完整租约并进入 signing，破坏服务器资源互斥。',
  'nyh-go-0252-bug-09': 'internal/store/store.go 中的 (*Store).WithTx 根本原因是普通错误路径在返回错误前仍提交事务，而不是回滚；RotationService.AcquireLeases 写入前几个 HSM/权威服务器租约后，在重复资源的活动租约唯一索引处失败，已写入的部分租约却被提交，导致后续独立轮换把这些残留行视为活动冲突。',
  'nyh-go-0252-bug-10': 'internal/service/signing.go 中的 (*RotationService).retryOne 根本原因是成功重试后按 kind=hsm_sign 批量删除 pending_calls，而不是只按当前 id 删除已消费行；RetryPending 处理一个到期任务并推进签名后，会同时清除其他任务的待重试记录，使后续轮询没有可重放的持久任务。',
  'nyh-go-0253-bug-01': 'api/handlers.go、service/receipts.go、service/challenges.go、task/task.go 中的 Server.handleReceipts 根本原因是 SubmitReceipt 在任务仍处于 challenge_issuing 时接受回执，并立即把整个任务推进到 receipt_verifying；SendNextChallenge 只允许 channel_occupied 或 challenge_issuing，导致挑战前缀尚未完成的终端不能继续下发，checkReady 也永远无法成立。',
  'nyh-go-0253-bug-02': 'adapter/scripted.go、api/adapter_control.go、service/challenges.go、api/api.go 中的 adapter.Scripted 根本原因是控制接口并发调用 Set、SetByTerminal、Reset 修改共享脚本表时，SendChallenge 同时读取并删除 Remaining 条目；脚本表使用未加锁的 map，最终产生数据竞态、不稳定脚本结果或 fatal concurrent map writes。',
  'nyh-go-0253-bug-03': 'store/sqlite_tasks.go、service/challenges.go 中的 (*sqliteTx).SaveTask 根本原因是第一次 SendNextChallenge 把任务从 channel_occupied 推进到 challenge_issuing 并持久化 revision=3；第二次合法下发只更新账簿且任务 revision 仍为 3，但 service/challenges.go 仍调用 SaveTask，SQL 条件 revision < ? 因新旧 revision 相等而得到 RowsAffected=0，返回 stale 冲突并回滚 prefix、adapter_calls 和幂等写入。',
  'nyh-go-0253-bug-04': 'service/reviews.go、store/sqlite_ledgers.go、service/recovery.go 中的 (*Service).Finalize 根本原因是终局事务只认领 final_result 并保存 admitted/risk/cancelled 状态，没有调用租约账簿释放操作；终态任务的 leases.released_at_tick 仍为 NULL，后续 Start 调用 Acquire 时持续把相同资源判为占用，必须等到服务重启后的 Recover 才会释放。',
  'nyh-go-0253-bug-05': 'service/recovery.go、service/challenges.go、store/sqlite_ledgers.go、service/service.go 中的 (*Service).Recover 根本原因是恢复流程只根据逻辑时钟和到期时间释放租约，没有转换或隔离原租约所属的活动任务；新任务可以取得已释放的 sector/slot/key，而旧任务仍停留在 channel_occupied/challenge_issuing，SendNextChallenge 又不校验当前开放租约所有权，导致两个任务在同一资源上继续推进。',
  'nyh-go-0253-bug-06': 'lease/lease.go 中的 Acquisition.Resources 根本原因是密钥代次被构造成包含 SectorID 的 ResourceID，而不是全局 KeyResourceID；不同扇区使用同一 KeyGeneration 时会生成不同租约键，Acquire 无法识别全局密钥代次冲突，两个任务因此可以同时持有本应互斥的 key generation。',
  'nyh-go-0253-bug-07': 'service/reviews.go 中的 (*Service).Finalize 根本原因是终局处理缺少 arbiter.SupportedDecision(reviews, decision) 校验；即使两名合格复核人都支持 readmit，请求仍可提交 risk_isolate，tx.Finalize 会认领该 final_result 并让 Task.Finalize 进入没有复核证据支持的终态。',
  'nyh-go-0253-bug-08': 'service/receipts.go 中的 countValidTerminals 根本原因是在每个 rv.Valid 挑战序列上直接执行 valid++，没有通过终端级 hasValid 标志去重；同一终端的两条有效回执会被计为两个终端并提前满足 threshold，使 checkReady 在其他锁定终端尚无有效证据时推进任务。',
  'nyh-go-0253-bug-09': 'task/snapshot.go 中的 LockedSnapshot.SnapshotDigest 根本原因是遍历 chals 时没有把 len(c.Bytes) 和 c.Bytes 写入摘要；挑战终端、序号等字段不变时，篡改挑战字节仍产生相同 SnapshotDigest，使基于错误挑战材料计算的授权被接受并允许任务启动。',
  'nyh-go-0253-bug-10': 'store/sqlite_ledgers.go 中的 queryPendingCalls 根本原因是查询只按 status=pending_retry 和 next_retry_tick 到期筛选，没有使用关联子查询限制同一 task/terminal/sequence 的最新 attempt；attempt 2 已成功交付后，旧的 attempt 1 仍会再次进入重试队列，引发重复下发和 prefix 冲突。',
}));

const PIPELINE_PROJECTS = new Map([
  ['pipeline-20260823105248-15508c0f', '0252'],
  ['pipeline-20260823153352-803044df', '0253'],
]);

function mechanismFromRootCause(value) {
  return String(value).split('根本原因是').slice(1).join('根本原因是').trim();
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

async function migratePublicTasks(libraryRoot) {
  const tasksRoot = path.join(libraryRoot, 'tasks');
  const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filename = path.join(tasksRoot, entry.name, 'public.json');
    const record = JSON.parse(await fs.readFile(filename, 'utf8').catch(() => 'null'));
    const rootCause = ROOT_CAUSES.get(record?.bug_id);
    if (!rootCause) continue;
    record.gold_root_cause = rootCause;
    await writeJsonAtomic(filename, record);
    count += 1;
  }
  return count;
}

async function migratePipelineJobs(libraryRoot) {
  let count = 0;
  for (const [pipelineId, project] of PIPELINE_PROJECTS) {
    const filename = path.join(libraryRoot, 'pipeline-jobs', pipelineId, 'job.json');
    const job = JSON.parse(await fs.readFile(filename, 'utf8'));
    for (const bug of job.bugs || []) {
      const index = Number(bug?.bugIndex || bug?.discovery?.bug_id || 0);
      const bugId = `nyh-go-${project}-bug-${String(index).padStart(2, '0')}`;
      const rootCause = ROOT_CAUSES.get(bugId);
      if (!rootCause) continue;
      const mechanism = mechanismFromRootCause(rootCause);
      if (bug.discovery) bug.discovery.failure_mechanism = mechanism;
      if (bug.naturalDiscovery) bug.naturalDiscovery.failure_mechanism = mechanism;
      count += 1;
    }
    await writeJsonAtomic(filename, job);
  }
  return count;
}

async function migrateArchive(libraryRoot) {
  const filename = path.join(libraryRoot, 'validation', 'archived_tasks.json');
  const archive = JSON.parse(await fs.readFile(filename, 'utf8'));
  let count = 0;
  for (const record of archive) {
    const rootCause = ROOT_CAUSES.get(record.bug_id);
    if (!rootCause) continue;
    record.gold_root_cause = rootCause;
    count += 1;
  }
  await writeJsonAtomic(filename, archive);
  return count;
}

async function main() {
  const libraryRoot = path.resolve(process.argv[2] || path.join(process.cwd(), '..', '.task_work', 'go-task-library'));
  for (const [bugId, rootCause] of ROOT_CAUSES) {
    if (!isChineseDescription(rootCause)) throw new Error(`${bugId} 的迁移根因仍包含英文叙述`);
  }
  const publicTasks = await migratePublicTasks(libraryRoot);
  const pipelineBugs = await migratePipelineJobs(libraryRoot);
  const archivedTasks = await migrateArchive(libraryRoot);
  console.log(`已迁移中文根因：活动任务 ${publicTasks} 条，流水线记录 ${pipelineBugs} 条，归档任务 ${archivedTasks} 条`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
