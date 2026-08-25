const textDecoder = new TextDecoder();

export const PROJECT_QUALITY_POLICY_VERSION = 3;
export const GENERATED_PROJECT_SMOKE_FILE = 'run_benzhi_smoke.sh';
export const GENERATED_PROJECT_SPEC_FILE = 'PROJECT_SPEC.md';

export const PROJECT_QUALITY_TIERS = Object.freeze({
  standard: Object.freeze({
    minProductionGoFiles: 20,
    minProductionCodeLines: 2000,
    bugQuota: 10,
  }),
  large: Object.freeze({
    minProductionGoFiles: 50,
    minProductionCodeLines: 5000,
    bugQuota: 30,
  }),
});

export const GENERATED_PROJECT_QUALITY_LIMITS = Object.freeze({
  minProductionGoFiles: PROJECT_QUALITY_TIERS.standard.minProductionGoFiles,
  minProductionPackages: 4,
  minPublicTestFiles: 4,
  minPublicTests: 12,
  minProductionCodeLines: PROJECT_QUALITY_TIERS.standard.minProductionCodeLines,
  // Tests are reported separately and never count toward project eligibility.
  minGoCodeLines: 0,
  minFunctions: 40,
  minBranches: 60,
  requireProjectTier: true,
  requireRuntimeSmoke: true,
  requireProjectSpec: true,
  requireRuntimeReachability: true,
  rejectDeadDeclarations: true,
  rejectDuplicateImplementations: true,
});

export const LEGACY_GENERATED_PROJECT_QUALITY_LIMITS = Object.freeze({
  minProductionGoFiles: 8,
  minProductionPackages: 4,
  minPublicTestFiles: 4,
  minPublicTests: 12,
  minProductionCodeLines: 1200,
  minGoCodeLines: 2000,
  minFunctions: 40,
  minBranches: 60,
  requireProjectTier: false,
  requireRuntimeSmoke: false,
  requireProjectSpec: false,
  requireRuntimeReachability: false,
  rejectDeadDeclarations: false,
  rejectDuplicateImplementations: false,
});

const PERSISTENCE_PATTERN = /database\/sql|modernc\.org\/sqlite|mattn\/go-sqlite|bbolt|bolt\.DB|os\.(?:OpenFile|WriteFile|Create)\b|CREATE\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET/i;
const PERSISTENCE_PLAN_PATTERN = /持久化|SQLite|数据库|事务|persistence|durable/i;
const RECOVERY_PLAN_PATTERN = /重启|崩溃|恢复|restart|crash recovery|recovery/i;
const CONCURRENCY_PLAN_PATTERN = /并发|竞态|goroutine|线程安全|线性化|锁竞争|concurrency|concurrent/i;

function contentOf(entry) {
  if (typeof entry?.content === 'string') return entry.content;
  if (entry?.content instanceof Uint8Array) return textDecoder.decode(entry.content);
  return String(entry?.content || '');
}

function withoutGoComments(source) {
  const input = String(source || '');
  let output = '';
  let state = 'code';
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    const next = input[index + 1] || '';
    if (state === 'line-comment') {
      if (value === '\n') { output += '\n'; state = 'code'; }
      continue;
    }
    if (state === 'block-comment') {
      if (value === '\n') output += '\n';
      if (value === '*' && next === '/') { state = 'code'; index += 1; }
      continue;
    }
    if (state === 'quoted') {
      output += value;
      if (value === '\\') { output += next; index += 1; }
      else if (value === '"') state = 'code';
      continue;
    }
    if (state === 'rune') {
      output += value;
      if (value === '\\') { output += next; index += 1; }
      else if (value === "'") state = 'code';
      continue;
    }
    if (state === 'raw') {
      output += value;
      if (value === '`') state = 'code';
      continue;
    }
    if (value === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
    if (value === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
    output += value;
    if (value === '"') state = 'quoted';
    else if (value === "'") state = 'rune';
    else if (value === '`') state = 'raw';
  }
  return output;
}

function productionGoEntries(entries) {
  return entries.filter((entry) => {
    const path = String(entry?.path || '').replaceAll('\\', '/');
    const content = contentOf(entry);
    return path.endsWith('.go')
      && !path.endsWith('_test.go')
      && !path.startsWith('vendor/')
      && !/(?:^|\/)(?:web|frontend)\//.test(path)
      && !/(?:\.pb\.go|_generated\.go|\.gen\.go)$/i.test(path)
      && !/^\s*\/\/\s*Code generated .* DO NOT EDIT\./m.test(content);
  });
}

function publicTestEntries(entries) {
  return entries.filter((entry) => {
    const path = String(entry?.path || '').replaceAll('\\', '/');
    return path.endsWith('_test.go') && !path.startsWith('vendor/');
  });
}

function frontendEntries(entries) {
  return entries.filter((entry) => {
    const filePath = String(entry?.path || '').replaceAll('\\', '/');
    return /(?:^|\/)(?:web|frontend)\/package\.json$/.test(filePath)
      || /(?:^|\/)(?:web|frontend)\/(?:[^/]+\.(?:tsx?|jsx?|vue|svelte)|(?:src|app)\/[^/]+\.(?:tsx?|jsx?|vue|svelte))$/.test(filePath);
  });
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => String(item || '').trim()) : [];
}

function markdownList(values, empty = '- 未定义') {
  const items = list(values);
  return items.length ? items.map((item, index) => `${index + 1}. ${String(item).trim()}`).join('\n') : empty;
}

export function renderGeneratedProjectSpec(plan = {}) {
  return [
    `# ${String(plan.title || plan.project_slug || '0-1 Go 项目').trim()}`,
    '',
    '## 项目目标',
    '',
    String(plan.overview || '').trim(),
    '',
    '## 端到端业务流程',
    '',
    markdownList(plan.business_flows),
    '',
    '## 核心组件与职责',
    '',
    markdownList(plan.components),
    '',
    '## 领域规则与不变量',
    '',
    markdownList(plan.domain_rules),
    '',
    '## 数据模型与持久化',
    '',
    markdownList(plan.data_model),
    '',
    '## 公开接口',
    '',
    markdownList(plan.interfaces),
    '',
    '## 失败边界',
    '',
    markdownList(plan.failure_boundaries),
    '',
    '## 验收标准',
    '',
    markdownList(plan.acceptance),
    '',
    '## 确定性测试场景',
    '',
    markdownList(plan.test_scenarios),
    '',
    '## 组件追踪关系',
    '',
    markdownList(plan.component_traceability),
    '',
    '## 独特性',
    '',
    String(plan.uniqueness || '').trim(),
    '',
  ].join('\n');
}

export function detectGeneratedFrontend(entries = [], plan = {}) {
  const paths = entries.map((entry) => String(entry?.path || '').replaceAll('\\', '/'));
  const packagePath = paths.find((filePath) => /(?:^|\/)(?:web|frontend)\/package\.json$/.test(filePath)) || '';
  const frontendDir = packagePath ? packagePath.slice(0, -'/package.json'.length) : '';
  const required = Boolean(plan.frontend_required || plan.frontendRequired || plan.frontend === true);
  const sources = frontendEntries(entries).filter((entry) => !String(entry?.path || '').endsWith('package.json'));
  const source = sources.length > 0;
  const packageJson = packagePath ? contentOf(entries.find((entry) => String(entry?.path || '').replaceAll('\\', '/') === packagePath)) : '';
  let hasBuildScript = false;
  try {
    hasBuildScript = Boolean(JSON.parse(packageJson || '{}')?.scripts?.build);
  } catch {}
  const backendIntegration = sources.some((entry) => /\bfetch\s*\(|\baxios\b|\bWebSocket\s*\(|\/(?:api|health|v1)\b/i.test(contentOf(entry)));
  const hasLockfile = frontendDir
    ? paths.includes(`${frontendDir}/package-lock.json`)
      || paths.includes(`${frontendDir}/pnpm-lock.yaml`)
      || paths.includes(`${frontendDir}/yarn.lock`)
    : false;
  return {
    present: Boolean(packagePath),
    required,
    frontendDir,
    source,
    hasLockfile,
    hasBuildScript,
    backendIntegration,
    ok: !required || (Boolean(packagePath) && source && hasLockfile && hasBuildScript && backendIntegration),
  };
}

function planText(plan = {}) {
  return [
    plan.title,
    plan.overview,
    ...list(plan.business_flows),
    ...list(plan.components),
    ...list(plan.domain_rules),
    ...list(plan.data_model),
    ...list(plan.interfaces),
    ...list(plan.failure_boundaries),
    ...list(plan.acceptance),
    ...list(plan.test_scenarios),
    ...list(plan.component_traceability),
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizedPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function packageDirectory(filePath) {
  const normalized = normalizedPath(filePath);
  return normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '.';
}

function modulePath(entries) {
  const goMod = entries.find((entry) => normalizedPath(entry?.path) === 'go.mod');
  return /^\s*module\s+(\S+)/m.exec(contentOf(goMod))?.[1] || '';
}

function importedPaths(source) {
  const imports = [];
  const pattern = /\bimport\s*(?:\(([\s\S]*?)\)|(?:[._A-Za-z]\w*\s+)?["`]([^"`]+)["`])/g;
  for (const match of String(source || '').matchAll(pattern)) {
    if (match[2]) imports.push(match[2]);
    if (match[1]) {
      for (const item of match[1].matchAll(/(?:^|\s)(?:[._A-Za-z]\w*\s+)?["`]([^"`]+)["`]/g)) imports.push(item[1]);
    }
  }
  return imports;
}

function assessRuntimeReachability(entries, production) {
  const module = modulePath(entries);
  const packageSources = new Map();
  for (const entry of production) {
    const directory = packageDirectory(entry.path);
    packageSources.set(directory, `${packageSources.get(directory) || ''}\n${withoutGoComments(contentOf(entry))}`);
  }
  const directories = new Set(packageSources.keys());
  const mainPackages = [...packageSources]
    .filter(([, source]) => /^\s*package\s+main\b/m.test(source))
    .map(([directory]) => directory);
  const graph = new Map([...directories].map((directory) => [directory, new Set()]));
  if (module) {
    for (const [directory, source] of packageSources) {
      for (const imported of importedPaths(source)) {
        if (imported === module || imported.startsWith(`${module}/`)) {
          const target = imported === module ? '.' : imported.slice(module.length + 1);
          if (directories.has(target)) graph.get(directory).add(target);
        }
      }
    }
  }
  const reachable = new Set(mainPackages);
  const pending = [...mainPackages];
  while (pending.length) {
    const current = pending.shift();
    for (const dependency of graph.get(current) || []) {
      if (reachable.has(dependency)) continue;
      reachable.add(dependency);
      pending.push(dependency);
    }
  }
  const unreachablePackages = [...directories]
    .filter((directory) => !reachable.has(directory))
    .sort();
  return {
    ok: Boolean(module) && mainPackages.length > 0 && unreachablePackages.length === 0,
    module,
    mainPackages,
    reachablePackages: [...reachable].sort(),
    unreachablePackages,
  };
}

function allGoEntries(entries) {
  return entries.filter((entry) => {
    const filePath = normalizedPath(entry?.path);
    return filePath.endsWith('.go') && !filePath.startsWith('vendor/');
  });
}

function deadDeclarationCandidates(entries) {
  const grouped = new Map();
  for (const entry of allGoEntries(entries)) {
    const directory = packageDirectory(entry.path);
    const current = grouped.get(directory) || { sources: [], entries: [] };
    current.sources.push(withoutGoComments(contentOf(entry)));
    current.entries.push(entry);
    grouped.set(directory, current);
  }
  const candidates = [];
  const declarationPattern = /^\s*(?:func\s+(?:\([^\n)]*\)\s*)?|type\s+|var\s+|const\s+)([a-z][A-Za-z0-9_]*)\b/gm;
  for (const [directory, group] of grouped) {
    const combined = group.sources.join('\n');
    for (let index = 0; index < group.entries.length; index += 1) {
      const source = group.sources[index];
      for (const match of source.matchAll(declarationPattern)) {
        const name = match[1];
        if (name === 'init') continue;
        const occurrences = combined.match(new RegExp(`\\b${name}\\b`, 'g'))?.length || 0;
        if (occurrences === 1) candidates.push(`${normalizedPath(group.entries[index].path)}:${name}`);
      }
    }
  }
  return [...new Set(candidates)].sort();
}

function maskGoNonCode(source) {
  const input = String(source || '');
  let output = '';
  let state = 'code';
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    const next = input[index + 1] || '';
    if (state === 'line-comment') {
      output += value === '\n' ? '\n' : ' ';
      if (value === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      output += value === '\n' ? '\n' : ' ';
      if (value === '*' && next === '/') { output += ' '; index += 1; state = 'code'; }
      continue;
    }
    if (state === 'quoted' || state === 'rune') {
      output += value === '\n' ? '\n' : ' ';
      if (value === '\\') { output += ' '; index += 1; }
      else if ((state === 'quoted' && value === '"') || (state === 'rune' && value === "'")) state = 'code';
      continue;
    }
    if (state === 'raw') {
      output += value === '\n' ? '\n' : ' ';
      if (value === '`') state = 'code';
      continue;
    }
    if (value === '/' && next === '/') { output += '  '; index += 1; state = 'line-comment'; continue; }
    if (value === '/' && next === '*') { output += '  '; index += 1; state = 'block-comment'; continue; }
    output += value;
    if (value === '"') state = 'quoted';
    else if (value === "'") state = 'rune';
    else if (value === '`') state = 'raw';
  }
  return output;
}

function duplicateImplementationGroups(production) {
  const bodies = new Map();
  for (const entry of production) {
    const source = maskGoNonCode(contentOf(entry));
    const matcher = /\bfunc\s*(?:\([^\n)]*\)\s*)?([A-Za-z_]\w*)\s*\([^\n)]*\)[^{]*\{/g;
    for (const match of source.matchAll(matcher)) {
      const opening = source.indexOf('{', match.index + match[0].length - 1);
      if (opening < 0) continue;
      let depth = 1;
      let closing = opening + 1;
      while (closing < source.length && depth > 0) {
        if (source[closing] === '{') depth += 1;
        else if (source[closing] === '}') depth -= 1;
        closing += 1;
      }
      if (depth !== 0) continue;
      const body = source.slice(opening + 1, closing - 1).replace(/\s+/g, ' ').trim();
      if (body.length < 240) continue;
      const locations = bodies.get(body) || [];
      locations.push(`${normalizedPath(entry.path)}:${match[1]}`);
      bodies.set(body, locations);
    }
  }
  return [...bodies.values()].filter((locations) => locations.length > 1);
}

function effectiveCodeLines(entries) {
  return entries.reduce((total, entry) => total + withoutGoComments(contentOf(entry))
    .split(/\r?\n/)
    .filter((line) => line.trim()).length, 0);
}

export function classifyProjectTier({ productionGoFiles = 0, productionCodeLines = 0 } = {}) {
  if (productionGoFiles >= PROJECT_QUALITY_TIERS.large.minProductionGoFiles
    && productionCodeLines >= PROJECT_QUALITY_TIERS.large.minProductionCodeLines) return 'large';
  if (productionGoFiles >= PROJECT_QUALITY_TIERS.standard.minProductionGoFiles
    && productionCodeLines >= PROJECT_QUALITY_TIERS.standard.minProductionCodeLines) return 'standard';
  return '';
}

export function bugQuotaForProjectTier(tier) {
  return PROJECT_QUALITY_TIERS[tier]?.bugQuota || 0;
}

export function assessGeneratedProjectPlan(plan = {}) {
  const issues = [];
  const text = planText(plan);
  const components = Array.isArray(plan.components) ? plan.components : [];
  const acceptance = Array.isArray(plan.acceptance) ? plan.acceptance : [];
  const businessFlows = list(plan.business_flows);
  const domainRules = list(plan.domain_rules);
  const dataModel = list(plan.data_model);
  const interfaces = list(plan.interfaces);
  const failureBoundaries = list(plan.failure_boundaries);
  const testScenarios = list(plan.test_scenarios);
  const traceability = list(plan.component_traceability);
  if (components.length < 5) issues.push(`0-1 项目规划至少需要 5 个核心组件，当前 ${components.length} 个`);
  if (acceptance.length < 7) issues.push(`0-1 项目规划至少需要 7 条可验证验收标准，当前 ${acceptance.length} 条`);
  if (businessFlows.length < 3) issues.push(`项目文档至少需要 3 条端到端业务流程，当前 ${businessFlows.length} 条`);
  if (domainRules.length < 8) issues.push(`项目文档至少需要 8 条领域规则或不变量，当前 ${domainRules.length} 条`);
  if (dataModel.length < 5) issues.push(`项目文档至少需要 5 个数据模型及持久化说明，当前 ${dataModel.length} 个`);
  if (interfaces.length < 5) issues.push(`项目文档至少需要 5 个公开接口及错误语义，当前 ${interfaces.length} 个`);
  if (failureBoundaries.length < 5) issues.push(`项目文档至少需要 5 条失败边界，当前 ${failureBoundaries.length} 条`);
  if (testScenarios.length < 8) issues.push(`项目文档至少需要 8 个确定性测试场景，当前 ${testScenarios.length} 个`);
  if (traceability.length < components.length) issues.push(`组件追踪关系不足：${traceability.length} 条，至少覆盖 ${components.length} 个核心组件`);
  if (!PERSISTENCE_PLAN_PATTERN.test(text)) issues.push('0-1 项目规划必须包含真实持久化能力');
  if (!RECOVERY_PLAN_PATTERN.test(text)) issues.push('0-1 项目规划必须包含可验证的重启或崩溃恢复能力');
  if (!CONCURRENCY_PLAN_PATTERN.test(text)) issues.push('0-1 项目规划必须包含可验证的并发或一致性控制逻辑');
  if (!/测试|复现|test|deterministic/i.test(text)) issues.push('0-1 项目规划必须包含确定性公开测试要求');
  return { ok: issues.length === 0, issues };
}

export function assessGeneratedProjectQuality(entries = [], plan = {}, limits = GENERATED_PROJECT_QUALITY_LIMITS) {
  const issues = [];
  const production = productionGoEntries(entries);
  const tests = publicTestEntries(entries);
  const productionText = production.map((entry) => withoutGoComments(contentOf(entry))).join('\n');
  const testText = tests.map(contentOf).join('\n');
  const packages = new Set(production.map((entry) => {
    const path = String(entry.path || '').replaceAll('\\', '/');
    return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
  }));
  const functionCount = (productionText.match(/\bfunc\s*(?:\([^\n]*\)\s*)?[A-Za-z_]\w*\s*\(/g) || []).length;
  const branchCount = (productionText.match(/\b(?:if|for|switch|select|case)\b/g) || []).length;
  const publicTestCount = (testText.match(/^\s*func\s+Test[A-Z0-9_]\w*\s*\(/gm) || []).length;
  const productionCodeLines = effectiveCodeLines(production);
  const goCodeLines = effectiveCodeLines([...production, ...tests]);
  const planRequiresPersistence = PERSISTENCE_PLAN_PATTERN.test(planText(plan));
  const hasPersistence = PERSISTENCE_PATTERN.test(productionText);
  const frontend = detectGeneratedFrontend(entries, plan);
  const runtimeSmokeEntry = entries.find((entry) => String(entry?.path || '').replaceAll('\\', '/') === GENERATED_PROJECT_SMOKE_FILE);
  const projectSpecEntry = entries.find((entry) => normalizedPath(entry?.path) === GENERATED_PROJECT_SPEC_FILE);
  const expectedProjectSpec = renderGeneratedProjectSpec(plan);
  const projectSpec = {
    present: Boolean(projectSpecEntry),
    matchesPlan: Boolean(projectSpecEntry) && contentOf(projectSpecEntry) === expectedProjectSpec,
  };
  const runtimeSmoke = {
    present: Boolean(runtimeSmokeEntry),
    hasShellHeader: /^#!(?:\/bin\/bash|\/usr\/bin\/env\s+bash)\b/m.test(contentOf(runtimeSmokeEntry)),
    failFast: /^\s*set\s+-[^\n]*e/m.test(contentOf(runtimeSmokeEntry)),
  };
  runtimeSmoke.ok = runtimeSmoke.present && runtimeSmoke.hasShellHeader && runtimeSmoke.failFast;
  const projectTier = classifyProjectTier({ productionGoFiles: production.length, productionCodeLines });
  const bugQuota = bugQuotaForProjectTier(projectTier);
  const runtimeReachability = assessRuntimeReachability(entries, production);
  const deadDeclarations = deadDeclarationCandidates(entries);
  const duplicateImplementations = duplicateImplementationGroups(production);

  if (production.length < limits.minProductionGoFiles) issues.push(`生产 Go 文件过少：${production.length}，至少需要 ${limits.minProductionGoFiles} 个`);
  if (packages.size < limits.minProductionPackages) issues.push(`生产 Go 包过少：${packages.size}，至少需要 ${limits.minProductionPackages} 个`);
  if (tests.length < limits.minPublicTestFiles) issues.push(`公开测试文件过少：${tests.length}，至少需要 ${limits.minPublicTestFiles} 个`);
  if (publicTestCount < limits.minPublicTests) issues.push(`公开测试用例过少：${publicTestCount}，至少需要 ${limits.minPublicTests} 个`);
  if (productionCodeLines < limits.minProductionCodeLines) issues.push(`生产 Go 有效代码量过少：${productionCodeLines} 行，至少需要 ${limits.minProductionCodeLines} 行`);
  if (limits.minGoCodeLines > 0 && goCodeLines < limits.minGoCodeLines) issues.push(`Go 有效代码总量过少：${goCodeLines} 行，至少需要 ${limits.minGoCodeLines} 行`);
  if (limits.requireProjectTier !== false && !projectTier) issues.push('项目未达到标准质量层级：生产 Go 代码至少需要 2000 行且 20 个文件');
  if (functionCount < limits.minFunctions || branchCount < limits.minBranches) {
    issues.push(`业务逻辑过于简单：函数 ${functionCount} 个、控制流 ${branchCount} 个；至少需要函数 ${limits.minFunctions} 个、控制流 ${limits.minBranches} 个`);
  }
  if (planRequiresPersistence && !hasPersistence) issues.push('项目规划要求持久化，但生产 Go 代码未发现可核验的持久化实现');
  if (!frontend.ok) issues.push('项目规划要求前端页面，但未发现带构建脚本、锁文件、前端源码和 Go 后端交互的真实页面');
  if (limits.requireRuntimeSmoke && !runtimeSmoke.ok) issues.push(`${GENERATED_PROJECT_SMOKE_FILE} 必须存在、使用 bash shebang 并启用失败即退出`);
  if (limits.requireProjectSpec && !projectSpec.present) issues.push(`${GENERATED_PROJECT_SPEC_FILE} 缺失，必须先固化项目业务文档再生成代码`);
  else if (limits.requireProjectSpec && !projectSpec.matchesPlan) issues.push(`${GENERATED_PROJECT_SPEC_FILE} 与已批准的项目规划不一致，代码生成阶段不得改写项目文档`);
  if (limits.requireRuntimeReachability && !runtimeReachability.module) issues.push('go.mod 缺少可识别的 module 路径，无法验证业务代码可达性');
  if (limits.requireRuntimeReachability && !runtimeReachability.mainPackages.length) issues.push('项目缺少可运行的 package main 入口');
  if (limits.requireRuntimeReachability && runtimeReachability.unreachablePackages.length) {
    issues.push(`存在未接入可执行入口的生产包：${runtimeReachability.unreachablePackages.join(', ')}`);
  }
  if (limits.rejectDeadDeclarations && deadDeclarations.length) {
    issues.push(`存在未被生产代码或测试引用的内部声明：${deadDeclarations.slice(0, 12).join(', ')}${deadDeclarations.length > 12 ? ` 等 ${deadDeclarations.length} 处` : ''}`);
  }
  if (limits.rejectDuplicateImplementations && duplicateImplementations.length) {
    issues.push(`存在大段重复函数实现：${duplicateImplementations.slice(0, 4).map((group) => group.join(' = ')).join('；')}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    productionGoFiles: production.length,
    productionPackages: packages.size,
    publicTestFiles: tests.length,
    publicTests: publicTestCount,
    productionCodeLines,
    goCodeLines,
    functions: functionCount,
    branches: branchCount,
    hasPersistence,
    projectTier,
    bugQuota,
    frontend,
    runtimeSmoke,
    projectSpec,
    runtimeReachability,
    deadDeclarations,
    duplicateImplementations,
    qualityPolicyVersion: PROJECT_QUALITY_POLICY_VERSION,
  };
}
