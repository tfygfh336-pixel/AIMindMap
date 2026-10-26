/* ============================================================
 * src/diagram/wrap.js — **框内自动换行**（`C-F1-03`）+ 形状内接几何（`C-F1-01`）
 * ------------------------------------------------------------
 * 本模块存在的理由（MS1 点名的缺口 `C-F1-03`）：
 *   MS1 的三档兜底是"缩字号 → 加宽 → 超过 2000px 报错"，**没有承载换行** ⇒ 窄剖面里
 *   "长标题靠换行"这条真实需求无处落地（1 个长标题只能被压成 8.5px 小字或者把框拉到 800px）。
 *   本批补上"按 measured 宽度断行"这一档，并把它排在**缩字号之前**：
 *
 *       ① 单行放得下         ⇒ 用基准字号（不缩、不换）
 *       ② 换行后放得下       ⇒ 用基准字号 + 多行（**这一档是本批新增的**）
 *       ③ 换行也超过行数上限 ⇒ 缩字号，再回到 ①/②
 *       ④ 最小字号仍放不下   ⇒ 加宽（受 `MAX_NODE_W` 约束）
 *       ⑤ 加宽也超上限       ⇒ **响亮报错** `E_TEXT_OVERFLOW`（不裁字、不叠字）
 *
 * 为什么"行数上限"（`MAX_LINES`）是这条阶梯的支点：
 *   没有上限时任何文本都能靠无限多行塞进任意宽度 ⇒ ③④⑤ 三档全部不可达，
 *   于是"缩字号/加宽/报错"变成死代码 —— 那正是本工程反复治的"判据在空转"。
 *
 * 三条口径（判据就从这三条量）：
 *   ① **每一行**都满足 `measuredWidth(line) <= 可用宽度`（不是"整段文本量一次"）；
 *   ② 多行时框高按 `行数 × 字号 + (行数−1) × LINE_LEAD` 长（**算式**，不是"看着差不多"）；
 *   ③ 断行位置只由 (文本, 字号, 可用宽度) 决定 ⇒ 同输入同断点（零时钟、零随机）。
 *
 * 断行规则（确定性、可复算）：
 *   · 汉字/全角/假名/表情：**逐字可断**（每个码点自成一段）；
 *   · ASCII 词：按空白分段，**词内不断**（一个 40 字符的标识符不会被劈成两半）；
 *     词比可用宽度还宽 ⇒ 它独占一行且**标记溢出**（交给③缩字号，而不是偷偷劈开）；
 *   · 避头尾的**最小**处理：闭合标点粘前一段、开启标点粘后一段（行首不会是"。"、行尾不会是"（"）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./measure.js'), require('./tokens.js'));
  else root.MMDiagramWrap = factory(root.MMDiagramMeasure, root.MMDiagramTokens);
})(typeof self !== 'undefined' ? self : this, function (measure, tokens) {
  'use strict';

  const FONT = tokens.FONT;
  const MIN_FONT_SIZE = tokens.MIN_FONT_SIZE;
  const FONT_STEP = tokens.FONT_STEP;
  const LINE_GAP = tokens.LINE_GAP;
  const LINE_LEAD = tokens.LINE_LEAD;
  const MAX_LINES = tokens.MAX_LINES;
  const PARTS = tokens.PARTS;
  const BASE_SIZE = tokens.BASE_SIZE;
  const NODE_PAD = tokens.NODE_PAD;
  const CYLINDER_CAP_RATIO = tokens.CYLINDER_CAP_RATIO;
  const CYLINDER_CAP_MAX = tokens.CYLINDER_CAP_MAX;
  const MAX_NODE_W = tokens.MAX_NODE_W;
  const CONTENT_MAX_W = tokens.CONTENT_MAX_W;
  const EPS = tokens.EPS;
  const MMDiagramError = tokens.MMDiagramError;
  /** 自动布局时正文的**最小**宽度（只为不让两字标题变成一个 40px 的小方块；不影响判据） */
  const MIN_CONTENT_W = 96;

  /* ==================================================================
   * 一、形状几何（`C-F1-01`）：**六种**，圆角 token 固定，内接文本区一并算出来
   * ================================================================== */

  /**
   * 形状的"文字可用区"（inset）。
   * 为什么按形状算而不是一律 `rect − padding`：`diamond` 的内接矩形只有一半宽高、
   * `cylinder` 的两端是椭圆盖 ⇒ 用同一个 padding 会让字压在斜边/弧上（"看着没出框"但**出了形**）。
   */
  function shapeInset(rect, type) {
    const x = rect.x;
    const y = rect.y;
    const w = rect.w;
    const h = rect.h;
    if (type === 'diamond') {
      // 菱形（四个顶点 = 四边中点）的最大内接轴对齐矩形 = 半宽 × 半高，居中
      return { x: x + w / 4, y: y + h / 4, w: w / 2, h: h / 2, kind: 'diamond' };
    }
    if (type === 'cylinder') {
      const cap = Math.min(h * CYLINDER_CAP_RATIO, CYLINDER_CAP_MAX);
      return { x: x + NODE_PAD, y: y + cap, w: w - 2 * NODE_PAD, h: h - 2 * cap, cap: cap, kind: 'cylinder' };
    }
    if (type === 'row') {
      // 表行：左右到底（表行本来就是"框到框"），上下留半个 padding
      return { x: x + NODE_PAD, y: y + NODE_PAD / 2, w: w - 2 * NODE_PAD, h: h - NODE_PAD, kind: 'row' };
    }
    return { x: x + NODE_PAD, y: y + NODE_PAD, w: w - 2 * NODE_PAD, h: h - 2 * NODE_PAD, kind: type };
  }

  /** 三段式需要的最小内接高度（**空槽也占一行** ⇒ 缺一段时其他段不塌陷，`C-F1-02`） */
  function requiredInnerHeight() {
    return BASE_SIZE.title + LINE_GAP + BASE_SIZE.subtitle + LINE_GAP + BASE_SIZE.badge;
  }

  /** 内接尺寸 → 外形尺寸（缩字号/加宽/换行之后要把"要多大内接框"翻回"要多大外形框"）。
   *  ⚠️ `cylinder` 必须**解出来**而不是迭代试：cap 随 h 变化 ⇒ 迭代会撞上"每轮都差一点点"，
   *  于是 `MAX_FIT_ROUNDS` 用完还差 —— 那是把算式问题伪装成不收敛。闭式解：
   *  h·(1−2·ratio) ≥ innerH（cap 未到上限时）或 h = innerH + 2·capMax（cap 封顶后）。 */
  function outerSizeFor(type, innerW, innerH) {
    if (type === 'diamond') return { w: innerW * 2, h: innerH * 2 };
    if (type === 'cylinder') {
      const hUncapped = innerH / (1 - 2 * CYLINDER_CAP_RATIO);
      const capCapH = CYLINDER_CAP_MAX / CYLINDER_CAP_RATIO;       // cap 刚好封顶时的高度（16 / 0.2 = 80）
      return { w: innerW + 2 * NODE_PAD, h: hUncapped <= capCapH ? hUncapped : innerH + 2 * CYLINDER_CAP_MAX };
    }
    if (type === 'row') return { w: innerW + 2 * NODE_PAD, h: innerH + NODE_PAD };
    return { w: innerW + 2 * NODE_PAD, h: innerH + 2 * NODE_PAD };
  }

  /* ==================================================================
   * 二、字号阶梯（`C-F1-04`）
   * ================================================================== */

  /** 字号阶梯：从 base 逐档下调，**最后一档恒为 8.5**（不是"刚好碰到"）。 */
  function fontLadder(base) {
    const out = [];
    for (let s = base; s > MIN_FONT_SIZE + EPS; s -= FONT_STEP) out.push(Math.round(s * 10) / 10);
    if (Math.abs(out[out.length - 1] - MIN_FONT_SIZE) > EPS) out.push(MIN_FONT_SIZE);
    return out;
  }

  /* ==================================================================
   * 三、分段（断点在哪）—— 确定性，只由码点与一张标点表决定
   * ================================================================== */

  /** 闭合标点：粘在**前**一段的尾巴上（行首出现"。"就是断错了） */
  const CLOSE_PUNCT = '，。、；：！？）》」』】”’％…—～,.;:!?)]}%';
  /** 开启标点：粘在**后**一段的头上 */
  const OPEN_PUNCT = '（《「『【“‘([{';

  function isAsciiSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u3000'; }

  /**
   * 把一段文本切成"断点单元"。返回 `[{ text, spaceBefore }]`：
   *   `spaceBefore: true` ⇒ 这一单元与前一个之间**有一个空格**（拼接成行时才补回空格；
   *   行首不补 ⇒ 行首永远不会有空格）。
   * @param {string} text
   * @returns {Array<{text:string, spaceBefore:boolean}>}
   */
  function segmentsOf(text) {
    const s = String(text === undefined || text === null ? '' : text);
    const out = [];
    let word = '';              // 正在累积的 ASCII 词
    let pendingOpen = '';       // 待粘到下一单元头上的开启标点
    let spaceBefore = false;

    const push = (t, sp) => {
      if (!t) return;
      out.push({ text: t, spaceBefore: sp });
    };
    const flushWord = () => {
      if (!word) return;
      push(pendingOpen + word, spaceBefore);
      word = '';
      pendingOpen = '';
      spaceBefore = false;
    };

    for (const ch of s) {
      if (isAsciiSpace(ch)) { flushWord(); spaceBefore = true; continue; }
      const wide = measure.isWideCodePoint(ch.codePointAt(0));
      if (OPEN_PUNCT.indexOf(ch) >= 0) { flushWord(); pendingOpen += ch; continue; }
      if (CLOSE_PUNCT.indexOf(ch) >= 0) {
        // 粘前：先看词尾，再看 `pendingOpen`（"（"后面紧跟"）"这种退化输入也得有去处）
        if (word) { word += ch; continue; }
        if (out.length && !pendingOpen) { out[out.length - 1].text += ch; continue; }
        push(pendingOpen + ch, spaceBefore);
        pendingOpen = '';
        spaceBefore = false;
        continue;
      }
      if (wide) {
        flushWord();
        push(pendingOpen + ch, spaceBefore);
        pendingOpen = '';
        spaceBefore = false;
        continue;
      }
      // ASCII 词内字符：开启标点贴在词头
      if (pendingOpen) { word = pendingOpen + word; pendingOpen = ''; }
      word += ch;
    }
    flushWord();
    if (pendingOpen) push(pendingOpen, spaceBefore);
    return out;
  }

  /* ==================================================================
   * 四、换行（`C-F1-03` 的核心：贪心填行，每行都不超宽）
   * ================================================================== */

  /**
   * 按 measured 宽度断行。
   * @param {string} text
   * @param {number} size 字号
   * @param {number} maxW 可用宽度
   * @param {object} measurer `createMeasurer()` 的产物（**唯一的量宽入口**）
   * @param {number} [limit] 只要行数超过它就可以提前收工（判"超限"用；缺省不限）
   * @returns {{lines:Array<{text:string,width:number}>, maxWidth:number, fits:boolean}}
   *   `fits` = 每一行都 ≤ maxW（**单行不超宽**才是真的放得下）
   */
  function wrapText(text, size, maxW, measurer, limit) {
    const s = String(text === undefined || text === null ? '' : text);
    const fam = FONT.family;
    const cap = typeof limit === 'number' && limit > 0 ? limit : Infinity;
    const segs = segmentsOf(s);
    const lines = [];
    let cur = '';
    let curW = 0;
    const pushLine = () => {
      if (cur !== '') lines.push({ text: cur, width: curW });
      cur = '';
      curW = 0;
    };
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      // 拼接：行首不补空格（`cur === ''` 时），其余按"原处有空格才补一个空格"
      const add = (cur === '' ? '' : (seg.spaceBefore ? ' ' : '')) + seg.text;
      const cand = cur + add;
      const candW = measurer.widthOf(cand, size, fam);
      if (cur !== '' && candW > maxW + EPS) {
        pushLine();
        cur = seg.text;
        curW = measurer.widthOf(seg.text, size, fam);
      } else {
        cur = cand;
        curW = candW;
      }
      if (lines.length > cap) break;                 // 提前收工（调用方只关心"超没超"）
    }
    pushLine();
    if (!lines.length) lines.push({ text: '', width: 0 });
    let maxWidth = 0;
    let fits = true;
    lines.forEach((l) => {
      if (l.width > maxWidth) maxWidth = l.width;
      if (l.width > maxW + EPS) fits = false;
    });
    return { lines: lines, maxWidth: maxWidth, fits: fits };
  }

  /** 一段文字在给定行数上限下**至少需要多宽**（加宽档用它一次算准，而不是 1px 1px 挪）。
   *  二分搜整数宽度：单调（宽度 ↑ ⇒ 行数不增）⇒ 二分是对的，且步数固定 = 可复现。 */
  function neededWidthFor(text, size, maxLines, availW, measurer) {
    const lo = Math.max(1, Math.floor(availW));
    let hi = Math.min(Math.ceil(MAX_NODE_W) + 1, Math.max(lo + 1, lo * 2));
    // 先把 hi 顶到"能放下"或触到上限
    let guard = 0;
    while (guard++ < 64) {
      const w = wrapText(text, size, hi, measurer, maxLines);
      if (w.lines.length <= maxLines && w.fits) break;
      if (hi >= MAX_NODE_W) return MAX_NODE_W + 1;
      hi = Math.min(MAX_NODE_W + 1, hi * 2);
    }
    let low = lo;
    let high = hi;
    let guard2 = 0;
    while (low < high && guard2++ < 64) {
      const mid = Math.floor((low + high) / 2);
      const w = wrapText(text, size, mid, measurer, maxLines);
      if (w.lines.length <= maxLines && w.fits) high = mid; else low = mid + 1;
    }
    return low;
  }

  /** 一段文字的块高：`行数 × 字号 + (行数−1) × 行距`（空文本按 1 行算 ⇒ 槽位不塌陷） */
  function blockHeight(lines, size) {
    const n = Math.max(1, lines.length);
    return n * size + (n - 1) * LINE_LEAD;
  }

  /**
   * 一段文本"塞进一个宽 availW、最多 maxLines 行的槽"的**完整求解**（阶梯 ①…⑤ 都在这一个函数里）。
   *
   * @returns {{size:number, lines:Array<{text:string,width:number}>, width:number, height:number,
   *            shrunk:boolean, wrapped:boolean, needW:number, needH:number, overflow:number}}
   *   `needW` = 这一段的**内容宽度需求**（> availW ⇒ 调用方要加宽框或报错）；
   *   `overflow` > 0 ⇒ 连加宽都超上限（调用方**必须**报 `E_TEXT_OVERFLOW`）。
   */
  function fitPartInBox(text, baseSize, availW, maxLines, measurer) {
    const cap = Math.max(1, Math.floor(maxLines));
    const s = String(text === undefined || text === null ? '' : text);
    if (!s) {
      return { size: baseSize, lines: [], width: 0, height: baseSize, shrunk: false, wrapped: false,
        needW: 0, needH: baseSize, overflow: 0 };
    }
    const ladder = fontLadder(baseSize);
    for (let i = 0; i < ladder.length; i++) {
      const size = ladder[i];
      const w = wrapText(s, size, availW, measurer);
      if (w.lines.length <= cap && w.fits) {
        return { size: size, lines: w.lines, width: w.maxWidth, height: blockHeight(w.lines, size),
          shrunk: size < baseSize - EPS, wrapped: w.lines.length > 1, needW: w.maxWidth,
          needH: blockHeight(w.lines, size), overflow: 0 };
      }
    }
    // 最小字号下仍超限 ⇒ **加宽**（宽度需求由二分算准，不是 1px 挪）
    const need = neededWidthFor(s, MIN_FONT_SIZE, cap, availW, measurer);
    const room = Math.max(availW, need);
    const w = wrapText(s, MIN_FONT_SIZE, room, measurer);
    const ok = w.lines.length <= cap && w.fits && need <= MAX_NODE_W;
    const overflow = ok ? 0 : Math.max(w.maxWidth - room, need - MAX_NODE_W, 1);
    return { size: MIN_FONT_SIZE, lines: w.lines, width: w.maxWidth, height: blockHeight(w.lines, MIN_FONT_SIZE),
      shrunk: MIN_FONT_SIZE < baseSize - EPS, wrapped: w.lines.length > 1,
      needW: room, needH: blockHeight(w.lines, MIN_FONT_SIZE), overflow: overflow };
  }

  /* ==================================================================
   * 五、整节点求解（三段各自换行，块高与内接宽由三段合成）
   * ================================================================== */

  /**
   * 一个节点的三段各自的求解结果。
   * @param {object} node 节点（`title`/`subtitle`/`badge` 任缺 = 该段不画，但**槽位仍预留**）
   * @param {number} availW 可用内接宽度
   * @param {object} measurer
   * @returns {Object<string, object>} 三段各自的 `fitPartInBox` 结果
   */
  function measureParts(node, availW, measurer) {
    const out = {};
    for (let i = 0; i < PARTS.length; i++) {
      const key = PARTS[i];
      const text = typeof node[key] === 'string' ? node[key] : '';
      out[key] = fitPartInBox(text, BASE_SIZE[key], availW, MAX_LINES[key], measurer);
    }
    return out;
  }

  /** 三段合成后的内接高：三段块高之和 + 两个段距（**空段按 1 行占位**） */
  function innerHeightOf(parts) {
    let h = 0;
    for (let i = 0; i < PARTS.length; i++) h += parts[PARTS[i]].height;
    return h + LINE_GAP * (PARTS.length - 1);
  }

  /** 三段合成后的内接宽 = 三段里最宽的那一行的宽度（**不是**"整段文本量一次"） */
  function innerWidthOf(parts) {
    let w = 0;
    for (let i = 0; i < PARTS.length; i++) {
      const p = parts[PARTS[i]];
      if (p.width > w) w = p.width;
    }
    return w;
  }

  /** 三段里最"需要宽"的那一段（报错与加宽都按它算） */
  function maxNeedW(parts) {
    let w = 0;
    for (let i = 0; i < PARTS.length; i++) w = Math.max(w, parts[PARTS[i]].needW);
    return w;
  }

  /**
   * **自动布局用的**节点尺寸：不给定 rect，而是从文本反推"这个节点该多大"。
   *   `contentMaxW` 是"正文最大宽度"（超过就换行，`C-F1-03`）；节点外框 = 内接 + padding。
   * 与 `render-svg` 的 `fitNode` 是**同一套** `fitPartInBox` ⇒ 布局给的框渲染时必然刚好放下
   * （`tests/diagram-layout.test.js` 有一条"布局给的框必然不再被加宽"的判据钉着这件事）。
   *
   * @param {object} node
   * @param {object} opts `{ measurer, contentMaxW }`
   * @returns {{w:number, h:number, parts:object, inner:{w:number,h:number}, overflow:number}}
   */
  function measureNodeBox(node, opts) {
    const o = opts || {};
    const contentMaxW = typeof o.contentMaxW === 'number' && o.contentMaxW > 0 ? o.contentMaxW : CONTENT_MAX_W;
    const parts = measureParts(node, contentMaxW, o.measurer);
    // 内接宽 = 最宽那一行（换行/加宽已经把"需要多宽"体现在行宽里）；
    // 再兜一个**最小正文宽**，否则"标题两个字"的节点会缩成一个 40px 的小方块，
    // 在分层布局里与邻居的视觉权重完全不成比例（那是观感，不是判据，所以只兜下限）。
    const innerW = Math.max(MIN_CONTENT_W, Math.min(MAX_NODE_W, innerWidthOf(parts)));
    const innerH = Math.max(1, innerHeightOf(parts));
    const outer = outerSizeFor(node.type, innerW, innerH);
    let overflow = 0;
    for (let i = 0; i < PARTS.length; i++) overflow = Math.max(overflow, parts[PARTS[i]].overflow);
    if (outer.w > MAX_NODE_W) overflow = Math.max(overflow, outer.w - MAX_NODE_W, 1);
    return { w: outer.w, h: outer.h, parts: parts, inner: { w: innerW, h: innerH }, overflow: overflow };
  }

  /**
   * 三段的**基线 y**（从内接区顶部往下排；多行段逐行给一条基线）。
   * 判据：单行时与 MS1 逐字相同（`yTitle = inset.y + size`，`ySub = yTitle + LINE_GAP + size`）；
   * 多行时同一段内按 `LINE_LEAD` 递增，段间仍是 `LINE_GAP`。
   * @returns {Object<string, number[]>}
   */
  function partBaselines(parts, insetY) {
    const out = {};
    let cursor = insetY;
    for (let i = 0; i < PARTS.length; i++) {
      const key = PARTS[i];
      const p = parts[key];
      const n = Math.max(1, p.lines.length);
      const ys = [];
      for (let k = 0; k < n; k++) {
        cursor += p.size;
        ys.push(cursor);
        cursor += LINE_LEAD;
      }
      cursor += LINE_GAP - LINE_LEAD;                // 撤掉最后一行之后的行距，换成段距
      out[key] = ys;
    }
    return out;
  }

  return {
    shapeInset: shapeInset,
    requiredInnerHeight: requiredInnerHeight,
    outerSizeFor: outerSizeFor,
    fontLadder: fontLadder,
    segmentsOf: segmentsOf,
    wrapText: wrapText,
    neededWidthFor: neededWidthFor,
    blockHeight: blockHeight,
    fitPartInBox: fitPartInBox,
    measureParts: measureParts,
    innerHeightOf: innerHeightOf,
    innerWidthOf: innerWidthOf,
    maxNeedW: maxNeedW,
    measureNodeBox: measureNodeBox,
    partBaselines: partBaselines,
    CLOSE_PUNCT: CLOSE_PUNCT,
    OPEN_PUNCT: OPEN_PUNCT
  };
});
