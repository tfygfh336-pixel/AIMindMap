/* ============================================================
 * tests/diagram-fixture.js —— MS1 渲染内核的**手写坐标夹具**（不是被测对象，是基准）
 * ------------------------------------------------------------
 * 为什么夹具要常驻 `tests/`（设计 §9 第 2 条把它列为"需要拍板"）：
 *   "同输入两跑逐字节相同"与"节点顺序打乱坐标不变"这两条判据**必须有一份稳定的输入**
 *   —— 放 `.review/`（可随时整目录删）就等于把验收基准放在会被清掉的目录里。
 *   它是**手写坐标**的图（MS1 不做自动布局），所以每个 rect 都是人给的数，改它就是改基准。
 *
 * 图的形态（照任务书 §3 的 netfilter 骨架，但只用 9 个节点 —— 本批判的是"几何算得对不对"，
 * 不是"内容全不全"）：
 *   三条层带（Ingress / Core / Egress，含竖排水印与横排水印各一）、
 *   两个容器（`free` 自由坐标 + `stack` 表行）、六种形状各一个、三段式、
 *   六条边（含一条双向、一条虚、一条点线、两条自动选端口）、一条注释。
 * ============================================================ */

/** 深拷贝（每次调用给一份新的：用例之间不许共享可变对象） */
function clone(x) { return JSON.parse(JSON.stringify(x)); }

const DOC = {
  graph: {
    version: 1,
    profile: 'complex',
    direction: 'LR',
    grid: 8,
    layers: [
      { id: 'l-ingress', label: 'Ingress', labelSide: 'top', rect: [0, 20, 1200, 220], fill: '#eef4fb',
        watermark: { text: 'INGRESS', rotate: -90, opacity: 0.35 } },
      { id: 'l-core', label: 'Core', labelSide: 'top', rect: [0, 250, 1200, 300], fill: '#f4f7f2',
        watermark: { text: 'CORE', rotate: 0, opacity: 0.3 } },
      { id: 'l-egress', label: 'Egress', labelSide: 'top', rect: [0, 560, 1200, 180], fill: '#fbf2f2' }
    ],
    containers: [
      { id: 'c-free', label: '自由坐标分组', layout: 'free', rect: [80, 260, 500, 100],
        children: ['n-ct', 'n-filter'] },
      { id: 'c-rows', label: '表行（stack）', layout: 'stack', rect: [620, 280, 340, 120],
        padding: 12, gap: 8, children: ['n-log', 'n-log2'] }
    ],
    edges: [
      { id: 'e1', from: { node: 'n-nic', port: 'e' }, to: { node: 'n-hook', port: 'w' }, label: 'skb' },
      { id: 'e2', from: { node: 'n-hook', port: 'e' }, to: { node: 'n-route', port: 'w' } },
      { id: 'e3', from: { node: 'n-route', port: 's' }, to: { node: 'n-filter', port: 'n' }, style: 'dashed' },
      { id: 'e4', from: { node: 'n-ct', port: 'e' }, to: { node: 'n-filter', port: 'w' },
        arrow: { start: true, end: true }, label: '状态' },
      { id: 'e5', from: { node: 'n-log2' }, to: { node: 'n-egress' }, style: 'dotted' },
      { id: 'e6', from: { node: 'n-filter', port: 's' }, to: { node: 'n-drop', port: 'n' } }
    ],
    annotations: [
      { text: 'MS1 fixture：手写坐标，不做自动布局', at: [900, 40], style: 'note-blue' }
    ]
  },
  nodes: [
    { id: 'n-nic', type: 'rect', rect: [100, 70, 200, 70], title: 'NIC 收包', subtitle: 'netif_receive_skb', badge: 'P1' },
    { id: 'n-hook', type: 'round', rect: [360, 70, 200, 70], title: 'PREROUTING', subtitle: 'NF_INET_PRE_ROUTING', badge: 'HOOK' },
    { id: 'n-route', type: 'diamond', rect: [640, 50, 240, 110], title: '查路由', subtitle: 'fib_lookup', badge: 'DECIDE' },
    { id: 'n-ct', type: 'pill', rect: [110, 300, 220, 70], title: 'conntrack', subtitle: 'nf_conntrack_in', badge: 'M2' },
    { id: 'n-filter', type: 'cylinder', rect: [370, 300, 220, 90], title: 'filter 表', subtitle: 'iptables', badge: 'M3' },
    { id: 'n-log', type: 'row', rect: [630, 300, 300, 59], title: '日志行 1', subtitle: 'nf_log_packet', badge: 'ROW' },
    { id: 'n-log2', type: 'row', rect: [630, 400, 300, 59], title: '日志行 2', subtitle: 'nf_log_packet', badge: 'ROW' },
    { id: 'n-egress', type: 'rect', rect: [100, 620, 200, 70], title: '发包', subtitle: 'dev_queue_xmit', badge: 'P2' },
    { id: 'n-drop', type: 'rect', rect: [360, 620, 200, 70], title: '丢弃', subtitle: 'kfree_skb', badge: 'X' }
  ]
};

/** 基准图（每次一份深拷贝） */
export function netfilterDoc() { return clone(DOC); }

/** 只要一层 + 一个节点的**最小图**（判单条几何时用，免得被别的元素干扰） */
export function minimalDoc(extra) {
  const doc = {
    graph: Object.assign({ version: 1, direction: 'LR', grid: 8 }, (extra && extra.graph) || {}),
    nodes: (extra && extra.nodes) || [
      { id: 'n-a', type: 'rect', rect: [0, 0, 200, 70], title: '甲', subtitle: 'a', badge: 'A' },
      { id: 'n-b', type: 'rect', rect: [300, 0, 200, 70], title: '乙', subtitle: 'b', badge: 'B' }
    ]
  };
  if (extra && extra.graph && extra.graph.layers) doc.graph.layers = extra.graph.layers;
  if (extra && extra.graph && extra.graph.edges) doc.graph.edges = extra.graph.edges;
  if (extra && extra.graph && extra.graph.containers) doc.graph.containers = extra.graph.containers;
  if (extra && extra.graph && extra.graph.annotations) doc.graph.annotations = extra.graph.annotations;
  return doc;
}

/** 六种形状各一个（判 `C-F1-01` 时用；每个都够宽够高，不触发缩字号/加宽） */
export function sixShapesDoc() {
  const types = ['rect', 'round', 'diamond', 'pill', 'cylinder', 'row'];
  return {
    graph: { version: 1, direction: 'LR', grid: 8 },
    nodes: types.map((t, i) => ({
      id: 'shape-' + t,
      type: t,
      rect: [20 + i * 220, 40, 200, 110],
      title: '形状 ' + t,
      subtitle: 'shape=' + t,
      badge: t.toUpperCase().slice(0, 4)
    }))
  };
}
