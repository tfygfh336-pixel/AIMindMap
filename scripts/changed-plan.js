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
  for (const g of plan.byRule || []) {
    lines.push('  · ' + g.rule + '：' + g.files.length + ' 个文件 —— ' + g.why);
  }
  return lines;
}

module.exports = { planForFiles, describePlan, FULL_STEPS, ALWAYS, RULES };
