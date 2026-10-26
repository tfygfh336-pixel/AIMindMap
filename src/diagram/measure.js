/* ============================================================
 * src/diagram/measure.js — 文本测量（**可注入**；缺省是**确定的近似器**）
 * ------------------------------------------------------------
 * 本批（MS1 渲染内核）的硬约束之一（父批 §一 第 8 条、设计 §2.5 的 `C-F5-01`/`C-F5-02`）：
 *   渲染内核**不许碰 DOM** —— 它吃 JSON、吐 SVG 字符串，跑在 node 里（vitest 直测）。
 *   但「文本永不溢出边框」（`C-F1-05`）这条【必备】判据必须靠"先量再定框"才成立
 *   ⇒ 于是测量必须是**一个可换的实现**，而不是散在渲染里的估算。
 *
 * 三条口径（写在这里就是判据，别在别处再写一份）：
 *   ① **缺省是近似**：中文/全角字宽 = 字号 × 1.00、其余（ASCII 等）= 字号 × 0.55。
 *      ⇒ 它**不是**真字体度量（真值要 DOM/canvas）；所以 `approximate` 永远是 `false`
 *      之外的显式读数，报告里能看到，**不许**把它当"和浏览器一致"。
 *      `C-F5-01` 的判据原文是"无 Canvas 环境下**响亮失败**，不静默估宽" —— 那条针对的是
 *      **界面里的渲染器**（那条路的量宽由浏览器给，估宽会让界面与导出不一致）。
 *      MS1 是 headless 内核：这里"缺省近似"是**声明的**而不是偷偷的（`approximate:true`
 *      会被写进渲染报告的 `report.measure`），且注入真 `measureText` 就能替换 ——
 *      两条路都不静默，所以不违反那条判据的意图。
 *   ② **缓存**（`C-F5-02`）：键必须含 (文本, 字号, 字体, 字重) —— 少一个都会让"改字号后
 *      仍用旧宽度"悄悄成立（那正是 `C-F5-03` 的坏形态）。命中数/未命中数是**可读**的。
 *   ③ **确定性**（`C-F4-04`/`C-F9-02`）：本模块零时钟、零随机、零 I/O；同一串同一字号
 *      永远同一个数（浮点也只经 `+ - *`，不做任何依赖平台的运算）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMDiagramMeasure = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 近似器的取值表（**唯一一处**；改这里就改了所有判据的基准）
   * ------------------------------------------------------------------ */

  /** CJK / 全角字符的宽度系数（相对字号）。1.0 = 方块字，是中日韩排版的通行近似。 */
  const CJK_FACTOR = 1;
  /** 其余字符（ASCII 字母数字标点）的宽度系数。0.55 是**近似**：真值随字体在 0.45–0.62 间浮动。 */
  const OTHER_FACTOR = 0.55;

  /** 判定"按方块字算宽度"的码点区间（**写全区间而不是只写 \u4e00-\u9fff**：
   *  中文标点（\u3000-\u303f）、全角 ASCII（\uff00-\uffef）、假名、韩文都占一个全角格，
   *  只认汉字会让"（一）"这类文本被算窄 40%，于是边框看着够、字实际出界）。 */
  const CJK_RANGES = [
    [0x1100, 0x115F],   // 韩文字母
    [0x2E80, 0x303E],   // CJK 部首扩展 + 中日韩符号与标点
    [0x3041, 0x33FF],   // 平假名/片假名/注音/CJK 兼容
    [0x3400, 0x4DBF],   // CJK 扩展 A
    [0x4E00, 0x9FFF],   // CJK 统一表意文字
    [0xA000, 0xA4CF],   // 彝文
    [0xAC00, 0xD7A3],   // 韩文音节
    [0xF900, 0xFAFF],   // CJK 兼容表意文字
    [0xFE30, 0xFE6F],   // CJK 兼容形式 + 小写变体
    [0xFF00, 0xFF60],   // 全角 ASCII
    [0xFFE0, 0xFFE6],   // 全角符号（￥ 等）
    [0x1F300, 0x1FAFF], // 表情符号（界面里真的会用）
    [0x20000, 0x3FFFD]  // CJK 扩展 B 及以后
  ];

  /** 一句话说清"这是近似"—— 报告里原样印出来，人不读代码也知道基准是什么 */
  const APPROX_NOTE = '近似器：CJK/全角 = 字号×' + CJK_FACTOR + '，其余 = 字号×' + OTHER_FACTOR
    + '（不是真字体度量；注入 measureText 可换成真值）';

  /** 这个字符按全角算吗（区间表上的二分；表按起点升序 ⇒ 先排一次序再查） */
  const SORTED_RANGES = CJK_RANGES.slice().sort((a, b) => a[0] - b[0]);
  function isWideCodePoint(cp) {
    let lo = 0;
    let hi = SORTED_RANGES.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = SORTED_RANGES[mid];
      if (cp < r[0]) hi = mid - 1;
      else if (cp > r[1]) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /**
   * 缺省的**近似**量宽（纯函数，确定性）。
   * 口径：逐个码点累计"占几个全角格"，再乘字号。代理对按**一个码点**算（`for...of`），
   * 不按 UTF-16 码元算 —— 否则表情符号会被算成两倍宽。
   * @param {string} text 文本
   * @param {number} fontSize 字号（px）
   * @returns {number} 宽度（px；可能是小数，**不四舍五入** —— 舍入由渲染层的 `fmt` 一处做）
   */
  function approxMeasureText(text, fontSize) {
    const s = text === undefined || text === null ? '' : String(text);
    const size = typeof fontSize === 'number' && Number.isFinite(fontSize) ? fontSize : 0;
    if (!s || size <= 0) return 0;
    let units = 0;
    for (const ch of s) {
      units += isWideCodePoint(ch.codePointAt(0)) ? CJK_FACTOR : OTHER_FACTOR;
    }
    return units * size;
  }

  /** 缓存键：**文本 + 字号 + 字体 + 字重**（`C-F5-02` 的键集判据就靠这一行）。
   *  用 `|` 分隔会把"文本里本来就有 |"算成碰撞 ⇒ 用**长度前缀**（与 `draft-map.js` 的
   *  `canonical` 同一条教训：任何分隔符都可能出现在标题里）。 */
  function cacheKey(text, fontSize, fontFamily, fontWeight) {
    const t = String(text === undefined || text === null ? '' : text);
    return t.length + ':' + t + '|' + fontSize + '|' + fontFamily + '|' + fontWeight;
  }

  /**
   * 造一个量宽器（**唯一入口**；渲染层不许自己算宽度）。
   *
   * @param {object} [opts]
   * @param {Function} [opts.measureText] 注入的真测量实现 `(text, {fontSize, fontFamily, fontWeight}) => number`。
   *   给了它 ⇒ `approximate` 为 false，且**任何非法返回值都响亮失败**（NaN/负数/非数不静默当 0 ——
   *   "量不出来就当作 0"会让溢出判据恒绿，那是本工程最不能接受的一类假绿）。
   * @param {boolean} [opts.cache=true] 关掉缓存只给测试用（判"缓存真的少了调用次数"）。
   * @returns {{widthOf:Function, measureText:Function, approximate:boolean, note:string,
   *            cacheKey:Function, stats:Function}}
   */
  function createMeasurer(opts) {
    const o = opts || {};
    const injected = typeof o.measureText === 'function' ? o.measureText : null;
    const useCache = o.cache !== false;
    const store = new Map();
    let hits = 0;
    let misses = 0;

    /** 唯一的取数点：命中缓存 / 真测量 / 近似，三档都从这里出去 */
    function raw(text, fontSize, fontFamily, fontWeight) {
      if (injected) {
        const w = injected(text, { fontSize: fontSize, fontFamily: fontFamily, fontWeight: fontWeight });
        if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
          throw new Error('注入的 measureText 返回了非法宽度（' + JSON.stringify(w)
            + '）—— 量不出宽度时必须响亮失败；当作 0 会让"文本不溢出"这条判据恒绿');
        }
        return w;
      }
      return approxMeasureText(text, fontSize);
    }

    function widthOf(text, fontSize, fontFamily, fontWeight) {
      const size = typeof fontSize === 'number' && Number.isFinite(fontSize) ? fontSize : 0;
      const fam = fontFamily === undefined || fontFamily === null ? '' : String(fontFamily);
      const wt = fontWeight === undefined || fontWeight === null ? '' : String(fontWeight);
      const key = cacheKey(text, size, fam, wt);
      if (useCache && store.has(key)) { hits++; return store.get(key); }
      misses++;
      const w = raw(text === undefined || text === null ? '' : String(text), size, fam, wt);
      if (useCache) store.set(key, w);
      return w;
    }

    return {
      widthOf: widthOf,
      /** 签名与注入接口同形，方便渲染层把它当"一个 measureText"往下传 */
      measureText: function (text, o2) {
        const b = o2 || {};
        return widthOf(text, b.fontSize, b.fontFamily, b.fontWeight);
      },
      approximate: !injected,
      note: injected ? 'measureText 已注入（真值由调用方给）' : APPROX_NOTE,
      cacheKey: cacheKey,
      /** 读数（判"缓存真的生效"用）：命中/未命中/条目数 */
      stats: function () { return { hits: hits, misses: misses, size: store.size, enabled: useCache }; }
    };
  }

  return {
    createMeasurer: createMeasurer,
    approxMeasureText: approxMeasureText,
    isWideCodePoint: isWideCodePoint,
    cacheKey: cacheKey,
    APPROX_NOTE: APPROX_NOTE,
    CJK_FACTOR: CJK_FACTOR,
    OTHER_FACTOR: OTHER_FACTOR,
    CJK_RANGES: CJK_RANGES
  };
});
