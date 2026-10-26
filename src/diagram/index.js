/* ============================================================
 * src/diagram/index.js — 图渲染内核的**唯一入口**（MS1）
 * ------------------------------------------------------------
 * 消费者只 `require('./src/diagram/index.js')`，不要逐个文件 require：
 *   · 文件名是会变的实现细节（`schema` / `measure` / `render-svg` 是模块拆分，不是接口）；
 *   · 不变量共 4 条（形状 / 三段 / z-order / 溢出为 0），它们**跨模块**成立 ——
 *     入口是"这套东西一起才算数"的落点。
 *
 * 本批（MS1）产出的是**纯字符串**：`render()` 吃一份手写坐标的 JSON、吐 SVG 字符串 + 报告。
 * 它**不做**（设计 §7.2，属 MS2/MS3）：自动布局、正交/曲线布线、交互、PNG/PDF 导出、
 * 接界面。`route: orthogonal|curve` 会**响亮拒绝**（`E_ROUTE_UNSUPPORTED`），
 * 布局留了 `layoutOf` 这个可替换的接口（默认 = 直接用 JSON 里的 `rect`）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./schema.js'), require('./measure.js'), require('./render-svg.js'));
  } else {
    root.MMDiagram = factory(root.MMDiagramSchema, root.MMDiagramMeasure, root.MMDiagramRender);
  }
})(typeof self !== 'undefined' ? self : this, function (schema, measure, render) {
  'use strict';

  /** 本内核的接口版本（**不是** `graph.version`、也不是 `meta.formatVersion`）：
   *  形状变了就升它；消费者可以据此判"我按哪一版写的调用"。 */
  const API_VERSION = 1;

  return {
    API_VERSION: API_VERSION,
    // ---- 渲染（唯一入口）----
    render: render.renderDiagram,
    /** 布局接口的**默认实现**（= 直接用 JSON 里的 `rect`）；MS2 换的是它，不是渲染 */
    layoutOf: render.layoutOf,
    // ---- 校验（`src/schema.js` 也用这一份，判据不分叉）----
    validateGraph: schema.validateGraph,
    validateGraphRefs: schema.validateGraphRefs,
    // ---- 文本测量（缺省是**确定**的近似器；可注入真 measureText）----
    createMeasurer: measure.createMeasurer,
    approxMeasureText: measure.approxMeasureText,
    APPROX_NOTE: measure.APPROX_NOTE,
    // ---- 报错类型（调用方按 `code` 判，不按文案判）----
    MMDiagramError: render.MMDiagramError,
    // ---- 取值表（文档与测试从这里取，别抄字面量）----
    SHAPES: schema.SHAPES,
    PORTS: schema.PORTS,
    EDGE_ROUTES: schema.EDGE_ROUTES,
    ROUTE_IMPLEMENTED: schema.ROUTE_IMPLEMENTED,
    Z_ORDER: render.Z_ORDER,
    FONT: render.FONT,
    MIN_FONT_SIZE: render.MIN_FONT_SIZE,
    CONTAINER_PAD: render.CONTAINER_PAD,
    CONTAINER_GAP: render.CONTAINER_GAP,
    /** 形状的"文字可用区"（判据要**独立复算**溢出时用它，别自己再写一份 inset 公式） */
    shapeInset: render.shapeInset
  };
});
