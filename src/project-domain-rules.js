const PROHIBITED_PROJECT_DOMAINS = Object.freeze([
  {
    id: 'accounting-reconciliation',
    label: '查账/记账/财务对账',
    patterns: [
      /查账|对账|记账|账务|会计核算|财务核算|流水账|收支管理|应收账款|应付账款|报销|发票管理|财务结算/i,
      // Do not reject legitimate non-financial uses such as "mass
      // accounting" or "resource accounting".  The bare word
      // `accounting` is too broad for the policy; require an explicitly
      // financial/bookkeeping context instead.
      /financial accounting|financial reconciliation|accounting (?:system|software|records?|ledger|reconciliation|workflow|platform)|accounting reconciliation|bookkeeping|accounts payable|accounts receivable|expense reimbursement|invoice management/i,
    ],
  },
  {
    id: 'order-workflows',
    label: '订单/下单/履约业务',
    patterns: [
      /订单|下单|接单|派单|退单|改单|采购单|销售单|退货单|配送单|发货单|履约单|订单履约/i,
      /order management|order processing|order fulfillment|purchase order|sales order|shopping cart|checkout/i,
    ],
  },
  {
    id: 'games-graphics',
    label: '游戏/图形',
    patterns: [
      /贪吃蛇|打砖块|俄罗斯方块|坦克大战|经典小游戏|小游戏|snake game|tetris|breakout|game/i,
      /粒子.*物理|物理.*模拟|星系模拟|烟花|落沙|布料模拟|particle|physics simulation/i,
      /塔防|2d?解谜|潜行|平台跳跃|喂食.*(?:小动物|宠物)|记忆翻牌|连连看|五子棋|围棋|象棋|棋类|2048|扫雷|打地鼠/i,
    ],
  },
  {
    id: 'local-desktop-tools',
    label: '本地/桌面工具',
    patterns: [
      /命令行工具|命令行程序|\bCLI\b.*(?:工具|程序)|(?:工具|程序).*\bCLI\b|desktop app|桌面应用/i,
      /代码片段管理|snippet manager|批量重命名|截图标注|文件管理|文件同步|书签管理|密码管理/i,
    ],
  },
  {
    id: 'platform-business-systems',
    label: '平台/业务系统',
    patterns: [
      /电商|购物车|RBAC|权限后台|仓库库存|库存管理|投票|问卷|考勤|\bOA\b|图书借阅/i,
      /博客|\bCMS\b|医院挂号|问诊|外卖|点餐|\bCRM\b|\bIM\b|私信|拍卖|停车|工单|客服/i,
      /商品.*Excel|Excel.*导入|积分商城|预约系统|booking system|e-commerce|shopping cart/i,
    ],
  },
  {
    id: 'visualization-frontend',
    label: '数据可视化/前端页面',
    patterns: [
      /报表统计|Streamlit|CSV看板|数据看板|数据可视化|dashboard|visualization/i,
      /记账|健康健身|健康管理|菜谱|天气|番茄钟|习惯打卡|音乐播放器|旅行日志|旅行记录/i,
      /前端页面|frontend page|前端应用|web 前端|web frontend/i,
    ],
  },
]);

export function prohibitedProjectDomainPolicyText() {
  return [
    '后续出题不得选择以下项目类型；命中任一类型必须换一个完全不同的领域：',
    ...PROHIBITED_PROJECT_DOMAINS.map((domain) => `- ${domain.label}`),
    '查账/记账/财务对账包括：查账、对账、记账、账务、会计或财务核算、收支、应收应付、报销、发票及财务结算。普通技术审计日志不属于查账项目。',
    '订单/下单/履约业务包括：订单、下单、接单、派单、退改单、采购单、销售单、退货/配送/发货/履约单，以及购物车和结账流程。',
    '游戏/图形包括：贪吃蛇、打砖块、俄罗斯方块、坦克大战及其变式，粒子/物理模拟（星系、烟花、落沙、布料），塔防、2D 解谜、潜行、平台跳跃、喂食小动物、记忆翻牌、连连看、棋类、2048、扫雷、打地鼠。',
    '本地/桌面工具包括：命令行 CLI、代码片段管理器、批量重命名、截图标注、文件管理/同步、书签、密码管理器。',
    '平台/业务系统包括：电商购物车/订单、权限 RBAC 后台、仓库库存、投票问卷、考勤 OA、图书借阅、博客 CMS、医院挂号/问诊、外卖点餐、CRM、IM 私信、拍卖、停车、工单客服、商品 Excel 导入、积分商城、预约系统。',
    '数据可视化/前端页面包括：报表统计、Streamlit、CSV 看板、记账、健康健身、菜谱、天气、番茄钟、习惯打卡、音乐播放器、旅行日志/记录，以及以普通前端页面为主体的项目。',
  ].join('\n');
}

export const PROJECT_DOMAIN_FAMILIES = Object.freeze([
  { id: 'industrial-manufacturing', label: '工业生产与工艺控制', patterns: [/工业|制造|工厂|产线|灌装|造纸|化工装置|冶炼|机床/i] },
  { id: 'infrastructure-utilities', label: '基础设施、能源与公用设施', patterns: [/供水|水务|电网|能源|泵站|泵组|管网|电站|公用设施/i] },
  { id: 'transportation-safety', label: '交通设施与运行安全', patterns: [/铁路|轨道交通|车站|机场|公路|桥梁|道路|航班|车辆/i] },
  { id: 'scientific-instrumentation', label: '科研实验、检测与计量', patterns: [/科研|实验室|校准|定标|计量|测量|仪器|探头|试验室/i] },
  { id: 'agriculture-food', label: '农业、育种与食品生产检验', patterns: [/农业|种子|植株|育种|农作物|食品|乳制品|培养基|检疫/i] },
  { id: 'environment-geoscience', label: '环境、地质与气象监测', patterns: [/环境|地质|地震|气象|火山|水文|土壤|生态/i] },
  { id: 'healthcare-life-science', label: '医疗检验与生命科学', patterns: [/医疗|临床|患者|药品|检验科|生命科学|生物样本|基因|细胞/i] },
  { id: 'culture-archives', label: '文化遗产、出版与档案保护', patterns: [/博物馆|藏品|文物|档案|出版|书稿|盲文|语料|文化遗产/i] },
  { id: 'communications-security', label: '通信、网络与安全工程', patterns: [/通信|网络|光缆|密码设备|安全证件|电子护照|固件/i] },
  { id: 'aerospace-marine', label: '航空航天与海洋工程', patterns: [/航空|航天|飞机|民机|海洋|海底|海缆|船舶|潜航/i] },
  { id: 'emergency-public-safety', label: '应急、消防与公共安全', patterns: [/应急|消防|救援|危险品|爆破|安检|公共安全|警戒区/i] },
  { id: 'construction-materials', label: '建筑、材料与工程质量', patterns: [/建筑|施工|大坝|岩芯|混凝土|复合材料|结构件|工程质量/i] },
]);

export function projectDomainFamily(value) {
  const id = String(value || '').trim();
  return PROJECT_DOMAIN_FAMILIES.find((family) => family.id === id) || null;
}

export function inferProjectDomainFamily(plan = {}) {
  const explicit = projectDomainFamily(plan?.projectDomain);
  if (explicit) return explicit;
  const text = planText(plan);
  return PROJECT_DOMAIN_FAMILIES.find((family) => family.patterns.some((pattern) => pattern.test(text))) || null;
}

function planText(plan = {}) {
  const direct = [plan.title, plan.project_slug, plan.projectBrief].filter(Boolean);
  const descriptive = [
    plan.overview,
    ...(Array.isArray(plan.components) ? plan.components : []),
    ...(Array.isArray(plan.acceptance) ? plan.acceptance : []),
    plan.uniqueness,
  ].filter(Boolean)
    // Models commonly add a rationale such as “this is not an order or
    // dashboard project”.  Those exclusion statements are policy guidance,
    // not the business domain, and must not be treated as a positive match.
    .flatMap((value) => String(value).split(/[。！？.!?;；\n]+/u))
    .filter((sentence) => !isDomainExclusionSentence(sentence));
  return [...direct, ...descriptive].join('\n');
}

function isDomainExclusionSentence(value) {
  const sentence = String(value || '').trim();
  if (!sentence) return true;
  return /(?:\b(?:neither|not|no|without)\b|不是|不属于|不做|不涉及|不包含|非(?:财务|订单|电商|前端|可视化|游戏))/iu.test(sentence);
}

export function assessProjectDomain(plan = {}) {
  const text = planText(plan);
  const matches = PROHIBITED_PROJECT_DOMAINS
    .filter((domain) => domain.patterns.some((pattern) => pattern.test(text)))
    .map((domain) => ({ id: domain.id, label: domain.label }));
  return {
    ok: matches.length === 0,
    matches,
    issues: matches.map((match) => `命中不可出题类型：${match.label}`),
  };
}

export function assertProjectDomainAllowed(plan = {}) {
  const assessment = assessProjectDomain(plan);
  if (!assessment.ok) throw new Error(`项目领域不符合出题规则：${assessment.issues.join('；')}`);
  return assessment;
}
