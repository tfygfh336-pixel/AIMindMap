/* ============================================================
 * AI MindMap — 思维导图渲染库适配层（mindmap-adapter.js）
 * ------------------------------------------------------------
 * 存在的唯一理由：把"渲染层对**渲染库公共 API** 的调用"全部收敛到本文件。
 * 将来换库（或升到不兼容的大版本）只需要改这里 —— 其余 renderer 模块一行都不用动。
 * 这是那次"要不要换掉 jsMind"评估留下的**逃生门**（结论：有条件地不换，见 CHANGELOG）。
 *
 * 调用形状（全工程唯一）：
 *     MM.adapter.getNode(jm, id)
 *   · `jm` **永远显式传第一个参数**，不从 state.jm 内部取 —— 因为 renderMind() 里
 *     `new jsMind(...)` / `jm.show(data)` 发生在 `state.jm = jm` **之前**（见 app-core.js），
 *     内部读全局态会在那个窗口里取到上一次的实例（静默错误）。
 *   · **纯转发**：不判空、不兜底、不吞异常、不 try/catch —— 与直接调库**逐字同义**。
 *     这一层一旦开始"顺手做点判断"，它就从逃生门变成了第二个实现（本工程明令禁止：
 *     同一逻辑两处表达）。判空与兜底留在调用点，保持调用点原有语义。
 *
 * 边界（什么**不**在这里）：
 *   · 只覆盖**可移植的公共 API**。我们对渲染库的另一大半依赖是**主动接管其内部**
 *     （`view.relayout` / `view.show_lines` / `layout._data.layout` / `view.e_panel` /
 *     `<jmnode>`/`<jmnodes>` / `jmexpander` / `_reset_node_custom_style` …）——
 *     那部分换库时**必然要重写**，放进适配层只会把"贵的那一半"伪装成可移植。
 *     清单、位置与用途见 `renderer/vendor/JSMIND-INTERNALS.md`（升级时要人工回归的表）。
 *   · 序列化**故意不在这里**：本工程不用 jsMind 的 `get_data()`（它会丢掉存在 `node.data`
 *     上的 detail/images/links 等自定义字段），而是手工平铺（见 app-core.js 的 serializeTree）。
 *     所以"序列化"的库接触面只有"取根节点"一处 ⇒ 由 getRoot 承担。
 *     哪天真改用 `get_data()`，入口加在这里，调用点照样不动。
 *
 * 加新函数的判据（别把这层做成万能转发）：
 *   同一个公共 API 在调用点出现 ≥2 次，**或**它的语义值得起个名字时才加。
 *   当前 12 个函数**全部有真实调用者**，没有"备用/将来可能用到"的函数 ——
 *   没有调用者的转发函数是**没有断言覆盖的路径**，加了只会漂移。
 *
 * API → 函数对照（左列是 jsMind 0.9.1 的**公开方法名**，方法名只允许出现在本文件里）：
 *   get_node            → getNode         get_selected_node → getSelected
 *   select_node         → selectNode      select_clear      → （未用：0 个调用者）
 *   add_node            → addNode         update_node       → updateNode
 *   remove_node         → removeNode      expand_node       → expandNode
 *   collapse_node       → collapseNode    expand_all        → expandAll
 *   get_root            → getRoot         show(mind)        → loadTree
 *   另：available —— 不是库 API，是"这个对象像不像一个可用的导图实例"的能力探针。
 *
 * ⚠️ 已知缺陷（**本次纯重构按原样保留**，没有顺手修）：
 *   jsMind 0.9.1 的公开 `add_node(parent, id, topic, data, direction)` **只有 5 个形参，
 *   没有 index**。历史调用点（app-actions.js 的 addSiblingNode）多传了第 6 个实参
 *   `sel.index + 1`（本意"插到所选节点之后"）—— 它一直被**静默丢弃**，新节点实际追加在
 *   父节点末尾。报文见 `.review/20261009-jsMind事件派发探针/`；修它是**行为变更**，
 *   不属于"纯重构"，故原样保留并在调用点留了醒目注释。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  /* ---------------- 读 ---------------- */

  /** 按 id 取节点；**传节点对象也接受**（库对两者都处理）。取不到返回 null。 */
  function getNode(jm, idOrNode) { return jm.get_node(idOrNode); }

  /** 根节点。**为什么不直接写 get_root()**：历史调用点原本是
   *  `jm.get_node('root') || jm.mind.root`（优先按 id 取，取不到才退回库的根）。
   *  源码取证：`get_root(){return this.mind.root}` ⇒ 用公开的 get_root() 表达后半段
   *  **完全等价**，同时把 `jm.mind` 这个内部符号从调用点拿掉。 */
  function getRoot(jm) { return jm.get_node('root') || jm.get_root(); }

  /** 当前**单选**游标对应的节点（没有则 null）。注意这与本工程的"多选/框选"是两回事。 */
  function getSelected(jm) { return jm.get_selected_node(); }

  /** 能力探针：这个对象像不像一个可用的导图实例。
   *  替换历史调用点里四处写的 `jm && jm.get_node`（那是**在调用点里点库的方法名**）。
   *  返回**布尔**；原写法返回的是方法本身，但只被当条件用 ⇒ 语义相同。 */
  function available(jm) { return !!(jm && typeof jm.get_node === 'function'); }

  /* ---------------- 写 ---------------- */

  /** 选中：把库自己的**单选游标**移过去（不影响本工程的多选模型）。
   *  ⚠️ 库会在节点**可见**时派发 select 事件（**异步**，`setTimeout(…,0)`），
   *  且**点空白不派发**；本工程不在库里监听，理由见 `app-detail-content.js` 顶部注释。 */
  function selectNode(jm, idOrNode) { return jm.select_node(idOrNode); }

  /** 新增子节点。**5 个参数就是库的全部**：parent / id / topic / data / direction。
   *  库**没有 index 参数** —— 传第 6 个会被静默丢弃（见文件头 ⚠️）。
   *  `direction` 传 undefined = 让库自己算（默认右侧，主题模式下自动分侧）。 */
  function addNode(jm, parent, id, topic, data, direction) {
    return jm.add_node(parent, id, topic, data, direction);
  }

  /** 改标题。空标题会被库拒绝（只 warn，不抛）—— 调用点自己先判。 */
  function updateNode(jm, id, topic) { return jm.update_node(id, topic); }

  /** 删节点（含整棵子树）。根节点删不掉（库返回 false）。 */
  function removeNode(jm, idOrNode) { return jm.remove_node(idOrNode); }

  function expandNode(jm, idOrNode) { return jm.expand_node(idOrNode); }
  function collapseNode(jm, idOrNode) { return jm.collapse_node(idOrNode); }
  function expandAll(jm) { return jm.expand_all(); }

  /** 载入一整棵树（库的 show）—— 重建导图的唯一入口，app-core.js 的 renderMind 用。 */
  function loadTree(jm, data) { return jm.show(data); }

  MM.adapter = {
    // 读
    getNode, getRoot, getSelected, available,
    // 写
    selectNode, addNode, updateNode, removeNode,
    expandNode, collapseNode, expandAll, loadTree
  };
})();
