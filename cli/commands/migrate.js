/* ============================================================
 * cli/commands/migrate.js — v2 → v3 条目层迁移（S1）
 * ------------------------------------------------------------
 *   migrate items <项目> [--dry-run] [--json]
 *
 * 一句话：把 v2 节点的 `detail`（以及 `qa[]`）**无损**地搬进条目层 `items`，
 * 并让 `detail` 从"真源"降级为"派生缓存"。**能搬才搬，搬不了就整节点跳过并点名。**
 *
 * ## 契约（`docs/ITEM-MODEL.md` §6「迁移规则」，逐条按它实现，不重新设计）
 *   ① **幂等**：只处理"无 `items` 且（detail 含 `<li>` 或 有 `qa[]`）且能逐字节回放"的节点；
 *      跑第二次没有候选 ⇒ 回显"无需迁移"，`changed:{nodes:0,items:0}`，**文件逐字节不变**。
 *   ② **不改内容（准入门槛）**：只有 `renderDetail(parseDetail(detail)) === detail` **逐字节**成立
 *      才写 `items`；不成立 ⇒ **整个节点跳过**、一个字节都不动，并把 `{nodeId, reason}` 逐条写进报告。
 *      **不许**"修一下再写" —— 内容悄悄变质是本工程最重的损害类别。
 *   ③ **`qa[]` 收敛**：每一项映射成一条 `type:'qa'` 条目（`{q,a,at,model?}` 原样进 `item.qa`），
 *      **保序追加**在解析出的条目之后；随后**删掉节点的 `qa` 键**（不留只读副本：两处表达必漂移）。
 *   ④ **不写 `detailMode`**：它由**显式**动作写入（`edit --detail-mode rich`），迁移不自动推断；
 *      带了 `detailMode` 的节点**迁移不碰**（§2 互斥），并在报告里点名（"不可迁移"要**如实说**，
 *      不能伪装成"没有需要迁移的"）。
 *   ⑤ **版本号**：迁移把 `meta.formatVersion` 写成 `3`；`validate` 同时接受 2 与 3
 *      （这是"回退 = 恢复迁移前那份 `.aimap.json`"能成立的硬前提）。
 *   ⑥ **备份**：写盘**之前**自动 export-json 一份到 `.review/<YYYYMMDD>-条目层迁移/<项目>.aimap.json`，
 *      打印**绝对路径**，并打印"工程外备份"的推荐命令。**不提供跳过备份的开关**。
 *      同一步还会往那个目录写一份 `README.md`（自述：这是什么 / 能不能整目录删 / 怎么回退）——
 *      **G8 要求 `.review/` 的每个直接子目录都有 `README.md`**，本命令会当场新建目录，
 *      少了它 ⇒ 下一次全链的 G8 必红（G8 在链上第 2 步、G4 第 12 步：跑迁移那次却全绿）。
 *   ⑦ **报告**：文本与 `--json` 是**同一份数据**：
 *      `{ok, project, scanned, itemized, skipped:[{nodeId,reason}], items, changed:{nodes,items}, backup}`；
 *      `--dry-run` 只出报告（不写盘、不备份）。**跳过项逐条点名**。
 *
 * ## ⚠️ 子命令形式的位置参数陷阱（已实测，契约 §6 顶部那条）
 * `migrate items <项目>` 的第一个位置参数是子命令 `items`，而 `cli/core.js` 的
 * `ctx.projectName = args._[0]` ⇒ 它会等于 `"items"`。所以本文件：
 *   · 项目名一律取 **`ctx.args._[1]`**；
 *   · **不用** `ctx.read()` / `ctx.mutate()` / `ctx.find()`（它们都用 `projectName` ⇒ 报"项目不存在: items"），
 *     而是自己 `ctx.store.read(项目)` + `concurrency.withReplay`（写法与 `ctx.mutate` 同款：
 *     原子写 + 写后回读 + 并发时**按对象**判定能否安全重放）。
 *
 * ## 为什么命令体里要自己拼 withReplay（而不是"绕过并发机制直接写"）
 * 迁移期间别的会话可能正在改这个项目。直接 `store.write` 会**静默覆盖**对方的改动 ——
 * 本工程最重的损害类别。走 `withReplay` 之后：两路改动**不相交** ⇒ 自动合并（双方都在）；
 * 相交 ⇒ **指名拒绝**（`item:<节点>#<条目>` / `node:<id>` 这类键，见 `src/concurrency.js` §8 头部）。
 *
 * ## 与"证明的是这个、写的是那个"的关系（一次解析，一个产物）
 * 计划（plan）在**读到的这一版**上算好：每个节点要写的 `items` 数组是**那一份解析产物**，
 * 报告里说的也是它。写盘时只把这批产物**搬进去**（不重新解析），并在 `fn` 里核对
 * "这个节点还是当时那个状态吗" —— 变了就**中止并报错**（宁可失败，也不写一份报告与盘上不一致的数据）。
 * 解析只做一次 ⇒ `parseDetail` 生成的条目 id 也不会"校验一套、落盘另一套"。
 *
 * ## 一个字节都不动的两种拒绝（都在写盘之前，盘上零改动）
 *   · **准入门槛**：回放不了 ⇒ 整节点跳过（`skipped` 里点名）；
 *   · **计划前提失效**：并发把目标节点改了/条目化了 ⇒ 中止整条命令（`error: ` + 退出码 1）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const bundle = require('../../src/bundle.js');
const concurrency = require('../../src/concurrency.js');

/** 工程根（备份落在它下面的 `.review/` 里 —— 工作产物区，不进版本库） */
const ROOT = path.resolve(__dirname, '..', '..');
/** 备份目录名的后缀（前缀是迁移当天的本地日期 `YYYYMMDD`） */
const BACKUP_SUBDIR_SUFFIX = '-条目层迁移';

/* ============================================================================
 * 一、依赖：`src/item-model.js`（S1 的文件；四个纯函数 + 一个装配点）
 * ========================================================================== */

/**
 * 取用条目层模型。缺失/签名不符时**响亮报错** —— 绝不在这里自己实现一份
 * （两份实现必然漂移，那正是本工程最重的损害类别之一）。
 */
function model() {
  const m = require('../../src/item-model.js');
  ['parseDetail', 'renderDetail', 'validateItems', 'newItemId', 'itemizeNode'].forEach((k) => {
    if (typeof m[k] !== 'function') {
      throw new Error('src/item-model.js 缺少契约函数 ' + k
        + '（docs/ITEM-MODEL.md §5.1 的冻结签名）—— 迁移中止，盘上未改动');
    }
  });
  return m;
}

/* ============================================================================
 * 二、小工具（纯函数）
 * ========================================================================== */

/** 迁移时刻：**在进写盘函数之前**算好（`fn` 里不许读时钟 —— 并发重放会读到另一个时刻） */
function nowIso() { return new Date().toISOString(); }

/** 本地日期 `YYYYMMDD`（备份目录名 = `.review/<YYYYMMDD>-条目层迁移`） */
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate());
}

/** 在树里找节点（不用 ctx.find：它读的是 `projectName` ⇒ 那会去找名叫 `items` 的项目） */
function findNode(root, id) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.id === id) return n;
    (n.children || []).forEach((c) => stack.push(c));
  }
  return null;
}

/** 全项目**已有**条目 id 集合（新条目 id 的查重范围：契约 §5.1 的分工） */
function existingItemIds(root) {
  const used = new Set();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (Array.isArray(n.items)) n.items.forEach((it) => { if (it && it.id) used.add(it.id); });
    (n.children || []).forEach((c) => stack.push(c));
  }
  return used;
}

function nodeLabel(node) {
  const t = node && node.topic ? String(node.topic) : '';
  return t ? (node.id + '（' + t + '）') : String(node && node.id);
}

/* 跳过原因：**两类，各自有出口**。文本报告里会各解释一次（别让调用方只看到一串原因码）。 */
const R_SKIPPED_REPLAY = '不可逐字节回放（准入门槛：renderDetail(parseDetail(detail)) !== detail）';
const R_SKIPPED_RICH = '已显式声明为富文本节点（detailMode）—— 与条目层互斥，迁移不碰它';

/* ============================================================================
 * 三、计划（纯函数：读到的这一版 → 要写什么 / 跳过谁）
 * ========================================================================== */

/**
 * 扫一遍树，算出"这次迁移要做什么"。**不改入参**（只读）。
 *
 * 判定顺序（顺序本身是语义的一部分）：
 *   1. 已有 `items` ⇒ **幂等**跳过（不是失败；第二次跑就是这一档）；
 *   2. 有 `detailMode` ⇒ 富文本节点、迁移不碰（§2 互斥）——**它本来会被迁移时才点名**，免得刷屏；
 *   3. 其余交给 `itemizeNode`（它判"没有可迁移的内容"/"不在迁移范围"两种不适用）；
 *   4. 能条目化 ⇒ **过准入门槛**：解析出的那部分必须能逐字节回放，否则 `skipped` 点名。
 *      ⚠️ 门槛只看**解析产物那一段**（不含 qa 收敛出来的条目）—— 契约 §6 冻结了
 *      "qa 条目**保序追加**在解析出的条目之后"，所以前 `items.length - qaItems` 条就是解析产物。
 *      qa 收敛必然让 detail 多出渲染结果（这是设计的一部分，不是内容变质）；
 *      而"解析产物回放不了"才是真变质 ⇒ 必须跳过。
 *
 * @returns {{scanned:number, plan:Array<{nodeId,items,qaItems,detailBefore}>, skipped:Array<{nodeId,reason}>}}
 */
function buildPlan(data, at, by) {
  const M = model();
  const plan = [];
  const skipped = [];
  const used = existingItemIds(data.data);       // 新条目 id 的查重池（含本次新生成的）
  let scanned = 0;

  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    scanned++;
    const kids = node.children || [];

    // `items` 存在（含**非数组**的坏形状）⇒ 交给 G2 判红，迁移不替它收拾（这里必须**不碰**它）
    if (node.items === undefined) {
      const detail = (typeof node.detail === 'string') ? node.detail : '';
      const qaList = Array.isArray(node.qa) ? node.qa : [];
      const hasLi = /<li\b/i.test(detail);
      const wouldMigrate = (detail.trim() !== '' || qaList.length > 0) && (hasLi || qaList.length > 0);

      if (node.detailMode !== undefined) {
        // 富文本节点：**绝不自动条目化**（那要删掉一个显式写下的标记 ⇒ 属于 `edit` 的语义）
        if (wouldMigrate) skipped.push({ nodeId: node.id, reason: R_SKIPPED_RICH });
      } else {
        const r = M.itemizeNode(node, { at: at, by: by });
        if (r.ok) {
          const qaCount = r.qaItems || 0;
          const items = r.items.slice();
          // ⚠️ 解析产物的条目不带 `at`/`by` 时补上迁移时刻（契约 §1：at 可选、"迁移写迁移时刻"；
          //    这里逐条补，好让"这条是什么时候进库的"对**所有**迁移产物口径一致）。
          items.forEach((it) => {
            if (it.at === undefined) it.at = at;
            if (it.by === undefined) it.by = by;
            // id 查重（契约 §5.1：newItemId() 只产候选，唯一性由调用方在全项目里查）
            let guard = 0;
            while (used.has(it.id) && guard++ < 1000) it.id = M.newItemId();
            used.add(it.id);
          });
          const parsedOnly = items.slice(0, items.length - qaCount);   // 见上面那段注释
          let replay = null;
          try { replay = M.renderDetail(parsedOnly); } catch (e) { replay = null; }
          if (replay !== detail) {
            skipped.push({ nodeId: node.id, reason: R_SKIPPED_REPLAY });
          } else {
            plan.push({ nodeId: node.id, items: items, qaItems: qaCount, detailBefore: detail });
          }
        } else if (r.reason === 'not-lossless') {
          // 解析本身就回放不了（闭合标签缺失 / 根层裸文本 / 交叉嵌套…）
          skipped.push({ nodeId: node.id, reason: R_SKIPPED_REPLAY });
        }
        // `itemized` / `no-detail` / `not-list` ⇒ **不在迁移范围**（幂等行说的"没有候选"就是这一档）
      }
    }

    kids.forEach(walk);
  })(data.data);

  return { scanned: scanned, plan: plan, skipped: skipped };
}

/* ============================================================================
 * 四、应用计划（纯函数：在**写盘那一刻的那份数据**上执行）
 * ========================================================================== */

/**
 * 把计划搬到数据上。**可重复执行**（并发重放会再调一次）⇒ 每次都用计划里的产物**深拷贝**，
 * 不持有引用、不累积副作用。
 *
 * 计划前提核对（**变了就中止**，绝不"接着写"）：
 *   · 节点没了 ⇒ 并发删了它；
 *   · 节点已经有 `items` ⇒ 并发条目化了它（再写就会覆盖对方）。
 * 这两种都是"证明的是这个、写的是那个"的入口，必须响亮失败（报错由 `withReplay` 带出）。
 */
function applyPlan(data, plan) {
  const M = model();
  plan.forEach((p) => {
    const node = findNode(data.data, p.nodeId);
    if (!node) {
      throw new Error('迁移中止：节点 ' + p.nodeId + ' 在本次写入时已不存在 —— 计划是针对**读取到的那一版**算的，'
        + '盘上已有并发改动。请重新跑一次 `migrate items`（它会基于最新版重算计划）。');
    }
    if (node.items !== undefined) {
      throw new Error('迁移中止：节点 ' + nodeLabel(node) + ' 在本次迁移期间**已被条目化**（并发写入 / 另一会话）。'
        + '盘上未改动，请重新跑一次 `migrate items` 看新的计划。');
    }
    node.items = JSON.parse(JSON.stringify(p.items));      // 深拷贝：fn 可能被重放调用两次
    delete node.qa;                                        // qa[] 收敛后**删掉键**（不留只读副本）
    const html = M.renderDetail(node.items);
    if (html === '') delete node.detail; else node.detail = html;   // 缺 detail 与空串等价（§2）
  });
  if (plan.length) {
    if (!data.meta || typeof data.meta !== 'object') {
      throw new Error('迁移中止：项目缺少 meta（数据已坏，先修 data 再迁移）');
    }
    data.meta.formatVersion = 3;                           // 契约 §6：迁移把版本号写成 3
  }
  return data;
}

/* ============================================================================
 * 五、备份（写盘之前；与 `export-json` **同一实现**，产出同一份 `.aimap.json`）
 * ==========================================================================
 * 为什么不新写一套打包逻辑：备份必须**真的**能用 `import-json` 恢复回去，
 * 而"什么是合法的 aimap 文件"只有 `src/bundle.js` 一处实现（`export-json` 也用它）。
 * 复制一份打包代码 = 两份会漂的真相 —— 那是把"备份能不能恢复"这件事交给运气。
 *
 * 为什么必须有它（且不给跳过开关）：工程内备份**不是**磁盘级事故的兜底
 * （`docs/INCIDENTS.md` 第 4 条：大改前先导出到**工程外**）—— 所以除了自动备份，
 * 回显里还要把"工程外那份该怎么出"写成一句能直接抄的命令。
 * ========================================================================== */

/**
 * 备份目录的**自述文件**。
 *
 * ⚠️ 为什么它必须由**产品**写（而不是给 G8 开豁免）：G8（`scripts/docs-registry-check.js`
 * 的 `checkWorkDirStatus`）要求 `.review/` 的**每个直接子目录**都有 `README.md` 声明死活
 * （在飞 / 已收口 / 已废弃）。本命令会在建备份时**当场新建一个目录** ⇒ 没有自述，
 * 之后**任何一次** `npm run verify` 都会在 G8 红「[工作目录无状态]」，而**跑迁移的那一次却全绿**
 * （G8 在链上排第 2 步、G4 排第 12 步）—— 这正是本批实测踩到的"绿链毒化下一次绿链"。
 * 豁免是绕过；**让产物自己说清"我是什么、能不能删、怎么回退"**才是本工程的做法。
 *
 * 内容里的日期只到**天**（`YYYY-MM-DD`）⇒ 同一天重复迁移写出的内容**逐字节相同**，
 * 不引入非确定性产物（判据：同状态连跑两次逐字节相同，见 `scripts/determinism-check.js`）。
 */
function backupReadmeText() {
  const s = localStamp(new Date());
  return [
    '# 条目层迁移（v2 → v3）· 写盘前的自动备份',
    '',
    '- 主题: 条目层迁移（v2 → v3）的写盘前自动备份',
    '- 开始日期: ' + s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8),
    '- 状态: 已收口',
    '',
    '## 这是什么',
    '`node cli/mm-cli.js migrate items <项目>` **真要写盘之前**自动导出的那一份 `<项目>.aimap.json`。',
    '它用的是与 `export-json` **同一个**打包实现 ⇒ 能被 `import-json` 原样导回；',
    '里面那份还是 **formatVersion 2**（回退就靠它）。',
    '',
    '## 能整目录删除吗',
    '能。这是**工作产物区**：整个目录可以随时删掉，删它不影响任何项目数据',
    '（它**不进版本库** —— `.review/` 已在 `.gitignore` 里）。下次真跑迁移会按当日重新建目录。',
    '',
    '## 怎么用它回退',
    '1) 先停手，别再写那个项目；',
    '2) `node cli/mm-cli.js import-json <项目>.aimap.json <新项目名>` 导成一份新项目核对，',
    '   再 `node cli/mm-cli.js validate <新项目名>` 过一遍；',
    '3) 确认要就地回退：先 `export-json` 当前状态留底，再删掉要回退的项目目录、把这份备份导回来。',
    '',
    '## 边界',
    '- 它**不是**磁盘级事故的兜底：大改前请照 `docs/INCIDENTS.md` 第 4 条另导一份到**工程外**。',
    '- 目录名里的日期 = 迁移当天；同一天多次迁移会**覆盖**同名文件。',
    ''
  ].join('\n');
}

/**
 * @returns {{file:string, missing:string[], bytes:number}}
 */
function writeBackup(ctx, project, snapshot) {
  const dir = path.join(ROOT, '.review', localStamp(new Date()) + BACKUP_SUBDIR_SUFFIX);
  fs.mkdirSync(dir, { recursive: true });
  // 目录自述（G8 的判据 = `.review/<目录>/README.md` **存在**）：与备份同一步、同样在**写盘之前**。
  // 内容没变就不重复写（保持"不产生空写入"，也让同一天的多次迁移逐字节幂等）。
  const readme = path.join(dir, 'README.md');
  const readmeText = backupReadmeText();
  let readmeOld = null;
  try { readmeOld = fs.readFileSync(readme, 'utf8'); } catch (e) { /* 第一次：还没有 */ }
  if (readmeOld !== readmeText) ctx.store.writeFileAtomic(readme, readmeText);
  const file = path.join(dir, project + '.aimap.json');
  const assets = {};
  const missing = [];
  bundle.collectResourceRefs(snapshot.data.data).forEach((ref) => {
    const p = path.join(ctx.PROJECTS_DIR, project, ref.file);
    if (fs.existsSync(p)) assets[ref.file] = fs.readFileSync(p).toString('base64');
    else missing.push(ref.file);
  });
  const pack = bundle.buildBundle(snapshot.data, assets);
  const text = JSON.stringify(pack, null, 2);
  // 原子写（临时文件 + fsync + rename）：`docs/INCIDENTS.md` 第 5 条要求所有新增写盘路径复用它。
  // 走到这里说明真有节点要迁 ⇒ 这份备份是"改坏了能整体回滚"的唯一依据，绝不允许半截文件。
  ctx.store.writeFileAtomic(file, text);
  return { file: file, missing: missing, bytes: Buffer.byteLength(text, 'utf8') };
}

/* ============================================================================
 * 六、报告（文本与 `--json` 是**同一份数据**）
 * ========================================================================== */

/** 文本报告里对两类跳过项各给一次出口（逐条点名的那部分在下面按节点打） */
function skipLegend() {
  return [
    '  跳过项的两种原因与出口（契约 §6 的底线：不许把"不可迁移"伪装成"没有需要迁移的"）：',
    '    · 不可逐字节回放 ⇒ 该节点**一个字节都没动**。三条出路：① 先备份，再手工把 detail 拆成',
    '      能被 renderDetail 回放的形状；② 若它其实是不可拆的富文本，显式 `edit --detail-mode rich`；',
    '      ③ 保持原样（v2 节点照旧可读可写，条目层允许混合）。',
    '    · detailMode ⇒ 它是**显式**声明过的富文本节点，与条目层互斥（§2）。要按条目标就先',
    '      `edit <项目> <节点id> --clear-detail-mode`，再跑一次本命令。'
  ].join('\n');
}

/** 工程外备份的推荐命令（`docs/INCIDENTS.md` 第 4 条） */
function offProjectBackupHint(project) {
  return '    node cli/mm-cli.js export-json ' + project + ' "<工程外目录>\\' + project + '-' + localStamp(new Date())
    + '.aimap.json"';
}

/**
 * @param {object} r 报告（与 --json 同一份）
 * @param {{dryRun:boolean, qaItems:number, missing:string[], backupBytes:number}} extra 只在文本里多说几句
 */
function reportText(r, extra) {
  const lines = [];
  const skippedLines = r.skipped.map((s) => '    · ' + s.nodeId + '：' + s.reason);
  if (r.changed.nodes === 0) {
    if (r.skipped.length) {
      lines.push('本次**没有可迁移的节点**（0 个），但**有 ' + r.skipped.length + ' 个节点被跳过** ——'
        + '这不是"没有需要迁移的东西"，它们需要人来定（见下）。盘上**未改动**（changed.nodes=0 / changed.items=0）。');
    } else {
      lines.push('无需迁移：扫描 ' + r.scanned + ' 个节点，没有"未条目化且可无损回放"的节点 ——'
        + '盘上**未改动**（幂等，changed:{nodes:0,items:0}）。');
    }
    lines.push('  扫描 ' + r.scanned + ' 个节点，条目化 ' + r.itemized + ' 个，跳过 ' + r.skipped.length + ' 个。');
    if (skippedLines.length) { lines.push(skipLegend()); lines.push('  跳过项（逐条点名）：'); lines.push(...skippedLines); }
    return lines.join('\n');
  }

  const head = extra.dryRun
    ? '[--dry-run] 将迁移条目层（v2 → v3）：**盘上零改动**（没有备份、没有写入）'
    : '已迁移条目层（v2 → v3）';
  lines.push(head);
  lines.push('  扫描 ' + r.scanned + ' 个节点，条目化 ' + r.itemized + ' 个（新增 ' + r.items + ' 条条目'
    + (extra.qaItems ? '，其中由 qa[] 收敛 ' + extra.qaItems + ' 条' : '')
    + '），跳过 ' + r.skipped.length + ' 个。');
  if (!extra.dryRun) lines.push('  meta.formatVersion → 3');
  if (extra.dryRun) {
    lines.push('  预览的 changed：' + JSON.stringify(r.changed) + '（真跑时就是这个数）');
  } else {
    lines.push('  changed：' + JSON.stringify(r.changed));
    lines.push('  迁移前备份（绝对路径）：' + r.backup);
    if (extra.missing && extra.missing.length) {
      lines.push('  ⚠️ 备份里缺少这些资源文件（原文件就不在项目里，备份照实缺）：' + extra.missing.join(', '));
    }
    lines.push('  工程外备份的推荐命令（工程内备份**不是**磁盘级事故的兜底，见 docs/INCIDENTS.md 第 4 条）：');
    lines.push(offProjectBackupHint(r.project));
    lines.push('  回退办法：把上面那份 `.aimap.json` 用 `import-json` 导成项目（formatVersion 是 2，'
      + '恢复后所有写命令照常可用）。');
    lines.push('  下一步（契约 §6 的门禁）：`node cli/mm-cli.js validate-all` + 该项目的 `health`。');
  }
  if (skippedLines.length) { lines.push(skipLegend()); lines.push('  跳过项（逐条点名）：'); lines.push(...skippedLines); }
  return lines.join('\n');
}

/* ============================================================================
 * 七、命令体
 * ========================================================================== */

module.exports = {
  migrate(ctx) {
    const sub = ctx.args._[0] === undefined ? '' : String(ctx.args._[0]);
    const project = ctx.args._[1] === undefined ? '' : String(ctx.args._[1]);
    if (sub !== 'items' || !project) {
      ctx.error('用法: migrate items <项目> [--dry-run] [--json]'
        + '（把 v2 节点的 detail 无损迁成条目层 items）'
        + (sub && sub !== 'items' ? '\n  ⚠️ 未知子命令 `' + sub + '`：当前只有 `migrate items`（条目层迁移）' : '')
        + (!project ? '\n  ⚠️ 缺项目名：注意项目名是**第二个**位置参数（`migrate items <项目>`）' : ''));
    }
    const dryRun = !!ctx.args.dryRun;
    const at = nowIso();
    const by = ctx.writer;                                  // `<外壳>:<命令>`（这里 = cli:migrate）
    // ⚠️ **幂等守卫先于任何物理副作用**（契约 §5.2 的接口纪律）：本命令在写盘**之前**会导出备份
    //    （复制/新建文件），若命中幂等键还去做备份 ⇒ 留下孤儿产物，而回显却说"盘上数据未改动"。
    // ⚠️ **先自报项目名**（位置参数陷阱的连带项）：本命令的 `_[0]` 是子命令名 `items`，而
    //    `ctx.replayCheck()` 默认按 `_[0]` 去查"项目 `items`"的变更日志 ⇒ 幂等键**永远命中不了**
    //    （静默：第二次看起来正常、其实又执行了一遍）。必须在 replayCheck 之前把真项目名报上去。
    ctx.useProject(project);
    ctx.replayCheck();

    // 项目名**必须**从 `ctx.args._[1]` 取（见文件头的位置参数陷阱）⇒ 读盘也自己做
    const snapshot = ctx.store.read(project);               // 项目不存在 ⇒ 响亮抛错（名字正确）
    const { scanned, plan, skipped } = buildPlan(snapshot.data, at, by);
    const newItems = plan.reduce((s, p) => s + p.items.length, 0);
    const qaItems = plan.reduce((s, p) => s + p.qaItems, 0);
    const report = {
      ok: true,
      project: project,
      scanned: scanned,
      itemized: plan.length,
      skipped: skipped.map((s) => ({ nodeId: s.nodeId, reason: s.reason })),
      items: newItems,
      changed: { nodes: plan.length, items: newItems },
      backup: null
    };

    /* ---- 没有要写的 ⇒ 一次盘都不写（`--dry-run` 同理）---- */
    if (dryRun || plan.length === 0) {
      emit(ctx, report, reportText(report, { dryRun: dryRun, qaItems: qaItems, missing: [] }));
      return;
    }

    /* ---- 写盘：备份 → 一次原子写（自己 read/change/write，见文件头的位置参数陷阱）---- */
    const backup = writeBackup(ctx, project, snapshot);
    report.backup = backup.file;
    let attempts = 1, merged = false;
    try {
      const res = concurrency.withReplay({
        read: () => ctx.store.read(project),
        write: (data, wopts) => ctx.store.write(project, data, Object.assign({}, wopts, {
          writer: by, idem: ctx.idemKey
        }))
      }, (data) => applyPlan(data, plan));
      attempts = res.attempts;
      merged = res.merged;
    } catch (e) {
      ctx.error('迁移写入失败：' + ((e && e.message) || e)
        + '\n  盘上数据**未改动**；迁移前的备份已导出（绝对路径）：' + backup.file
        + '\n  要看引擎判断的冲突对象：报错里已经指名（`node:<id>` / `items:<id>` / `item:<节点>#<条目>`）。');
    }

    const text = reportText(report, {
      dryRun: false, qaItems: qaItems, missing: backup.missing, backupBytes: backup.bytes
    });
    if (merged) {
      const note = '（写入期间检测到并发改动：已按**不相交**判定自动重放，双方改动都保留，attempts=' + attempts + '）';
      // ⚠️ `--json` 的 stdout **必须是一份**可解析 JSON（契约 §3 通用约定）⇒ 这条提示走 stderr，
      //    绝不往 stdout 前面插一行文本（插了就不是 JSON 了，机器消费者会当场崩）。
      if (ctx.args.json) process.stderr.write(note + '\n');
      else ctx.out(note);
    }
    /* 幂等键的"首次回显"补进变更日志那一条（`cli/core.js` 的 flushIdemRecord 用的是
     * `args._[0]` 推出的项目名 ⇒ 对本命令会找错项目；这里用**真实项目名**自己补一次）。
     * 没有键（`--idem` 未给）时什么都不做 —— 老路径行为不变。 */
    const idemText = ctx.args.json ? JSON.stringify(report) : text;
    if (ctx.idemKey) {
      try { ctx.store.recordChangeOut(project, ctx.idemKey, idemText); } catch (e) { /* 日志是旁路产物：失败不影响数据 */ }
    }
    emit(ctx, report, text);
  }
};

/** 统一回显：`--json` 给**一份**可解析 JSON（末尾不追加文本行），否则给多行文本（契约 §3 通用约定） */
function emit(ctx, report, text) {
  if (ctx.args.json) {
    ctx.outJson(report);
    ctx.setIdemResult(JSON.stringify(report));      // 幂等重放要复述**这一份 JSON**（不是 "[object Object]"）
    return;
  }
  ctx.out(text);
  ctx.setIdemResult(text);
}
