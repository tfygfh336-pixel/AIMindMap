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
  function validateProject(data, projectsRoot, selfProject) {
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
      // 语义：界面把顶层主题拖到别处后的**相对偏移**（逻辑画布像素，相对该主题的自动布局位置）；
      // 缺省 = 全部按自动布局。只影响呈现，不改变树结构 —— 所以它是可选字段、formatVersion 不升。
      // 上下界（±20000）不是随手写的：它是"明显异常数据"的护栏（自动布局量级是千像素级），
      // 防止坏数据把内容推到视口之外、用户再也找不回来。
      if (data.meta.themeOffsets !== undefined) {
        const TO = data.meta.themeOffsets;
        const LIMIT = 20000;
        if (typeof TO !== 'object' || TO === null || Array.isArray(TO)) err('meta.themeOffsets 必须是对象');
        else Object.keys(TO).forEach((tid) => {
          if (!ID_RE.test(tid)) err('meta.themeOffsets 含非法 id（小写字母/数字/连字符）: ' + tid);
          const p = TO[tid];
          if (typeof p !== 'object' || p === null || Array.isArray(p)) { err('meta.themeOffsets.' + tid + ' 必须是 {x,y} 对象'); return; }
          ['x', 'y'].forEach((k) => {
            const v = p[k];
            if (typeof v !== 'number' || !Number.isFinite(v)) err('meta.themeOffsets.' + tid + '.' + k + ' 必须是有限数字');
            else if (Math.abs(v) > LIMIT) err('meta.themeOffsets.' + tid + '.' + k + ' 超出允许范围（±' + LIMIT + '）: ' + v);
          });
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

  return { validateProject, validateNode, checkIdsAndCycles, checkItemIds, flatten, ID_RE };
});
