import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { isChineseDescription } from '../src/export-rules.js';

const ROOT_CAUSES = new Map(Object.entries({
  'nyh-go-0254-bug-01': 'internal/httpapi/server.go、internal/httpapi/handlers.go、internal/aggregate/lease.go、internal/aggregate/helpers.go、internal/store/sqlite.go、internal/store/audit_store.go 中的 Aggregate.AcquireLeases 根本原因是 POST /api/missions/{id}/leases/acquire 虽把路径中的 mission id 传给 Aggregate.AcquireLeases，但 LeaseRequest 的幂等摘要只包含 generation；SQLite 主键和 idempotencyQ 仅按 op_key、operation_kind 查询，resolveIdempotency 也未校验 rec.MissionID 或 rec.Generation 是否匹配当前任务。第二个 generation=1 的任务复用相同 op_key 时被误判为幂等重放，buildLeaseResult 随后读取该任务的空租约账簿并返回 200，实际没有插入租约，状态仍为 pending_authorization。',
  'nyh-go-0254-bug-02': 'internal/httpapi/handlers.go、internal/aggregate/review.go、internal/aggregate/vessel.go、internal/aggregate/helpers.go、internal/store/audit_store.go、internal/store/mission_store.go 中的 Aggregate.RecordVesselConfirmation 根本原因是 RecordReview 只有在评审端点中检查 reviewComplete(reviews) 与 vesselConfirmed(attempts) 并更新 StateLaunchable；RecordVesselConfirmation 写入成功船端确认后仅返回 Confirmed=true，没有复查评审是否已完成，也没有更新 missions.state。先完成评审再确认船端时，GET 从账簿重建出的两个布尔值都为 true，但任务行仍停在 pending_vessel_confirmation。',
  'nyh-go-0254-bug-03': 'internal/httpapi/handlers.go、internal/aggregate/segment.go、internal/aggregate/helpers.go、internal/store/evidence_store.go、internal/store/audit_store.go 中的 Server.handleSimulate 根本原因是 SimulateSegment 虽在处理前调用 resolveIdempotency，但 unknown、duplicate、skipped、适配器失败和模拟器失败等 retry/fail 分支会直接返回 recordSegmentRetry；recordSegmentRetry 只写入 segment_evidence 并构造结果，没有在同一事务中保存幂等记录。相同 op_key 再次送达时查不到首次决定，于是追加新的 attempt_no 和前驱指针。',
  'nyh-go-0254-bug-04': 'internal/aggregate/lease.go、internal/aggregate/helpers.go 中的 Aggregate.AcquireLeases 根本原因是函数先加载任务并检查终态、代次和 pending_authorization 状态，之后才调用 resolveIdempotency；首次成功请求写入租约、把状态推进到 leases_held 并保存幂等记录，完全相同的重试却先因当前状态为 leases_held 返回 STATE_TRANSITION_INVALID，无法读取已经提交的成功结果。',
  'nyh-go-0254-bug-05': 'internal/aggregate/lease.go、internal/store/sqlite.go、internal/store/lease_store.go 中的 Aggregate.AcquireLeases 根本原因是 route_generation 租约使用 routeGenerationKey(m) 生成资源键，而该键包含 missionID 和 routeHashPrefix；开放租约唯一索引只约束 resource_type、resource_key，因此不同任务即使路线摘要相同也会得到不同资源键，两笔事务均可提交，导致同一路线包的代次互斥失效。',
  'nyh-go-0254-bug-06': 'internal/store/sqlite.go 中的 (*SQLite).WithTx 根本原因是事务回调返回错误后仍提交事务，而不是回滚；矛盾船端确认会先写入 adapter attempt，随后才返回 CONTRADICTORY_CONFIRMATION，错误路径提交使接口虽然返回冲突，第二条成功确认记录却仍留在审计和尝试账簿中。',
  'nyh-go-0254-bug-07': 'internal/httpapi/handlers.go 中的 (*Server).handleFinalize 根本原因是调用终局服务时使用 context.Background()，没有传递 r.Context()；HTTP 请求超时、取消或断开后，聚合事务仍继续更新终态、terminal_result、租约释放和 launch credential，导致调用方已经取消的请求仍产生持久化副作用。',
  'nyh-go-0254-bug-08': 'internal/aggregate/margins_math.go 中的 computeMargins 根本原因是累计 ExpectedDrawWh 时直接执行未检查的 int64 加法，删除了 add64 及 overflow 判断；多航点总能耗超过 int64 上限后回绕成较小有符号值，该错误值被写入余量证据并可能通过检查，使任务在没有返回稳定溢出错误的情况下继续推进。',
  'nyh-go-0254-bug-09': 'internal/store/sqlite.go 中的 (*SQLite).migrate 根本原因是 idx_leases_effective 被建立为覆盖全部 leases(resource_type, resource_key) 的普通唯一索引，没有使用 status=open 的部分索引条件；终局释放后历史行虽然已标记 released，仍参与唯一约束，后续任务即使预检不到开放租约，也无法重新获取相同 hull、beacon 或 route_generation 资源。',
  'nyh-go-0254-bug-10': 'internal/aggregate/finalize.go 中的 (*Aggregate).Finalize 根本原因是 ReleaseLeases 只在 req.Result 等于 FinalLaunch 时执行，取消和工程隔离分支仅更新终态与终态围栏，没有释放 hull、beacon 和 route-generation 开放租约；后续任务申请相同资源时持续收到 LEASE_CONFLICT。',
  'nyh-go-0256-bug-01': 'service/service.go、service/authorize.go、service/lease.go、service/ephemeris.go、service/capture.go、service/finalize.go 中的 Engine.idempotentResolve 根本原因是变更类处理器先加载任务并执行终态或阶段校验，之后才查询 operation_idempotency；首次操作提交并推进状态后，相同 operation_no 的重试会先被 INVALID_STATE 或 TERMINAL_STATE 拒绝。即使同阶段命中缓存，调用方也丢弃 ResponseJSON 并临时拼装不完整响应，AcquireLeases 还暴露了 OperationNo 却从未记录和解析幂等结果。',
  'nyh-go-0256-bug-02': 'service/lease.go、service/finalize.go、store/store.go、store/sqlite.go、lease/lease.go 中的 service.(*Engine).AcquireLeases 根本原因是租约冲突查询只认 active=1，而 Finalize 把旧任务推进到 sealed、reisolate 或 cancelled 并写入凭据后，没有任何存储接口把其 mount、receiver 和 window 租约标记为非活动；终态任务因此永久占用资源，阻止后续开放任务申请。',
  'nyh-go-0256-bug-03': 'service/service.go、service/lock.go、store/sqlite.go、cmd/orbitwake/main.go 中的 NewEngine 根本原因是每次进程启动都把 seq 初始化为 0，没有根据已打开数据库恢复序列；重启后的第一次 Lock 再次生成 m-1，emitAudit 也再次生成已有事件号。任务 upsert 命中旧 mission_id，随后审计主键冲突使事务回滚，HTTP 层把数据库错误映射为 INTERNAL，新任务无法创建。',
  'nyh-go-0256-bug-04': 'service/frames.go、receiver/receiver.go、store/sqlite.go 中的 SubmitFrames 根本原因是每次请求只根据锁定链路和 received_prefix_next 新建 Receiver，没有从持久化层恢复此前已接受帧的 digest 映射；Receiver.Accept 只有在私有 digests 中仍有旧记录时才能识别同摘要重复帧，因此跨 HTTP 请求或重启后的重复帧会被误判为 DIGEST_MISMATCH。',
  'nyh-go-0256-bug-05': 'store/sqlite.go 中的 (*SQLite).WithTx 根本原因是错误路径通过延迟 tx.Commit 提交事务，没有在回调返回错误时回滚；AcquireLeases 先为任务 B 写入不冲突的 mount 令牌，随后发现 receiver 或 window 冲突并返回 LEASE_CONFLICT，但部分 mount 租约仍被提交，GET /missions/{id} 因而暴露失败申请留下的活动资源。',
  'nyh-go-0256-bug-06': 'service/authorize.go 中的 authorizationComplete 根本原因是完成条件只统计不同审核人数量，没有继续要求资格集合至少包含 commander 和 telemetry；两个不同 telemetry 人员的授权被写入后，任务错误推进到 occupying，并允许在缺少 commander 授权的情况下申请设备租约。',
  'nyh-go-0256-bug-07': 'service/ephemeris.go 中的 (*Engine).appendEvidence 根本原因是追加证据时使用 evidence.NewChain() 建立空链，没有通过 evidence.BuildChain(existing) 重放已持久化版本；第二份摘要不同的有效链路读数面对空链检查时不会与首份有效证据冲突，SQLite 随后把它作为新的 valid=true 版本写入，破坏证据链一致性。',
  'nyh-go-0256-bug-08': 'service/frames.go 中的 (*Engine).SubmitFrames 根本原因是在记录首个非重复拒绝后错误执行 continue 而不是 break；接收器在期望序号 2 时拒绝序号 3，但服务仍继续处理同批次剩余切片并接受序号 2，SaveMission 随后把 received_prefix_next 持久化为 3，使已经出现流顺序违规的批次仍推进接收前缀。完整顺序批次仍应正常推进，单独一个乱序首帧仍应拒绝且不推进。',
  'nyh-go-0256-bug-09': 'evidence/integer.go 中的 SubChecked 根本原因是溢出分支返回 0、nil，而不是 ErrOverflow；锁定阶段接受 int64 最小值的船姿补偿后，AttitudeClosed 调用该函数并把溢出的差值当作 0，SubmitAttitude 随后写入 valid=true 的船姿证据，使本应拒绝的极端输入可以满足终局前置条件。',
  'nyh-go-0256-bug-10': 'service/finalize.go 中的 (*Engine).Finalize 根本原因是非 sealed 终局被错误允许从 pending_seal_review 执行，并直接赋值任务 state 和 FinalizedAtTick，绕过 Mission.Finalize 的领域状态机校验；尚未完成双人封存复核的 reisolate 请求因此可提前持久化终态任务和终局凭据。',
  'nyh-go-0257-bug-01': 'blindcode/gate.go、api/reviews.go、api/service.go、store/sqlite.go、store/schema.go 中的 Service.Finalize 根本原因是建检只针对非终态任务检查盲码冲突，因此新任务可以复用已放播批次的盲码；终局放播又调用仅存在于进程内、按盲码记忆历史的 MemoryGate.Open，使第二个任务完成全部检验后才被拒绝。持久化的 unblinded 状态没有用于初始化 gate，导致运行期间和重启后的裁定也不一致。',
  'nyh-go-0257-bug-02': 'store/sqlite.go、store/memory.go、api/cancel.go、api/rechamber.go、occupancy/release.go 中的 Service.releaseOccupancies 根本原因是终态和换舱流程调用 SaveOccupancy 保存 Release 或 Rechamber 结果时，内存与 SQLite 实现都追加新的生命周期行，没有更新或替代原 occupied 行；ListOpenOccupancies 和 memState.openOccupancies 仍把旧活动行返回给仲裁器，后续任务因此无法复用已经释放的舱位和板孔。',
  'nyh-go-0257-bug-03': 'store/schema.go、store/sqlite.go、api/pathogen.go、api/rejudge.go、pathogen/rejudge.go 中的 idx_pathogen_well 根本原因是病原证据唯一索引只允许每个 task_id、plate、well 组合存在一行；首条读数占用该键后，复判和迟到隔离仍要为同一孔追加 PathogenEvidence，sqliteTx.SavePathogen 因唯一约束失败并回滚，API 又把存储错误映射为 RICE_NOT_FOUND。',
  'nyh-go-0257-bug-04': 'store/schema.go、store/sqlite.go、store/memory.go、inspection/idempotency.go、api/split.go 中的 Service.SplitBlindSamples 根本原因是 operations 仅以 operation_id 为键，FindOperation 返回记录后没有校验请求中的 task ID 或 generation；分管请求又固定使用 Digest(split)，不同任务复用相同 operation ID 时摘要完全一致，于是第二个任务在加载和修改自身状态前就重放了第一个任务的缓存响应。',
  'nyh-go-0257-bug-05': 'inspection/idempotency.go、store/sqlite.go、store/memory.go、api/pathogen.go 中的 Service.RecordPathogen 根本原因是扩增仪耗尽重试后，recordRetryableOperation 保存 ResponseCode=RICE_DEVICE_RETRYABLE 但没有结果正文；相同请求重放时只校验摘要，再把空 ResultDigest 解码为零值 PathogenResponse 并返回 nil，导致已持久化失败结果被错误重放为空成功。',
  'nyh-go-0257-bug-06': 'api/service.go、inspection/idempotency.go、store/sqlite.go、store/schema.go、store/store.go 中的 Service.CreateTask 根本原因是在进入 Store.Mutate 前查询 FindOperation，两个并发相同 operation ID 的请求都可能读到不存在；首个事务提交任务和幂等记录后，第二个事务没有在事务内复查 operation，而是继续执行盲码和 seed_lot 唯一性判断，最终返回资源冲突而不是重放首个任务响应。',
  'nyh-go-0257-bug-07': 'api/pathogen.go、pathogen/retry.go、store/store.go 中的 Service.RecordPathogen 根本原因是在加载任务并校验状态、板孔和盲码之前就调用 runAmplifier；扩增仪返回可重试错误时，persistAttempts 只凭任务存在便提交全部尝试和审计事件，使仍处于 pending_sampling 的任务也会消耗设备脚本并留下病原重试状态。',
  'nyh-go-0257-bug-08': 'api/pathogen.go、store/schema.go、store/sqlite.go 中的 Service.RecordPathogen 根本原因是旧代次读数通过 isolateLate 写入 late_isolated 行时，使用了与当前真实读数相同的 task_id、plate、well 唯一身份；迟到行先占用 idx_pathogen_well 后，当前代次证据因唯一约束失败并被 asDomain 映射为 RICE_NOT_FOUND，导致板孔无法闭合。',
  'nyh-go-0257-bug-09': 'api/pathogen.go、api/summary.go、inspection/status.go 中的 Service.RecordPathogen 根本原因是 allWellsCovered 和 wellCovered 只按 plate、well 统计覆盖，没有把 blind code 纳入键；多盲码任务中，一个盲码为所有板孔提交读数后就会满足覆盖条件并推进到 moisture，其他已锁定盲码即使没有任何病原证据也被视为完成。',
}));

const USER_QUERIES = new Map(Object.entries({
  'nyh-go-0254-bug-05': '两条 VGR-01 任务使用相同 waypoint 路线包，但选择 HULL-01/BEACON-01 和 HULL-02/BEACON-02 分别走完授权后，第二条也能成功 acquire leases；控制台显示两条非终态任务都持有 route_generation 租约。为什么同一路线包没有互斥？\n\n公开复现步骤：在进程内通过 API 创建任务 A 和任务 B，两者使用同一路线 R 但使用不同 hull 与 beacon；分别完成授权和租约申请，再查询两条任务详情。',
  'nyh-go-0256-bug-01': '在任务授权、设备占用或最终封存接口里，客户端超时后用相同 operation_no 重试。只要任务阶段已经被另一个请求推进，重试没有返回第一次的结果，反而变成 INVALID_STATE 或 TERMINAL_STATE。帮忙看为什么幂等重试不稳定。\n\n公开复现步骤：依次调用任务锁定接口，再用 operation_no=a1 完成首次授权，随后用 operation_no=a2 推进到 occupying，最后用完全相同的 operation_no=a1 和请求体重试首次授权。',
  'nyh-go-0256-bug-03': '服务用同一个 SQLite 库重启后，GET 老任务正常，但再次锁定新的卫星过境任务失败，接口返回内部错误，无法继续创建新任务。请排查为什么重启后不能继续接任务。\n\n公开复现步骤：使用持久化 ORBITWAKE_DB 启动服务并锁定一个任务，停止后用同一数据库重启，再提交任意合法快照锁定第二个任务。',
}));

const PIPELINE_PROJECTS = new Map([
  ['pipeline-20260823164900-34ef06db', '0254'],
  ['pipeline-20260823211015-8a8599f9', '0256'],
  ['pipeline-20260824012050-97cdc64d', '0257'],
]);

function mechanismFromRootCause(value) {
  return String(value).split('根本原因是').slice(1).join('根本原因是').trim();
}

function chineseTitle(record, rootCause) {
  const lead = String(rootCause || '').split('根本原因是')[0].replace(/[，,\s]+$/u, '');
  const symbol = lead.match(/中的\s+([^、，]+)$/u)?.[1]?.trim();
  const subject = symbol && symbol.length <= 60 ? symbol : record?.bug_id;
  return `${subject || '任务'}${record?.task_type === 'diagnosis' ? '异常根因定位' : '缺陷修复'}`;
}

function chineseSuccessCriteria(record, rootCause) {
  if (record?.task_type !== 'diagnosis') return String(record?.success_criteria || '').trim();
  const lead = String(rootCause || '').split('根本原因是')[0].replace(/[，,\s]+$/u, '');
  const symbol = lead.match(/中的\s+([^、，]+)$/u)?.[1]?.trim();
  const target = symbol ? `${symbol} 的` : '';
  return `必须通过公开接口稳定复现题面描述的异常，准确定位${target}根本原因，并提供可核验的状态或持久化结果证据；诊断过程不得修改工作区代码。`;
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

function patchDeliveryRecord(record) {
  if (!record?.bug_id) return false;
  let changed = false;
  const mappedRootCause = ROOT_CAUSES.get(record.bug_id);
  if (mappedRootCause && record.gold_root_cause !== mappedRootCause) {
    record.gold_root_cause = mappedRootCause;
    changed = true;
  }
  const rootCause = record.gold_root_cause || mappedRootCause || '';
  const mappedQuery = USER_QUERIES.get(record.bug_id);
  if (mappedQuery && record.user_query !== mappedQuery) {
    record.user_query = mappedQuery;
    changed = true;
  }
  if (rootCause && !isChineseDescription(record.title || '')) {
    record.title = chineseTitle(record, rootCause);
    changed = true;
  }
  if (rootCause && !isChineseDescription(record.success_criteria || '')) {
    record.success_criteria = chineseSuccessCriteria(record, rootCause);
    changed = true;
  }
  return changed;
}

async function migratePublicTasks(libraryRoot) {
  const tasksRoot = path.join(libraryRoot, 'tasks');
  const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
  let changed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filename = path.join(tasksRoot, entry.name, 'public.json');
    const record = await readJson(filename).catch(() => null);
    if (!record || !patchDeliveryRecord(record)) continue;
    await writeJsonAtomic(filename, record);
    changed += 1;
  }
  return changed;
}

function patchDiscovery(discovery, bugId, taskType = '') {
  if (!discovery) return false;
  const mappedRootCause = ROOT_CAUSES.get(bugId);
  const existingMechanism = String(discovery.failure_mechanism || '').trim();
  if (!mappedRootCause && !isChineseDescription(existingMechanism)) return false;
  const files = Array.isArray(discovery.target_files) ? discovery.target_files.filter(Boolean).join('、') : '';
  const symbols = Array.isArray(discovery.symbols) ? discovery.symbols.filter(Boolean).join('、') : '';
  const rootCause = mappedRootCause || `${files || '已定位文件'} 中的 ${symbols || '已定位符号'} 根本原因是${existingMechanism}`;
  let changed = false;
  const set = (key, value) => {
    if (value && discovery[key] !== value) {
      discovery[key] = value;
      changed = true;
    }
  };
  if (mappedRootCause) set('failure_mechanism', mechanismFromRootCause(rootCause));
  set('title', chineseTitle({ bug_id: bugId, task_type: taskType }, rootCause));
  set('user_query', USER_QUERIES.get(bugId));
  if (!isChineseDescription(discovery.success_criteria || '')) {
    set('success_criteria', chineseSuccessCriteria({ bug_id: bugId, task_type: taskType || 'diagnosis' }, rootCause));
  }
  if (!isChineseDescription(discovery.reason || '')) set('reason', '该候选已通过代码范围、独立根因和公开可复现性检查，适合作为当前问题。');
  if (!isChineseDescription(discovery.reproduction_evidence || '')) set('reproduction_evidence', '按照 user_query 描述的公开接口场景执行，可稳定观察到状态、响应或持久化结果与预期不一致。');
  if (!isChineseDescription(discovery.state_or_resource_impact || '')) set('state_or_resource_impact', '该缺陷会造成题面描述的公开状态、资源生命周期或持久化结果不一致。');
  if (!isChineseDescription(discovery.difficulty_evidence || '')) set('difficulty_evidence', '定位需要同时追踪目标符号、服务调用路径和持久化结果，不能只根据接口错误判断。');
  return changed;
}

function patchPipelineJob(job, project) {
  let changed = false;
  for (const bug of job?.bugs || []) {
    const index = Number(bug?.bugIndex || 0);
    if (!index) continue;
    const bugId = bug?.task?.bugId
      || (project ? `nyh-go-${project}-bug-${String(index).padStart(2, '0')}` : String(bug?.discovery?.bug_id || `bug-${index}`));
    const taskType = job?.request?.taskType || job?.request?.task_type || (project === '0257' ? 'bugfix' : 'diagnosis');
    changed = patchDiscovery(bug.discovery, bugId, taskType) || changed;
    if (bug.naturalDiscovery?.found) changed = patchDiscovery(bug.naturalDiscovery, bugId, taskType) || changed;
  }
  return changed;
}

function syncChineseDiscoveries(target, source) {
  let changed = false;
  const fields = ['reason', 'title', 'user_query', 'failure_mechanism', 'reproduction_evidence', 'success_criteria', 'state_or_resource_impact', 'difficulty_evidence'];
  for (const targetBug of target?.bugs || []) {
    const sourceBug = (source?.bugs || []).find((bug) => Number(bug?.bugIndex) === Number(targetBug?.bugIndex));
    if (!targetBug?.discovery || !sourceBug?.discovery) continue;
    for (const field of fields) {
      const value = sourceBug.discovery[field];
      if (!isChineseDescription(value || '') || targetBug.discovery[field] === value) continue;
      targetBug.discovery[field] = value;
      changed = true;
    }
  }
  return changed;
}

async function migratePipelineCopies(libraryRoot) {
  let changed = 0;
  const jobsRoot = path.join(libraryRoot, 'pipeline-jobs');
  const backupsRoot = path.join(libraryRoot, 'pipeline-refill', 'job-backups');
  const jobEntries = await fs.readdir(jobsRoot, { withFileTypes: true });
  const backupEntries = await fs.readdir(backupsRoot, { withFileTypes: true }).catch(() => []);
  const filenames = [
    ...jobEntries.filter((entry) => entry.isDirectory()).map((entry) => path.join(jobsRoot, entry.name, 'job.json')),
    ...backupEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => path.join(backupsRoot, entry.name)),
  ];
  for (const filename of filenames) {
    const job = await readJson(filename).catch(() => null);
    const pipelineId = String(job?.id || path.basename(filename, '.json'));
    const project = PIPELINE_PROJECTS.get(pipelineId) || '';
    let copyChanged = false;
    if (filename.startsWith(`${backupsRoot}${path.sep}`)) {
      const primary = await readJson(path.join(jobsRoot, pipelineId, 'job.json')).catch(() => null);
      if (primary) copyChanged = syncChineseDiscoveries(job, primary);
    }
    if (!job || (!patchPipelineJob(job, project) && !copyChanged)) continue;
    await writeJsonAtomic(filename, job);
    changed += 1;
  }
  return changed;
}

async function migrateGraderContexts(libraryRoot) {
  const tasksRoot = path.join(libraryRoot, 'tasks');
  const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
  let changed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const publicFile = path.join(tasksRoot, entry.name, 'public.json');
    const contextFile = path.join(tasksRoot, entry.name, 'grader', 'v4-context.json');
    const record = await readJson(publicFile).catch(() => null);
    const context = await readJson(contextFile).catch(() => null);
    const rootCause = ROOT_CAUSES.get(record?.bug_id);
    if (!context || !rootCause) continue;
    const mechanism = mechanismFromRootCause(rootCause);
    if (context.failure_mechanism === mechanism) continue;
    context.failure_mechanism = mechanism;
    await writeJsonAtomic(contextFile, context);
    changed += 1;
  }
  return changed;
}

async function migrateArchive(libraryRoot) {
  const filename = path.join(libraryRoot, 'validation', 'archived_tasks.json');
  const records = await readJson(filename).catch(() => null);
  if (!Array.isArray(records)) return 0;
  let changed = 0;
  for (const record of records) if (patchDeliveryRecord(record)) changed += 1;
  if (changed) await writeJsonAtomic(filename, records);
  return changed;
}

async function main() {
  const libraryRoot = path.resolve(process.argv[2] || path.join(process.cwd(), '..', '.task_work', 'go-task-library'));
  for (const [bugId, rootCause] of ROOT_CAUSES) {
    if (!isChineseDescription(rootCause)) throw new Error(`${bugId} 的迁移根因仍包含英文叙述`);
  }
  const publicTasks = await migratePublicTasks(libraryRoot);
  const pipelineCopies = await migratePipelineCopies(libraryRoot);
  const graderContexts = await migrateGraderContexts(libraryRoot);
  const archivedTasks = await migrateArchive(libraryRoot);
  console.log(JSON.stringify({ publicTasks, pipelineCopies, graderContexts, archivedTasks }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
