/* ============================================================
 * src/item-model.js — 条目层 v3 的模型核心（UMD，纯函数：无 I/O、不读盘、不读时钟）
 * ------------------------------------------------------------
 * 契约：`docs/ITEM-MODEL.md` §5.1（已冻结）。四个导出：
 *   parseDetail(html, opts) -> items     把 detail 按**顶层块**切成条目
 *   renderDetail(items) -> html          唯一的渲染实现（数组顺序 = 渲染顺序）
 *   validateItems(items) -> errors       校验**单个节点**的 items（字符串数组，空 = 合法）
 *   newItemId() -> 'i-xxxx'              生成候选 id（唯一性由调用方在全项目里查）
 * 外加一个装配点 / 一处结构助手（给 schema 与迁移用）：
 *   itemizeNode(node) -> {items, added, reason, qaItems}
 *   itemsWithContainers(items) -> 带容器信息的条目（**只读**，给并发合并逐条挑来源用）
 *
 * ## 这个模块存在的唯一理由：`detail` 必须能**逐字节**由 `items` 重建
 * `renderDetail(parseDetail(detail)) === detail` 是 v2→v3 迁移的**准入门槛**，不是努力方向：
 * 回放不了 ⇒ **整个节点跳过**（一个字节都不动），绝不"修一下再写"——内容悄悄变质是本工程
 * 最重的损害类别。所以下面这条设计贯穿全文：
 *
 *   **保真优先**：条目里存的 `html` 是**原样切片**（不重新转义、不改空白、不补标签）；
 *   块与块之间的空白（换行/缩进）是 `renderDetail` 用出来的**分隔符**，不是内容。
 *
 * ## 唯一一条不可违反的记账规则：**每一个字节只有一个承载者**
 * 上面那条"往返逐字节"能不能成立，全看这句话守没守住。落地形态：
 *  - 相邻两条之间的空白 ⇒ **后一条**的 `_gap`（外壳段落里由组内第一条带）；前一条**不再**另记一份。
 *  - 组内部的空白 ⇒ `_container.prefix` / `.sep` / `.suffix`（组内第二条起 `_gap` 留空）。
 *  - 全串末尾那一截 ⇒ **最后一条**的 `_tail`（渲染时挂起，等它那一组收完再写）。
 * 同一段字节被两处各记一遍，渲染就会多写一遍（实测：相邻顶层块之间多一个 `\n`，
 * 两个真实项目里绝大多数有 detail 的节点都只差这一个换行 ⇒ 迁移会把它们整节点跳过）。
 * ⇒ 改 `scanBlocks` / `parseDetail` / `renderDetail` 任一处前，先把"这段字节归谁"说清楚。
 *
 * ## 内部字段（`_` 起头，都是**解析期事实**）
 *  - `_container`  本组共有的外壳：`{open, close, prefix, sep, suffix, innerTo}`
 *  - `_groupStart` 本组**头一条**（渲染据此开一个新外壳；组内其余条目只靠 `_container` 认组）
 *  - `_gap`       这一条**之前**的空白（组内第二条起留空 —— 那份空白由 `sep` 承载）
 *  - `_tail`      末尾那一截（只有全串最后一条会带）
 * `_container` / `_groupStart` 用**标记 + 结构**判组、**不靠对象引用**：`items` 落盘再读回来时，
 * 同一组的两条会拿到两个不同但相等的对象（JSON 不保留引用）。
 *
 * ## `parseDetail` 的切分口径（契约 §5.1 一句话的可执行解释）
 *  - **顶层块** = 内容层最外那一层元素（`<p>` / `<h3>` / `<table>` / `<li>` / …）。
 *  - `<li>`（**去掉列表外壳后的**）⇒ `type:'text'`；其余块 ⇒ `type:'rich'`。
 *    契约说"`<li>` ⇒ text，其余顶层块 ⇒ rich"，而实际数据里 `<li>` 一律被 `<ul>`/`<ol>`
 *    包着（`<ul><li>a</li><li>b</li></ul>`）—— 所以"顶层"指的是**内容层**：列表外壳
 *    （`<ul>`/`<ol>`/`<dl>`）本身不是条目，它是**该组条目共有的容器**，逐条记住。
 *    ⇒ 同一个节点里的两个 `<ul>` 会并成**同一组**条目（顺序即数组顺序），外壳在渲染时补回。
 *  - 纯容器（只含空白 + 一个块）**不产生条目**：`<div><p>x</p></div>` ⇒ 一条，不含 `<div>`。
 *    （此例的 `<div>` 也回不来 ⇒ 那个节点回放不了 ⇒ 迁移时跳过并在 skipped 里点名 ✓）
 *  - **回放不了时返回 `null`**（哨兵）：闭合标签缺失、根层有非空白裸文本（如 `<!-- 注释 -->`
 *    与浏览器注入的 `<b>`）、约定不成立 —— 这些没有"通用的正确修法"，**跳过**才是诚实的处置。
 *
 * ## 为什么要有"容器"这个概念（两个理由，都不是洁癖）
 *  1. **渲染保真**：`<ul>\n<li>a</li>\n<li>b</li>\n</ul>` 与 `<ul><li>a</li><li>b</li></ul>`
 *     都要能逐字节回来 —— 分隔符（`\n` / `\n  ` / 空串）与外壳都是**原文里的事实**，
 *     必须逐条记住，不能用一个全局常量猜。
 *  2. **并发粒度**：容器是"多条条目共享的闭包"。只改一条 ⇒ 容器不变 ⇒ 另一个人改同组里的
 *     另一条仍**不相交** ⇒ 自动合并；而"往组里加/删条目"会改容器（或数组顺序）⇒ 那才是
 *     真冲突（两条都声称"这组里多了一条"）。见 `docs/ITEM-MODEL.md` §8。
 *
 * ## 与 `src/qa.js` 的关系（契约硬约束：不许复制那段逻辑）
 * `type:'qa'` 的正文由 `src/qa.js` 的 `appendHtml(item.qa)` 渲染 —— 本模块**调用**它，
 * 不重写。`parseDetail` **不产生** qa 条目（老数据里的问答段是普通 HTML 块）：
 * qa 条目只由显式动作产生（`item-add --type qa` 走 `ask-apply`；迁移把 `node.qa[]` 收敛成它）。
 * ⇒ 因此"往返逐字节"的门槛与 qa 无关，是干净成立的。
 *
 * ⚠️ **浏览器侧加载顺序**：若将来渲染层要用本模块，`index.html` 里 `qa.js` 必须排在它之前
 *    （UMD 取 `root.MMQa`）；当前渲染层**不加载**它（详情框渲染的是 `detail`，不是 items）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./qa.js'));
  } else {
    root.MMItemModel = factory(root.MMQa);
  }
})(typeof self !== 'undefined' ? self : this, function (qa) {
  'use strict';

  /* ---------------------------------------------------------------
   * 常量
   * ------------------------------------------------------------- */

  /** 条目 id 的形状（与节点/assoc 同一套；契约 §1 第一节）。**不强制 `i-` 前缀**（同 assoc 的 `a-` 先例）。 */
  const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
  /** `type` 取值表 —— **封闭**（契约 §1：别的值判红，要启用新值先改契约） */
  const TYPES = Object.freeze(['text', 'rich', 'qa']);
  /** 渲染时 qa 条目的正文：**唯一实现**在 `src/qa.js`（契约 §5.1 明令不许复制那段逻辑） */
  const QA_RENDERER = qa && typeof qa.appendHtml === 'function' ? qa.appendHtml : null;

  /** 可以被"钻进去"列表容器：它们自己不含内容，只是若干条目的外壳 */
  const LIST_SHELLS = new Set(['ul', 'ol', 'dl']);
  /** 自闭合/空元素：**不增加嵌套深度**（缺了这张表，`<br>` 之后的所有块都会被算成内层） */
  const VOID_TAGS = new Set(('area base br col embed hr img input link meta param source track wbr '
    + 'command keygen menuitem').split(' '));

  /* ---------------------------------------------------------------
   * HTML 扫描器（纯字符串，不依赖 DOM ⇒ Node 与浏览器同一份行为）
   * ------------------------------------------------------------- */

  /**
   * 从 `i`（必须指向 `<`）解析出一个标签的结束位置。
   * `--detail '<p>a > b</p>'` 里的 `>` 在**引号内**，不能当成标签结束 —— 故必须逐字符走引号状态。
   * @returns {{end:number, name:(string|null), startTag:(string|null), selfClosing:boolean}|null}
   */
  function scanTag(s, i) {
    if (s[i] !== '<') return null;
    const c = s[i + 1];
    if (c === '!' || c === '?') {                      // 注释 / 声明：整段跳过，不产生标签
      const isComment = s.substr(i, 4) === '<!--';
      const close = s.indexOf(isComment ? '-->' : '>', i);
      if (close < 0) return null;
      const end = close + (isComment ? 3 : 1);
      return { end: end, name: null, startTag: s.slice(i, end), selfClosing: true, isClose: false };
    }
    // 名字：一次正则把"开标签 `<p`"与"闭标签 `</p`"一起认掉。
    // ⚠️ **别改回"先判 `/[A-Za-z]/.test(s[i+1])` 再算名字起点"** —— 那两处一叠就互相打架：
    //    闭标签的 `s[i+1]` 是 `/`，那条守卫会在**算名字之前**直接 `return null`，
    //    于是闭标签被静默丢弃、块扫描永远配不上深度 ⇒ **全部输入解析成 null**。
    //    实测代价：真实两个项目 659 个有 detail 的节点全部回放失败，且症状看起来像"设计错了"。
    // ⚠️ 正则要拿**到串尾**的切片（`s.slice(i)`）：固定窗口（曾用 `i+64`）会把**靠近文末的
    //    闭标签截断**（`…</ul>\n` 只剩 `</u`）⇒ 正则不匹配 ⇒ 闭标签被当成"不认识"跳过 ⇒
    //    块判定为"闭合标签缺失"⇒ **整段判不可回放**。实测症状极隐蔽：只影响"文档最后 64 字符内
    //    还有标签"的那几个节点（卖点讨论 6 个 + comnet 2 个），其它节点全绿。
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(s.slice(i));
    if (!m) return null;
    const isClose = m[1] === '/';
    const nameAt = i + 1 + m[1].length;
    const name = m[2].toLowerCase();
    let j = nameAt + m[2].length;
    let q = null;
    while (j < s.length) {
      const ch = s[j];
      if (q) { if (ch === q) q = null; j++; continue; }
      if (ch === '"' || ch === "'") { q = ch; j++; continue; }
      if (ch === '>') break;
      j++;
    }
    if (j >= s.length) return null;
    const startTag = s.slice(i, j + 1);
    // 自闭合判定：**从 `>` 往前**剥空白，再看是不是 `/`。
    // ⚠️ 别写成"从 `>` 往前找 `/`" —— 那样 `<p>a</p>` 的 `<p>` 会因为 `j` 之后（甚至更远处）
    //    的 `/` 被误判成自闭合（实测：全部 450 个节点的 detail 都解析成了 null）。
    let k = j - 1;
    while (k > i && /\s/.test(s[k])) k--;
    return {
      end: j + 1, name: name, startTag: startTag, isClose: isClose,
      selfClosing: !isClose && (s[k] === '/' || VOID_TAGS.has(name))
    };
  }

  /**
   * 扫一个"块"：从 `i` 起，到它自己的闭标签之后（自闭合则到 `>` 之后）。
   *
   * **实现口径：一个显式栈，别写"深度计数器"。**
   * 计数器版本在这里踩过两次同一个坑（实测形态：`<ul><li>a</li></ul>` 被判不可回放，
   * 而 `<p>x</p>` 正常 —— 因为闭标签那一路 `continue` 与开标签那一路 `depth += 1`
   * 在**同一个循环体**里互相干扰，读代码时几乎看不出来）。
   * 显式栈没有这个歧义：见到开标签压栈，见到**同名**闭标签弹栈，栈空即块结束。
   *
   * @returns {{start:number, end:number, name:(string|null), startTag:(string|null),
   *            selfClosing:boolean, endTag:(string|null)}|null}
   */
  function scanBlock(s, i, lim) {
    const t = scanTag(s, i);
    if (!t) return null;
    if (t.name === null) return { start: i, end: t.end, name: null, startTag: t.startTag, selfClosing: true, endTag: '' };
    if (t.selfClosing) return { start: i, end: t.end, name: t.name, startTag: t.startTag, selfClosing: true, endTag: '' };
    const stack = [t.name];                             // 待闭合的名字（**从外到内**）
    let p = t.end;
    // ⚠️ `lim` 只用来做**越界判定**，不能拿它当搜索上界：外壳的闭标签在 `lim` **之外**
    //    （`lim` 是外壳内容的右边界）⇒ 当上界用会让每个 `<ul>…</ul>` 都"找不到闭标签"。
    //    真正的边界检查在下面对匹配到的那一个闭标签上做。
    while (p < s.length) {
      const lt = s.indexOf('<', p);
      if (lt < 0) return null;                          // 后面再没有标签 ⇒ 闭标签缺失 ⇒ 回放不了
      const nt = scanTag(s, lt);
      if (!nt) { p = lt + 1; continue; }                // 文本里的裸 `<`
      if (nt.name === null) { p = nt.end; continue; }   // 注释 / 声明：不参与配对
      if (nt.isClose) {
        const top = stack[stack.length - 1];
        if (nt.name !== top) {
          if (stack.indexOf(nt.name) < 0) return null;  // 完全对不上 ⇒ 真的坏了
          return null;                                  // 交叉（`<b><i></b></i>`）⇒ 回放不了
        }
        stack.pop();
        if (!stack.length) {
          if (nt.end > lim) return null;                // 闭标签越过本层右边界 ⇒ 越界，不认
          return {
            start: i, end: nt.end, name: t.name,
            startTag: t.startTag, selfClosing: false, endTag: s.slice(lt, nt.end)
          };
        }
        p = nt.end;
        continue;
      }
      if (!nt.selfClosing) stack.push(nt.name);         // 自闭合与空元素不占栈位
      p = nt.end;
    }
    return null;                                        // 走到串尾仍未闭合 ⇒ 回放不了
  }

  /** 一个块是不是"纯列表外壳"（`<ul>`/`<ol>`/`<dl>`）：是则返回它的开/闭标签与内层区间 */
  function shellParts(s, blk) {
    if (!blk || !blk.name || blk.selfClosing || !LIST_SHELLS.has(blk.name)) return null;
    if (blk.endTag !== '</' + blk.name + '>') return null;   // `</ ul >` 这种写不回去，不认
    const innerFrom = blk.start + blk.startTag.length;
    const innerTo = blk.end - blk.endTag.length;
    if (innerTo <= innerFrom) return null;                   // `<ul></ul>` 空壳：留给上层当普通块
    return { open: blk.startTag, close: blk.endTag, innerFrom: innerFrom, innerTo: innerTo };
  }

  /** 这一片里所有块之外的字符是否**全是空白**（有裸文本就回放不了 —— 那些文字没有条目可承载） */
  function onlyWhitespaceBetween(s, from, to, blocks) {
    let p = from;
    for (const b of blocks) {
      if (s.slice(p, b.start).trim() !== '') return false;
      p = b.end;
    }
    return s.slice(p, to).trim() === '';
  }

  /**
   * 一块（可能带外壳）在原文里**结束**的位置：外壳组 = 外壳闭标签之后；普通块 = 正文结束（`to`）。
   * ⚠️ "某一组/某一块到哪儿结束"只有这一个来源 —— 别在别处再推一遍（两套位次必然互相打架，
   * 见 `scanBlocks` 里那条"每个字节只有一个承载者"的注释）。
   */
  function spanEnd(s, b) {
    return b.container ? b.container.innerTo + b.container.close.length : b.to;
  }

  /**
   * 内容层切块：把 `[from,to)` 里的顶层块切成**一条扁平的"块序"**（含外壳展开）。
   *
   * ## 模型：给原文的每一段字节安排**唯一**一个槽位
   *
   * 一条块 = `{tag, html, gap, container, to}`：
   *   `gap`       这一块**之前**的空白（换行 / 缩进）—— 组内第一条吃的是外壳之前的空白
   *   `container` 若它在外壳里：**同一个外壳共用同一个对象**（同一引用 = "这是一组"的判据）
   *               `{open, close, prefix, sep, suffix}`
   *                 `prefix` 外壳开标签之后的前导空白（`<ul>\n<li>` 那个换行）
   *                 `sep`    组内两条之间的空白（**统一一份**；间距在原文里是同一个串）
   *                 `suffix` 最后一条之后、闭标签之前的空白（`</li>\n</ul>` 那个换行）
   *   `html`      这一块的**正文**（含自己的开闭标签，如 `<li>a</li>`）
   *   `to`        这一块正文的结束位置（外层块 = 元素结束；外壳里的条目 = 它的 `<li>` 结束）
   *
   * 剩下两段（`to` → 下一块起点、最后一块之后到串尾）由 `parseDetail` 按"下一块的起点"算成
   * `_tail`（末尾空白），**每一段字节只有这一个承载者**。
   *
   * ⚠️ 早期版本在这一层同时算 `prefix/sep/tail/outer/gap` 五套位次、在 `parseDetail` 又算一套，
   *    两套互相打架：真实数据 450 个节点里 193 个回放失败，每个都只差一个换行。
   *    "同一段字节被两处各记一遍"是这里最贵的 bug —— 看着对，逐字节不对。故改为一张表。
   *
   * 回放不了 ⇒ `null`（闭合标签缺失、根层裸文本、交叉嵌套…）。
   */
  function scanBlocks(s, from, to) {
    const top = scanTopBlocks(s, from, to);
    if (!top) return null;
    if (!top.blocks.length) return null;                        // 整段都是空白/空 ⇒ 调用方按空 detail 处理
    const out = [];
    let prevEnd = from;                                         // 上一个**外层块**的收尾（算 gap 用）
    for (const b of top.blocks) {
      const gap = s.slice(prevEnd, b.start);
      prevEnd = b.end;
      const shell = shellParts(s, b);
      // 纯列表外壳 ⇒ **钻进去**，把它的孩子们当成这一层的块。
      // 只有一件事会失败：外壳里的内容自己回放不了 ⇒ 退化成"把整个外壳当一个 rich 块"（仍是逐字节的）。
      const inner = shell ? scanBlocks(s, shell.innerFrom, shell.innerTo) : null;
      if (inner && inner.blocks.length) {
        const kids = inner.blocks;
        // ⚠️⚠️ **位次一律取自 `spanStart` / `spanEnd`，绝不能取 `start`**：钻进去那一层的元素是
        //     `{spanStart, to}` 形状（**没有 `start` 字段**）。写成 `kids[0].start` 拿到的是
        //     `undefined` ⇒ `s.slice(x, undefined)` = **整个剩余字符串** ⇒ 外壳里把正文又抄了一遍。
        //     实测症状（真实输入 `<p>旧内容</p><ul><li>甲</li><li>乙</li></ul>`）：
        //       prefix = `"<li>甲</li><li>乙</li></ul>"`、sep = `"<li>乙</li></ul>"`
        //       ⇒ 渲染成 `…</ul><li>甲</li><li>乙</li></ul><li>乙</li></ul><li>乙</li></ul>`
        //     同一份 detail 还会把 `_gap` 带歪，于是 6 条往返断言与整个自动条目化闸全线红。
        const c = {
          open: shell.open,
          close: shell.close,
          prefix: s.slice(shell.innerFrom, kids[0].spanStart),
          sep: kids.length > 1 ? s.slice(spanEnd(s, kids[0]), kids[1].spanStart) : '',
          suffix: s.slice(spanEnd(s, kids[kids.length - 1]), shell.innerTo),
          innerTo: shell.innerTo                       // 外壳内容的右边界（闭标签之前）
        };
        kids.forEach((k, ki) => out.push({
          tag: k.tag,
          html: k.html,
          // ⚠️ 组内**两条之间**的空白只由 `sep` 承载 ⇒ 组内第二条起 `gap` 一律留空。
          //    两处各记一遍 = 渲染时多写一遍（实测症状：`<ul>\n<li>a</li>\n<li>b</li>\n</ul>`
          //    渲染出 `</li>\n\n<li>`；两个真实项目里绝大多数节点都只差这一个换行）。
          gap: ki === 0 ? gap : '',
          groupStart: ki === 0,                        // 本组的**头一条**（渲染据此开一个新外壳）
          container: c,
          // ⚠️ `spanStart` = **这一组整体**的起点（外壳开标签），不是组内第一条的 `<li>` 起点。
          //    外层所有"到下一块开始为止"的位次（上一条的 `_tail`、本组的 `_gap`、本组的 `prefix`）
          //    都拿它当右边界 —— 拿 `<li>` 起点当边界会把外壳开标签那一截**切进上一条的尾巴**
          //    （实测症状：`<h3>H</h3>` 的 `_tail` 变成 `"\n<ul>\n"`，渲染出 `<h3>H</h3>\n<ul>\n\n<ul>…`）。
          spanStart: ki === 0 ? shell.innerFrom - c.open.length : k.spanStart,
          to: k.to
        }));
        continue;
      }
      out.push({ tag: b.name, html: s.slice(b.start, b.end), gap: gap, container: null, spanStart: b.start, to: b.end });
    }
    return { blocks: out, end: top.blocks[top.blocks.length - 1].end };
  }

  /**
   * 只切"字面量顶层块"（**不展开外壳、不递归**）。
   * 与 `scanBlocks` 分开是必须的：两者互相调用会**无限递归**（第一次实现就栽在这里，
   * 表现为"真实数据 450 个节点全部解析成 null"）。`lim` 传本层的右边界，块越界即判不可回放。
   */
  function scanTopBlocks(s, from, to) {
    const blocks = [];
    let pos = from;
    while (pos < to) {
      let nxt = pos;
      while (nxt < to && /\s/.test(s[nxt])) nxt++;
      if (nxt >= to) break;                                     // 尾随空白：由调用方挂到最后一个块上
      if (s[nxt] !== '<') return null;                          // 根层裸文本 ⇒ 没有条目能承载它
      const blk = scanBlock(s, nxt, to);
      if (!blk || blk.end > to) return null;
      blocks.push(blk);
      pos = blk.end;
    }
    if (!blocks.length) return null;
    if (!onlyWhitespaceBetween(s, from, to, blocks)) return null;
    return { blocks: blocks };
  }

  /* ---------------------------------------------------------------
   * parseDetail
   * ------------------------------------------------------------- */

  /**
   * 一条解析结果 → 条目对象（`html` 是原样切片：不重新转义、不改空白、不补标签）。
   * @param {{tag:(string|null), container:(object|null)}} block 扫描结果
   * @param {string} html 该条的正文（原样切片）
   * @param {{at?:string,by?:string,src?:(string|string[])}} opts
   */
  function makeItem(block, html, opts) {
    const item = { id: newItemId(), type: block.tag === 'li' ? 'text' : 'rich', html: html };
    const c = block.container;
    if (c) item._container = c;
    if (opts.at !== undefined && opts.at !== null && opts.at !== '') item.at = String(opts.at);
    if (opts.by !== undefined && opts.by !== null && opts.by !== '') item.by = String(opts.by);
    const src = opts.src;
    if (typeof src === 'string' && src) item.src = [src];
    else if (Array.isArray(src) && src.length) item.src = src.filter((x) => typeof x === 'string' && x).slice();
    return item;
  }

  /**
   * 把一段 detail HTML 按顶层块切成条目（保序）。
   *
   * ## 每一个字节**只有一个**承载者（本模块最贵的一条纪律）
   *  - 相邻两条之间的那一截空白 ⇒ 由**后一条**的 `_gap` 承载（外壳段落里由**组内第一条**带）。
   *    前一条**不再**另记一份 —— 早期版本两边各记一遍，渲染就把同一段空白写了两遍
   *    （实测症状：`<p>a</p>\n<ul>…` 渲染成 `<p>a</p>\n\n<ul>…`；两个真实项目里绝大多数
   *    有 detail 的节点都只差这一个换行 ⇒ 迁移会整节点跳过）。
   *  - 组**内部**的空白 ⇒ `container.prefix` / `container.sep` / `container.suffix`（统一一份）。
   *  - 全串**末尾**那一截（最后一块/最后一个外壳之后到串尾）⇒ 最后一条的 `_tail`。
   *    它必须等外壳收完再写 ⇒ `renderDetail` 把它挂起、延迟到收组处输出。
   * @param {string} html 节点 detail（HTML 片段）
   * @param {{at?:string, by?:string, src?:(string|string[])}} [opts] 给了就写进每一条
   * @returns {Array<object>|null} 条目数组；**`null` = 这段回放不了**（迁移必须跳过它，见文件头）
   */
  function parseDetail(html, opts) {
    const o = opts || {};
    // **类型守卫 + 响亮报错**：`String(html)` 会把 `{}` 变成 `"[object Object]"`、把 42 变成 `"42"`，
    // 那样只会得到一句"回放不了" —— 把"入参根本不是字符串"（调用方 bug）伪装成"这段内容不可切分"
    // （数据事实），两者要的处置完全不同（改调用方 vs 迁移跳过这个节点）。
    // `null` / `undefined` 照旧当"空 detail"（契约 §2：与空串等价），只有**别的类型**才抛。
    if (html !== null && html !== undefined && typeof html !== 'string') {
      throw new Error('parseDetail: html 必须是字符串（节点 detail 是 HTML 片段）—— 收到 '
        + (Array.isArray(html) ? 'array' : typeof html));
    }
    const s = String(html == null ? '' : html);
    if (!s.trim()) return [];                                   // 空 detail ⇒ 空数组（契约 §2：与"缺 detail"等价）
    const r = scanBlocks(s, 0, s.length);
    if (!r) return null;
    const last = r.blocks.length - 1;
    return r.blocks.map((b, i) => {
      const item = makeItem(b, b.html, o);
      // `_gap`：这一条**之前**的空白（外壳段落里由组内第一条带；组内第二条起由 `sep` 承载 ⇒ 留空）
      if (b.gap) item._gap = b.gap;
      // `_groupStart`：这一条要**开一个新外壳**（本组头一条）。组内其余条目靠 `_container` 认组 ——
      // ⚠️ 但不能只靠"两个容器对象相等"：`items` 一落盘再读回来，同一组的两条会拿到**两个不同但相等**
      //    的对象（JSON 不保留引用），那时按引用判组会把一组拆成两组、渲染出重复的外壳。
      if (b.container && b.groupStart) item._groupStart = true;
      // 末尾那一截：从这一条（或它所在的外壳）**结束处**到串尾（通常只有一个换行）
      if (i === last) {
        const from = spanEnd(s, b);
        if (s.length > from) item._tail = s.slice(from);
      }
      return item;
    });
  }

  /* ---------------------------------------------------------------
   * renderDetail
   * ------------------------------------------------------------- */

  /** 一条条目在**没有容器信息**时的正文渲染（`_container` 只影响外壳与分隔符，不影响正文） */
  function renderOne(it) {
    if (!it || typeof it !== 'object') return '';
    if (it.type === 'qa') {
      if (!QA_RENDERER) throw new Error('renderDetail: type=\'qa\' 需要 src/qa.js 的 appendHtml（浏览器侧请先加载 qa.js）');
      return QA_RENDERER(it.qa || {});
    }
    return String(it.html == null ? '' : it.html);
  }

  /**
   * 唯一的渲染实现（数组顺序 = 渲染顺序）。
   * 硬约束（契约 §5.1）：**幂等**；`renderDetail([]) === ''`；`type:'qa'` 调 `src/qa.js` 渲染；
   * 往返契约 `renderDetail(parseDetail(detail)) === detail` 逐字节成立。
   * @param {Array<object>} items
   * @returns {string}
   */
  function renderDetail(items) {
    if (items === undefined || items === null) return '';
    if (!Array.isArray(items)) throw new Error('renderDetail: items 必须是数组（收到 ' + (typeof items) + '）');
    if (!items.length) return '';
    /* **按解析时那张表逐槽位拼回**（顺序与原文字节顺序一致）：
     *   `_gap` → 外壳开标签 → `prefix` → 正文 → `sep` → 正文 → … → `suffix` → 外壳闭标签 →（末尾）`_tail`
     * 分组判据 = **`_groupStart`**（本组头一条）＋ `_container`（组内其余条目）；换了组（或没外壳）
     * 就收尾上一组。⚠️ 判组**不能**只看容器对象引用：`items` 一落盘再读回来，同一组的两条会拿到
     * 两个**不同但相等**的对象（JSON 不保留引用）⇒ 按引用判组会把一组拆成两组、渲染出重复的外壳。
     * ⚠️ 别在这里补默认分隔符（如 `'\n'`）：每一位空白在解析时都有主了，补一次就多一次
     *   （实测症状：`</li>\n</ul>` → `</li>\n\n</ul>`）。
     * ⚠️ `_tail`（末尾那一截）要**等它那一组收完**再写 ⇒ 先挂起，在收组处或最后统一输出。*/
    let out = '';
    let cur = null;                                             // 当前组的容器（null = 无外壳段）
    let opened = false;                                         // 当前组的外壳开标签是否已写
    let pending = '';                                           // 挂起的 `_tail`（紧随本组闭标签输出）
    items.forEach((it) => {
      const c = (it && it._container) || null;
      const fresh = !c || !cur || it._groupStart || !sameContainer(c, cur);
      if (fresh) {                                              // 收尾上一组，开新的一段
        if (cur) out += (cur.suffix || '') + cur.close;         // 闭标签在 suffix 之后
        cur = c;
        opened = false;
      }
      if (pending) { out += pending; pending = ''; }
      if (typeof it._gap === 'string' && it._gap) out += it._gap;
      if (c && !opened) { out += c.open + (c.prefix || ''); opened = true; }
      else if (c) out += (cur.sep || '');
      out += renderOne(it);
      if (typeof it._tail === 'string' && it._tail) pending = it._tail;
    });
    if (cur) out += (cur.suffix || '') + cur.close;
    if (pending) out += pending;
    return out;
  }

  /**
   * 两个外壳算不算"同一个外壳"（**只作补充判据**：主判据是条目上的 `_groupStart` 标记）。
   * 用途：`_groupStart` 不在场时（外部手写的 items）仍能认出"这是同一组的续条"。
   * ⚠️ 引用相等只是**其中一种**情形，不能当成唯一判据：`items` 落盘再读回来时同一组的两个容器
   *    是**两个不同但相等**的对象（JSON 不保留引用）—— 那时按引用判组会把一组拆成两组。
   * ⚠️ 两个**相邻且形状相同**的独立外壳（`<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>`）
   *    在这里会被判成"同一个" ⇒ 所以头一条上的 `_groupStart` 必须优先（分层：标记 > 结构）。
   */
  function sameContainer(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a === b) return true;
    return a.open === b.open && a.close === b.close
      && (a.prefix || '') === (b.prefix || '') && (a.sep || '') === (b.sep || '')
      && (a.suffix || '') === (b.suffix || '');
  }

  /**
   * 带容器信息的条目（**只读**；给并发合并逐条挑来源时判断"这组结构有没有变"）。
   * 语义：返回一份新数组，每项是 `{item, index}`，`item` 仍指向**原对象**（不拷贝）。
   */
  function itemsWithContainers(items) {
    if (!Array.isArray(items)) return [];
    return items.map((it, index) => ({ item: it, index: index })).filter((x) => x.item && x.item._container);
  }

  /* ---------------------------------------------------------------
   * validateItems
   * ------------------------------------------------------------- */

  function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function nonEmptyString(x) { return typeof x === 'string' && x.trim() !== ''; }

  /** 可选字段的通用形状：给了就必须是**非空字符串** */
  function checkOptionalString(it, key, at, errors) {
    if (it[key] === undefined) return;
    if (!nonEmptyString(it[key])) errors.push(at + '.' + key + ' 必须是非空字符串（收到 ' + JSON.stringify(it[key]) + '）');
  }

  /**
   * 校验**单个节点**的 items 数组。返回**字符串数组**（空 = 合法），报错逐条点名。
   * 纯函数；**不判全项目唯一性**（那需要看到整棵树 ⇒ 由 `src/schema.js` 用一张 Set 判，
   * 见契约 §5.1 的"id 唯一性的分工"）。
   * @param {Array<object>} items
   * @returns {string[]}
   */
  function validateItems(items) {
    const errors = [];
    if (!Array.isArray(items)) return ['items 必须是数组（收到 ' + (items === null ? 'null' : typeof items) + '）'];
    const seenIds = new Set();
    const seenObjects = new Set();
    items.forEach((it, i) => {
      const at = 'items[' + i + ']';
      if (!isPlainObject(it)) { errors.push(at + ' 必须是对象（收到 ' + (it === null ? 'null' : typeof it) + '）'); return; }
      if (seenObjects.has(it)) { errors.push(at + ' 与前面的条目是**同一个对象**（数据损坏的典型形态，写盘会变成两份别名）'); return; }
      seenObjects.add(it);

      // ---- id ----
      if (!nonEmptyString(it.id)) errors.push(at + '.id 必填（稳定、可寻址的条目 id）');
      else if (!ID_RE.test(it.id)) errors.push(at + '.id 不合规范（小写字母/数字/连字符，如 i-3f2k9a）: ' + it.id);
      else if (seenIds.has(it.id)) errors.push(at + '.id 与前面重复: ' + it.id + '（条目 id 至少要在**节点内**唯一）');
      else seenIds.add(it.id);
      const label = nonEmptyString(it.id) ? at + '（' + it.id + '）' : at;

      // ---- type（封闭取值表）----
      if (!nonEmptyString(it.type)) errors.push(label + '.type 必填（' + TYPES.join(' / ') + '）');
      else if (TYPES.indexOf(it.type) < 0) errors.push(label + '.type 取值非法: ' + it.type + '（只允许 ' + TYPES.join(' / ') + '）');

      // ---- html / qa：**互斥**（type=qa 的正文由 qa 渲染；两处表达必漂移）----
      if (it.type === 'qa') {
        if (it.html !== undefined) errors.push(label + '.html 与 type=\'qa\' 互斥（正文由 qa 渲染，两处表达必漂移 —— 删掉 html）');
        if (!isPlainObject(it.qa)) errors.push(label + '.qa 必填（type=\'qa\' 必须有 {q,a,at,model?}）');
        else {
          if (!nonEmptyString(it.qa.a)) errors.push(label + '.qa.a 必须是非空字符串（一条没有回答的记录毫无意义）');
          if (it.qa.q !== undefined && typeof it.qa.q !== 'string') errors.push(label + '.qa.q 必须是字符串（**允许空串**："解释这个节点"本来就没有提问文本）');
          if (!nonEmptyString(it.qa.at)) errors.push(label + '.qa.at 必须是非空字符串（ISO 时间）');
          if (it.qa.model !== undefined && typeof it.qa.model !== 'string') errors.push(label + '.qa.model 必须是字符串');
        }
      } else if (typeof it.html !== 'string') {
        errors.push(label + '.html 必填且必须是字符串（type=\'' + (it.type || 'text') + '\'）');
      }

      // ---- 出处 / 标签 ----
      if (it.src !== undefined) {
        if (Array.isArray(it.src)) {
          if (!it.src.length) errors.push(label + '.src 不能是空数组（不出现 = 没有出处）');
          it.src.forEach((v, k) => { if (!nonEmptyString(v)) errors.push(label + '.src[' + k + '] 必须是非空字符串'); });
        } else if (!nonEmptyString(it.src)) {
          errors.push(label + '.src 必须是非空字符串或非空字符串数组');
        }
      }
      if (it.tags !== undefined) {
        if (!Array.isArray(it.tags)) errors.push(label + '.tags 必须是数组');
        else it.tags.forEach((v, k) => { if (!nonEmptyString(v)) errors.push(label + '.tags[' + k + '] 必须是非空字符串'); });
      }
      checkOptionalString(it, 'at', label, errors);
      checkOptionalString(it, 'by', label, errors);
      checkOptionalString(it, 'supersededBy', label, errors);
      if (it.supersededBy !== undefined && nonEmptyString(it.supersededBy) && it.supersededBy === it.id) {
        errors.push(label + '.supersededBy 不能指自己（那是"被我取代"的循环）');
      }

      // ---- 核验：三字段全必填；**缺失 = 未核**（不写 null、不写空对象）----
      if (it.verified !== undefined) {
        if (!isPlainObject(it.verified)) {
          errors.push(label + '.verified 必须是 {at,by,how} 对象（**缺失 = 未核**；不要写 null 或空对象）');
        } else {
          ['at', 'by', 'how'].forEach((k) => {
            if (!nonEmptyString(it.verified[k])) errors.push(label + '.verified.' + k + ' 必填（三字段全必填：at/by/how）');
          });
        }
      }

      // ---- 内部字段：`_` 起头的才放行（`_container` 是解析期事实，落盘即丢，见文件头）----
      Object.keys(it).forEach((k) => {
        if (k[0] === '_') return;
        if (['id', 'type', 'html', 'src', 'tags', 'at', 'by', 'verified', 'supersededBy', 'qa'].indexOf(k) >= 0) return;
        errors.push(label + '.' + k + ' 不是契约字段（docs/ITEM-MODEL.md §1 的取值表是**封闭**的；'
          + '内部字段必须以 `_` 起头，且落盘前要删掉）');
      });
    });
    return errors;
  }

  /* ---------------------------------------------------------------
   * newItemId
   * ------------------------------------------------------------- */

  /**
   * 生成一个候选条目 id：`i-` + 时间戳 base36 + 随机后缀（同 `src/markdown.js` 的 idGen 先例）。
   * **只生成候选**：唯一性由调用方在**全项目** id 集合里查重，撞了重生成（不许"靠概率"）。
   * @returns {string}
   */
  function newItemId() {
    return 'i-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------------------------------------------------------
   * 装配点：把一个 v2 节点变成条目化节点（迁移 + schema 报错指路都用它）
   * ------------------------------------------------------------- */

  /**
   * 尝试把节点条目化。
   * 返回四种结局（迁移据此分类，报告与回显同一份数据）：
   *   `{ok:true,  items, qaItems}` —— 可无损回放（含"detail 为空但节点有 qa[]"这一档）
   *   `{ok:false, reason:'itemized'}`    —— 已有 items：**幂等**，不是失败
   *   `{ok:false, reason:'no-detail'}`   —— 无 detail 也无 qa[]：没有可条目化的内容
   *   `{ok:false, reason:'not-list'}`    —— detail 里没有 `<li>`：只有列表才在迁移范围（契约 §6）
   *   `{ok:false, reason:'not-lossless'}`—— **回放不了** ⇒ 整节点跳过（一个字节都不动）
   * `added` 只对 `ok:true` 有意义；`qaItems` 是"这一节由 qa[] 收敛来的"条数（报告里要能分开说）。
   * **纯函数**：不改入参节点。
   */
  function itemizeNode(node, opts) {
    if (!node || typeof node !== 'object') return { ok: false, reason: 'no-detail' };
    if (node.items !== undefined) return { ok: false, reason: 'itemized' };
    const detail = typeof node.detail === 'string' ? node.detail : '';
    const qaList = Array.isArray(node.qa) ? node.qa : [];
    const hasLi = /<li\b/i.test(detail);
    if (!detail.trim() && !qaList.length) return { ok: false, reason: 'no-detail' };
    if (!hasLi && !qaList.length) return { ok: false, reason: 'not-list' };
    const parsed = detail.trim() ? parseDetail(detail, opts) : [];
    if (parsed === null) return { ok: false, reason: 'not-lossless' };
    const items = parsed.slice();
    // qa[] 收敛：**保序追加**在解析出的条目之后（契约 §6），随后删掉节点的 qa 键（不留只读副本）
    qaList.forEach((e) => {
      const q = {};
      if (e && e.q !== undefined) q.q = String(e.q);
      else q.q = '';
      q.a = String((e && e.a) || '');
      q.at = String((e && e.at) || '');
      if (e && e.model !== undefined) q.model = String(e.model);
      items.push({ id: newItemId(), type: 'qa', qa: q });
    });
    return { ok: true, items: items, qaItems: qaList.length, added: items.length };
  }

  return {
    parseDetail, renderDetail, validateItems, newItemId,
    itemizeNode, itemsWithContainers,
    TYPES, ID_RE, LIST_SHELLS, VOID_TAGS
  };
});
