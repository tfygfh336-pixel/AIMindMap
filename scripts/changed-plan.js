/* ============================================================
 * scripts/changed-plan.js —— 「改动面 → 必跑集」的**纯函数**映射（功能 4 批 2）
 * ------------------------------------------------------------
 * 为什么需要：本工程的全链 ≈124 s，其中**冒烟段 ≈101 s（81%）**。而绝大多数改动
 * （改文档、改一条单测、改某个冒烟域）根本用不着跑那 101 秒 —— 于是现实里只有两种选择：
 * 要么每次都付全价（慢），要么凭感觉跑（漏）。这个模块把"该跑什么"变成**机械可算**的答案 ✓。
 *
 * 设计纪律（都是踩过坑换来的）：
 *   ① **保守优先**：认不出的路径 ⇒ **全量**。宁可多跑，不可漏跑；
 *   ② `G1/G8/G9` **恒定跑**（编码 / 文档登记与家门 / 规则自洽，合计 ≈1.5 s）——
 *      其中 G8 还负责"新代码文件必须入档"，任何代码改动它都该看一眼 ✓；
 *   ③ 结果**不是全量真值** ⇒ 调用方（`verify.js --changed`）必须打出显式横幅、
 *      写进**另一个**记录位（不覆盖"上次全链"那句话），历史里标 `partial: true`
 *      （度量列的基线也不认它 ✓ 与"失败/中断的运行不当基线"同一个理由）；
 *   ④ 冒烟**只在**"改动全部落在已知冒烟域文件里"时才收窄（收窄走既有的 `SMOKE_ONLY`，
 *      它的选择器本来就会"筛错名字响亮失败"并标记"过滤运行不是全量真值" ✓）。
 *
 * ⚠️ 与 `scripts/smoke-select.js` 的分工：那个负责**怎么按前缀选域**（含并集 `01-*` 预热），
 *    本模块只负责**从改动面推出该选哪些域**。两件事一个负责"选法"一个负责"选什么" ✓。
 * ============================================================ */
'use strict';

/** 全链的步（顺序即执行顺序；与 `scripts/verify.js` 的 STEPS 对齐） */
const FULL_STEPS = ['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'G3', 'G6', 'G7', 'G4', 'G2', 'G5'];
/** 廉价卫生门禁：任何改动都跑（合计 ≈2.4 s；G8 还管"新代码文件必须入档"）。
 *  V1 / V2 也恒定跑：它们只扫 `scripts/smoke/*.js` 的**源码文本**（各 ≈0.3 s），而
 *  "新写一条只用 rect 的可见性断言"与"某域开了模态却没写收尾"正是最容易顺手犯的那两类错
 *  ⇒ 让它们出现在每一次部分验证里 ✓（V2 的运行时兜底在 main.js 的"域开始的干净前置"）
 *  S1 / S2 / S3（结构声明的三条卫生门禁）同样恒定跑，理由相同且更直接：它们守的是**跨文件的
 *  连带**（依赖方向 / 连带清单 / 产物确定性），任何一次改动都可能破（新增一个模块、加一条命令、
 *  改一个生成物），而代价是纯文本扫描（实测各 ≈0.1–0.6 s）⇒ 没有"省掉它"的理由 ✓ */
const ALWAYS = ['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3'];

/**
 * 规则表。**顺序即优先级**：一个文件只按**第一个**命中的规则归类。
 * 每条规则声明"这类改动需要哪些步"（不含 ALWAYS，那部分会自动并入）。
 */
const RULES = [
  {
    name: '文档与记录',
    // docs/ 下都是受管文档；工程根的记录文件；工作产物区（可随时整目录删）
    re: /^(docs\/|CHANGELOG\.md$|README\.md$|SKILL\.md$|\.review\/|backups\/)/,
    // ⚠️ G3 **要带上**（实测结论，2026-10-08）：不跑 G3 时 G6 会**自己重跑一遍 vitest** 取用例数
    //   （实测 G6 单独跑 18.1s；而 G3 17.6s + G6 0.6s = 18.2s）⇒ 耗时一样，但**单测真跑了** ✓。
    steps: ['G3', 'G6'],
    why: '文档改动：跑 G3+G6（G6 不跑 G3 会自跑 vitest，耗时一样 ⇒ 不如真跑单测）；不碰运行期行为'
  },
  {
    name: '单元测试',
    re: /^tests\//,
    steps: ['G3', 'G6'],
    why: '测试改动：跑单测（G3）；用例数会变 ⇒ G6 必须跟着看（忘了 facts:write 要红）'
  },
  {
    name: '某个冒烟域',
    // 只吃"域文件本身"；scripts/smoke/ 下别的文件（如公共工具）不算 ⇒ 落到兜底的全量 ✓
    re: /^scripts\/smoke\/(\d+)-[^/]+\.js$/,
    steps: ['G5', 'G6'],
    // 冒烟断言数会变 ⇒ G6 要看；且**只跑改动的那个域**（走 SMOKE_ONLY）
    smokeFromMatch: 1,
    why: '冒烟域改动：只跑该域（+ 选择器固定并入的 01-* 预热）+ G6；断言数会变 ⇒ 别忘 facts:write'
  }
];

/**
 * 把改动文件清单映射成必跑集。
 * @param {string[]} files 仓库相对路径（`/` 分隔）—— 通常是 `git diff --name-only HEAD` + 未跟踪文件
 * @returns {{full:boolean, steps:string[], smokeOnly:string[]|null, byRule:Array<{rule:string,files:string[],why:string}>, reason:string}}
 */
function planForFiles(files) {
  const list = (files || []).map((f) => String(f).trim().replace(/\\/g, '/')).filter(Boolean);
  // 干净工作树 ⇒ **一步都不跑**：跑三件卫生门禁会让输出"看起来验证过了" ✗（要的就是别误导）
  if (!list.length) {
    return { full: false, steps: [], smokeOnly: null, byRule: [],
      reason: '没有检测到改动 ⇒ 本次**没有验证任何东西**（要全量请不传 --changed）' };
  }
  const byRule = [];
  const steps = new Set(ALWAYS);
  const unknowns = [];
  const smokeDirs = [];
  let full = false;

  const group = new Map();   // rule index → files
  for (const f of list) {
    const ri = RULES.findIndex((r) => r.re.test(f));
    if (ri < 0) { unknowns.push(f); continue; }
    if (!group.has(ri)) group.set(ri, []);
    group.get(ri).push(f);
  }

  for (const [ri, fs_] of group) {
    const rule = RULES[ri];
    rule.steps.forEach((s) => steps.add(s));
    byRule.push({ rule: rule.name, files: fs_, why: rule.why });
    if (rule.smokeFromMatch !== undefined) {
      for (const f of fs_) smokeDirs.push(f.match(rule.re)[rule.smokeFromMatch]);
    }
  }

  // 认不出的路径 ⇒ 全量（保守优先）。这是**唯一**接受"多跑"的分支 ✓
  if (unknowns.length) {
    full = true;
    byRule.push({
      rule: '兜底：全量',
      files: unknowns,
      why: '有认不出的路径 ⇒ 按全量跑（宁可多跑，不可漏跑）'
    });
  }

  const smokeRuleIdx = RULES.findIndex((r) => r.smokeFromMatch !== undefined);
  // 收窄的前提：要跑 G5，**且 G5 的唯一来源就是那个"冒烟域"规则**（别的规则若也声明 G5 ⇒ 不收窄 ✗）
  const rulesAddingG5 = Array.from(group.keys()).filter((ri) => RULES[ri].steps.includes('G5'));
  const onlySmokeRuleAddsG5 = !full && rulesAddingG5.length === 1 && rulesAddingG5[0] === smokeRuleIdx;

  const out = full ? { full: true, steps: FULL_STEPS.slice(), smokeOnly: null } : {
    full: false,
    // 顺序按全链顺序排，读起来稳定（也便于与耗时表对照）
    steps: FULL_STEPS.filter((s) => steps.has(s)),
    smokeOnly: (onlySmokeRuleAddsG5 && smokeDirs.length)
      ? Array.from(new Set(smokeDirs)).sort()
      : null
  };
  out.byRule = byRule;

  if (out.full) out.reason = '有认不出的路径 ⇒ 按全量跑（保守优先）';
  else out.reason = '改动都在已知范围内 ⇒ 只跑相关步骤（**不是全量真值**）';
  return out;
}

/** 只用于打印的一行摘要（调用方打在横幅里，让人一眼知道"为什么选了这些"） */
function describePlan(plan) {
  const lines = [];
  lines.push('计划：' + (plan.full ? '全量' : plan.steps.join(' → ')));
  if (plan.smokeOnly) lines.push('冒烟收窄到域：' + plan.smokeOnly.join(', ') + '（其余域本轮不跑）');
  if (plan.domainsAll) lines.push('冒烟：**全部域**都跑（这一面改的是冒烟底板/全链，收窄任何子集都不成立）');
  for (const g of plan.byRule || []) {
    lines.push('  · ' + g.rule + '：' + g.files.length + ' 个文件 —— ' + g.why);
  }
  /* `--for <改动面>` 的行（与上面"按文件"的形态并排，**同一份数据表**推出来的） */
  if (plan.surface) {
    lines.push('  改动面 = ' + plan.surface + '（' + plan.surfaceWhat + '）');
    lines.push('  该面登记：' + (plan.surfaceSteps.length ? plan.surfaceSteps.join(' + ') : '（无 —— 只有卫生八件）'));
    for (const row of plan.matrix || []) {
      lines.push('    层次 ' + row.key + '：' + row.status + '（' + row.gates.join('/') + '）');
    }
  }
  return lines;
}

/* ================================================================================
 * 「改动面（`--for <面>`）→ 必跑集」—— **一张数据表**（本模块是它的唯一权威）
 * --------------------------------------------------------------------------------
 * 与上面 RULES 的分工：RULES 吃的是"`git diff` 出来的**文件清单**"（`--changed`，自动档），
 * 本表吃的是"**改动面**这个名字"（`--for <面>`，人显式点名档）。两者最后都归到同一个
 * 「必跑集」形状（`{full, steps, smokeOnly}`）⇒ 调用方（verify.js）只有一份执行/跳过/留痕逻辑。
 *
 * 判据（表自己要被**门禁**核对，见 surfaceSelfCheck —— 表与实跑分叉 ⇒ 判红）：
 *   ① 表里登记的每个域号都必须**真实存在**于 `scripts/smoke/`（悬挂登记 ⇒ 红）；
 *   ② 目录里每个冒烟域都必须被**恰好一个**面的 `domains` 登记（重复登记 / 漏登记 ⇒ 红），
 *      条数**现算**（域数来自目录列举，不写死）；
 *   ③ `domainsAll` 的面 `domains` 必须为空（不许既说"全部"又列具体，那是第二份会漂的口径）；
 *   ④ 每个面**自动**含"卫生八件 + G3 + G6"（任何改动都该付的最小价；G6 不带 G3 时会自跑一遍
 *      vitest）—— 这是**结构保证**（`effectiveSteps` 无条件并入 `SURFACE_FLOOR`），不是一条
 *      可失败的检查（写不出来的东西不需要一条永远绿的断言 ✗）；
 *   ⑤ 声明跑 G5 ⇔ 声明了域（`domains` 非空或 `domainsAll`）—— 不许"跑冒烟但不说是哪些域"。
 * 另：**不留"视情况"档** —— 档位只有 必跑/跳过 两档，且由 `steps` **派生**（层次表不是第二份手抄的
 * 对应关系；"视情况"等于把口径交给下一个人临场决定 ✗）。
 *
 * 域怎么归属（判据写在一处，别在下一个人那里重新发明）：
 *   按**该域主要钉住的产品层**归给对应面 —— 读数以界面（DOM / 真鼠标 / 真帧）为主的 ⇒ `renderer`；
 *   以主进程/壳（IPC / 写盘 / 原生侧栏 / 窗口 / 隔离）为主的 ⇒ `main`；以 CLI 报告与盘上项目为主的
 *   （三条导入管线）⇒ `cli`。`src`（共享核心）**一个域都不登记**：`docs/ARCHITECTURE.md` §6 的分层
 *   纪律是「**核心 → 单测；命令 → 集成；渲染 → 冒烟**」—— core 的必跑层是 G3/G4/G2，冒烟不为它站岗 ✓。
 * ================================================================================ */

/** 层次枚举（打印用；每格的"必跑/跳过"由该面的 `steps` **派生**，不在这里手写） */
const LAYERS = [
  { key: '规则卫生', gates: ['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3'] },
  { key: '单测', gates: ['G3'] },
  { key: '文档真值', gates: ['G6', 'G7'] },
  { key: 'CLI 集成', gates: ['G4'] },
  { key: '数据校验', gates: ['G2'] },
  { key: '冒烟', gates: ['G5'] }
];

/** 每个面**自动并入**的价（任何改动都该付的最小价）：卫生八件 + 单测 + 文档真值。
 *  ⚠️ 它是**结构保证**（`effectiveSteps` 无条件并入）而不是一条可失败的检查 —— 表里根本写不出
 *  "少付这一档"的面 ⇒ 也就不会有一条"永远绿着"的检查（空转门禁比没有门禁更坏 ✗）。
 *  单测里另有一条**非空转**的判据：每个面的 effectiveSteps 都必须含这份 floor ✓。 */
const SURFACE_FLOOR = ALWAYS.concat(['G3', 'G6']);

/**
 * 改动面表。**一处实现**：改必跑集只改这里（`steps` 是唯一权威，`domains` 是域的**归属**）。
 * `steps` 不含 `ALWAYS`（自动并入），与上面 RULES 同一约定。
 */
const SURFACES = [
  {
    id: 'docs', what: '文档与记录（`docs/` · `CHANGELOG.md` · `README.md` · `SKILL.md` · `.review/`）',
    steps: [],                       // = 卫生八件 + G3 + G6
    domains: [],
    why: '文档不碰运行期行为 ⇒ 只要"卫生八件 + 单测 + 文档数字一致"（G6 不带 G3 会自跑一遍 vitest，耗时一样）'
  },
  {
    id: 'tests', what: '单测（`tests/`）',
    steps: [],
    domains: [],
    why: '测试改动：用例数会变 ⇒ G6 必须跟着看；跑的是同一批单测'
  },
  {
    id: 'scripts', what: '门禁与工具（`scripts/*.js` 里**不是**冒烟底板的那部分 + `package.json`）',
    steps: ['G4'],
    domains: [],
    why: '门禁/工具脚本：卫生八件自己就是被改的对象（在 ALWAYS 里）+ 单测 + 文档数字；'
      + '另加 CLI 集成（`scripts/mcp-server.js` 一类夹在 CLI 与 MCP 之间）'
  },
  {
    id: 'smoke', what: '冒烟地板（`scripts/smoke-*.js` · `scripts/smoke/` 里的**非域文件**）',
    steps: ['G5'],
    domainsAll: true,                // 改地板 ⇒ 每个域都可能受影响，收窄任何子集都不成立
    why: '改的是所有域共用的底板（真输入 / 断言入口 / 选择器）⇒ **全部域**都要跑一遍'
  },
  {
    id: 'src', what: '共享核心（`src/`：数据模型 / 存储 / 搜索 / 导入解析 / 条目）',
    steps: ['G4', 'G2'],
    domains: [],
    why: '核心 → 单测 / 命令 → 集成（ARCHITECTURE §6）：core 另加数据校验（G2 扫真实项目），不占冒烟'
  },
  {
    id: 'cli', what: '命令行与 MCP（`cli/` · `scripts/mcp-server.js`）',
    steps: ['G4', 'G2', 'G5'],
    domains: ['27', '43', '44'],
    why: '命令面：端到端集成（G4）+ 数据校验（G2）+ 三条**导入管线**的冒烟域（读数以 CLI 报告与盘上项目为准）'
  },
  {
    id: 'main', what: '主进程与壳（`main.js` · `preload.js` · `main-dsh-sidebar.js`）',
    steps: ['G5'],
    domains: ['07', '09', '11', '12', '13', '14', '15', '18', '21', '22', '23', '24'],
    why: '壳面：IPC / 写盘闸门 / 原生侧栏 / 窗口 / 沙箱隔离 —— 这些域的读数以主进程行为为准'
  },
  {
    id: 'renderer', what: '渲染层（`renderer/` · `editor.js` · `style.css` · `index.html`）',
    steps: ['G5'],
    domains: ['01', '02', '03', '04', '05', '06', '08', '10', '16', '17', '19', '20', '25', '26',
      '28', '29', '30', '31', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '45', '46',
      '47'],
    why: '界面面：读数以界面（DOM / 真鼠标 / 真帧）为主的域都归这里 —— 这也是**最大的一块**'
      + '（界面域本来就占冒烟的大多数）⇒ 单点小改动请用 `--domains` 再收窄，或用 `--changed` 自动档'
  },
  {
    id: 'all', what: '全链（**默认档**：不带任何开关时的行为）',
    steps: [],
    domainsAll: true,
    full: true,
    why: '全量 —— 一步都不省（放行点 / 夜间档 / 发布前就该用这一档）'
  }
];

/** 面 id 列表（打印与报错时给"有哪些面可选"） */
function surfaceIds(surfacesIn) { return (surfacesIn || SURFACES).map((s) => s.id); }

/** 找一面；找不到 ⇒ 抛错并**列出可选面**（采不到真值 = 红，不许静默退回全量 ✗） */
function findSurface(id, surfacesIn) {
  const surfaces = surfacesIn || SURFACES;
  const hit = surfaces.filter((s) => s.id === id)[0];
  if (!hit) {
    throw new Error('不认识的改动面：' + JSON.stringify(id) + ' —— 可选：'
      + surfaceIds(surfaces).join(' / '));
  }
  return hit;
}

/**
 * 某个面的**层次表**：每格"必跑/跳过"由 `steps` 派生（不是第二份手抄的对应关系 ✓）。
 * @returns {Array<{key:string,gates:string[],status:'必跑'|'跳过'}>}
 */
function layerMatrix(surface) {
  const eff = effectiveSteps(surface);
  return LAYERS.map((l) => ({
    key: l.key,
    gates: l.gates.slice(),
    status: l.gates.some((g) => eff.indexOf(g) >= 0) ? '必跑' : '跳过'
  }));
}

/** 面的实际步骤（声明 + 恒定的卫生八件），按全链顺序排（读起来稳定、便于与耗时表对照）。
 *  `full: true` 的面（`all`）= 全链每一步 ⇒ 也从这里返回，别在别处再写一遍"全链有哪些步" ✓ */
function effectiveSteps(surface) {
  if (surface.full === true) return FULL_STEPS.slice();
  const set = new Set(SURFACE_FLOOR);
  (surface.steps || []).forEach((s) => set.add(s));
  return FULL_STEPS.filter((s) => set.has(s));
}

/**
 * 把"改动面"名字变成必跑集（形状与 `planForFiles` 一致 ⇒ 调用方只有一份执行逻辑）。
 * @param {string} id 面名（见 SURFACES）
 * @param {{domains?:string[]|null, surfaces?:Array}} [opts] `domains` = 人显式再收窄的域号
 * @returns {{full:boolean, surface:string, steps:string[], smokeOnly:string[]|null, domainsAll:boolean, ...}}
 */
function planForSurface(id, opts) {
  const o = opts || {};
  const s = findSurface(id, o.surfaces);
  const steps = effectiveSteps(s);
  const domainsAll = s.domainsAll === true;
  const registered = (s.domains || []).slice();
  if (o.domains && o.domains.length) {
    // 顺序有讲究：**先问这一面跑不跑冒烟** —— 面根本不跑冒烟时，"这些域没登记"那句话会把人
    // 引到错的方向（真正的问题是"这个面压根没有域"）。
    if (steps.indexOf('G5') < 0) {
      throw new Error('改动面 ' + s.id + ' 不跑冒烟（G5）⇒ 别给它 --domains（那次运行不会跑任何域）');
    }
    // 人显式收窄：只许收窄**这一面登记过的**域（面没登记它 ⇒ 说明你点错了面 ⇒ 响亮拒绝 ✗）
    const bad = o.domains.filter((d) => !domainsAll && registered.indexOf(d) < 0);
    if (bad.length) {
      throw new Error('这些域不在改动面 ' + s.id + ' 的登记里：' + bad.join(', ')
        + ' —— 该面登记的是：' + (registered.length ? registered.join(', ') : '（一个都没有）'));
    }
  }
  const smokeOnly = o.domains && o.domains.length ? o.domains.slice().sort()
    : (domainsAll || !registered.length ? null : registered.slice().sort());
  // 声明跑 G5 却不收窄（domainsAll）⇒ smokeOnly=null ⇒ 跑全部域 ✓（既有 SMOKE_ONLY 机制原样复用）
  const full = s.full === true;
  const out = {
    full,
    surface: s.id,
    surfaceWhat: s.what,
    surfaceSteps: (s.steps || []).slice(),
    domainsAll,
    steps: full ? FULL_STEPS.slice() : steps.slice(),
    smokeOnly: full ? null : smokeOnly,
    matrix: layerMatrix(s),
    byRule: [],
    reason: s.why
  };
  if (full) out.reason = '全链：一步都不省（与不带开关的默认档一致）';
  return out;
}

/**
 * `--for <面>` / `--domains a,b` / `--changed` 的**解析**（纯函数，入口只有这一处）。
 * @param {string[]} argv process.argv
 * @returns {{mode:'full'|'changed'|'for', surface:string|null, domains:string[]|null, error:string|null}}
 */
function parseForArgs(argv) {
  const args = (argv || []).slice(2);
  const pick = (name) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === name) return args[i + 1] === undefined ? '' : args[i + 1];
      if (args[i].indexOf(name + '=') === 0) return args[i].slice(name.length + 1);
    }
    return null;
  };
  const changed = args.indexOf('--changed') >= 0;
  const rawFor = pick('--for');
  const rawDomains = pick('--domains');
  const domains = rawDomains === null ? null
    : rawDomains.split(',').map((d) => d.trim()).filter(Boolean);
  if (changed && rawFor !== null) {
    return { mode: 'changed', surface: null, domains: null,
      error: '`--changed`（按 git 改动清单自动选）与 `--for <改动面>`（人显式点名）**只能给一个** —— '
        + '同时给就等于两套选择口径同时生效 ✗' };
  }
  if (rawFor !== null) {
    if (!rawFor) return { mode: 'for', surface: null, domains, error: '`--for` 后面要跟一个改动面名' };
    if (domains && !domains.length) {
      return { mode: 'for', surface: rawFor, domains: null, error: '`--domains` 给了空清单（要么不给，要么给域号）' };
    }
    return { mode: 'for', surface: rawFor, domains, error: null };
  }
  if (domains) {
    return { mode: 'full', surface: null, domains: null,
      error: '`--domains` 只能跟着 `--for <面>` 用（单独给它就没有"面"可收窄）' };
  }
  return { mode: changed ? 'changed' : 'full', surface: null, domains: null, error: null };
}

/** 打印用：**这次没跑什么**（只报"跑了什么"会把"没跑"读成"过了" ✗） */
function describeNotRun(plan) {
  if (!plan || plan.full) return [];
  const lines = [];
  const skipped = FULL_STEPS.filter((g) => plan.steps.indexOf(g) < 0
    && !(g === 'G7' && plan.steps.indexOf('G6') >= 0));   // G7 与 G6 共用一次调用
  const run = plan.steps.filter((g) => g !== 'G7');
  if (!skipped.length) {
    lines.push('没跑什么：**没有** —— 全链的每一步都在计划里');
  } else {
    lines.push('没跑什么（' + skipped.length + ' 步；G7 与 G6 共用一次调用，G6 在计划里它就跟着跑）：'
      + skipped.map((g) => g + '（要跑它请用 ' + whoRuns(g) + '）').join(' · '));
  }
  lines.push('本轮真的会跑 ' + run.length + ' 步：' + run.join(' → '));
  // 冒烟那一半：跑了哪些域 / 没跑哪些域（个数现算，不写死）
  if (plan.steps.indexOf('G5') >= 0) {
    if (plan.smokeOnly) {
      lines.push('冒烟只跑域 ' + plan.smokeOnly.join(', ') + '（**其余域本轮一个都不跑**）'
        + '；域集合来自改动面表，可用 `--domains` 再收窄');
    } else {
      lines.push('冒烟跑**全部**已登记的域（这一面改的是所有域共用的底板）');
    }
  } else {
    lines.push('冒烟（G5）本轮**不跑**：这一面没有为它登记 —— 要跑它请用 ' + whoRuns('G5'));
  }
  return lines;
}

/** 某个门禁该用哪个面来跑（打印"要跑它请用 …"，从表里现算，不手抄 ✓） */
function whoRuns(gate) {
  const hits = SURFACES.filter((s) => effectiveSteps(s).indexOf(gate) >= 0).map((s) => s.id);
  const nonAll = hits.filter((h) => h !== 'all');
  return (nonAll.length ? '`--for ' + nonAll.join('` / `--for ') + '`' : '`--for ' + hits.join('` / `--for ') + '`');
}

/**
 * **表自检（门禁自己核对这张表）**：调用方**现算**目录里的域号传进来（本函数不做 I/O ⇒ 可单测）。
 * 判据见文件头 ①–⑤；任何一条不成立 ⇒ `ok:false` + 逐条理由（调用方据此**判红**）。
 * @param {string[]} domainNumbers `scripts/smoke/` 里真实存在的域号（如 ['01','02',…]）
 * @param {Array} [surfacesIn] 表（默认用真表；单测可注入坏表做判别力证明）
 */
function surfaceSelfCheck(domainNumbers, surfacesIn) {
  const surfaces = surfacesIn || SURFACES;
  const errs = [];
  const seen = new Set();
  const claim = new Map();          // 域号 → 登记它的面 id
  let domainsAllCount = 0;
  let domainClaims = 0;
  for (const s of surfaces) {
    if (!s.id) { errs.push('有一面没有 id'); continue; }
    if (seen.has(s.id)) errs.push('面的 id 重复：' + s.id);
    seen.add(s.id);
    const doms = s.domains || [];
    if (s.domainsAll) {
      domainsAllCount += 1;
      if (doms.length) {
        errs.push('面 ' + s.id + ' 既声明 domainsAll 又列了 ' + doms.length + ' 个具体域 —— '
          + '两者只能给一个（否则域归属有两份口径，必然漂）');
      }
    }
    for (const d of doms) {
      domainClaims += 1;
      if (claim.has(d)) errs.push('域 ' + d + ' 被两个面同时登记：' + claim.get(d) + ' 与 ' + s.id);
      else claim.set(d, s.id);
    }
    const eff = effectiveSteps(s);
    const hasG5 = eff.indexOf('G5') >= 0;
    if (hasG5 && !s.domainsAll && !doms.length) {
      errs.push('面 ' + s.id + ' 声明跑冒烟（G5）却没登记任何域 —— 不许"跑冒烟但不说跑哪些域"');
    }
    if (!hasG5 && (s.domainsAll || doms.length)) {
      errs.push('面 ' + s.id + ' 登记了域却不跑冒烟（G5）—— 登记与实跑分叉');
    }
    const bad = (s.steps || []).filter((g) => FULL_STEPS.indexOf(g) < 0);
    if (bad.length) errs.push('面 ' + s.id + ' 声明了链上不存在的步骤：' + bad.join(', '));
  }
  if (surfaces.length && domainsAllCount === 0) {
    errs.push('没有任何面声明 domainsAll —— "改冒烟底板 ⇒ 全部域都跑"这条能力就不存在了');
  }
  // ① 悬挂登记：表里的域号必须真实存在
  const have = new Set(domainNumbers || []);
  const dangling = Array.from(claim.keys()).filter((d) => !have.has(d)).sort();
  if (dangling.length) {
    errs.push('表里登记了 `scripts/smoke/` 里不存在的域号（悬挂登记）：' + dangling.join(', '));
  }
  // ③ 现算覆盖：目录里每个域都必须被登记**恰好一次**
  const uncovered = Array.from(have).filter((d) => !claim.has(d)).sort();
  if (uncovered.length) {
    errs.push('这些域**一个面都没登记**（新加的域必须同批归到某个改动面下）：' + uncovered.join(', '));
  }
  return {
    ok: errs.length === 0,
    errors: errs,
    stats: {
      surfaces: surfaces.length,
      domainsInRepo: have.size,
      domainClaims,                       // 表里的登记条数（**现算**，不写死）
      domainsAll: domainsAllCount,
      layers: LAYERS.length,
      stepsInChain: FULL_STEPS.length
    }
  };
}

/** `scripts/smoke/` 里真实存在的域号（I/O 只在这一处；域文件判据与 S2/V1/V2 同一形态：`NN-*.js`） */
function domainNumbersIn(dir, fsMod) {
  const f = fsMod || require('fs');
  return f.readdirSync(dir).filter((n) => /^\d+-.+\.js$/.test(n))
    .map((n) => n.slice(0, n.indexOf('-'))).sort();
}

/**
 * **表与实跑分叉 ⇒ 判红**（运行时核对；调用方把真实结果传进来）。
 * 判据：计划里的步骤必须真的跑过；跑过的步骤必须真的在计划里。
 * `G7` 与 `G6` 共用一次调用 ⇒ 它在计划里等于 G6 在计划里，`skipped` 是正常形态 ✓。
 * @param {object} plan planForSurface / planForFiles 的结果
 * @param {Array<{gate:string, skipped?:boolean, code:number|null}>} actual 每个门禁的真实结果
 */
function planDivergence(plan, actual) {
  const errs = [];
  const planned = new Set(plan.steps || []);
  const byGate = new Map();
  (actual || []).forEach((r) => {
    if (!byGate.has(r.gate)) byGate.set(r.gate, []);
    byGate.get(r.gate).push(r);
  });
  const ranGates = new Set();
  for (const [gate, rs] of byGate) {
    const ran = rs.some((r) => !r.skipped && r.code !== null);
    if (ran) ranGates.add(gate);
  }
  for (const gate of ranGates) {
    if (planned.has(gate)) continue;
    if (gate === 'G7' && planned.has('G6')) continue;   // 与 G6 共用一次调用
    errs.push('**计划外的步骤真的跑了**：' + gate + '（表说它不该跑 ⇒ 表与实跑分叉）');
  }
  for (const gate of planned) {
    if (gate === 'G7') continue;                        // G7 不单独跑（与 G6 同一次调用）
    if (!byGate.has(gate)) { errs.push('**计划内的步骤没有结果**：' + gate + '（采不到 ⇒ 不算通过 ✗）'); continue; }
    if (!ranGates.has(gate)) errs.push('**计划内的步骤没跑**：' + gate + '（表说该跑 ⇒ 表与实跑分叉）');
  }
  return { ok: errs.length === 0, errors: errs, ranGates: Array.from(ranGates) };
}

module.exports = {
  planForFiles, describePlan, FULL_STEPS, ALWAYS, RULES,
  // 「改动面（--for）」：同一张表 + 解析 + 自检 + 分叉判定（verify.js 是唯一调用方）
  SURFACES, LAYERS, SURFACE_FLOOR, surfaceIds, findSurface, layerMatrix, effectiveSteps,
  planForSurface, parseForArgs, describeNotRun, whoRuns, surfaceSelfCheck, domainNumbersIn,
  planDivergence
};
