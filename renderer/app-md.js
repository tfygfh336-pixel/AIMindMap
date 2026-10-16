/* ============================================================
 * renderer/app-md.js — 正文增强：**Mermaid 懒加载** + **三类链接** + **笔记锚点（关键词链接）**
 * ------------------------------------------------------------
 * 一句话：它是"正文注入之后"的那一步 —— 消毒（`renderer/sanitize.js`）负责**不许进来什么**，
 * 本模块负责**进来之后怎么点、怎么画**。两者都不改数据：产物只进 DOM（契约 §5-3）。
 *
 * ## ① Mermaid：这是一条**新机制**（本仓此前零 `import()` / 零 script 注入，30 个静态 `<script src>`）
 * ```
 * 探测（```mermaid 围栏 / language-mermaid 类） ⇒ 懒加载本地 vendored 文件 ⇒ 等 onload
 *   ⇒ mermaid.initialize({securityLevel:'strict', startOnLoad:false}) ⇒ render(id, src)
 *   ⇒ 成功：把 svg 落进图区容器 ｜ 失败：**可见的降级条 + 原因**，图源代码块一个字不丢
 * ```
 *   · 载荷 = 动态注入 `<script src="vendor/mermaid/mermaid.min.js">`（**经典脚本**，不是 `import()`）。
 *     为什么不是 `import()`：本页是 `loadFile()` 出来的 `file://` 文档，模块脚本走 CORS 而
 *     `file://` 的源是 opaque ⇒ 模块取回被拦（实测读数见 `.review/20261016-R7实现/` 与冒烟域 52 的
 *     `mm-import-probe`）。而 `createElement('script')+appendChild` 在 `script-src 'self' file:` 下
 *     是放行的（设计稿 §⑫-5.1 自己也是这么写的）⇒ **唯一实现在 `loadMermaid()`**。
 *   · 库文件在**仓库内**（`renderer/vendor/mermaid/`），**不从 CDN 取**；首屏不付它的代价。
 *   · **强制 `securityLevel:'strict'`**（不许 loose / antiscript）：图源可能来自外部导入文件。
 *   · ⚠️ **已知边界（本模块管不到）**：mermaid 一定会往文档里插 `<style>`，而
 *     `style-src 'unsafe-inline'` 放行它 —— 时序上**消毒在前、渲染在后**，所以 §② 的白名单
 *     **管不到 mermaid 自己产出的 DOM**。这条边界写在这里、写在 `renderer/vendor/MERMAID-INTERNALS.md`。
 *   · 上界（超过就如实标注、不静默）：单次最多渲染 **5** 张、单张图源 **> 20 KB 拒渲**。
 *
 * ## ② 三类链接（**都落在既有底座上，不新造关系类型**）
 * | 形态 | 点击发生什么 |
 * |---|---|
 * | 常规 · 工程内相对路径 / 本机绝对路径 | 判据 = `src/path-chain.js`（`kind:'inline'` / `'localPath'`），出口 = 既有 `app:open-file`（经 `MM.openByChain`）|
 * | 常规 · `http(s)` / `mailto` | 本工程**没有**"交系统浏览器"的出口（唯一出口 `app:open-file` 只收本机绝对路径，**不许加平行通道**）⇒ **拦下导航并响亮说明**（状态栏点名 URL 与原因），绝不静默跳走 |
 * | 站内 · `aimm://项目/节点id[#条目id]` | `MM.followNodeRef(项目, 节点)`（同项目选中+滚到、跨项目切项目 —— **R7-0 的唯一实现**）；带 `#条目` 再 `MM.fdSelectItem` 高亮该条 |
 * | 独立笔记 · `.fd-notelink`（笔记锚点） | `MM.showAssocPage(assoc, 锚定节点)` —— **复用 `createFdBox()`**，不是新窗口 |
 * 点击一律用**事件委托**（`dc` 上一个监听器，绑一次）：既不为每个链接挂监听器，也不给正文加属性
 * ⇒ **默认档（没有 mermaid、没有链接、没有锚点的节点）正文逐字节不变** 这条判据不受影响 ✓
 *
 * ## ③ 笔记锚点（`assoc.anchors[]`，正文**逐字节不动**）
 * 锚点声明在**笔记侧**（`assoc.anchors[]`），渲染期按文本在**消毒后的 DOM 文本节点**上匹配：
 *   · **跳过 `code`/`pre`/`a` 与所有属性值**（照 `W5b` 的规矩：不许命中代码块与 URL）；
 *   · **原样精确匹配**（不做大小写折叠）；一词多次出现 ⇒ **全部**成为链接；
 *   · 匹配不上**不是静默** —— 那篇笔记仍在「本页笔记」区（`assoc-list --node` 的口径已把它带出），
 *     且失效的锚点在清单里显示坏引用态（`.is-dangling` + `title` 给原因，判据见冒烟域 52）。
 * ============================================================ */
(function (root) {
  'use strict';

  const MM = root.MM = root.MM || {};

  /** 上界（**常量单源**：判据读这里，不许在别处再写一遍数字） */
  const LIMITS = { maxDiagrams: 5, maxSrcBytes: 20 * 1024, loadTimeoutMs: 15000 };
  /** vendored 库的**相对页面**地址（`renderer/vendor/mermaid/mermaid.min.js`） */
  const VENDOR_URL = 'vendor/mermaid/mermaid.min.js';
  /** 探测：围栏语言显式标注，或首行是 mermaid 的图类型关键字 */
  const MERMAID_START_RE = /^(?:graph|flowchart)\s+(?:TD|TB|BT|RL|LR)\b|^(?:sequenceDiagram|classDiagram|stateDiagram-v2|stateDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline|journey|quadrantChart|xychart-beta|xychart|block-beta|sankey-beta|packet-beta|architecture-beta|C4Context|C4Container|requirementDiagram)\b/;

  const state = {
    loader: null,             // Promise（同一时刻只加载一次）
    loaderSrc: '',            // 'cache' | 'script' | 'fail'
    loaderErr: '',
    renders: [],              // 每次 enhance 的读数
    seq: 0
  };

  const setStatus = (t, e) => MM.setStatus(t, e);

  /* ================= ① Mermaid 懒加载链（唯一实现） ================= */

  /** 全局是否已经有可用的 mermaid（脚本 onload 之后才可能为真） */
  function mermaidGlobal() {
    const m = root.mermaid;
    return (m && typeof m.render === 'function' && typeof m.initialize === 'function') ? m : null;
  }

  /**
   * 加载 vendored mermaid（**同一时刻只加载一次**；失败要能被调用方看见）。
   * 失败三档都会带非空 `error`：取不到文件 / 脚本报错 / 加载后全局仍没有 mermaid。
   */
  function loadMermaid() {
    if (state.loader) return state.loader;
    const have = mermaidGlobal();
    if (have) { state.loaderSrc = 'cache'; state.loader = Promise.resolve(have); return state.loader; }
    state.loader = new Promise(function (resolve, reject) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return; done = true; state.loaderSrc = 'fail';
        state.loaderErr = '加载超时（' + LIMITS.loadTimeoutMs + 'ms）：' + VENDOR_URL;
        reject(new Error(state.loaderErr));
      }, LIMITS.loadTimeoutMs);
      const s = document.createElement('script');
      s.src = VENDOR_URL;
      s.async = true;
      s.onload = function () {
        if (done) return;
        const m = mermaidGlobal();
        if (!m) { done = true; clearTimeout(timer); state.loaderSrc = 'fail';
          state.loaderErr = '脚本已加载但全局没有 mermaid（vendor 文件不是预期的 UMD 形态？）';
          reject(new Error(state.loaderErr)); return; }
        done = true; clearTimeout(timer); state.loaderSrc = 'script';
        /* ⚠️ 安全档位**只有这一处**：strict（图源可能来自外部导入文件）。
         * 不许改成 'loose'/'antiscript' —— 那会让图源里的 HTML/点击回调活过来。 */
        m.initialize({ startOnLoad: false, securityLevel: 'strict' });
        resolve(m);
      };
      s.onerror = function () {
        if (done) return; done = true; clearTimeout(timer); state.loaderSrc = 'fail';
        state.loaderErr = '取不到本地库文件：' + VENDOR_URL + '（file:// 下 script-src 里必须有 file:）';
        reject(new Error(state.loaderErr));
      };
      document.head.appendChild(s);
    });
    return state.loader;
  }

  /** 一个候选块是不是 mermaid 图源 */
  function isMermaidBlock(codeEl) {
    if (!codeEl) return false;
    const W = root.MMHtmlWhitelist;
    if (W && W.isMermaidLang(codeEl.className)) return true;
    const first = String(codeEl.textContent || '').split('\n').map((l) => l.trim()).find((l) => l);
    return !!(first && MERMAID_START_RE.test(first));
  }

  function firstLine(text) { return String(text || '').split('\n').map((l) => l.trim()).find((l) => l) || ''; }

  /** 降级条（**可见、带原因、图源一个字不丢**） */
  function degrade(preEl, reason, tag) {
    const box = document.createElement('div');
    box.className = 'fd-mermaid-fail';
    box.setAttribute('data-mm-mermaid', tag || 'fail');
    box.setAttribute('title', reason);
    box.textContent = '⚠️ mermaid 未渲染：' + reason + '（图源仍以代码块显示）';
    if (preEl.parentNode) preEl.parentNode.insertBefore(box, preEl);
    return box;
  }

  /** 把正文里的 mermaid 代码块**异步**渲染出来（首屏永不等它：打开详情框不阻塞） */
  function renderMermaids(dc) {
    const codes = Array.prototype.slice.call(dc.querySelectorAll('pre > code')).filter(isMermaidBlock);
    const out = { candidates: codes.length, rendered: 0, degraded: 0, skipped: 0, reasons: [] };
    if (!codes.length) return Promise.resolve(out);
    let budget = LIMITS.maxDiagrams;
    const jobs = codes.map(function (codeEl) {
      const pre = codeEl.parentNode;
      const src = String(codeEl.textContent || '');
      if (src.length > LIMITS.maxSrcBytes) {
        out.skipped += 1; out.degraded += 1;
        out.reasons.push({ id: '', code: 'too-large', msg: '图源超过 ' + Math.round(LIMITS.maxSrcBytes / 1024) + ' KB 上限' });
        degrade(pre, '图源超过 ' + Math.round(LIMITS.maxSrcBytes / 1024) + ' KB 上限', 'skip');
        return null;
      }
      if (budget <= 0) {
        out.skipped += 1;
        degrade(pre, '超出单次最多渲染 ' + LIMITS.maxDiagrams + ' 张的上限', 'skip');
        return null;
      }
      budget -= 1;
      const host = document.createElement('div');
      host.className = 'fd-mermaid';
      host.setAttribute('data-mm-mermaid', 'pending');
      pre.parentNode.insertBefore(host, pre);
      return loadMermaid().then(function (m) {
        state.seq += 1;
        const id = 'mm-mermaid-' + state.seq;
        return m.render(id, src, host).then(function (res) {
          const svg = (res && res.svg) ? String(res.svg) : '';
          if (!svg.trim()) throw new Error('渲染器返回了空 svg');
          host.innerHTML = svg;
          host.setAttribute('data-mm-mermaid', 'ok');
          if (typeof res.bindFunctions === 'function') { try { res.bindFunctions(host); } catch (e) { /* 图表交互非必需 */ } }
          if (pre.parentNode) pre.parentNode.removeChild(pre);
          out.rendered += 1;
        });
      }).catch(function (err) {
        const msg = firstLine(String((err && err.message) || err)) || '未知原因';
        out.degraded += 1;
        out.reasons.push({ id: '', code: 'render-fail', msg: msg });
        if (host.parentNode) host.parentNode.removeChild(host);
        degrade(pre, msg, 'fail');
      });
    });
    return Promise.all(jobs).then(function () { out.reasons = out.reasons.slice(0, 3); return out; });
  }

  /* ================= ② 三类链接（唯一一处点击分支） ================= */

  /** 站内链接的形状错误 / 目标状态都**响亮报**（绝不静默跳） */
  function followAim(raw, box, node) {
    const p = root.MMHtmlWhitelist.parseAimUrl(raw);
    if (!p.ok) { setStatus('站内链接打不开：' + p.reason + '｜' + raw, true); return false; }
    const cur = MM.getState ? (MM.getState().project || {}).name : '';
    if (p.project === 'note' || p.project === 'assoc') {
      // `aimm://note/<assocId>`：独立笔记（= 关联笔记实体）
      const list = (MM.getState && MM.getState().assoc) || [];
      const a = list.filter((x) => x && x.id === p.id)[0];
      if (!a) { setStatus('站内链接打不开：本项目的关联笔记里没有 ' + p.id + '（可能在别的项目，或已被删）', true); return false; }
      if (MM.showAssocPage) { MM.showAssocPage(a, node); return true; }
      return false;
    }
    if (MM.followNodeRef && MM.followNodeRef(p.project || cur, p.id)) {
      if (p.item && MM.fdSelectItem && box) MM.fdSelectItem(box, p.item);
      return true;
    }
    setStatus('站内链接打不开：' + raw, true);
    return false;
  }

  /** 正文里一个 `<a>` 被真点一下（事件委托的落点） */
  function onLinkClick(a, ev, box, node) {
    const blocked = a.classList && a.classList.contains('fd-link-blocked');
    const href = a.getAttribute('href') || '';
    const W = root.MMHtmlWhitelist;
    if (blocked || !href) {
      ev.preventDefault();
      setStatus('这个链接被拦下：' + (a.getAttribute('title') || '地址不在放行名单里'), true);
      return;
    }
    const c = W.classifyUrl(href, 'a');
    if (c.ok && c.kind === 'scheme' && c.scheme === 'aimm') {
      ev.preventDefault(); followAim(href, box, node); return;
    }
    if (c.ok && (c.kind === 'relative' || c.kind === 'drivepath')) {
      ev.preventDefault();
      /* 判据仍是**唯一那份**（`src/path-chain.js`）：相对路径走 `inline`（R7 正文路径档），
       * 本机绝对路径走 `localPath`（它天然在项目外，只校验形状）；出口仍是 `app:open-file`。 */
      const kind = (c.kind === 'drivepath') ? 'localPath' : 'inline';
      if (MM.openByChain) MM.openByChain({ kind: kind, raw: href });
      else setStatus('没有打开出口（app-media.js 未加载）：' + href, true);
      return;
    }
    if (c.ok && (c.kind === 'fragment')) return;    // 页内锚点：交给浏览器
    // http(s) / mailto：本工程**没有**把 URL 交出去的出口（唯一出口只收本机绝对路径，且不许加平行通道）
    // ⇒ 拦住默认导航（否则整个 Electron 渲染进程会被导航走 = 把应用变成浏览器），并**响亮说明**。
    ev.preventDefault();
    setStatus('外部链接不在本工程的打开出口内（唯一出口 app:open-file 只收本机路径）：'
      + href + ' —— 可复制后用系统浏览器打开', true);
  }

  /**
   * 绑正文坐标上的点击（**委托、只绑一次**）。绑在 `dc` 自己身上：
   * 详情框是复用容器，绑定标记随元素走，重绘不会累积监听器。
   */
  function wireLinks(box) {
    const dc = box && box.el ? box.el.querySelector('.fd-detail-content') : null;
    if (!dc || dc.dataset.mmLinkBound === '1') return false;
    dc.dataset.mmLinkBound = '1';
    dc.addEventListener('click', function (ev) {
      const a = (ev.target && ev.target.closest) ? ev.target.closest('a') : null;
      if (!a || !dc.contains(a)) return;
      onLinkClick(a, ev, box, box.node);
    });
    return true;
  }

  /* ================= ③ 笔记锚点：关键词 → `.fd-notelink` ================= */

  /** 收集正文里可匹配的文本节点（**跳过 code/pre/a 与属性值**） */
  function textNodesOf(dc) {
    const skip = { CODE: 1, PRE: 1, A: 1, SCRIPT: 1, STYLE: 1 };
    const out = [];
    (function walk(n) {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          if (c.nodeValue && c.nodeValue.trim()) out.push(c);
          continue;
        }
        if (c.nodeType !== 1) continue;
        if (skip[c.tagName]) continue;
        walk(c);
      }
    })(dc);
    return out;
  }

  /**
   * 按锚点把正文里的关键词变成**可打开笔记的链接**（`.fd-notelink`，配色是 R7-0 已落地的约定色）。
   * @returns {{marked:number, anchors:number, dangling:number}}
   */
  function applyAnchors(dc, node, assocView) {
    const out = { marked: 0, anchors: 0, dangling: 0, tagAnchors: 0, rawCount: 0, mineCount: 0,
      skippedOtherProject: 0, skippedOtherNode: 0, texts: 0 };
    const raw = (assocView && Array.isArray(assocView.raw)) ? assocView.raw
      : (assocView && Array.isArray(assocView.items)) ? assocView.items : [];
    out.rawCount = raw.length;
    const viewById = {};
    ((assocView && assocView.items) || []).forEach((v) => { if (v && v.id) viewById[v.id] = v; });
    const selfName = (MM.getState && MM.getState().project) ? MM.getState().project.name : '';
    const mine = [];
    raw.forEach(function (a) {
      ((a && a.anchors) || []).forEach(function (an) {
        if (!an) return;
        out.anchors += 1;
        if (an.tag) { out.tagAnchors += 1; return; }
        const proj = an.project || '';
        if (proj && proj !== selfName) { out.skippedOtherProject += 1; return; }  // 跨项目的锚点不在本节点正文里找
        if (an.id && node && an.id !== node.id) { out.skippedOtherNode += 1; return; }  // 锚在别的节点上
        if (typeof an.text === 'string' && an.text) mine.push({ assoc: a, text: an.text });
      });
    });
    out.mineCount = mine.length;
    out.nodeId = (node && node.id) || '';
    out.selfName = selfName;
    out.textNodeCount = textNodesOf(dc).length;
    if (!mine.length) { state.lastAnchors = out; return out; }
    // 长的优先（否则短词会先把长词切碎）
    mine.sort((x, y) => y.text.length - x.text.length);
    textNodesOf(dc).forEach(function (tn) {
      let cur = tn;
      mine.forEach(function (m) {
        if (!cur.parentNode) return;
        const idx = String(cur.nodeValue || '').indexOf(m.text);
        if (idx < 0) return;
        const after = cur.splitText(idx);
        const hit = after.splitText(m.text.length);
        const a = document.createElement('a');
        a.className = 'fd-notelink';
        a.setAttribute('href', '#');
        a.setAttribute('data-assoc-id', m.assoc.id);
        const v = viewById[m.assoc.id];
        const state2 = (v && v.anchorState) || 'ok';
        if (state2 !== 'ok') { a.classList.add('is-dangling'); a.setAttribute('title', (v && v.anchorHint) || '锚点已失效'); out.dangling += 1; }
        a.textContent = m.text;
        /* ⚠️ 下面两行是**必须的**（少写它们 = 只把文本节点切成了三段、链接元素却留在文档外：
         * 读数上 `marked` 照样 +1，而 DOM 里根本没有 `.fd-notelink` —— 本批实测踩到过一次，
         * 冒烟域 52 的锚点判据当场红。**"计数增加了"不等于"元素进了 DOM"**。） */
        hit.parentNode.insertBefore(a, hit);
        hit.parentNode.removeChild(hit);
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          const box = MM.fdPrimaryNodeBox ? MM.fdPrimaryNodeBox() : null;
          if (v && v.anchorState && v.anchorState !== 'ok') {
            setStatus('这篇笔记的锚点已失效（' + ((v && v.anchorHint) || '') + '）：' + m.assoc.id + ' —— 笔记仍可从「本页笔记」打开', true);
            return;
          }
          if (MM.showAssocPage) MM.showAssocPage(m.assoc, node);
          else setStatus('打不开笔记（没有 showAssocPage）：' + m.assoc.id, true);
          void box;
        });
        out.marked += 1;
        cur = hit;
      });
    });
    out.texts = 1;
    state.lastAnchors = out;
    return out;
  }

  /* ================= 站内链接的"坏引用态"（点击前就画出来） ================= */

  /** 异步给 `aimm://` 链接标出目标状态（同项目：内存树；跨项目：CLI 的 nodes 读口） */
  function markRefStates(dc) {
    const links = Array.prototype.slice.call(dc.querySelectorAll('a[href^="aimm://"]'));
    if (!links.length) return Promise.resolve({ checked: 0, dangling: 0, unreadable: 0 });
    const selfName = (MM.getState && MM.getState().project) ? MM.getState().project.name : '';
    const byProject = {};
    links.forEach(function (a) {
      const p = root.MMHtmlWhitelist.parseAimUrl(a.getAttribute('href') || '');
      if (!p.ok) { a.classList.add('is-dangling'); a.setAttribute('title', p.reason); return; }
      const key = p.project || selfName;
      (byProject[key] = byProject[key] || []).push({ el: a, ref: p });
    });
    return Promise.all(Object.keys(byProject).map(function (proj) {
      if (proj === selfName) {
        byProject[proj].forEach(function (it) {
          const jm = MM.getState && MM.getState().jm;
          const n = (jm && MM.adapter && MM.adapter.getNode) ? MM.adapter.getNode(jm, it.ref.id) : null;
          if (!n) { it.el.classList.add('is-dangling'); it.el.setAttribute('title', '目标节点不在当前树里：' + proj + '/' + it.ref.id); }
        });
        return Promise.resolve();
      }
      if (!root.desktop || !root.desktop.app || !root.desktop.app.nodes) return Promise.resolve();
      return Promise.resolve(root.desktop.app.nodes(proj)).then(function (r) {
        const nodes = (r && Array.isArray(r.nodes)) ? r.nodes : (Array.isArray(r) ? r : []);
        const ids = nodes.map((n) => (n && n.id) || n);
        byProject[proj].forEach(function (it) {
          if (ids.indexOf(it.ref.id) < 0) {
            it.el.classList.add('is-dangling');
            it.el.setAttribute('title', '目标节点不存在：' + proj + '/' + it.ref.id + '（目标项目读到了，节点不在）');
          }
        });
      }).catch(function (err) {
        byProject[proj].forEach(function (it) {
          it.el.classList.add('is-unreadable');
          it.el.setAttribute('title', '目标项目读不出来（不是"不存在"）：' + proj + '｜' + String((err && err.message) || err));
        });
      });
    })).then(function () {
      return { checked: links.length,
        dangling: dc.querySelectorAll('a.is-dangling').length,
        unreadable: dc.querySelectorAll('a.is-unreadable').length };
    });
  }

  /* ================= 入口：正文注入之后的那一步 ================= */

  /**
   * 对一个详情框的正文做增强（**同步部分立刻返回读数；mermaid 与坏引用态是异步的**）。
   * @returns {{links:number, anchors:object, mermaid:Promise|null}}
   */
  function enhance(box) {
    const dc = box && box.el ? box.el.querySelector('.fd-detail-content') : null;
    const node = box ? box.node : null;
    if (!dc) return { links: 0, anchors: null, mermaid: null };
    wireLinks(box);
    const links = dc.querySelectorAll('a[href], a.fd-link-blocked').length;
    const rec = { links: links, anchors: null, mermaid: null, refStates: null, at: Date.now() };
    state.renders.push(rec);
    // mermaid：**打开框之后异步**（照热度条的既有做法：首屏永不等渲染）
    setTimeout(function () {
      const p = renderMermaids(dc);
      rec.mermaid = p;
      p.catch(function () { /* 已在 renderMermaids 内部逐张降级 */ });
    }, 0);
    if (links) markRefStates(dc).then((r) => { rec.refStates = r; }).catch(() => {});
    return rec;
  }

  MM.mdEnhance = enhance;
  MM.mdApplyAnchors = applyAnchors;
  /** 上一次锚点标记的读数（冒烟断言与排查用；**不是**判据本身） */
  MM.mdAnchorState = function () { return state.lastAnchors ? JSON.parse(JSON.stringify(state.lastAnchors)) : null; };
  MM.mdMermaidStats = function () {
    const seen = state.renders.filter((r) => r.mermaid);
    return { loaderSrc: state.loaderSrc, loaderErr: state.loaderErr, renders: state.renders.length, seen: seen.length };
  };
  MM.mdLoadMermaid = loadMermaid;              // 冒烟域 52 的加载链判据直接调它（**唯一实现**）
  MM.mdLimits = LIMITS;
  MM.mdVendorUrl = VENDOR_URL;
  MM.mdIsMermaidBlock = isMermaidBlock;        // 探测函数的只读出口（判据不复制正则）
})(typeof window !== 'undefined' ? window : this);
