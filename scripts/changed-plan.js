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
const FULL_STEPS = ['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'S4', 'G3', 'G6', 'G7', 'G4', 'G2', 'G5'];
/** 廉价卫生门禁：任何改动都跑（合计 ≈2.4 s；G8 还管"新代码文件必须入档"）。
 *  V1 / V2 也恒定跑：它们只扫 `scripts/smoke/*.js` 的**源码文本**（各 ≈0.3 s），而
 *  "新写一条只用 rect 的可见性断言"与"某域开了模态却没写收尾"正是最容易顺手犯的那两类错
 *  ⇒ 让它们出现在每一次部分验证里 ✓（V2 的运行时兜底在 main.js 的"域开始的干净前置"）
 *  S1 / S2 / S3（结构声明的三条卫生门禁）同样恒定跑，理由相同且更直接：它们守的是**跨文件的
 *  连带**（依赖方向 / 连带清单 / 产物确定性），任何一次改动都可能破（新增一个模块、加一条命令、
 *  改一个生成物），而代价是纯文本扫描（实测各 ≈0.1–0.6 s）⇒ 没有"省掉它"的理由 ✓
 *  S4（标签词表契约，2026-10-20 加）也恒定跑：它只读 `docs/TAGS.md` + 进一次
 *  `tags --vocab --json`（进程内，实测 43ms / 7 本书），守的是"标签越界 / 落点掉到下限以下 /
 *  词表空转"这三件**只有跑一次才看得见**的事 —— 而改一个节点的 `--tags` 就可能破它们。 */
const ALWAYS = ['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'S4'];

/* ================================================================================
 * **运行副产物**（T1 批，2026-10-17）：单独一档 —— 既**不算越界**，也**不触发兜底全量**
 * --------------------------------------------------------------------------------
 * 为什么非有不可（实测，不是推理）：加这一档之前，`projects/**`（用户的项目数据）**命不中任何
 * 一条 RULES** ⇒ 落进「兜底：全量」⇒ **用户只是用了软件**（界面上改一个节点、AI 用 CLI 写一条笔记）
 * 就让 `--changed` 从"10 步 / 十几秒"变成"14 步 / 二十几分钟"，而且**输出上完全看不出原因**。
 * 两处旁证：① `scripts/docs-registry-check.js:1197` 早就写明"G8 刻意跳过 `projects/`（那是用户数据）"——
 * 同一件事在门禁侧已裁决过，改动面这一侧却还把它当源码；② `docs/RULES.md` 的 R3a：
 * **编辑笔记 ≠ 功能迭代，禁止跑 verify 全链** ⇒ 用户数据改动本来就不该付全链的价。
 *
 * 判据（三条同时成立才算副产物，缺一条就还是"源码级"⇒ 仍然走保守面）：
 *   ① **正常使用/正常运行就会变**（不是"我改了代码"）；
 *   ② **可重新生成 / 本身就是数据**（删掉不损失工程能力）；
 *   ③ **不改变任何源码行为** ⇒ 不需要冒烟/集成，最多跑一次数据校验。
 *
 * ⚠️ 与「文档与记录」那条规则的分工：`.review/` 是本工程既定的**工作产物区**，但它已在第一条
 * 规则里 ⇒ 本表**只列不归任何改动面**的那些副产物（两张表不重叠：顺序即优先级，见 RULES）。
 * ================================================================ */
const BYPRODUCTS = [
  { re: /^projects\//, label: '用户的项目数据',
    why: '项目 JSON / 附件 / 访问日志：用户一用软件就会改（G8 也刻意跳过这个目录）' },
  { re: /^(dist|dist-portable|build|vendor|node_modules)\//, label: '构建产物与依赖',
    why: '可重新生成，已 gitignore（正常不入库）' },
  { re: /(^|\/)[^/]*\.tmp$|(^|\/)\.tmp-[^/]*(\/|$)/, label: '临时文件',
    why: '原子写的残片 / 临时目录，正常不存在' },
  { re: /^(smoke-shot\.png|smoke-frame\.json|smoke-out\.txt|\.DS_Store|Thumbs\.db)$|(^|\/)[^/]*\.log$/,
    label: '冒烟/系统杂项与日志',
    why: '每跑一次就重写，已 gitignore' }
];

/** 运行副产物该跑哪一档（**一处**）：RULES 的那条规则与 SURFACES 的 `byproduct` 面都从这里取 ——
 *  写两遍就是第二份会漂的口径（A3）。只跑数据校验（G2）：副产物**不改代码行为**，
 *  而它最常见的形状是"项目数据变了" ⇒ `validate-all` 正是该看的那一眼（≈1–3 s，不是十几分钟）。 */
const BYPRODUCT_STEPS = ['G2'];

/** 某个文件是哪一类运行副产物（命中不了 ⇒ null）。**顺序即优先级**，与 BYPRODUCTS 一致。 */
function byproductFor(file) {
  const f = String(file || '').trim().replace(/\\/g, '/');
  if (!f) return null;
  for (const b of BYPRODUCTS) if (b.re.test(f)) return b;
  return null;
}

/** BYPRODUCTS 的正则**并集**（给 RULES 那一条用：RULES 的契约是"每条规则一个 re"，不另造形状） */
const BYPRODUCT_RE = new RegExp(BYPRODUCTS.map((b) => '(' + b.re.source + ')').join('|'));

/**
 * 规则表。**顺序即优先级**：一个文件只按**第一个**命中的规则归类。
 * 每条规则声明"这类改动需要哪些步"（不含 ALWAYS，那部分会自动并入）。
 */
const RULES = [
  {
    name: '运行副产物',
    re: BYPRODUCT_RE,           // 由 BYPRODUCTS 派生（单源），不在这里手抄第二份正则
    byproduct: true,
    steps: BYPRODUCT_STEPS,
    why: '运行副产物（用户数据 / 构建产物 / 临时文件 / 日志）：**不是源码、不是越界**，'
      + '也不该把 --changed 拖成全量 —— 只跑数据校验（G2）'
  },
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
 * @param {{rules?:Array}} [opts] `rules` = 换一张规则表（**只给单测 / A-B 读数用**；默认真表）
 * @returns {{full:boolean, steps:string[], smokeOnly:string[]|null, byRule:Array<{rule:string,files:string[],why:string}>, reason:string}}
 */
function planForFiles(files, opts) {
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
  /* 规则表可注入（`opts.rules`）—— 与本文件其它表同一处置（`surfaceSelfCheck(…, surfacesIn)` /
   * `findSurface(id, surfacesIn)`）：**判别力证明**与**A/B 读数**（"加这一档之前 / 之后"）都要能
   * 在不改工程的前提下换表；默认真表，调用方不传就当它是常量 ✓ */
  const rules = (opts && Array.isArray(opts.rules)) ? opts.rules : RULES;

  const group = new Map();   // rule index → files
  for (const f of list) {
    const ri = rules.findIndex((r) => r.re.test(f));
    if (ri < 0) { unknowns.push(f); continue; }
    if (!group.has(ri)) group.set(ri, []);
    group.get(ri).push(f);
  }

  for (const [ri, fs_] of group) {
    const rule = rules[ri];
    rule.steps.forEach((s) => steps.add(s));
    const rec = { rule: rule.name, files: fs_, why: rule.why };
    if (rule.byproduct === true) rec.byproduct = true;   // 只有副产物那条带这个标记（别的规则形状不变）
    byRule.push(rec);
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

  const smokeRuleIdx = rules.findIndex((r) => r.smokeFromMatch !== undefined);
  // 收窄的前提：要跑 G5，**且 G5 的唯一来源就是那个"冒烟域"规则**（别的规则若也声明 G5 ⇒ 不收窄 ✗）
  const rulesAddingG5 = Array.from(group.keys()).filter((ri) => rules[ri].steps.includes('G5'));
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

  /* 运行副产物**单列**一份（调用方据此响亮说"这不是越界"；边界判定也复用它，不另写一套正则）。
   * 注意：`full` 与它是**正交**的两件事 —— 一批里既有源码又有副产物时，full 仍由源码那几条规则决定。 */
  out.byproducts = [];
  for (const g of byRule) {
    if (!g.byproduct) continue;
    for (const f of g.files) {
      const b = byproductFor(f);
      out.byproducts.push({ path: f, label: b ? b.label : '运行副产物' });
    }
  }
  /** 这次改动**全是**副产物 ⇒ 一句更准的理由（"都在已知范围内"读起来像"我改了代码但面认得"，太含糊） */
  const allByproduct = !full && out.byproducts.length === list.length;

  if (out.full) out.reason = '有认不出的路径 ⇒ 按全量跑（保守优先）';
  else if (allByproduct) {
    out.reason = '本次改动**全是运行副产物**（用户数据 / 构建产物 / 临时文件 / 日志）⇒ '
      + '不是越界、也不是无人认领；只跑数据校验（G2）+ 卫生八件（**不是全量真值**）';
  } else out.reason = '改动都在已知范围内 ⇒ 只跑相关步骤（**不是全量真值**）';
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
  /* 运行副产物**点名**（B8：跳过要与通过可区分）—— 不点名的话，读者会把"没跑冒烟"读成"漏跑了一档" */
  if ((plan.byproducts || []).length) {
    const bp = plan.byproducts;
    lines.push('  · 运行副产物 ' + bp.length + ' 个文件（**不是越界、也不是无人认领** —— 用户用了软件就会改）：'
      + bp.slice(0, 3).map((x) => x.path + '（' + x.label + '）').join('、')
      + (bp.length > 3 ? ' 等' : ''));
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
  { key: '规则卫生', gates: ['G1', 'G8', 'G9', 'V1', 'V2', 'S1', 'S2', 'S3', 'S4'] },
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
    domains: ['07', '09', '11', '12', '13', '14', '15', '18', '21', '22', '23', '24', '53', '57'],
    why: '壳面：IPC / 写盘闸门 / 原生侧栏 / 窗口 / 沙箱隔离 —— 这些域的读数以主进程行为为准'
      + '（53 = 测量驱动的侧栏宽度预算：档位/区间/读数序列/上报，读数全部以主进程状态为主）'
      + '（57 = 导出导图 PNG：`exportMapPng` 在主进程里撑窗口/平移分片/截图/拼图 —— 读数（PNG 尺寸、'
      + '底部像素、用户窗口 bounds）有一半是主进程 API，故归壳面，只登记这一次）'
  },
  {
    id: 'renderer', what: '渲染层（`renderer/` · `editor.js` · `style.css` · `index.html`）',
    steps: ['G5'],
    domains: ['01', '02', '03', '04', '05', '06', '08', '10', '16', '17', '19', '20', '25', '26',
      '28', '29', '30', '31', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '45', '46',
      '47', '48', '49', '50', '51', '52', '54', '55', '56'],   // 49 = R2 期 4（重挂父：三道闸 + 既有 move 语义；读数以界面 / 真鼠标 / 盘上 JSON
      // 55 = `DM` 草稿图（台账 `W11`）：读数落在**草稿窗自己的页面**（`elementFromPoint` 命中根节点）
      //      + **主进程窗口面**（置顶 / 无父窗 / 按内容定尺寸）+ 盘上（并入后回读、幂等拒绝后零变化），
      //      本批改的是 `renderer/draft-map.*` 与 `main.js` 的草稿窗一段 ⇒ 归界面面，**只登记这一次** 为准）
      // 56 = `DM` 草稿图的**编辑**（`W11 a–e` 的 `b`）：读数以草稿窗页面（真 UI 点击 + `elementFromPoint`）
      //      + 主进程权威副本（`ctx.draft.list()` / 导出 json）+ 盘上零写入为准 ⇒ 归界面面，**只登记这一次**
      // 50 = R6 五星评价（星标/弹框/摘要 = 界面读数为主；落库走主进程独占通道端到端对拍，归界面面）
      // 51 = R2 期 5 复杂结构模式（结构轴开关 / 双击分支 / 拖动不受层约束 / 关系层画法；
      //      读数以真鼠标 + 真 DOM + 盘上项目 JSON 原文为准 ⇒ 归界面面）
      // 52 = R7 主体（详情正文的白名单消毒 / Mermaid 懒加载 / details / 三类链接 / 笔记锚点）：
      //      读数以真鼠标 + 真帧像素 + 主进程出口调用账 + DOM 为准；本批改的也主要是 `renderer/**`
      //      （另含 `src/html-whitelist.js` 那张表、`src/assoc.js`·`src/relations.js`·`src/schema.js`
      //      的锚点判据、`cli/commands/assoc.js` 的 `--anchor`）⇒ 归界面面，
      //      **恰好登记这一次**（同一个域不许在两个面各登记一遍）
      // 54 = `TV` 标签视图（台账 `W9`）：读数全部落在界面（`mm-tag-hit` 的 id 集 / 面板计数 /
      //      `elementFromPoint` 命中自身 / Esc 后标记归零），本批改的是 `renderer/app-tag-view.js`
      //      + `src/tree-utils.js` 的纯函数 ⇒ 归界面面，**只登记这一次**
    why: '界面面：读数以界面（DOM / 真鼠标 / 真帧）为主的域都归这里 —— 这也是**最大的一块**'
      + '（界面域本来就占冒烟的大多数）⇒ 单点小改动请用 `--domains` 再收窄，或用 `--changed` 自动档'
  },
  {
    id: 'byproduct', what: '运行副产物（`projects/**` 用户数据 · 构建产物 · 临时文件 · 日志）',
    steps: BYPRODUCT_STEPS,          // = ['G2']，与 RULES 的「运行副产物」同源（一处）
    domains: [],
    why: '用户数据 / 运行留痕：**不改源码行为** ⇒ 不跑冒烟、不跑集成；只跑数据校验（G2）'
      + '（用户"只是用了软件"就让全链跑二十几分钟，正是 RULES.md 的 R3a 要避免的那件事）'
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

/** `--boundary` 的两档（T1 批）。**默认档由实测误报率决定**，理由写在 `BOUNDARY_DEFAULT` 那一段 ✓ */
const BOUNDARY_MODES = ['report', 'strict'];

/** 越界判定的默认档。
 *  **2026-10-17（T1 批）定档依据 = 实测误报率**（`testing-for-ai` B8 / 调研的「误报率 > 20% ⇒ 停下」判据）：
 *  见 `.review/20261016-T1-批次越界检查/README.md` 的读数表 —— 本档取 **report**，
 *  理由是"**多批并发**"那一档的误报率超过 20%：本工程同时有多个会话在改（实测开工时工作树里
 *  就有别人的 10 个文件），而这些批次**今天不会**去写 `.review/claim-*.json` ⇒ 判红会把
 *  "别人的改动"记到我头上。**判据一条没放宽**（`strict` 走的是同一份判定，已注入证明会红）；
 *  变的只是"默认发不发红" —— 这正是 B8 的三档，不是把门禁调松 ✗。
 *  ⚠️ 要它判红的场合（放行点 / 收口提交前）：`--changed --boundary=strict`。 */
const BOUNDARY_DEFAULT = 'report';

/**
 * `--for <面>` / `--domains a,b` / `--changed` / `--claimed a,b` / `--boundary=report|strict` 的
 * **解析**（纯函数，入口只有这一处）。
 * @param {string[]} argv process.argv
 * @returns {{mode:'full'|'changed'|'for', surface:string|null, domains:string[]|null,
 *   claimed:string[]|null, boundaryMode:'report'|'strict', error:string|null}}
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
  const rawClaimed = pick('--claimed');
  const rawBoundary = pick('--boundary');
  const domains = rawDomains === null ? null
    : rawDomains.split(',').map((d) => d.trim()).filter(Boolean);
  const claimed = rawClaimed === null ? null
    : rawClaimed.split(',').map((s) => s.trim()).filter(Boolean);
  let boundaryMode = BOUNDARY_DEFAULT;
  if (rawBoundary !== null) {
    if (BOUNDARY_MODES.indexOf(rawBoundary) < 0) {
      return { mode: changed ? 'changed' : (rawFor !== null ? 'for' : 'full'), surface: null, domains: null,
        claimed: null, boundaryMode,
        error: '`--boundary` 只认 ' + BOUNDARY_MODES.join(' / ') + '（收到 ' + JSON.stringify(rawBoundary) + '）' };
    }
    boundaryMode = rawBoundary;
  }
  /* 越界判定的两个开关都**只在 `--changed` 档有意义**：另外两档根本不看工作树
   * （`--for` 是人点名面、默认档是全链）⇒ 给了就该**响亮拒绝**，别静默忽略（否则用户以为判过了 ✗） */
  if ((claimed !== null || rawBoundary !== null) && !changed) {
    return { mode: rawFor !== null ? 'for' : 'full', surface: null, domains: null, claimed: null, boundaryMode,
      error: '`--claimed` / `--boundary` 只能跟着 `--changed` 用（越界判定要一份**实际的**改动清单，'
        + '另外两档都给不出那份清单：`--for` 是人点名面、默认档是全链）' };
  }
  if (rawClaimed !== null && (!claimed || !claimed.length)) {
    return { mode: 'changed', surface: null, domains: null, claimed: null, boundaryMode,
      error: '`--claimed` 给了空清单（要么不给 = 本档只报"未验证"，要么给路径/前缀/glob）' };
  }
  if (boundaryMode === 'strict' && (!claimed || !claimed.length)) {
    return { mode: 'changed', surface: null, domains: null, claimed: null, boundaryMode,
      error: '`--boundary=strict` 必须同时给 `--claimed <路径/前缀/glob>` —— '
        + '没有声明面就没有"越界"可言，给不出判据时**判红**是假红，不如当场拒 ✗' };
  }
  if (changed && rawFor !== null) {
    return { mode: 'changed', surface: null, domains: null, claimed: null, boundaryMode,
      error: '`--changed`（按 git 改动清单自动选）与 `--for <改动面>`（人显式点名）**只能给一个** —— '
        + '同时给就等于两套选择口径同时生效 ✗' };
  }
  if (rawFor !== null) {
    if (!rawFor) {
      return { mode: 'for', surface: null, domains, claimed: null, boundaryMode,
        error: '`--for` 后面要跟一个改动面名' };
    }
    if (domains && !domains.length) {
      return { mode: 'for', surface: rawFor, domains: null, claimed: null, boundaryMode,
        error: '`--domains` 给了空清单（要么不给，要么给域号）' };
    }
    return { mode: 'for', surface: rawFor, domains, claimed: null, boundaryMode, error: null };
  }
  if (domains) {
    return { mode: 'full', surface: null, domains: null, claimed: null, boundaryMode,
      error: '`--domains` 只能跟着 `--for <面>` 用（单独给它就没有"面"可收窄）' };
  }
  return { mode: changed ? 'changed' : 'full', surface: null, domains: null,
    claimed: changed ? claimed : null, boundaryMode, error: null };
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

/* ================================================================================
 * 「批次越界检查」（T1 批，2026-10-17）—— 本批声明面 × 实际改动清单
 * --------------------------------------------------------------------------------
 * 它回答 `architecture-for-ai` E1 的**另一半**：
 *   **一条命令能不能列出「本批声明的面之外」被改动的文件？**
 * 本工程原先**不能**（全仓搜 越界/ownership/claimed/分区/认领，在 `scripts/` 与 `tests/` 下零命中），
 * 于是「登记面无主」这件事的后果是"每批的子集各自都绿、合起来必红、且**没人会看见**"。
 *
 * 判据（一句话）：**改动文件里有没有「既不属于本次声明的改动面、也不是运行副产物」的**。
 * 每个文件的身份**四种，互斥**（`B4b`：判定档数不许少于要区分的状态数）：
 *   `byproduct` 运行副产物（`projects/**` 用户数据 / 构建产物 / 临时文件 / 日志）—— **不算越界**
 *   `mine`      命中**本批**声明面（`--claimed` 或 `.review/claim-*.json` 里本批那一份）
 *   `other`     命中**别的在飞批次**的登记 —— 并发时**不制造假红**（这是"多批并发"那一档的全部意义）
 *   `unclaimed` 谁都不是 ⇒ **只有这一族**会让判定变红
 * 三档（`testing-for-ai` B8：跳过必须与通过可区分）：
 *   `skipped`   没有声明面 / 采不到清单 / 工作树干净 ⇒ **本次没判**（响亮说"未验证"，**不是通过** ✗）
 *   `ok`        有声明面，面外没有源码级文件
 *   `violation` 有声明面，面外有源码级文件
 *
 * ⚠️ 能力边界（照 E1 如实标注，别当它比实际强）：它只判「文件有没有人认领」，
 *   **判不出「是谁写的」** ⇒ 「属共享写者、但被他人改过」的文件（`CHANGELOG.md` 被别的批次补了一行）
 *   仍需**逐行复核后收编**。它也不判"这个文件该不该被改"（那是各面自己的判据）。
 * ================================================================ */

/** 路径归一化（只做"同一份清单"这一件事：反斜杠 → `/`、去 `./`、去首尾空白） */
function normalizeRel(f) { return String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, ''); }

/** 一条声明是否覆盖某文件。三种写法：`dir/` 前缀 · 精确文件 · glob（`**` 跨目录、`*` 不跨）。
 *  glob 只做最小实现（**不新造路径表**，也不引依赖）：除 `*` 外一律按字面量转义。 */
function matchClaim(file, claim) {
  const f = normalizeRel(file);
  const c = normalizeRel(claim);
  if (!f || !c) return false;
  if (c.indexOf('*') >= 0) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const src = c.split('**').map((seg) => seg.split('*').map(esc).join('[^/]*')).join('.*');
    return new RegExp('^' + src + '$').test(f);
  }
  if (/\/$/.test(c)) return f === c.slice(0, -1) || f.indexOf(c) === 0;
  return f === c;
}

/**
 * 越界判定（**纯函数**：无 I/O、无时钟、无环境 ⇒ 可单测、可注入坏输入做判别力证明）。
 * @param {string[]|null} files 改动文件（`git diff --name-only HEAD` ∪ 未跟踪）；`null` = 采不到
 * @param {{claimed?:string[]|null, claims?:Array<{id?:string, files:string[]}>}} [opts]
 *   `claimed` = **本批**声明面；`claims` = **别的在飞批次**的登记（`.review/claim-*.json`）
 * @returns {{status:'skipped'|'ok'|'violation', ok:boolean, declared:string[],
 *   byproduct:Array<{path:string,label:string}>, mine:string[],
 *   other:Array<{path:string,batch:string}>, unclaimed:string[],
 *   counts:{files:number,mine:number,byproduct:number,other:number,unclaimed:number}, reason:string}}
 */
function planBoundary(files, opts) {
  const o = opts || {};
  const declared = (o.claimed || []).map(normalizeRel).filter(Boolean);
  const others = (o.claims || []).filter(Boolean).map((c, i) => ({
    id: String((c && (c.id || c.batch)) || ('claim#' + (i + 1))),
    files: ((c && c.files) || []).map(normalizeRel).filter(Boolean)
  }));
  const out = {
    status: 'skipped', ok: false, declared,
    byproduct: [], mine: [], other: [], unclaimed: [],
    counts: { files: 0, mine: 0, byproduct: 0, other: 0, unclaimed: 0 },
    reason: ''
  };
  if (files === null || files === undefined) {
    out.reason = '取不到改动清单（git 失败 / 不在仓库里）⇒ **本次没有判越界**（采不到真值 ≠ 通过）';
    return out;
  }
  const list = Array.from(new Set(files.map(normalizeRel).filter(Boolean))).sort();
  out.counts.files = list.length;
  if (!list.length) {
    out.reason = '工作树干净 ⇒ 没有东西可判（**这不算通过**，只是没有输入）';
    return out;
  }
  if (!declared.length) {
    out.reason = '没有声明本批改动面（`--claimed`）⇒ **本次没有判越界**（未验证 ≠ 通过）';
    return out;
  }
  for (const f of list) {
    const b = byproductFor(f);
    if (b) { out.byproduct.push({ path: f, label: b.label }); continue; }
    if (declared.some((c) => matchClaim(f, c))) { out.mine.push(f); continue; }
    const hit = others.filter((ot) => ot.files.some((c) => matchClaim(f, c)))[0];
    if (hit) { out.other.push({ path: f, batch: hit.id }); continue; }
    out.unclaimed.push(f);
  }
  out.counts.mine = out.mine.length;
  out.counts.byproduct = out.byproduct.length;
  out.counts.other = out.other.length;
  out.counts.unclaimed = out.unclaimed.length;
  out.status = out.unclaimed.length ? 'violation' : 'ok';
  out.ok = out.status === 'ok';
  out.reason = out.ok
    ? '面外的改动**都有身份**（运行副产物 / 别批在飞），没有无人认领的源码级文件'
    : '有 ' + out.unclaimed.length + ' 个文件**既不在本批声明面里、也不是运行副产物** ⇒ 越界'
      + '（若是别批在飞，请让它登记 `.review/claim-<批名>.json`）';
  return out;
}

/** 打印用（与 `describePlan` 同一分工：判定在纯函数里，这里只组织人读的行）
 *  三档**都必须说清是哪一档** —— 只报"跑了什么"会把"没判"读成"过了" ✗ */
function describeBoundary(res) {
  const lines = [];
  const c = (res && res.counts) || {};
  lines.push('批次越界检查（本批声明面 × 实际改动清单）：' + ({
    skipped: '— **本次没判**（未验证，不是通过）',
    ok: '✓ 无越界',
    violation: '✗ **越界**'
  }[res.status] || '?'));
  lines.push('  声明面 ' + (res.declared || []).length + ' 项 · 改动 ' + (c.files || 0) + ' 个文件 ⇒ '
    + '本批 ' + (c.mine || 0) + ' · 运行副产物 ' + (c.byproduct || 0)
    + ' · 别批在飞 ' + (c.other || 0) + ' · **无人认领 ' + (c.unclaimed || 0) + '**');
  if ((res.byproduct || []).length) {
    lines.push('  · 运行副产物（**不算越界**）：' + res.byproduct.slice(0, 4)
      .map((x) => x.path + '（' + x.label + '）').join('、')
      + (res.byproduct.length > 4 ? ' 等 ' + res.byproduct.length + ' 个' : ''));
  }
  if ((res.other || []).length) {
    lines.push('  · 别批在飞（已登记，**不算越界**）：' + res.other.slice(0, 4)
      .map((x) => x.path + '（' + x.batch + '）').join('、')
      + (res.other.length > 4 ? ' 等 ' + res.other.length + ' 个' : ''));
  }
  if ((res.unclaimed || []).length) {
    res.unclaimed.forEach((f) => lines.push('  ✗ ' + f));
  }
  lines.push('  ' + res.reason);
  return lines;
}

/**
 * 读**别的在飞批次**的声明登记：`.review/claim-*.json`（一份文件 = 一个批次 ⇒ 并发时不抢同一份，
 * `D1` 单一写者；`E5` 名字带批次 id ⇒ 不固定名）。
 * 采不到 / 读不懂 ⇒ **响亮列出**并**不计入**（不让坏登记静默变成"它认领了这些文件"）。
 * 格式（唯一权威就是这里，别再写第二份说明）：
 *   `{ "batch": "<批名>", "files": ["src/x.js", "docs/", "tests/*.test.js"] }`
 * @returns {{claims:Array<{id:string,files:string[]}>, errors:string[]}}
 */
function readClaims(dir, fsMod) {
  const f = fsMod || require('fs');
  const claims = [];
  const errors = [];
  let names;
  try { names = f.readdirSync(dir).filter((n) => /^claim-.+\.json$/.test(n)).sort(); }
  catch (e) { return { claims, errors }; }               // 目录不存在 = 没有别批登记（正常）
  for (const n of names) {
    const id = n.slice('claim-'.length, -'.json'.length);
    try {
      const j = JSON.parse(f.readFileSync(require('path').join(dir, n), 'utf8'));
      const files = j && Array.isArray(j.files) ? j.files : null;
      if (!files) { errors.push(n + '：缺 files 数组（读不懂 ⇒ 不计入）'); continue; }
      claims.push({ id: String(j.batch || id), files: files.map(normalizeRel).filter(Boolean) });
    } catch (e) { errors.push(n + '：' + (e.message || e) + '（读不懂 ⇒ 不计入）'); }
  }
  return { claims, errors };
}

module.exports = {
  planForFiles, describePlan, FULL_STEPS, ALWAYS, RULES,
  // 运行副产物（T1 批）：分类器 + 它该跑哪一档（RULES 与 SURFACES 共用这一份）
  BYPRODUCTS, BYPRODUCT_STEPS, byproductFor,
  // 批次越界检查（T1 批）：纯函数判定 + 打印 + 别批登记的读取 + 两档/默认档
  planBoundary, describeBoundary, matchClaim, readClaims, BOUNDARY_MODES, BOUNDARY_DEFAULT,
  // 「改动面（--for）」：同一张表 + 解析 + 自检 + 分叉判定（verify.js 是唯一调用方）
  SURFACES, LAYERS, SURFACE_FLOOR, surfaceIds, findSurface, layerMatrix, effectiveSteps,
  planForSurface, parseForArgs, describeNotRun, whoRuns, surfaceSelfCheck, domainNumbersIn,
  planDivergence
};
