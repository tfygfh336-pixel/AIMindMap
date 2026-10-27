/* ============================================================
 * tests/diagram-auto-fixture.js —— MS2 的**自动布局夹具**（不是被测对象，是基准）
 * ------------------------------------------------------------
 * 与 `diagram-fixture.js`（MS1 手写坐标）**分开**，理由：
 *   ① MS1 那份是"手写坐标"的基准，改它就是改 MS1 的逐字节基线；
 *   ② 本批要测的是"**没有坐标**时图能不能自己排"—— 所以这里的节点**一个 rect 都没有**
 *      （只有被 `graph.pinned` 钉住的那个例外，用来测"显式意图优先"）。
 *
 * 图形态（仍是任务书 §3 的 netfilter 骨架，扩到 9 个节点 / 12 条边）：
 *   · 一条**回边**（`e-back`：filter → PREROUTING），用来测去环与回边布线；
 *   · 两条边共用同一节点的同一侧（`n-hook` 的 e 侧），用来测"同侧多支线确定性展开"；
 *   · 一条跨多层的长边（`e-long`：NIC → 发包），用来测虚拟节点与通道 lane；
 *   · 四条带标签的边（标签必须不压线不压框）。
 *   **不带 `pinned`**：显式意图那一条单独一份 `pinnedDoc()` —— 混进基准图会让"自动布局的读数"
 *   与"显式意图的读数"互相污染（改一处判据就看不出是哪一条坏了）。
 * ============================================================ */

function clone(x) { return JSON.parse(JSON.stringify(x)); }

const DOC = {
  graph: {
    version: 1,
    profile: 'complex',
    direction: 'LR',
    grid: 8,
    gap: { node: 28, rank: 64 },
    edges: [
      { id: 'e1', from: { node: 'n-nic' }, to: { node: 'n-hook' }, label: 'skb' },
      { id: 'e2', from: { node: 'n-hook' }, to: { node: 'n-route' } },
      { id: 'e3', from: { node: 'n-hook' }, to: { node: 'n-ct' }, label: '状态' },
      { id: 'e4', from: { node: 'n-route' }, to: { node: 'n-filter' }, style: 'dashed' },
      { id: 'e5', from: { node: 'n-route' }, to: { node: 'n-log' } },
      { id: 'e6', from: { node: 'n-ct' }, to: { node: 'n-filter' }, arrow: { start: true, end: true } },
      { id: 'e7', from: { node: 'n-filter' }, to: { node: 'n-drop' }, label: 'REJECT' },
      { id: 'e8', from: { node: 'n-filter' }, to: { node: 'n-snat' } },
      { id: 'e9', from: { node: 'n-snat' }, to: { node: 'n-egress' } },
      { id: 'e10', from: { node: 'n-log' }, to: { node: 'n-egress' }, style: 'dotted' },
      { id: 'e11', from: { node: 'n-nic' }, to: { node: 'n-egress' }, label: '长边' },
      { id: 'e-back', from: { node: 'n-filter' }, to: { node: 'n-hook' }, label: '回边' }
    ]
  },
  nodes: [
    { id: 'n-nic', type: 'rect', title: 'NIC 收包', subtitle: 'netif_receive_skb', badge: 'P1' },
    { id: 'n-hook', type: 'round', title: 'PREROUTING', subtitle: 'NF_INET_PRE_ROUTING', badge: 'HOOK' },
    { id: 'n-route', type: 'diamond', title: '查路由', subtitle: 'fib_lookup', badge: 'DECIDE' },
    { id: 'n-ct', type: 'pill', title: 'conntrack', subtitle: 'nf_conntrack_in', badge: 'M2' },
    { id: 'n-filter', type: 'cylinder', title: 'filter 表', subtitle: 'iptables', badge: 'M3' },
    { id: 'n-log', type: 'row', title: '日志', subtitle: 'nf_log_packet', badge: 'ROW' },
    { id: 'n-drop', type: 'rect', title: '丢弃', subtitle: 'kfree_skb', badge: 'X' },
    { id: 'n-snat', type: 'rect', title: 'SNAT', subtitle: 'nf_nat_masquerade', badge: 'M4' },
    { id: 'n-egress', type: 'rect', title: '发包', subtitle: 'dev_queue_xmit', badge: 'P2' }
  ]
};

/** 基准图（每次一份深拷贝） */
export function autoDoc() { return clone(DOC); }

/**
 * **显式意图**夹具：`n-b` 被 `pinned` 钉住并且带 `rect`。
 * 判据：它的位置**逐值等于声明的 rect**（自动布局不许覆盖），其余节点照常自动布局，
 * 且 `report.layout.explicit[]` 逐条点名"为什么这个节点没被摆"。
 */
export function pinnedDoc() {
  return {
    graph: {
      version: 1, direction: 'LR', grid: 8, pinned: ['n-b'],
      edges: [
        { id: 'p1', from: { node: 'n-a' }, to: { node: 'n-b' } },
        { id: 'p2', from: { node: 'n-b' }, to: { node: 'n-c' } }
      ]
    },
    nodes: [
      { id: 'n-a', type: 'rect', title: '甲', subtitle: 'a', badge: 'A' },
      { id: 'n-b', type: 'rect', rect: [600, 400, 208, 96], title: '乙（钉住）', subtitle: 'b', badge: 'B' },
      { id: 'n-c', type: 'rect', title: '丙', subtitle: 'c', badge: 'C' }
    ]
  };
}

/** 只有一条边的**最小自动图**（判单条几何时用，免得被别的边干扰） */
export function autoMinimal(extra) {
  const e = extra || {};
  const doc = {
    graph: Object.assign({ version: 1, direction: 'LR', grid: 8 }, e.graph || {}),
    nodes: [
      { id: 'a', type: 'rect', title: '甲', subtitle: 'a', badge: 'A' },
      { id: 'b', type: 'rect', title: '乙', subtitle: 'b', badge: 'B' }
    ]
  };
  if (e.nodes) doc.nodes = e.nodes;
  if (e.edges) doc.graph.edges = e.edges;
  return doc;
}

/**
 * **钉住的框正好压在自动区域内**的夹具（`pinned` 与自动区域的重叠避免）。
 * 判据：钉住的那个框位置**逐值不变**，自动节点被推到不重叠处（且仍在 8px 网格上），
 * 且 `report.pinnedAvoid[]` 逐条点名"谁被推了、往哪个轴、推了多少"。
 * ⚠️ 这份夹具**必须真的会撞**（否则判据空转）：`n-b` 钉在 (0,0)，而 `n-a` 的自动位置就在那一带。
 */
export function pinnedCollideDoc() {
  const doc = pinnedDoc();
  doc.nodes.forEach((n) => { if (n.id === 'n-b') n.rect = [0, 0, 208, 96]; });
  return doc;
}

/** 一条**长链**（a→b→c→d→e）：每层只有一个节点 ⇒ 副轴可以精确居中（误差必须 === 0） */
export function chainDoc(n) {
  const count = n || 5;
  const nodes = [];
  const edges = [];
  for (let i = 0; i < count; i++) {
    nodes.push({ id: 'k' + i, type: 'rect', title: '第' + (i + 1) + '步', subtitle: 's' + i, badge: 'S' });
    if (i > 0) edges.push({ id: 'c' + i, from: { node: 'k' + (i - 1) }, to: { node: 'k' + i } });
  }
  return { graph: { version: 1, direction: 'LR', grid: 8, edges: edges }, nodes: nodes };
}
