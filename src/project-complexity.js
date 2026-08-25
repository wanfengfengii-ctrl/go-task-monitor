export const PROJECT_COMPLEXITY_LIMITS = Object.freeze({
  maxComponents: 6,
  maxAcceptance: 8,
  // Advanced dimensions are reported for observability, but are not a gate.
  maxPlanCharacters: 4200,
});

const DIMENSIONS = [
  ['concurrency', /并发|竞态|goroutine|线程安全|线性化|锁竞争/i],
  ['persistence', /持久化|SQLite|数据库|事务|重启恢复|崩溃恢复/i],
  ['custom_protocol', /定长|二进制协议|CRC|校验和|帧协议|自定义协议/i],
  ['fault_injection', /故障注入|事务故障|断电|损坏检查点|崩溃点/i],
  ['complex_math', /有理数|定点换算|精度转换|比例换算|舍入规则/i],
  ['out_of_order_merge', /乱序|迟到回报|归并器|事件重排|因果顺序/i],
];

export function assessProjectComplexity(plan = {}, limits = PROJECT_COMPLEXITY_LIMITS) {
  const components = Array.isArray(plan.components) ? plan.components : [];
  const acceptance = Array.isArray(plan.acceptance) ? plan.acceptance : [];
  const text = [plan.overview, ...components, ...acceptance].filter(Boolean).join('\n');
  const dimensions = DIMENSIONS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const issues = [];
  if (components.length > limits.maxComponents) issues.push(`核心组件 ${components.length} 个，最多 ${limits.maxComponents} 个`);
  if (acceptance.length > limits.maxAcceptance) issues.push(`验收标准 ${acceptance.length} 条，最多 ${limits.maxAcceptance} 条`);
  if (text.length > limits.maxPlanCharacters) issues.push(`规划正文 ${text.length} 字符，最多 ${limits.maxPlanCharacters} 字符`);
  return {
    ok: issues.length === 0,
    issues,
    componentCount: components.length,
    acceptanceCount: acceptance.length,
    dimensions,
    characterCount: text.length,
  };
}

export function assertProjectComplexity(plan, limits) {
  const assessment = assessProjectComplexity(plan, limits);
  if (!assessment.ok) throw new Error(`项目规划复杂度超限：${assessment.issues.join('；')}`);
  return assessment;
}
