import assert from 'node:assert/strict';
import test from 'node:test';
import { assessProjectComplexity, assertProjectComplexity } from './project-complexity.js';
import { assessProjectDomain, assertProjectDomainAllowed, inferProjectDomainFamily, prohibitedProjectDomainPolicyText } from './project-domain-rules.js';

test('manageable project plans pass the V5 complexity budget', () => {
  const plan = {
    overview: '实现带并发任务队列和 SQLite 持久化的 Go 服务。',
    components: ['任务状态机', 'SQLite 存储', 'HTTP 管理接口', '确定性测试'],
    acceptance: ['并发提交不丢失', '重启后状态恢复', '非法状态返回稳定错误', '测试和双架构构建通过'],
  };
  const assessment = assertProjectComplexity(plan);
  assert.deepEqual(assessment.dimensions, ['concurrency', 'persistence']);
});

test('advanced dimensions are informational and do not block a plan', () => {
  const plan = {
    overview: '实现并发 SQLite 持久化服务，并使用定长 CRC 帧协议接收设备事件。',
    components: ['事件接入', '状态协调', 'SQLite 存储', '协议编解码'],
    acceptance: ['并发事件幂等', '重启后状态恢复', 'CRC 错帧被拒绝'],
  };
  const assessment = assertProjectComplexity(plan);
  assert.deepEqual(assessment.dimensions, ['concurrency', 'persistence', 'custom_protocol']);
});

test('enterprise-sized plans are rejected before Claude project generation', () => {
  const plan = {
    overview: '并发 SQLite 服务还包含定长 CRC 协议、故障注入、有理数换算和乱序归并器。',
    components: Array.from({ length: 10 }, (_, index) => `组件 ${index}`),
    acceptance: Array.from({ length: 13 }, (_, index) => `验收 ${index}`),
  };
  const assessment = assessProjectComplexity(plan);
  assert.equal(assessment.ok, false);
  assert.match(assessment.issues.join(';'), /核心组件 10 个/);
  assert.throws(() => assertProjectComplexity(plan), /复杂度超限/);
});

test('four advanced dimensions remain allowed when the plan is otherwise bounded', () => {
  const plan = {
    overview: '并发 SQLite 服务还包含定长 CRC 协议和故障注入。',
    components: ['队列', '存储', '协议', '故障恢复'],
    acceptance: ['并发安全', '重启恢复', '协议校验', '故障回滚'],
  };
  const assessment = assessProjectComplexity(plan);
  assert.equal(assessment.ok, true);
  assert.deepEqual(assessment.dimensions, ['concurrency', 'persistence', 'custom_protocol', 'fault_injection']);
});

test('project domain policy rejects every prohibited category from the selection brief', () => {
  const samples = [
    '实现一个贪吃蛇游戏',
    '实现本地密码管理器 CLI',
    '实现电商购物车和订单系统',
    '实现采购订单履约和退单系统',
    '实现财务查账与应收账款对账平台',
    '实现天气数据可视化前端页面',
  ];
  for (const title of samples) assert.equal(assessProjectDomain({ title }).ok, false, title);
  assert.match(prohibitedProjectDomainPolicyText(), /游戏\/图形/);
  assert.match(prohibitedProjectDomainPolicyText(), /电商购物车/);
  assert.match(prohibitedProjectDomainPolicyText(), /查账\/记账\/财务对账/);
  assert.match(prohibitedProjectDomainPolicyText(), /订单\/下单\/履约业务/);
});

test('technical audit logs are not mistaken for accounting projects', () => {
  assert.equal(assessProjectDomain({ title: '设备安全审计日志归档服务' }).ok, true);
});

test('material accounting is not mistaken for financial reconciliation', () => {
  assert.equal(assessProjectDomain({
    title: '极地冰芯样本处理服务',
    components: ['样本切割与质量 accounting', '低温保管令牌'],
    uniqueness: 'It is neither finance nor a presentation/dashboard system.',
  }).ok, true);
  assert.equal(assessProjectDomain({ title: 'Accounting system and reconciliation service' }).ok, false);
});

test('negative domain disclaimers do not trigger the prohibited-domain gate', () => {
  assert.equal(assessProjectDomain({
    title: '预拌混凝土试件强度放行服务',
    overview: '它不是订单系统，也不是财务或普通前端页面，而是实验室证据链服务。',
    uniqueness: 'This is not a dashboard and does not provide bookkeeping.',
  }).ok, true);
});

test('historical project titles can be classified for diversity balancing', () => {
  assert.equal(inferProjectDomainFamily({ title: '区域地震震相事件归并发布器' })?.id, 'environment-geoscience');
  assert.equal(inferProjectDomainFamily({ title: '盲文点字版校样签发协调台' })?.id, 'culture-archives');
});

test('project domain policy accepts an operational Go workflow outside the prohibited list', () => {
  const plan = {
    title: '冷链批次温控告警协调服务',
    overview: '面向仓储设备上报和温控告警处置的 Go 服务，管理告警生命周期并保证并发事件按规则收敛。',
    components: ['告警状态机', '设备事件接入', '持久化恢复'],
    acceptance: ['重复事件幂等', '重启后恢复', '公开 API 测试可复现'],
  };
  assert.equal(assertProjectDomainAllowed(plan).ok, true);
});
