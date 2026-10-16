/* ============================================================
 * src/schema.js — 数据格式校验（UMD）
 * ------------------------------------------------------------
 * 校验 projects/<name>/<name>.json（`meta.formatVersion` = 2 或 3）：
 *   - 整体结构（meta/format/data）
 *   - 节点字段（id/topic/children/detail/images/links）
 *   - **条目层（v3）**：`items[]` 的形状、`items` ↔ `detail` 的派生一致性、`items` ⇄ `detailMode`/`qa[]` 互斥
 *   - id 规范（小写字母/数字/连字符，禁止空白与中文）
 *   - **条目 id 的全项目唯一性**（`supersededBy` / `links[].item` 只带条目 id ⇒ 不唯一则引用有歧义）
 *   - 图片必填字段（file/caption）
 *   - 跨项目链接悬挂检测（links 指向的 project+id 必须存在）
 *   - 关联笔记（data.assoc）：结构与成员悬挂检测
 * 供 CLI validate / 主进程保存闸门 / 测试三方共用。
 *
 * ⚠️ **条目层的判定表在 `docs/ITEM-MODEL.md` §2（三档封闭表）**，本文按它实现，别另立一套：
 *   有 `items`（含空数组） ⇒ items 是真源、`detail` 是**落盘派生缓存**（必须逐字节等于
 *                            `renderDetail(items)`）、不得有 `detailMode`、不得有 `qa[]`；
 *   无 items 且有 `detailMode:'rich'` ⇒ 富文本节点，**不得**出现 items；
 *   无 items 且无 detailMode ⇒ v2 节点，语义与 v2 完全一致。
 * 判红的**修法**也由契约指定：`detail` 不一致 ⇒ 跑 `render-detail`（唯一修法）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // `./relations.js` 注入**只为**条目级悬挂的判据（targetHasItem）—— 见下 §2。
    // ⚠️ 方向已核：`scripts/dep-direction-check.js` 的 LAYERS 里 `src` 是 rank 1、
    //    `schema.js` 与 `relations.js` **同层**（同 rank 互不判方向），且
    //    `src/relations.js` **零 require**（实测 Select-String 无任何 require/import 行）
    //    ⇒ 不可能造出同层环。实测门禁：131 条相对边全部朝下（或同层）、无环、无图外边 ✓
    //    （数字要与盘上事实一致：**补丁前 130 条 / 补丁后 131 条** —— 多出的那一条
    //      **就是本补丁引入的** `require('./relations.js')` 这条同层边）
    module.exports = factory(require('fs'), require('path'), require('./assoc.js'), require('./item-model.js'),
      require('./relations.js'));
  } else {
    // 浏览器不校验；assoc / itemModel / relations 都可能未加载，下方各有守卫
    // （没有 itemModel 时条目层只判形状，不判 `detail` 一致性 —— 那条判据要求"唯一的渲染实现"，
    //  不能在别处再写一份；没有 relations 时**跳过**条目级悬挂 —— 门禁在 CI 侧，那里一定有）
    root.MMSchema = factory(null, null, root.MMAssoc, root.MMItemModel, root.MMRelations);
  }
})(typeof self !== 'undefined' ? self : this, function (fs, path, assoc, itemModel, relations) {
  'use strict';

  const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

  /* ==========================================================================
   * 工作区文件夹绑定（R4）的**取值表**（唯一一处）
   * --------------------------------------------------------------------------
   * 为什么放在这里而不是 `src/doc-import.js`（那条绑定同步链路住的地方）：
   *   · 本文件是**数据契约的校验处** —— 取值表在这里，校验就在这里，两处不会漂；
   *   · `docs-registry-check.js` 的门禁刻意只认 `src/` 顶层的**文件**，新增一个模块要同批
   *     改 `docs/ARCHITECTURE.md`（那属于文档面）⇒ 把"字符串取值 + 校验"并进已有模块，
   *     "取值只有一处"与"文档面不变"两件事同时成立 ✓
   *   · 消费方（`src/doc-import.js` 的绑定同步链路、`cli/commands/project.js` 的 `bind-sync`）
   *     **必须 require 这里取**，不许各写一份字面量（第二份必然与校验漂移）。
   * ======================================================================== */
  /** 导入形态：`flat` = 目录里所有文件平铺在根下；`mirror` = 目录结构与文件夹同构（同 import-dir） */
  const BINDING_MODES = Object.freeze(['flat', 'mirror']);
  const BINDING_MODE_DEFAULT = 'flat';
  /** 删除策略：**只有这一档合法**（"不许删除"是工程铁律 ⇒ 自动化只能提议，不能自动删） */
  const BINDING_DELETIONS = 'propose-only';
  /** 事件防抖的上下界（毫秒）。下界：一次保存会触发好几个 fs 事件，太小等于没有防抖；
   *  上界：再大就"改了看不见"了。缺省 800ms（与 `main.js` 既有 300ms 的项目文件监听分开：
   *  那条是"盘上 JSON 变了 ⇒ 界面重读"，这条是"源文件夹变了 ⇒ 转成节点"。 */
  const BINDING_DEBOUNCE_DEFAULT = 800;
  const BINDING_DEBOUNCE_MIN = 50;
  const BINDING_DEBOUNCE_MAX = 60000;
  /** 绑定状态：缺省 = `watching`（守护中）；`paused` = 人按了暂停；`blocked` = 本轮被挡住
   *  （界面有未保存编辑 / 版本打架）—— **被挡住不是失败**，要如实说出来并等下一轮再试 */
  const BINDING_STATUSES = Object.freeze(['watching', 'paused', 'blocked']);
  const BINDING_STATUS_DEFAULT = 'watching';
  /** 默认忽略的目录/片段（与 `doc-import.js` 的 `SKIP_DIR_NAMES` 同一份口径的补充：
   *  那边已经一律跳过隐藏项（`.git` / `.review` / `.obsidian` 都以点开头）与
   *  `node_modules`；这里只是把"绑定默认忽略什么"写成**可读的契约**，默认值见 doc-import） */
  const BINDING_IGNORE_DEFAULT = Object.freeze(['node_modules', '.git', '.review']);

  /** 这个绑定现在**守护着**吗（缺省 status = watching ⇒ 守护）。
   *  为什么要有这个函数：`watching`/`paused`/`blocked` 三态的解释只允许一处 ——
   *  主进程的守护、命令的回显、测试都调它，免得"暂停了却还在同步"这种两处各判一次的分叉。 */
  function isBindingActive(b) {
    if (!b || typeof b !== 'object') return false;
    return (b.status === undefined || b.status === BINDING_STATUS_DEFAULT);
  }

  /**
   * 给老项目补上 `bindings` 键（**迁移**：只补空数组，一个字节的既有数据都不动）。
   *
   * 为什么需要：`bindings` 是可选键 ⇒ 老项目**不补也能读、能写、能过校验**（缺省 = 未绑定）。
   * 补它只为一件事：让"这个项目支持绑定"在数据里**看得见**（而不是"没这个键"与"有键但空"
   * 两种状态各判一次）。所以：
   *   · 只在**缺键**时补，缺值是坏数据（`bindings: null` / 字符串）⇒ 交给校验判红，这里不替它收拾；
   *   · `bindings` 已经是数组 ⇒ **原样返回**（`changed:false`，连对象都不重建）；
   *   · 纯函数：入参不被修改（返回的是新对象），调用方决定要不要写盘。
   * @param {object} data 项目数据（**只读**）
   * @returns {{data:object, changed:boolean, note:string}} 补过键的那份（或原样）
   */
  function migrateBindings(data) {
    const d = (data && typeof data === 'object') ? data : null;
    if (!d) return { data: data, changed: false, note: '不是对象，未改动' };
    if (Array.isArray(d.bindings)) return { data: d, changed: false, note: '已有 bindings 数组，未改动' };
    if (d.bindings !== undefined) {
      return { data: d, changed: false, note: 'bindings 不是数组（坏数据）—— 不替它收拾，交给 validate 判红' };
    }
    return {
      data: Object.assign({}, d, { bindings: [] }),
      changed: true,
      note: '缺 bindings 键 ⇒ 补空数组（**缺省 = 未绑定**，既有数据逐字节未动）'
    };
  }

  /* ==========================================================================
   * 树偏移的**取值表 + 形状校验**（唯一一处；`themeOffsets` 与 `nodeOffsets` 共用）
   * --------------------------------------------------------------------------
   * 为什么两个键只写一套：它们**形状与上下界完全相同**，差别只在**键域**（谁是偏移根）——
   *   · `meta.themeOffsets`：键 = **顶层主题 id**（root 的直接子节点）；
   *   · `meta.nodeOffsets` ：键 = **更深的节点 / 子树根 id**（契约见 docs/DATA-FORMAT.md §1）。
   * 两处各写一份形状校验 ⇒ 改上下界时必然只改到一处（本工程反复治过的"同一件事两处表达"）。
   * 键域那一半**不在 schema 判**：它要读整棵树才判得了，而契约把这件事交给渲染层的
   * **写回单源**（`renderer/app-view.js` 的 `collectOffsets()`：按遍历现树分桶），
   * 校验只管"这份对象**是不是一份合法偏移表**"。
   *
   * 语义（两个键一致）：界面把某个子树根拖到别处后的**相对偏移**（逻辑画布像素，相对该根的
   * 自动布局位置）；**缺省 = 全部按自动布局**（⇒ 它是可选键、`formatVersion` **不升**、
   * 老项目**零迁移** —— 见 `migrateNodeOffsets` 的说明：那不是默认路径要走的动作）。
   * 上下界（±`OFFSET_LIMIT`）不是随手写的：它是"明显异常数据"的护栏（自动布局量级是千像素级），
   * 防止坏数据把内容推到视口之外、用户再也找不回来。
   * ======================================================================== */
  /** 偏移键名（**唯一一处**：校验、迁移、单测都从这里取，别在别处抄字面量） */
  const OFFSET_KEYS = Object.freeze(['themeOffsets', 'nodeOffsets']);
  /** 偏移分量的绝对值上界（唯一一处；两个键共用） */
  const OFFSET_LIMIT = 20000;

  /**
   * 一张偏移表的形状校验（**一处实现，两个键各一行调用**）。
   * 报错文案带完整键路径（`meta.<键>.<id>.<分量>`）—— 判红的**修法**要能照着报文改。
   * @param {object} map 候选偏移表
   * @param {string} key 完整键路径（如 `meta.themeOffsets`）
   * @param {Function} err 收错函数
   */
  function validateOffsetMap(map, key, err) {
    const LIMIT = OFFSET_LIMIT;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) { err(key + ' 必须是对象'); return; }
    Object.keys(map).forEach((tid) => {
      if (!ID_RE.test(tid)) err(key + ' 含非法 id（小写字母/数字/连字符）: ' + tid);
      const p = map[tid];
      if (typeof p !== 'object' || p === null || Array.isArray(p)) { err(key + '.' + tid + ' 必须是 {x,y} 对象'); return; }
      ['x', 'y'].forEach((k) => {
        const v = p[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) err(key + '.' + tid + '.' + k + ' 必须是有限数字');
        else if (Math.abs(v) > LIMIT) err(key + '.' + tid + '.' + k + ' 超出允许范围（±' + LIMIT + '）: ' + v);
      });
    });
  }

  /**
   * 给项目补上 `meta.nodeOffsets` 键（**迁移**：只补空对象，一个字节的既有数据都不动）。
   *
   * ⚠️ **它不是默认路径要走的动作**（与 `migrateBindings` 同一个定位，但更强）：
   *   `meta.nodeOffsets` **缺省 = 未偏移** —— 老项目不补也能读、能写、能过校验，语义与从前
   *   **完全一致**（`renderer/app-core.js` 的 `serializeTree` 只在**非空**时写这个键 ⇒
   *   没拖过任何节点的项目保存后**逐字节不变**）。所以**界面与 CLI 的任何默认路径都不许调它**：
   *   调了就会在"用户什么都没做"的数据里凭空多出一个键（那正是不变式③要防的事）。
   *   它存在的唯一理由与 `migrateBindings` 相同 —— 让"这个项目带节点级偏移"在数据里**看得见**，
   *   由**显式**动作（将来某条工具/命令）决定要不要补。
   * 三条口径与 `migrateBindings` 逐条对齐：只补**缺键**、坏形状不替它收拾（交给校验判红）、纯函数。
   * @param {object} data 项目数据（**只读**）
   * @returns {{data:object, changed:boolean, note:string}} 补过键的那份（或原样）
   */
  function migrateNodeOffsets(data) {
    const d = (data && typeof data === 'object') ? data : null;
    if (!d) return { data: data, changed: false, note: '不是对象，未改动' };
    const meta = (d.meta && typeof d.meta === 'object' && !Array.isArray(d.meta)) ? d.meta : null;
    if (!meta) return { data: d, changed: false, note: '缺 meta（坏数据）—— 不替它收拾，交给 validate 判红' };
    if (meta.nodeOffsets !== undefined) {
      return { data: d, changed: false, note: '已有 nodeOffsets 键（形状对不对交给 validate）—— 未改动' };
    }
    return {
      data: Object.assign({}, d, { meta: Object.assign({}, meta, { nodeOffsets: {} }) }),
      changed: true,
      note: '缺 nodeOffsets 键 ⇒ 补空对象（**缺省 = 未偏移**，既有数据逐字节未动）'
    };
  }

  /** 条目级悬挂的**唯一判据**（契约 §12：与节点级同一处逻辑）。
   *  ⚠️ **绝不**在本文件再写一份"条目在不在"：第二处表达必然与 S6 那处漂移。 */
  const targetHasItemOf = (relations && typeof relations.targetHasItem === 'function')
    ? relations.targetHasItem : null;

  /** 条目 id 的唯一渲染/校验实现（契约 §5.1 明令：**不许复制**那几段逻辑，只能取用） */
  const renderDetailOf = (itemModel && typeof itemModel.renderDetail === 'function')
    ? itemModel.renderDetail : null;
  const validateItemsOf = (itemModel && typeof itemModel.validateItems === 'function')
    ? itemModel.validateItems : null;

  /**
   * 每次校验用**自己的**数组，最后随结果一起返回。
   *
   * 曾经用模块级共享 `errors` 数组（调用时 `errors.length = 0` 复用）——
   * 那会让**先前返回的结果对象被后续调用改写**：
   *   v1 = validateProject(好数据)   // {ok:true, errors:[]}
   *   validateProject(坏数据)         // 同一个数组被清空后重新填充
   *   v1.errors  =>  ['…']           // ok 仍为 true，却带着错误 → 自相矛盾
   * 任何"先收集多份结果、再统一报告"的调用方都会读到被污染的数组。
   * 现改为局部数组；`err` 的作用域随之收进 validateProject。
   * @param {object} data 待校验的项目数据（**即将落盘的那一份**）
   * @param {string} [projectsRoot] 给出则做悬挂检测（需跨项目读盘）
   * @param {string} [selfProject] 入参 data 对应的项目名。给了它，**同项目**的
   *   链接/关联成员就以 `data` 自身为准，而不是去读磁盘上的旧文件。
   *   不给的后果（实测）：写盘闸门永远慢一步 —— 删掉被关联引用的节点能写进去
   *   （闸门看磁盘，那时节点还在），此后该项目**所有**写命令都被这条悬挂成员挡住，
   *   直到 assoc-prune 才解开。跨项目成员只能读盘（磁盘是唯一真值），保持不变。
   */
  function validateProject(data, projectsRoot, selfProject, opts) {
    const errors = [];
    const err = (msg, nodeId) => {
      errors.push(nodeId ? '[' + nodeId + '] ' + msg : msg);
    };
    if (!data || typeof data !== 'object') { err('顶层必须是对象'); return { ok: false, errors }; }
    if (!data.meta || typeof data.meta !== 'object') err('缺少 meta');
    else {
      if (typeof data.meta.name !== 'string' || !data.meta.name.trim()) err('meta.name 必填');
      // 版本号：**2 与 3 都合法**（契约 §6/§9 第一条）。这是"迁移可回退"的硬前提 ——
      // 回退 = 恢复迁移前那份 `.aimap.json`（里面是 2）⇒ 恢复之后所有写命令必须照常可用。
      // 只写 3 或只写 2 都会让另一半数据变成"连读都读不了"，那是把回退路堵死。
      if (data.meta.formatVersion !== undefined
        && data.meta.formatVersion !== 2 && data.meta.formatVersion !== 3) {
        err('meta.formatVersion 必须是 2 或 3（收到 ' + JSON.stringify(data.meta.formatVersion)
          + '）—— 2 = v2 数据，3 = 已迁移条目层；两者都要接受，否则回退（恢复迁移前的备份）走不通');
      }
      // 主题布局（可选）：meta.layout = { left: [主题id], right: [主题id] }，决定顶层主题的左右分侧
      if (data.meta.layout !== undefined) {
        if (typeof data.meta.layout !== 'object' || Array.isArray(data.meta.layout)) err('meta.layout 必须是对象');
        else ['left', 'right'].forEach((side) => {
          const ids = data.meta.layout[side];
          if (ids !== undefined) {
            if (!Array.isArray(ids)) err('meta.layout.' + side + ' 必须是数组');
            else ids.forEach((id) => {
              if (typeof id !== 'string' || !ID_RE.test(id)) err('meta.layout.' + side + ' 含非法 id（小写字母/数字/连字符）: ' + id);
            });
          }
        });
      }
      // 树偏移（可选，2026-10-08 新增）：meta.themeOffsets = { "<顶层主题id>": { x, y } }
      // 语义与形状说明**只在取值表那一处**（本文件上方的 `validateOffsetMap`），这里不重复：
      // 拷贝一份说明就等于多一份会漂的事实。这一行只做"在就校验"。
      if (data.meta.themeOffsets !== undefined) {
        validateOffsetMap(data.meta.themeOffsets, 'meta.themeOffsets', err);
      }
      // 节点/子树偏移（可选，2026-10-14 新增，R2 期 1）：meta.nodeOffsets = { "<子树根id>": { x, y } }
      // 与 themeOffsets **同一套形状与上下界**（同一个校验实现），差别只在键域：
      // themeOffsets 记顶层主题、nodeOffsets 记更深的节点/子树根。
      // 缺省 = 未偏移 ⇒ 老项目零迁移、formatVersion 不升（见 `migrateNodeOffsets`）。
      if (data.meta.nodeOffsets !== undefined) {
        validateOffsetMap(data.meta.nodeOffsets, 'meta.nodeOffsets', err);
      }
    }
    /* ---- 工作区文件夹绑定（R4，2026-10-13；契约 docs/DATA-FORMAT.md §1.5）-------------------
     * 项目级可选字段（**不是**节点字段：它是"这个项目盯着哪个本机文件夹"的事实，与树无关）。
     * 三条口径写在这里，别在别处再判一遍：
     *   · **缺省 = 未绑定**（老项目没有这个键，语义与从前**完全一致**）⇒ 所以它不升 formatVersion；
     *   · 只校验**形状**，不校验目录在不在/读不读得了 —— 与 `localPath` 同一条理由：
     *     把存在性做成校验条件会让"换台机器打开就连 validate 都红"，那是把环境问题伪装成数据问题；
     *   · `deletions` **只能**是 `propose-only`：工程铁律是"不许删除"（删节点只在界面上由人做）
     *     ⇒ 这里把它固化成契约，任何"自动删"的取值都**判红**（判别力：改成 'auto' 必红）。
     *   · 扫描快照（mtime/大小/指纹）**不进这里**：它在旁路文件里（见 §1.5），
     *     否则守护进程每扫一次就把项目数据搅脏一次 ✗。 */
    if (data.bindings !== undefined) {
      if (!Array.isArray(data.bindings)) {
        err('bindings 必须是数组（工作区文件夹绑定；**缺省 = 未绑定**，见 docs/DATA-FORMAT.md §1.5）');
      } else {
        const seenBid = new Set();
        data.bindings.forEach((b, i) => {
          const at = 'bindings[' + i + ']';
          if (!b || typeof b !== 'object' || Array.isArray(b)) { err(at + ' 必须是对象'); return; }
          if (typeof b.id !== 'string' || !ID_RE.test(b.id)) {
            err(at + '.id 不合规范（小写字母/数字/连字符，如 wb-1）: ' + JSON.stringify(b.id));
          } else if (seenBid.has(b.id)) {
            err(at + '.id 重复: ' + b.id + '（绑定 id 在项目内必须唯一 —— 快照按它分文件）');
          } else seenBid.add(b.id);
          // 目录是本机绝对路径（与 localPath 同档：它是**明文例外**，见 §2.5 那条）
          if (typeof b.dir !== 'string' || !b.dir.trim()) err(at + '.dir 必须是非空字符串（本机目录绝对路径）');
          else if (/[\r\n]/.test(b.dir)) err(at + '.dir 不能含换行');
          else if (b.dir.length > 500) err(at + '.dir 过长（超过 500 字符）');
          if (typeof b.mode !== 'string' || BINDING_MODES.indexOf(b.mode) < 0) {
            err(at + '.mode 必须是 ' + BINDING_MODES.map((m) => JSON.stringify(m)).join(' 或 ')
              + '（收到 ' + JSON.stringify(b.mode) + '）：flat = 所有文件平铺在根下、mirror = 目录结构与文件夹同构');
          }
          ['include', 'ignore'].forEach((k) => {
            const v = b[k];
            if (v === undefined) return;
            if (!Array.isArray(v)) { err(at + '.' + k + ' 必须是字符串数组'); return; }
            v.forEach((p, j) => {
              if (typeof p !== 'string' || !p.trim()) err(at + '.' + k + '[' + j + '] 必须是非空字符串');
            });
          });
          // 删除策略：**只有一档合法取值**（"不许删除"是工程铁律 ⇒ 只能提议，不能自动删）
          if (b.deletions !== 'propose-only') {
            err(at + '.deletions 只能是 "propose-only"（删除/改名**只产出待确认提议、绝不自动删** —— '
              + '收到 ' + JSON.stringify(b.deletions) + '；自动化只负责"加"和"改"）');
          }
          if (b.debounceMs !== undefined) {
            if (typeof b.debounceMs !== 'number' || !Number.isFinite(b.debounceMs)
              || b.debounceMs < BINDING_DEBOUNCE_MIN || b.debounceMs > BINDING_DEBOUNCE_MAX) {
              err(at + '.debounceMs 必须是 ' + BINDING_DEBOUNCE_MIN + '–' + BINDING_DEBOUNCE_MAX
                + ' 之间的数字（毫秒）：太小会让一次保存触发多次同步，太大就"改了看不见"');
            }
          }
          if (b.lastSyncAt !== undefined && typeof b.lastSyncAt !== 'string') err(at + '.lastSyncAt 必须是字符串（ISO 时间）');
          if (b.status !== undefined && BINDING_STATUSES.indexOf(b.status) < 0) {
            err(at + '.status 必须是 ' + BINDING_STATUSES.map((s) => JSON.stringify(s)).join(' / ')
              + '（缺省 = ' + BINDING_STATUS_DEFAULT + '；' + JSON.stringify('blocked')
              + ' 时 note 要写清"被什么挡住了"）: ' + JSON.stringify(b.status));
          }
          if (b.note !== undefined && typeof b.note !== 'string') err(at + '.note 必须是字符串');
        });
      }
    }
    if (data.format !== 'node_tree') err('format 必须为 "node_tree"');
    if (!data.data) err('缺少 data（根节点）');
    else {
      // 先迭代检测环：递归 validateNode 遇环会栈溢出，必须先拦截
      const seen = new Set();
      const stack = [data.data];
      let cyclic = false;
      while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        if (seen.has(n)) { err('树存在环（节点被重复访问）', n.id); cyclic = true; break; }
        seen.add(n);
        (n.children || []).forEach((c) => stack.push(c));
      }
      if (!cyclic) {
        // 形状校验（逐节点字段）与「重复 id / 环」分开：
        // 后者必须是**整棵树的一次遍历**。原先把它写在 validateNode 里，
        // 而 validateNode 对每个子节点递归 + 又对本子树做一次迭代扫描 →
        // 同一处重复 id 按祖先层数被**重复报多次**（3 层嵌套报 3 次，实测）。
        validateNode(data.data, err);
        checkIdsAndCycles(data.data, err);
        // 条目 id 的**全项目唯一性**（契约 §5.1）。放在这里与 checkIdsAndCycles 并列：
        // 两者都是"必须看整棵树"的判据，节点形状校验管不了它们。
        checkItemIds(data.data, err);
      }
    }

    // 关联笔记的结构校验（不需要读盘）。
    // 浏览器侧可能没加载 assoc.js（渲染层不校验），故加守卫而不是直接调用。
    if (assoc && assoc.validateAll) {
      const assocCheck = assoc.validateAll(data.assoc);
      if (!assocCheck.ok) assocCheck.errors.forEach((e) => err(e));
    }

    // 悬挂检测（需跨项目文件系统）：链接目标 + 关联成员，同一处逻辑
    if (projectsRoot && fs && path) {
      // 同项目成员的节点集合（惰性构建：绝大多数项目没有悬挂问题，不必先遍历）
      let selfIds = null;
      /** 某项目的 JSON 里是否存在该节点；不可读时返回异常标记（调用方报"无法读取"） */
      const nodeExists = (proj, nodeId) => {
        // 同项目：以入参 `data` 为准 —— 那才是即将写下去的真值。
        // 读盘会把"我刚删掉的那个节点"算成还在（磁盘尚未覆盖），闸门因此漏判。
        if (selfProject && proj === selfProject) {
          if (selfIds === null) {
            selfIds = new Set();
            flatten(data && data.data).forEach((n) => { if (n && n.id !== undefined) selfIds.add(n.id); });
          }
          return selfIds.has(nodeId) ? 'yes' : 'no';
        }
        const p = path.join(projectsRoot, proj, proj + '.json');
        if (!fs.existsSync(p)) return 'no-project';
        try {
          const pd = JSON.parse(fs.readFileSync(p, 'utf8'));
          const found = (function findNode(r) {
            if (!r) return false;
            if (r.id === nodeId) return true;
            return (r.children || []).some(findNode);
          })(pd.data);
          return found ? 'yes' : 'no';
        } catch (e) {
          return 'unreadable:' + (e.message || e);
        }
      };

      /**
       * 把上面那份"在不在"的判断**再走一遍、但把节点对象带出来**（条目级悬挂需要 `node.items`）。
       * 为什么必须与 `nodeExists` **共用同一段解析**（而不是再读一次盘）：
       *   · 同项目**必须走待写数据 `data`**（理由见上：读盘会把刚删掉的节点算成还在）；
       *   · 跨项目的读盘只发生一次（这里返回对象；`nodeExists` 那边照旧只问在不在）。
       * 返回值：`{ok:true, node}` | `{ok:false, reason:'no-project'|'no'|'unreadable', detail?}`。
       * ⚠️ 节点不存在 / 项目读不出来 ⇒ 返回 `{ok:false}` 而**不在这里报错** ——
       *   那一档上面（节点级）已经报过，重复报会把同一处坏数据报两遍，读者以为有两处坏。
       */
      const targetNodeOf = (proj, nodeId) => {
        if (selfProject && proj === selfProject) {
          let hit = null;
          (function findNode(n) {
            if (!n || hit) return;
            if (n.id === nodeId) { hit = n; return; }
            (n.children || []).forEach(findNode);
          })(data && data.data);
          return hit ? { ok: true, node: hit } : { ok: false, reason: 'no' };
        }
        const p = path.join(projectsRoot, proj, proj + '.json');
        if (!fs.existsSync(p)) return { ok: false, reason: 'no-project' };
        try {
          const pd = JSON.parse(fs.readFileSync(p, 'utf8'));
          let hit = null;
          (function findNode(n) {
            if (!n || hit) return;
            if (n.id === nodeId) { hit = n; return; }
            (n.children || []).forEach(findNode);
          })(pd.data);
          return hit ? { ok: true, node: hit } : { ok: false, reason: 'no' };
        } catch (e) {
          return { ok: false, reason: 'unreadable', detail: (e.message || e) };
        }
      };

      /**
       * 条目级悬挂：**同一处判据**（`relations.targetHasItem`）+ **分开的报文**。
       * 为什么与"节点不存在"分开报：**修法不同** ——
       *   节点不存在 ⇒ 这条边该剪（目标整个没了）；
       *   节点还在、条目已删 ⇒ **这条边**该剪，但内容可能该恢复（或换个条目指向）。
       * 报同一种会把修法指错；而"节点还在、条目不在"恰恰是最容易被当成"节点级没问题"漏过去的一档。
       */
      const itemDangling = (l, at) => {
        if (!targetHasItemOf) return;                       // 浏览器侧未注入 ⇒ 跳过（门禁在 CI 侧）
        if (!l || !l.item) return;                          // 节点级引用：上面那一档已经判过
        const t = targetNodeOf(l.project, l.id);
        if (!t.ok) return;                                  // 节点/项目那一档上面已报，不重复报
        const chk = targetHasItemOf(t.node, l.item);
        if (chk.ok) return;
        err('悬挂链接: ' + l.project + '/' + l.id + '#' + l.item + ' 不存在'
          + '（**节点还在、条目已被删**）—— 修法：`links-prune <项目>` 剪掉这条边；'
          + '若只是条目被误删，先 `item-add` / `item-move` 把它恢复或改指向'
          + (chk.ids.length ? '（该节点现有条目：' + chk.ids.join(', ') + '）' : '（该节点现在没有条目层）'),
        at);
      };

      /** `anchorState` 的唯一实现来自 `src/relations.js`（浏览器侧未注入 ⇒ 这一档跳过，门禁在 CI 侧） */
      const anchorStateOf = (relations && typeof relations.anchorState === 'function')
        ? relations.anchorState : null;

      /**
       * 标签索引（`tag` 锚点用）：`project|tag` 的集合成员查询 —— **强判据**（不是文本匹配）。
       * 范围口径（本工程**显式定死**，免得"标签是全局还是项目内"长期悬着）：
       *   · 锚点**没写** `project` ⇒ 在**当前项目**里判；
       *   · 锚点**写了** `project`  ⇒ 在那个项目里判；
       *   · 项目读不出来 ⇒ 返回 `null`（"采不到真值"）⇒ 判成 `unreadable`，**不当作失效**。
       */
      const tagIndex = (() => {
        const cache = {};
        function tagsIn(proj) {
          if (cache[proj] !== undefined) return cache[proj];
          const set = new Set();
          if (selfProject && proj === selfProject) {
            flatten(data && data.data).forEach((n) => ((n && n.tags) || []).forEach((t) => set.add(String(t))));
            cache[proj] = set;
            return set;
          }
          const p = path.join(projectsRoot, proj, proj + '.json');
          try {
            if (!fs.existsSync(p)) { cache[proj] = null; return null; }
            const pd = JSON.parse(fs.readFileSync(p, 'utf8'));
            (function w(n) { if (!n) return; ((n.tags) || []).forEach((t) => set.add(String(t))); (n.children || []).forEach(w); })(pd.data);
            cache[proj] = set;
            return set;
          } catch (e) { cache[proj] = null; return null; }
        }
        return {
          hasTag(tag, proj) {
            const s = tagsIn(proj);
            if (s === null) return null;                    // 读不出来 ⇒ 不猜
            return s.has(String(tag));
          }
        };
      })();

      flatten(data.data).forEach((n) => {
        (n.links || []).forEach((l, i) => {
          if (!l || typeof l !== 'object') { err('links[' + i + '] 不是对象', n.id); return; }
          if (!l.project || !l.id) { err('links[' + i + '] 缺少 project/id', n.id); return; }
          const r = nodeExists(l.project, l.id);
          if (r === 'no-project') err('悬挂链接: 项目不存在 ' + l.project, n.id);
          else if (r === 'no') err('悬挂链接: ' + l.project + '/' + l.id + ' 不存在', n.id);
          else if (r !== 'yes') err('悬挂链接: 无法读取 ' + l.project + '（' + r.slice(11) + '）', n.id);
          itemDangling(l, n.id);          // ← 加这一行（条目级：节点在、条目不在）
        });
      });

      // 关联成员悬挂：成员指向的节点若已不存在，该关联就是坏的。
      // 与悬挂链接同样按项目名读盘（不是 meta.name）——成员里的 project 就是项目目录名。
      (Array.isArray(data.assoc) ? data.assoc : []).forEach((a, ai) => {
        if (!a || !Array.isArray(a.members)) return;
        a.members.forEach((m, mi) => {
          if (!m || typeof m !== 'object' || !m.project || !m.id) return;  // 结构问题已由 validateAll 报过
          const r = nodeExists(m.project, m.id);
          const at = 'assoc[' + ai + '].members[' + mi + ']';
          if (r === 'no-project') err('悬挂关联成员: 项目不存在 ' + m.project, at);
          else if (r === 'no') err('悬挂关联成员: ' + m.project + '/' + m.id + ' 不存在', at);
          else if (r !== 'yes') err('悬挂关联成员: 无法读取 ' + m.project + '（' + r.slice(11) + '）', at);
          itemDangling(m, at);            // ← 加这一行（assoc 成员的条目级同款）
        });
        /* ---- 笔记锚点（R7）：`assoc.anchors[]` 的失效检测 ----------------------------
         * 判据**只有一处实现**：`relations.anchorState`（内部先调 `refState`，只补 no-tag / bad-anchor）。
         * 这里只负责"把判据接进闸门 + 点名 + 给修法"，不自己 walk 树、不自己判文本。
         * ⚠️ **锚点不在 `allRefs` 里**（锚点不是边，见 `docs/DATA-FORMAT.md` §2.6）⇒ 它**不参与**
         *   图距离（`src/item-index.js`）与关系栏（`src/related-model.js`），那两处**不改代码**。
         * ⚠️⚠️ **默认档不判锚点**（`opts.checkAnchors === true` 才判）—— 这一条**是实测逼出来的**：
         *   `validate` 同时是**写盘闸门**（每次写之前跑一遍）⇒ 若 `bad-anchor`/`no-tag` 默认算错，
         *   则"改写正文里那句话"或"去掉一个标签"这两件**正常事**会把整个项目变成**只读**
         *   （实测：`edit r7p n-root --detail …` 直接 `error: 校验失败: … 失效锚点（bad-anchor）`）。
         *   而这两档本来就是**弱判据**（会随时间自然失效），修它要改的是**笔记**而不是正文。
         *   ⇒ 口径：**默认 `validate` 不做锚点判定**（默认档逐字节不变）；`validate --anchors`
         *     显式**判红**（点名 + 给修法）；`assoc-prune [--dry-run]` **总是报告**（只报不剪）；
         *     界面侧失效锚点画成坏引用态（`.is-dangling` + `title`）。**三段都不静默** ✓ */
        if (!anchorStateOf || !selfProject) return;
        if (!(opts && opts.checkAnchors === true)) return;
        const ans = Array.isArray(a.anchors) ? a.anchors : [];
        ans.forEach((an, ni) => {
          if (!an || typeof an !== 'object') return;                       // 结构问题已由 validateAll 报过
          const at = 'assoc[' + ai + '].anchors[' + ni + ']';
          const where = an.project || selfProject;
          let root = null;
          if (where === selfProject) root = data.data;
          else {
            const p = path.join(projectsRoot, where, where + '.json');
            try { root = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).data : null; }
            catch (e) { root = null; }
          }
          const st = anchorStateOf(an, { root: root, project: where }, tagIndex);
          if (st.state === 'ok') return;
          /* 三档分开报（**修法不同**，报同一种会把路指错）：读不出来 ⇒ 先修项目；
           * 标签没了 ⇒ 加回标签或删锚点；正文改了 ⇒ 改锚点文本。 */
          err('失效锚点（' + st.state + '）: ' + (st.label || '(无点名)') + ' —— ' + st.hint
            + '（锚点不是边：它只决定"从哪儿点得进来"，不参与关系栏与图距离）', at);
        });
      });
    }
    return { ok: errors.length === 0, errors };
  }

  /** 形状校验：只校验节点**自身字段**并递归子节点；不做 id 去重/环检测（见 checkIdsAndCycles） */
  function validateNode(node, err) {
    if (!node || typeof node !== 'object') { err('节点必须是对象'); return; }
    if (typeof node.id !== 'string' || !node.id) err('缺少 id');
    else if (!ID_RE.test(node.id)) err('id 不合规范（小写字母/数字/连字符，如 my-node）: ' + node.id);
    if (typeof node.topic !== 'string' || !node.topic.trim()) err('缺少 topic（节点标题）', node.id);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) err('children 必须是数组', node.id);
      else node.children.forEach((c) => validateNode(c, err));
    }
    if (node.detail !== undefined && typeof node.detail !== 'string') err('detail 必须是字符串', node.id);
    // ---- 条目层（v3，`docs/ITEM-MODEL.md` §1/§2）---------------------------------------------
    // 三档封闭判定表（契约 §2），**判红必须给修法**（契约 §9 的 G2 ④）：
    //   ① 有 items（**含空数组**）⇒ items 是真源：detail 必须逐字节 == renderDetail(items)，
    //      且不得有 detailMode、不得有 qa[]（两处表达必漂移）；
    //   ② 无 items 且有 detailMode:'rich' ⇒ 富文本节点，不得出现 items（③ 那一档由本段的下方守卫覆盖）；
    //   ③ 无 items 且无 detailMode ⇒ v2 节点，语义与 v2 完全一致（本段一个字都不改它）。
    // ⚠️ "缺 detail" 与 "空串" **等价**（契约 §2）—— 否则"把条目删空"的节点过不了闸门。
    const itemized = Array.isArray(node.items);
    if (node.items !== undefined) {
      if (!itemized) err('items 必须是数组（有它即"条目化"，**含空数组**；契约 §2）', node.id);
      else {
        // 形状：逐节点自校验（唯一性**只管节点内**；全项目唯一由 checkItemIds 判，见契约 §5.1 的分工）
        if (validateItemsOf) {
          const ie = validateItemsOf(node.items) || [];
          ie.forEach((m) => err('items 不合法：' + m, node.id));
        }
        if (node.detailMode !== undefined) {
          err('条目化节点不得有 detailMode（`items` 与 `detailMode` **互斥**：契约 §2）'
            + '—— 它是显式声明"整节点是富文本、没有条目"的标记；要条目化就先 `edit <项目> ' + node.id
            + ' --clear-detail-mode`', node.id);
        }
        if (node.qa !== undefined) {
          err('条目化节点不得有 qa[]（问答必须收敛成 `type:\'qa\'` 条目 —— 两处表达必漂移：契约 §6/§7）'
            + '；跑 `migrate items <项目>` 收敛它', node.id);
        }
        // detail：**派生缓存**，必须逐字节等于 renderDetail(items)
        if (renderDetailOf) {
          const expect = renderDetailOf(node.items);
          const actual = (typeof node.detail === 'string') ? node.detail : '';
          if (actual !== String(expect)) {
            err('detail 与 items 不一致：条目化节点的 detail 是**派生缓存**，必须逐字节等于 renderDetail(items)'
              + '（修法：`node cli/mm-cli.js render-detail <项目> ' + node.id
              + '`；契约 §2/§9 —— 这是 G2 判红时**唯一**的修法）', node.id);
          }
        }
      }
    }
    if (node.detailMode !== undefined && node.detailMode !== 'rich') {
      err('detailMode 的唯一合法取值是 \'rich\'（收到 ' + JSON.stringify(node.detailMode) + '）', node.id);
    }
    if (node.tags !== undefined) {
      if (!Array.isArray(node.tags)) err('tags 必须是数组', node.id);
      else node.tags.forEach((t, i) => {
        if (typeof t !== 'string' || !t.trim()) err('tags[' + i + '] 必须是非空字符串', node.id);
      });
    }
    // 本机文件夹路径（可选）：节点对应的目录在**本机**的绝对路径，界面点击后用系统文件管理器打开。
    // 它是 `docs/DATA-FORMAT.md`「禁止绝对路径」的**明文例外**（见该文 §2.5）：
    // 目录快捷方式天然是机器本地的（不像 assets/ 的相对引用要保证可移植）。
    // ⚠️ **只校验形状，不校验存在性** —— 存在性依赖运行环境（盘可能没挂、目录可能还没建），
    // 把它做成校验条件会让"换台机器打开就连 validate 都红"，那是把环境问题伪装成数据问题。
    if (node.localPath !== undefined) {
      if (typeof node.localPath !== 'string' || !node.localPath.trim()) err('localPath 必须是非空字符串', node.id);
      else if (/[\r\n]/.test(node.localPath)) err('localPath 不能含换行', node.id);
      else if (node.localPath.length > 500) err('localPath 过长（超过 500 字符）', node.id);
    }
    if (node.images !== undefined) {
      if (!Array.isArray(node.images)) err('images 必须是数组', node.id);
      else node.images.forEach((img, i) => {
        if (!img || typeof img !== 'object') { err('images[' + i + '] 不是对象', node.id); return; }
        if (typeof img.file !== 'string' || !img.file) err('images[' + i + '] 缺少 file', node.id);
        if (typeof img.caption !== 'string' || !img.caption.trim()) err('images[' + i + '] 缺少 caption（AI 理解图片的备注）', node.id);
      });
    }
    if (node.files !== undefined) {
      if (!Array.isArray(node.files)) err('files 必须是数组', node.id);
      else node.files.forEach((f, i) => {
        if (!f || typeof f !== 'object') { err('files[' + i + '] 不是对象', node.id); return; }
        if (typeof f.file !== 'string' || !f.file) err('files[' + i + '] 缺少 file', node.id);
        if (typeof f.caption !== 'string' || !f.caption.trim()) err('files[' + i + '] 缺少 caption（AI 理解附件的备注）', node.id);
      });
    }
    if (node.links !== undefined && !Array.isArray(node.links)) err('links 必须是数组', node.id);
    // AI 问答记录（**可选字段**，不升 formatVersion；无则兼容 —— 见 docs/DATA-FORMAT.md §2.7）。
    // 它回答的是"这个节点的这一段结论是哪一次 AI 交流得来的"，卖点 5 点名要它。
    // 校验只判**形状**：`a` 必为非空字符串（一条没有回答的记录毫无意义，而且它会让
    // "AI 产出是不是落进去了"这个判定永远为真 —— 本工程最忌的那种假绿）；
    // `q` 允许空串（"解释这个节点"本来就没有提问文本）⇒ 用 `!== undefined` 而不是真值判定。
    if (node.qa !== undefined) {
      if (!Array.isArray(node.qa)) err('qa 必须是数组', node.id);
      else node.qa.forEach((e, i) => {
        if (!e || typeof e !== 'object' || Array.isArray(e)) { err('qa[' + i + '] 必须是对象', node.id); return; }
        if (typeof e.a !== 'string' || !e.a.trim()) err('qa[' + i + '].a 必须是非空字符串', node.id);
        if (e.q !== undefined && typeof e.q !== 'string') err('qa[' + i + '].q 必须是字符串', node.id);
        if (typeof e.at !== 'string' || !e.at.trim()) err('qa[' + i + '].at 必须是非空字符串（ISO 时间）', node.id);
        if (e.model !== undefined && typeof e.model !== 'string') err('qa[' + i + '].model 必须是字符串', node.id);
      });
    }
    // 来源指纹（**可选字段**，不升 formatVersion；无则兼容 —— 见 docs/DATA-FORMAT.md §2.8）。
    // 它回答"这棵树/这棵子树是从哪一份文档、哪一次导入来的"，是**批量导入幂等**的前提：
    // 节点 id 由 `Date.now()+随机` 生成 ⇒ 同一份文档导入两次会得到两棵不相交的树，
    // 光看内容判不出"这份已经导过了"；`origin.src + origin.sha256` 才是那个判据。
    // ⚠️ 只校验**形状**，不重算哈希：重算要把整份源文档读回来，而它可能早已不在本机/已被改过
    //    —— 那样"校验"就变成了环境检查（同 localPath 不校验存在性的理由）。
    if (node.origin !== undefined) {
      const o = node.origin;
      if (!o || typeof o !== 'object' || Array.isArray(o)) err('origin 必须是对象', node.id);
      else {
        if (o.kind !== 'import') err('origin.kind 必须是 "import"（当前只有这一种来源）', node.id);
        if (typeof o.src !== 'string' || !o.src.trim()) err('origin.src 必须是非空字符串（来源文件/URL）', node.id);
        // 64 位小写十六进制 = `crypto.createHash('sha256').digest('hex')` 的形状。
        // 写死长度是**故意的**：截断的/别家算法的指纹都能通过"非空字符串"，却会让幂等判定永远不命中。
        if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) {
          err('origin.sha256 必须是 64 位小写十六进制（内容指纹）', node.id);
        }
        if (typeof o.at !== 'string' || !o.at.trim()) err('origin.at 必须是非空字符串（ISO 时间）', node.id);
        if (o.tool !== undefined && typeof o.tool !== 'string') err('origin.tool 必须是字符串', node.id);
      }
    }
  }

  /** 重复 id 与环检测：对整棵树做**一次**迭代遍历（不递归，避免环导致栈溢出） */
  function checkIdsAndCycles(root, err) {
    const seenNodes = new Set();
    const seenIds = new Set();
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if (seenNodes.has(n)) { err('树存在环（节点被重复访问）', n.id); continue; }
      seenNodes.add(n);
      if (seenIds.has(n.id)) err('重复 id: ' + n.id, n.id);
      seenIds.add(n.id);
      (n.children || []).forEach((c) => stack.push(c));
    }
  }

  /**
   * **条目 id 的全项目唯一性**（契约 §5.1 的"分工"那一节）。
   *
   * 为什么必须在这里判：`validateItems(items)` 只看得到一个节点的数组 ⇒ 它只能判"节点内唯一"；
   * 而 `supersededBy` / `links[].item` / `assoc.members[].item` **只带条目 id、不带节点 id** ——
   * 只有全项目唯一，引用才无歧义。撞了号时，`item-remove --clean-links` 之类的清理动作会
   * 清错边（清掉"另一条同名条目"的引用），这是**静默**的（两边都不报错）。
   *
   * 与 `checkIdsAndCycles` 同款：对整棵树做**一次**迭代遍历（不递归 ⇒ 环不会栈溢出）。
   * 形状问题（缺 id / 非法字符）不在这里报 —— 那是 `validateItems` 的职责，避免同一处报两遍。
   */
  function checkItemIds(root, err) {
    const owner = new Map();                    // 条目 id → 首次出现它的节点 id
    const seenNodes = new Set();
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n || seenNodes.has(n)) continue;
      seenNodes.add(n);
      if (Array.isArray(n.items)) {
        n.items.forEach((it) => {
          const id = it && it.id;
          if (typeof id !== 'string' || !id) return;          // 形状问题：validateItems 已逐条报过
          if (owner.has(id)) {
            err('重复条目 id: ' + id + '（节点 ' + owner.get(id) + ' 上已有一条同名条目）—— '
              + '条目 id 必须**全项目唯一**（supersededBy / links[].item 只带条目 id，不唯一则引用有歧义）', n.id);
          } else owner.set(id, n.id);
        });
      }
      (n.children || []).forEach((c) => stack.push(c));
    }
  }

  function flatten(root) {
    const out = [];
    (function w(n) { if (!n) return; out.push(n); (n.children || []).forEach(w); })(root);
    return out;
  }

  /* ==========================================================================
   * 契约字段表（**「节点上有哪些字段」的唯一权威副本**）+ 节点复制写回的加注解析器
   * --------------------------------------------------------------------------
   * 为什么在这里：本工程**五次**栽在同一形态上 —— **手挑字段清单漏一个** ⇒ 那个字段被
   * **静默抹掉**（没有门禁会红、事后极难发现，且往往不可逆）：
   *   `qa` → `localPath` → `origin` → 界面的 `items`/`detailMode` → `clone` 的深拷贝
   *   （`cli/commands/edit.js` 的 `cloneNode`，漏 `items`/`detailMode`/`localPath`/`origin`）。
   * 一次教训可以只修缺陷；**五次是形态问题** ⇒ 要有一个"哪些字段存在"的**机器可读**副本，
   * 供两类写回代码（界面整树保存、节点复制）的静态判据共用。
   * 放在本文件（而不是另起一个 `src/node-fields.js` 之类的模块）有两个理由：
   *   ① 本模块就是**节点字段形状的唯一校验处**（下面 `validateNode` 逐字段判的正是这张表）；
   *   ② `src/` 的新增文件要同批登记进 `docs/ARCHITECTURE.md` §2（G8 的 module-cover），
   *      而 `docs/**` 由人维护 ⇒ 能并入已登记模块就不新增文件。
   * ⚠️ 连带（改本表时要知道）：`scripts/docs-registry-check.js` 的契约覆盖判定用
   *    `NODE_FIELD_NAMES` 区分"节点级 / 非节点级"，并只把 `node.<名>` 当作"schema 校验了它"
   *    —— 本表只是**数据**，不许被读成校验。
   * 人读的权威仍是 `docs/DATA-FORMAT.md` §2（节点字段全表）与 `docs/ITEM-MODEL.md` §1/§2。
   * 顺序按 DATA-FORMAT §2 的表序，追加字段接在尾部 ⇒ **改动看起来就是「加一行」**。
   * 容器字段（`meta` / `assoc`）不在这里：它们不是节点字段，节点级覆盖判据管不到它们。
   * 边界：本表只说"**哪些字段存在**"，不说形状（类型/必填/互斥）—— 那是上面 `validateNode` 的事；
   *   于是"字段在不在"（静默丢失）与"字段合不合法"（判红）是两条独立的判据。
   * ======================================================================== */

  /** 每行一项：status = `required`（每个节点都该有的那一档）/ `optional`（可以不出现在节点上）。
   *  ⚠️ `expanded` 的说明：省略等价于 `true`（合法），但复制时要写出来 —— status 只管"该不该在"，
   *     不管"缺了算不算合法"。 */
  const NODE_FIELDS = Object.freeze([
    { name: 'id', status: 'required', desc: '节点 id（数据格式第 2 节：全树唯一）' },
    { name: 'topic', status: 'required', desc: '节点标题（数据格式第 2 节）' },
    { name: 'expanded', status: 'required', desc: '展开状态（缺省 true；第 2 节）' },
    { name: 'children', status: 'required', desc: '子节点（递归同构；第 2 节）' },
    { name: 'detail', status: 'optional', desc: '正文 HTML（数据格式第 2 节）' },
    { name: 'tags', status: 'optional', desc: '标签数组（数据格式第 2 节）' },
    { name: 'images', status: 'optional', desc: '图片引用（数据格式第 2 节）' },
    { name: 'files', status: 'optional', desc: '附件引用（数据格式第 2 节）' },
    { name: 'links', status: 'optional', desc: '跨项目链接（数据格式第 2 节）' },
    { name: 'background', status: 'optional', desc: '节点底色（透传字段；数据格式第 2 节）' },
    { name: 'localPath', status: 'optional', desc: '本机文件夹绝对路径（数据格式第 2 节）' },
    { name: 'qa', status: 'optional', desc: 'AI 问答记录（v2 节点级；数据格式第 2 节）' },
    { name: 'origin', status: 'optional', desc: '来源指纹（数据格式第 2 节）' },
    { name: 'items', status: 'optional', desc: '条目层 v3 真源（条目模型第 1 节）' },
    { name: 'detailMode', status: 'optional', desc: '富文本节点标记（条目模型第 2 节）' }
  ]);

  /** 全字段名（按契约表序）—— 判据与测试从这里取，**不要手抄一份** */
  const NODE_FIELD_NAMES = Object.freeze(NODE_FIELDS.map((f) => f.name));

  /** 「每个节点都该有」的那一档 */
  const NODE_FIELDS_REQUIRED = Object.freeze(NODE_FIELDS.filter((f) => f.status === 'required').map((f) => f.name));

  /** 「可以不出现在节点上」的那一档。
   *  为什么两条判据取不同档（都在本表里取，**没有第二份清单**）：
   *    · 节点复制（`cloneNode`）显式写全部四档必写字段 ⇒ 判据核**全表**；
   *    · 界面整树写回（`renderer/app-core.js` 的 `walk()`）把 `id/topic/expanded/children`
   *      写在对象字面量里、只有可选字段才逐条赋值 ⇒ 它**可核对的那一档**就是本数组。
   *  换言之：档位由本表定，判据按现场取对应档 —— 而不是各自维护一份字段名。 */
  const NODE_FIELDS_OPTIONAL = Object.freeze(NODE_FIELDS.filter((f) => f.status === 'optional').map((f) => f.name));

  /** 字段名 → 一句人话（判据报文用它点名"缺了什么"，免得读者去翻契约） */
  const NODE_FIELD_DESC = Object.freeze((() => {
    const o = {};
    NODE_FIELDS.forEach((f) => { o[f.name] = f.desc; });
    return o;
  })());

  /* ---------------------------------------------------------------
   * 加注解析器（两种写回现场、一个解析器）
   *   · 界面（`renderer/app-core.js` 的 `walk()`）：显式设值 —— 一行 `out.<名> = …` 一个字段。
   *   · 节点复制（`cli/commands/edit.js` 的 `cloneNode`）：一张**字段表**驱动，
   *     一行一项，格式 `序号 / [必] [选] 档位 / 字段名 / 写法 / 说明`。
   * 两处都用同一套加注语法（`[必] 名` / `[选] 名`）声明"这一行管的是哪个字段"，
   * 于是解析只有一份实现，"覆盖了契约吗"的判定也只有一份（见 `analyzeCloneFieldCopy`）。
   * ⚠️ 不匹配的行**不算错**（散文、标题、说明行都在这里通过）；"一条加注都没有"由
   *    `analyzeCloneFieldCopy` 的锚点/计数态判红，绝不静默放过。
   * @param {string} text 字段表正文（或含 `[必]/[选]` 加注的源码片段）
   * @returns {Array<{name:string, status:string, line:number}>}
   * --------------------------------------------------------------- */
  const FIELD_LINE_RE = /\[(必|选)\]\s*([A-Za-z_$][\w$]*)/g;

  function parseFieldLines(text) {
    const out = [];
    const lines = String(text === undefined || text === null ? '' : text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      FIELD_LINE_RE.lastIndex = 0;                  // 正则带 g ⇒ 每次扫描前复位（否则匹配位置在调用间残留）
      for (const m of lines[i].matchAll(FIELD_LINE_RE)) {
        out.push({ name: m[2], status: m[1] === '必' ? 'required' : 'optional', line: i + 1 });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------
   * 判据：节点复制（`cloneNode`）写回的字段必须覆盖契约
   *   `missing` = 契约里有、这份写回**不写** ⇒ 复制时**静默抹掉**（主判据）。
   *     刻意按**代码那一份读数**算、而不是"表 ∪ 代码"：字段有没有被写进副本，只有代码说了算。
   *   `unknown` = 这份写回有、契约里没有 ⇒ 写回代码先漂了，或契约表漏登记。
   *   `drift`   =「加注表」与「真实赋值」逐项对不上（多一条少一条都算）⇒ 表在骗人（数据没丢）。
   *   自洽      = 表行数 == 赋值个数，且两个锚点各**恰好**出现一次（定位失败 ⇒ 缺 = 全表，不许当通过）。
   * 判别力：删掉任一字段的**赋值** ⇒ `missing` 点名它；只删表里那一行 ⇒ `drift` 点名它；
   *   写一个契约外字段 ⇒ `unknown` 点名它；函数改名 ⇒ 锚点态判红。（单测里四档注入都有。）
   * @param {string} src 整个文件的源码
   * @returns {{ok:boolean, missing:string[], unknown:string[], drift:string[], seen:string[],
   *            parsed:number, fields:number, anchors:{decl:number, ret:number}, label:string}}
   * --------------------------------------------------------------- */
  const CLONE_FN_DECL = 'function cloneNode(';
  /** 函数体收尾锚点：函数里最后一个 `return node;`（签名 + 它 = 恰好夹住整张字段表与赋值正文） */
  const CLONE_FN_END = 'return node;';

  function analyzeCloneFieldCopy(src) {
    const text = String(src === undefined || src === null ? '' : src);
    const decl = text.split(CLONE_FN_DECL).length - 1;
    const end = text.split(CLONE_FN_END).length - 1;
    const res = {
      ok: false, missing: [], unknown: [], drift: [], seen: [], parsed: 0, fields: 0,
      /* ⚠️ 这里的 `anchors` = **源码位置锚点**（`{decl, ret}`：函数声明与返回各自的命中次数），
       *   与 `assoc[].anchors[]`（**笔记锚点**，R7 新增的"从哪儿点得进来"）**同名不同物**。
       *   两者都叫 anchors 是既定口径（用户/设计稿全篇用它），靠**这行交叉注释**避免
       *   "同一件事两处表达"的病根；另一处交叉注释在 `docs/DATA-FORMAT.md` §2.6 的字段表处。 */
      anchors: { decl: decl, ret: end }, label: CLONE_FN_DECL
    };
    if (decl !== 1 || end !== 1) {
      res.missing = NODE_FIELD_NAMES.slice();       // 看不见 = 缺（不许把"定位失败"当成"覆盖齐全"）
      return res;
    }
    const body = text.slice(text.indexOf(CLONE_FN_DECL) + CLONE_FN_DECL.length, text.lastIndexOf(CLONE_FN_END));
    /* 函数体切成两个区，各取一份读数（两份必须逐项对上）：
     *   甲区 =「第一条 `node.<名> =` 之前」⇒ 加注表；乙区 = 从第一条赋值到最后 ⇒ 真实赋值。
     * 按"第一条赋值"切、而不是要求加注与赋值同行：字段表要能**竖着读**才好逐行核对。
     * ⚠️ 甲区（注释）里不要写出 `node.<名> =` 的样子，否则切点会落进注释里（判据自己的禁区）。 */
    const cut = body.search(/\bnode\.[A-Za-z_$][\w$]*\s*=/);
    const annotated = parseFieldLines(cut > 0 ? body.slice(0, cut) : '');
    const seen = Array.from(new Set(Array.from((cut > 0 ? body.slice(cut) : '')
      .matchAll(/\bnode\.([A-Za-z_$][\w$]*)\s*=/g)).map((m) => m[1])));
    res.seen = seen;
    res.parsed = annotated.length;
    res.fields = seen.length;
    if (!annotated.length || !seen.length) {        // 两条读数为零 = 判据在空转，判红
      res.missing = NODE_FIELD_NAMES.slice();
      return res;
    }
    const annotatedNames = new Set(annotated.map((a) => a.name));
    const written = new Set(seen);
    res.missing = NODE_FIELD_NAMES.filter((f) => !written.has(f));
    const known = new Set(NODE_FIELD_NAMES);
    res.unknown = seen.filter((f) => !known.has(f))
      .concat(Array.from(annotatedNames).filter((f) => !known.has(f)));
    res.drift = Array.from(new Set(annotated.map((a) => a.name).filter((f) => !written.has(f))
      .concat(seen.filter((f) => !annotatedNames.has(f)))));
    res.ok = res.missing.length === 0 && res.unknown.length === 0 && res.drift.length === 0
      && res.parsed === res.fields;
    return res;
  }

  return {
    validateProject, validateNode, checkIdsAndCycles, checkItemIds, flatten, ID_RE,
    NODE_FIELDS, NODE_FIELD_NAMES, NODE_FIELDS_REQUIRED, NODE_FIELDS_OPTIONAL, NODE_FIELD_DESC,
    parseFieldLines, analyzeCloneFieldCopy,
    // 工作区文件夹绑定（R4）的取值表 + 迁移（**唯一一处**；消费方从这里取，别抄字面量）
    BINDING_MODES, BINDING_MODE_DEFAULT, BINDING_DELETIONS,
    BINDING_DEBOUNCE_DEFAULT, BINDING_DEBOUNCE_MIN, BINDING_DEBOUNCE_MAX,
    BINDING_STATUSES, BINDING_STATUS_DEFAULT, BINDING_IGNORE_DEFAULT,
    isBindingActive, migrateBindings,
    // 树偏移（themeOffsets / nodeOffsets）的取值表 + 形状校验 + 迁移（**唯一一处**）
    OFFSET_KEYS, OFFSET_LIMIT, validateOffsetMap, migrateNodeOffsets
  };
});
