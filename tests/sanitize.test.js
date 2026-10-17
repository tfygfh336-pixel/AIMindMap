/* ============================================================
 * tests/sanitize.test.js —— `renderer/sanitize.js`（正文消毒）的 **node 侧**判据
 * ------------------------------------------------------------
 * ## 为什么要有这个文件（它补的是"整条路一点覆盖都没有"的那个洞）
 *   `renderer/sanitize.js` 靠全局 `DOMParser` ⇒ 一直**只在** Electron 冒烟域 52 里被跑到。
 *   于是 2026-10-18 修的两个真 bug（**HEAD 上就有**）三处门禁全漏：
 *     · bug①`img` 被拦分支漏了 `mutated = true` ⇒ `changed` 停在 false ⇒ `inject()` 注入**原始字节**
 *       ⇒ 承诺的**可见占位**被整段丢弃（用户只看到一张坏图）；
 *     · bug②`note('img-blocked', 'urlsBlocked')` 把**数字计数器**当明细桶名 ⇒ `[object Object]1`
 *       污染 ⇒ **下一次**被拦图片 `TypeError` 抛穿 `inject()`。
 *   漏的原因不是"没人测"，是**测法本身有洞**：
 *     · 域 52 的 `D_EVIL` 把 http 图和一堆必删项塞进**同一个 detail** ⇒ `changed` 被别的改动置真；
 *     · bug② 的触发条件是"**进入这次调用时** `state.urlsBlocked` 已为真值"，而全仓 1327 条语料的
 *       被拦 URL = 0 ⇒ `D_EVIL` 之后再没有第二次被拦图片。
 *   ⇒ 本文件按"**隔离**"与"**连续两次**"两个形态各钉一条，并把"桶名必须是明细桶"做成**结构断言**。
 *
 * ## ⚠️ 这个文件为什么自己搭一个假 DOM + 假 DOMParser（而不用 jsdom / domino）
 *   本工程没有 jsdom（`package.json` 只有 electron / electron-builder / jsmind / vitest / pdfjs-dist），
 *   而**加一个依赖**是本件不该做的决定（任务书明文：`@mixmark-io/domino` 只是 DSH 自带，别写进 package.json）。
 *   先例：`tests/heat-bars.test.js` 对渲染层模块用的就是"**最小 DOM 桩 + 加载真文件**"这一套。
 *   本文件比它多一样东西：`DOMParser` 本身也是**注入的替身**（这正是任务书要的"注入"形态）——
 *   证据在 `DOMParser 是**注入**的` 那两条：模块内部**没有**回落路径，node 里跑得起来
 *   **只可能**是因为我们把替身注进去了（拿掉就 `ReferenceError`）。
 *
 * ## 替身的**保真边界**（如实写清，别让下一个人以为这里等于浏览器）
 *   ✅ 实现了（都是 `sanitize.js` 真的用到的）：`parseFromString` / `doc.head` / `doc.body` /
 *      `createElement` / `childNodes` / `parentNode` / `nodeType`(1 元素 / 3 文本 / 7 PI / 8 注释) /
 *      `tagName` / `attributes` / `get|set|remove|hasAttribute` / `className` / `classList.add` /
 *      `textContent`(读写) / `firstChild` / `insertBefore` / `removeChild` / `replaceChild` /
 *      `children` / `innerHTML`(读写) / `querySelector(All)`（只认"tag + .class + [attr]"复合选择器）；
 *      以及 HTML 解析的三条语义：**void 元素**、**注释/PI 节点**、**前导的文档级标签进 `head`**。
 *   ❌ 没实现（因此**不许**拿本文件去证这些）：表格错位修复（foster parenting）、`<p>` 自动闭合、
 *      实体全集（只做 `&amp; &lt; &gt; &quot; &#39; &nbsp;`）、`<template>` 的内容文档、`svg` 内部大小写。
 *   这三条"没实现"里**没有一条**落在本文件判的东西上（判的是"消毒有没有改 / 有没有抛"，
 *   不是"浏览器解析得对不对"）。**真实解析器那一半**由冒烟域 52 用 Chromium 的真 `DOMParser` 守着 ⇒
 *   两边分工：这里给**能 node 直跑、能被打红**的快速面，那边给**真引擎**的面。两边同批跑（G3 + G5）。
 *
 * ## ⭐ 判别力证明做进了用例里（不是只写在报告里）
 *   下面 `判别力：把两处修复各自回退成原形态` 那一组，用**内存里的源码副本**（不写盘！）把 bug 形态
 *   注回去，然后断言"**健康版绿、回退版红**"两侧读数都在。⇒ 这条证明**每次跑 npm test 都在跑**，
 *   不会像报告里的读数那样随时间失效。文件级的三记读数（sha256 / 字节数 / CR 数）见
 *   `.review/20261016-sanitize两bug/README.md`。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANITIZE_FILE = path.join(ROOT, 'renderer', 'sanitize.js');
const SANITIZE_SRC = fs.readFileSync(SANITIZE_FILE, 'utf8');
/** 表（`src/html-whitelist.js` 是唯一一份；本文件**不复制**任何判据，全部调它） */
const W = require('../src/html-whitelist.js');

/** 明细桶名后缀的**期望值**：手写在这里（不从被测源码里取 —— 否则环证） */
const EXPECTED_BUCKET_SUFFIX = 'ByTag';

/* ============================================================================
 * 第一部分：最小 DOM + 假 DOMParser（**注入**给模块；模块内部没有回落路径）
 * ========================================================================== */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr']);
/** 前导位置会被真解析器搬进 `<head>` 的那一族（`sanitize.js` 的 `report.head` 靠它） */
const HEAD_TAGS = new Set(['meta', 'base', 'style', 'link', 'title', 'script']);

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');
}
function escapeText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }

class MiniNode {
  constructor(nodeType, doc) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
    this.ownerDocument = doc || null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('removeChild: 不是我的孩子');
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChild(newNode, oldNode) {
    const i = this.childNodes.indexOf(oldNode);
    if (i < 0) throw new Error('replaceChild: 不是我的孩子');
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    this.childNodes[i] = newNode;
    newNode.parentNode = this;
    oldNode.parentNode = null;
    return oldNode;
  }
}

class MiniText extends MiniNode {
  constructor(v, doc) { super(3, doc); this.nodeValue = String(v); }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
}

class MiniComment extends MiniNode {
  constructor(v, doc) { super(8, doc); this.nodeValue = String(v); }
  get textContent() { return ''; }
}

class MiniPI extends MiniNode {
  constructor(v, doc) { super(7, doc); this.nodeValue = String(v); }
  get textContent() { return ''; }
}

class MiniElement extends MiniNode {
  constructor(tag, doc) {
    super(1, doc);
    this.tagName = String(tag).toUpperCase();
    this.attributes = [];                 // array-like：`Array.prototype.slice.call(el.attributes)` 可用
    this._classes = [];
  }
  /* ---- class（单一来源：`class` 不出现在 attributes 里，`classList.add` 与 `className=` 都落到 _classes） ---- */
  get className() { return this._classes.join(' '); }
  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
  get classList() {
    const self = this;
    return {
      add(c) { const s = String(c); if (self._classes.indexOf(s) < 0) self._classes.push(s); },
      remove(c) { const s = String(c); self._classes = self._classes.filter((x) => x !== s); },
      contains(c) { return self._classes.indexOf(String(c)) >= 0; }
    };
  }
  /* ---- 属性 ---- */
  setAttribute(name, value) {
    const k = String(name).toLowerCase();
    if (k === 'class') { this.className = value; return; }
    const hit = this.attributes.filter((a) => a.name === k)[0];
    if (hit) hit.value = String(value); else this.attributes.push({ name: k, value: String(value) });
  }
  getAttribute(name) {
    const k = String(name).toLowerCase();
    if (k === 'class') return this._classes.length ? this.className : null;
    const hit = this.attributes.filter((a) => a.name === k)[0];
    return hit ? hit.value : null;
  }
  hasAttribute(name) {
    const k = String(name).toLowerCase();
    if (k === 'class') return this._classes.length > 0;
    return this.attributes.some((a) => a.name === k);
  }
  removeAttribute(name) {
    const k = String(name).toLowerCase();
    if (k === 'class') { this._classes = []; return; }
    this.attributes = this.attributes.filter((a) => a.name !== k);
  }
  /* ---- 结构 ---- */
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 1 || c.nodeType === 3 ? c.textContent : '')).join('');
  }
  set textContent(v) {
    this.childNodes.slice().forEach((c) => this.removeChild(c));
    if (String(v) !== '') this.appendChild(new MiniText(String(v), this.ownerDocument));
  }
  /* ---- 序列化（`sanitize.js` 的返回值与 `inject` 的读法都用它） ---- */
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(v) {
    this.childNodes.slice().forEach((c) => this.removeChild(c));
    parseFragment(String(v), this.ownerDocument).forEach((n) => this.appendChild(n));
  }
  /* ---- 选择器：只认"tag + .class + [attr]"这种复合形态（本文件需要的那几个） ---- */
  querySelectorAll(sel) {
    const parts = String(sel).trim().match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)(\[[\w-]+\])?$/);
    if (!parts) throw new Error('MiniElement.querySelectorAll: 不支持的形态 ' + sel);
    const tag = parts[1] ? parts[1].toUpperCase() : '';
    const classes = (parts[2] || '').split('.').filter(Boolean);
    const attr = parts[3] ? parts[3].slice(1, -1) : '';
    const out = [];
    (function walk(n) {
      n.childNodes.forEach((c) => {
        if (c.nodeType !== 1) return;
        const hit = (!tag || c.tagName === tag)
          && !classes.some((x) => !c.classList.contains(x))
          && (!attr || c.hasAttribute(attr));
        if (hit) out.push(c);
        walk(c);
      });
    })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function serialize(n) {
  if (n.nodeType === 3) return escapeText(n.nodeValue);
  if (n.nodeType === 8) return '<!--' + n.nodeValue + '-->';
  if (n.nodeType === 7) return '<?' + n.nodeValue + '?>';
  if (n.nodeType !== 1) return '';
  const tag = n.tagName.toLowerCase();
  const attrs = n.attributes.map((a) => ' ' + a.name + '="' + escapeAttr(a.value) + '"').join('');
  const cls = n.className ? ' class="' + escapeAttr(n.className) + '"' : '';
  if (VOID_TAGS.has(tag)) return '<' + tag + attrs + cls + '>';
  return '<' + tag + attrs + cls + '>' + n.childNodes.map(serialize).join('') + '</' + tag + '>';
}

const ATTR_RE = /([^\s/>"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=`<>]+)))?/g;
const TOKEN_RE = /<!--([\s\S]*?)-->|<\?([\s\S]*?)\?>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s/>"'=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=`<>]+))?)*)\s*(\/?)>/g;

/** 把一段 HTML 解析成**顶层节点数组**（不放进任何容器） */
function parseFragment(html, doc) {
  const root = new MiniNode(0, doc);   // 临时根，用来接孩子
  const stack = [root];
  const cur = () => stack[stack.length - 1];
  const pushText = (t) => { if (t) cur().appendChild(new MiniText(decodeEntities(t), doc)); };
  let last = 0;
  const src = String(html);
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    pushText(src.slice(last, m.index));
    last = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) { cur().appendChild(new MiniComment(m[1], doc)); continue; }
    if (m[2] !== undefined) { cur().appendChild(new MiniPI(m[2], doc)); continue; }
    if (m[3]) {                                     // 结束标签
      const want = m[3].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === want) { stack.length = i; break; }
      }
      continue;
    }
    const tag = m[4].toLowerCase();
    const el = new MiniElement(tag, doc);
    ATTR_RE.lastIndex = 0;
    let a;
    const attrStr = m[5] || '';
    while ((a = ATTR_RE.exec(attrStr)) !== null) {
      const raw = a[1];
      if (!raw || raw === '/') continue;
      const val = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''));
      el.setAttribute(raw, decodeEntities(val));
    }
    cur().appendChild(el);
    if (!VOID_TAGS.has(tag) && m[6] !== '/') stack.push(el);
  }
  pushText(src.slice(last));
  return root.childNodes.slice();
}

class MiniDocument {
  constructor() {
    this.nodeType = 9;
    this.ownerDocument = null;
    this.head = new MiniElement('head', this);
    this.head.parentNode = this;
    this.body = new MiniElement('body', this);
    this.body.parentNode = this;
  }
  createElement(tag) { return new MiniElement(tag, this); }
  createTextNode(t) { return new MiniText(t, this); }
  /** 近似真解析器的两条语义（见文件头"保真边界"）：**前导的文档级标签进 head**；`<body attrs>` 的属主是 body。 */
  parseFromString(raw) {
    const nodes = parseFragment(raw, this);
    const headKids = [];
    const bodyKids = [];
    let seeingBody = false;
    nodes.forEach((n) => {
      if (n.nodeType === 1 && n.tagName === 'BODY') {
        seeingBody = true;
        n.attributes.forEach((a) => this.body.setAttribute(a.name, a.value));
        if (n.className) this.body.className = n.className;
        n.childNodes.slice().forEach((c) => bodyKids.push(c));
        return;
      }
      const isHeadish = n.nodeType === 1 && HEAD_TAGS.has(n.tagName.toLowerCase());
      if (!seeingBody && isHeadish) { headKids.push(n); return; }
      seeingBody = true;
      bodyKids.push(n);
    });
    headKids.forEach((n) => this.head.appendChild(n));
    bodyKids.forEach((n) => this.body.appendChild(n));
    return this;
  }
}

/** **注入点**：模块里是裸标识符 `DOMParser` ⇒ 由这里注进去（拿掉就 ReferenceError，见对应那两条） */
function makeDomParserSpy() {
  const calls = [];
  function DOMParser() {
    this.parseFromString = function (raw, type) {
      calls.push({ raw: String(raw), type: String(type) });
      return new MiniDocument().parseFromString(raw);
    };
  }
  DOMParser.__calls = calls;
  return DOMParser;
}

/** 用**真文件**跑起来（不是复制一份实现）：把源码装进一个干净的 vm 上下文
 *  `opts.src` —— 允许传**内存里的改动副本**（判别力证明用；**绝不写盘**）。
 *  `opts.domParser === null` —— 不注 DOMParser（用于证明"注入是唯一来源"）。 */
function loadSanitize(opts) {
  const o = opts || {};
  const src = o.src === undefined ? SANITIZE_SRC : o.src;
  const DOMParserImpl = o.domParser === null ? undefined : (o.domParser || makeDomParserSpy());
  const win = { MM: {}, MMHtmlWhitelist: W };
  const sandbox = { window: win, MMHtmlWhitelist: W, console: console };
  if (DOMParserImpl) sandbox.DOMParser = DOMParserImpl;
  vm.runInNewContext(src, sandbox, { filename: 'renderer/sanitize.js' });
  return { S: win.MM.Sanitize, win: win, calls: DOMParserImpl ? DOMParserImpl.__calls : null };
}

/* ============================================================================
 * 第二部分：判据
 * ========================================================================== */

const ONLY_HTTP_IMG = '<img src="http://example.invalid/only.png" alt="唯一一张">';
const HTTP_A = '<img src="http://example.invalid/one.png">';
const HTTP_B = '<img src="http://example.invalid/two.png">';
const HTTP_C = '<img src="http://example.invalid/three.png"><img src="http://example.invalid/four.png">';

describe('renderer/sanitize.js —— DOMParser 是**注入**的', () => {
  it('不注 DOMParser ⇒ 一调 sanitize 就 ReferenceError（模块内部没有回落路径）', () => {
    const { S } = loadSanitize({ domParser: null });
    expect(() => S.sanitize('<p>你好</p>')).toThrow(/DOMParser is not defined/);
  });

  it('注进去的替身**真的被用了**（不是被谁悄悄换掉）', () => {
    const { S, calls } = loadSanitize();
    S.sanitize('<p>你好</p>');
    expect(calls.length).toBe(1);
    expect(calls[0].type).toBe('text/html');
    expect(calls[0].raw).toBe('<p>你好</p>');
  });
});

describe('bug① 被拦图片的**可见占位**必须真的到用户眼前（隔离：detail 里只有那一张图）', () => {
  it('隔离输入（只有一张明文 http 图，没有别的必删项）⇒ changed === true', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize(ONLY_HTTP_IMG);
    /* ⚠️ 这一条就是 bug① 的红线：以前 `changed` 停 false ⇒ 调用方注入**原始字节** ⇒ 占位消失 */
    expect(r.changed, '只有一张被拦图时 changed 必须是 true，否则占位会被"原样注入"那条路整段丢弃')
      .toBe(true);
    expect(r.report.imgs).toBe(1);
    expect(r.report.urls.length).toBe(1);
    expect(r.report.urls[0].code).toBe('url-http-img');
    expect(S.state().changed).toBe(1);
  });

  it('输出的 HTML 里**没有**那张活图，而是占位 span（带原文与原因）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize(ONLY_HTTP_IMG);
    expect(r.html).toContain('fd-img-blocked');
    expect(r.html).toContain('拦下');                       // `REASONS['url-http-img']` 的可见文案
    expect(r.html).toContain('data-blocked-src="http://example.invalid/only.png"');
    expect(r.html.includes('改成 https 即可显示'), '原因文案要带上"怎么才能显示"').toBe(true);
    expect(r.html).not.toMatch(/<img/i);                    // 活图必须不在
  });

  it('占位真的到了**注入后的 DOM** 里（`inject` 这条路，不是只看返回值）', () => {
    const { S, win } = loadSanitize();
    S.resetState();
    const dc = new MiniDocument().createElement('div');
    const r = S.inject(dc, ONLY_HTTP_IMG);
    expect(r.changed).toBe(true);
    const spans = dc.querySelectorAll('.fd-img-blocked');
    expect(spans.length, '注入后容器里必须有 1 个占位').toBe(1);
    expect(spans[0].textContent).toMatch(/拦下/);
    expect(spans[0].getAttribute('data-blocked-src')).toBe('http://example.invalid/only.png');
    expect(dc.querySelectorAll('img').length).toBe(0);
    expect(win.MM.Sanitize).toBe(S);
  });

  it('反面对照：https 图**不**被拦（用户 2026-10-16 裁决：只做安全收敛、不做联网收敛）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize('<img src="https://example.invalid/remote.png" alt="远程图">');
    expect(r.changed).toBe(false);
    expect(r.report.imgs).toBe(0);
    expect(r.report.urls.length).toBe(0);
    expect(r.html).toContain('https://example.invalid/remote.png');
  });

  it('`<img>` 没有 src ⇒ 也是可见占位 + changed === true（这条分支一直是对的，别被顺手改坏）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize('<img alt="没 src">');
    expect(r.changed).toBe(true);
    expect(r.html).toContain('fd-img-blocked');
    expect(r.html).toContain('图片地址为空');
  });
});

describe('bug② 连续两次被拦图片**不许抛**（`[object Object]` 污染 + 明细桶名）', () => {
  it('连续调用 3 次（每次都有被拦图）⇒ 一次都不抛，且 3 次都被记成明细', () => {
    const { S } = loadSanitize();
    S.resetState();
    const doc = new MiniDocument();
    const d1 = doc.createElement('div');
    const d2 = doc.createElement('div');
    const d3 = doc.createElement('div');
    /* ⚠️ 触发条件正是任务书点名的那句："**进入这次调用时** `state.urlsBlocked` 已为真值" ⇒
     *   以前第 2 次就 `TypeError: Cannot create property 'img-blocked' on string '[object Object]1'`。 */
    expect(() => S.inject(d1, HTTP_A)).not.toThrow();
    expect(() => S.inject(d2, HTTP_B)).not.toThrow();
    expect(() => S.inject(d3, HTTP_C)).not.toThrow();       // 第三次里还有**两张**连着的被拦图
    const st = S.state();
    expect(st.urlsBlockedByTag['img-blocked'], '明细桶要记到 4 次').toBe(4);
    expect(typeof st.urlsBlocked, '计数器必须是数字（不是 "[object Object]…" 这种字符串）').toBe('number');
    expect(st.urlsBlocked).toBe(4);
    expect(d1.querySelectorAll('.fd-img-blocked').length).toBe(1);
    expect(d2.querySelectorAll('.fd-img-blocked').length).toBe(1);
    expect(d3.querySelectorAll('.fd-img-blocked').length).toBe(2);
  });

  it('一次调用里连着两张被拦图 ⇒ 两张都换成占位（不抛，也不丢第二张）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize('<p>两张</p>' + HTTP_C);
    expect(r.changed).toBe(true);
    expect(r.report.imgs).toBe(2);
    expect((r.html.match(/fd-img-blocked/g) || []).length).toBe(2);
    expect(r.html).toContain('两张');                       // 别的文字不许被吃掉
  });

  it('跨调用累计全部落在明细桶上，计数器与明细**两边一致**（36 次也不漂）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const doc = new MiniDocument();
    for (let i = 0; i < 36; i++) S.inject(doc.createElement('div'), HTTP_A);
    const st = S.state();
    expect(st.urlsBlockedByTag['img-blocked']).toBe(36);
    expect(st.urlsBlocked).toBe(36);
    expect(st.remoteImgs).toBe(36);
  });
});

/* ---------------------------------------------------------------------------
 * 结构断言（防"第三次"）：桶名必须以 `ByTag` 结尾
 * ------------------------------------------------------------------------- */

/** 一次扫描产出两样东西：
 *   · `mask[i]`   —— 该字符**在代码里**（不是注释、也不是字符串内部）；
 *   · `blanked`   —— 注释被抹成空格（换行保留），字符串**原样留着**（判"第二参是不是字面量"要用值）。
 *  为什么要两样：本文件第一版只做了"抹注释"，结果**报错文案里那句** `sanitize.note(): …`
 *  被当成一次真调用（假红）；而注释里"举例说明那个 bug"的 `note('img-blocked', 'urlsBlocked')`
 *  又被当成真调用（更假）。两样合起来才对。
 *  ⚠️ 边界：不认**正则字面量**（`/…/` 里的 `//` 会被当行注释）。当前 `sanitize.js` 里
 *  一个正则字面量都没有；将来若加了，这条扫描要跟着升级。 */
function scanSource(src) {
  const mask = new Array(src.length).fill(true);
  const blanked = src.split('');
  let i = 0;
  let quote = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      mask[i] = false;
      if (c === '\\') { mask[i + 1] = false; i += 2; continue; }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; mask[i] = false; i++; continue; }
    if (c === '/' && (d === '*' || d === '/')) {
      const end = d === '*' ? src.indexOf('*/', i + 2) : src.indexOf('\n', i + 2);
      const stop = end < 0 ? src.length : (d === '*' ? end + 2 : end);
      for (let k = i; k < stop; k++) {
        mask[k] = false;
        if (blanked[k] !== '\n') blanked[k] = ' ';
      }
      i = stop;
      continue;
    }
    i++;
  }
  return { mask: mask, blanked: blanked.join('') };
}

/** 从源码里取出每一次 `note(...)` 调用（**跳过函数声明** `function note(`）的**全部实参**
 *  （按括号/引号配对切，避免被嵌套括号骗） */
function noteCalls(srcRaw) {
  const { mask, blanked: src } = scanSource(srcRaw);
  const out = [];
  const re = /\bnote\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!mask[m.index]) continue;                                                     // 字符串/注释里的不算
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;   // 声明不算调用
    let i = re.lastIndex, depth = 1, quote = '';
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; }
      else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    const inner = src.slice(start, i - 1);
    const args = [];
    let d = 0, q = '', cur = '';
    for (let k = 0; k < inner.length; k++) {
      const ch = inner[k];
      if (q) { cur += ch; if (ch === '\\') { cur += inner[k + 1] || ''; k++; } else if (ch === q) q = ''; }
      else if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; }
      else if (ch === '(' || ch === '[' || ch === '{') { d++; cur += ch; }
      else if (ch === ')' || ch === ']' || ch === '}') { d--; cur += ch; }
      else if (ch === ',' && d === 0) { args.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push({ args: args, raw: 'note(' + inner + ')' });
  }
  return out;
}

/** 判"这段源码里的桶名用对没有"——**一个函数**，正反两侧共用（避免给回退形态另写一套判法） */
function bucketOffenders(src) {
  const calls = noteCalls(src);
  const counterNames = ['urlsBlocked', 'attrsRemoved', 'remoteImgs', 'dropped', 'unwrapped',
    'runs', 'changed', 'headDropped', 'imgs', 'urls', 'head', 'docAttrs'];
  return {
    calls: calls,
    badSuffix: calls.filter((c) => {
      const second = c.args[1] || '';
      if (!/^'[^']*'$/.test(second)) return true;                  // 非字面量 ⇒ 机械查不了 ⇒ 也算违规
      return second.slice(1, -1).slice(-EXPECTED_BUCKET_SUFFIX.length) !== EXPECTED_BUCKET_SUFFIX;
    }),
    counters: calls.filter((c) => counterNames.indexOf((c.args[1] || '').replace(/^['"]|['"]$/g, '')) >= 0)
  };
}

describe('结构断言：桶名必须以 `ByTag` 结尾（防"第三次"）', () => {
  const calls = noteCalls(SANITIZE_SRC);

  it('源码里每个 `note(...)` 的第二参都是**字面量**且以 `ByTag` 结尾', () => {
    expect(calls.length, 'note() 的调用点数不许为 0（否则这条断言恒真）').toBeGreaterThan(5);
    const { badSuffix } = bucketOffenders(SANITIZE_SRC);
    expect(badSuffix.map((c) => c.raw), '第二参必须是明细桶名（以 ByTag 结尾的字面量）').toEqual([]);
  });

  it('源码里**没有**"把数字计数器当桶名"的形态', () => {
    const { counters } = bucketOffenders(SANITIZE_SRC);
    expect(counters.map((c) => c.raw), '这些是计数器，不是桶（写过一次就炸过一次）').toEqual([]);
  });

  it('模块自报的后缀 == 期望值 == 源码里用到的后缀（同一个字面量，不许各写一份）', () => {
    const { S } = loadSanitize();
    expect(S.bucketSuffix()).toBe(EXPECTED_BUCKET_SUFFIX);
    calls.map((c) => (c.args[1] || '').replace(/^['"]|['"]$/g, '')).forEach((b) => {
      expect(b.endsWith(S.bucketSuffix()), b).toBe(true);
    });
  });

  it('初始状态：`*ByTag` 键必须是**对象**、其余键必须是**数字**（两套命名空间不许混）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const st = S.state();
    const keys = Object.keys(st);
    expect(keys.length, '状态字典不许为空').toBeGreaterThan(0);
    const byTag = keys.filter((k) => k.endsWith(EXPECTED_BUCKET_SUFFIX));
    expect(byTag.length, '明细桶一个都没有 ⇒ 这条断言没东西可判').toBe(4);
    byTag.forEach((k) => expect(typeof st[k], k + ' 必须是对象').toBe('object'));
    keys.filter((k) => !k.endsWith(EXPECTED_BUCKET_SUFFIX))
      .forEach((k) => expect(typeof st[k], k + ' 必须是数字').toBe('number'));
    /* 源码里用到的每个桶都必须**已声明**（否则 `note()` 会现场造一个新键，绕过上面两条） */
    calls.map((c) => (c.args[1] || '').replace(/^['"]|['"]$/g, '')).forEach((b) => {
      expect(Object.prototype.hasOwnProperty.call(st, b), '未声明的桶：' + b).toBe(true);
    });
  });

  it('`resetState()` 之后形状不变（以前它把初始对象**抄了一份**，加桶时漏改一边就是同型 bug）', () => {
    const { S } = loadSanitize();
    const shape = (s) => Object.keys(s).sort().map((k) => k + ':' + typeof s[k]).join(',');
    const first = shape(S.state());
    S.sanitize(HTTP_A);
    S.resetState();
    expect(shape(S.state())).toBe(first);
    expect(Object.keys(S.state()).filter((k) => k.endsWith(EXPECTED_BUCKET_SUFFIX)).length).toBe(4);
  });
});

/* ---------------------------------------------------------------------------
 * ⭐ 判别力证明（做进用例里：每次 `npm test` 都在跑）
 * ------------------------------------------------------------------------- */

/** 在**内存里**把源码改一处（不写盘）。改动点必须命中**恰好一次**，否则直接报错
 *  （防止"改了之后没命中"这种最坏情况：用例会静默地测原文件而假装红过）。 */
function mutateSrc(from, to) {
  const parts = SANITIZE_SRC.split(from);
  if (parts.length !== 2) throw new Error('注入点命中 ' + (parts.length - 1) + ' 次（要求 1 次）：' + JSON.stringify(from));
  return parts.join(to);
}
const BUG1_FROM = '\n        mutated = true;\n        return;\n      }';
const BUG1_TO = '\n        return;\n      }';
const BUG2_FROM = "note('img-blocked', 'urlsBlockedByTag')";
const BUG2_TO = "note('img-blocked', 'urlsBlocked')";
const GUARD_FROM = "if (String(bucket).slice(-BUCKET_SUFFIX.length) !== BUCKET_SUFFIX) {";
const GUARD_TO = "if (false) {";

describe('判别力证明：把两处修复各自**回退成原形态** ⇒ 上面那些断言会红', () => {
  it('回退 bug①（删掉 `img` 被拦分支的 `mutated = true`）⇒ 隔离单图 changed 掉回 false、占位消失', () => {
    const buggy = loadSanitize({ src: mutateSrc(BUG1_FROM, BUG1_TO) });
    buggy.S.resetState();
    const r = buggy.S.sanitize(ONLY_HTTP_IMG);
    expect(r.changed, '回退形态下 changed 必须是 false —— 这正是"占位被丢弃"的机制').toBe(false);
    const dc = new MiniDocument().createElement('div');
    const inj = buggy.S.inject(dc, ONLY_HTTP_IMG);
    expect(inj.changed).toBe(false);
    expect(dc.querySelectorAll('.fd-img-blocked').length, '回退形态下占位进不了 DOM').toBe(0);
    expect(dc.querySelectorAll('img').length, '回退形态下注入的是**原始字节**（活图回来了）').toBe(1);
    expect(inj.injected, '注入的就是原始字节（占位被整段丢弃）').toBe(ONLY_HTTP_IMG);
  });

  it('回退 bug②（桶名改回 `urlsBlocked`、并把运行期守卫关掉）⇒ 第 2 次调用 TypeError（历史原形）', () => {
    const buggy = loadSanitize({ src: mutateSrc(GUARD_FROM, GUARD_TO).split(BUG2_FROM).join(BUG2_TO) });
    buggy.S.resetState();
    const doc = new MiniDocument();
    expect(() => buggy.S.inject(doc.createElement('div'), HTTP_A), '第 1 次不抛').not.toThrow();
    expect(typeof buggy.S.state().urlsBlocked, '第 1 次之后计数器被污染成字符串').toBe('string');
    expect(buggy.S.state().urlsBlocked).toBe('[object Object]1');
    expect(() => buggy.S.inject(doc.createElement('div'), HTTP_B), '第 2 次必须是 TypeError')
      .toThrow(/Cannot create property 'img-blocked' on string/);
  });

  it('只回退 bug②的桶名（守卫还在）⇒ **当场**抛出并点名（不等到下一次）', () => {
    const buggy = loadSanitize({ src: mutateSrc(BUG2_FROM, BUG2_TO) });
    buggy.S.resetState();
    expect(() => buggy.S.sanitize(HTTP_A)).toThrow(/第二参必须是明细桶名.*urlsBlocked/);
  });

  it('结构断言对回退形态**必须报红**（同一个判法函数，正反两侧共用）', () => {
    const healthy = bucketOffenders(SANITIZE_SRC);
    expect(healthy.badSuffix.length, '健康源码上结构断言不许自己红').toBe(0);
    expect(healthy.counters.length).toBe(0);
    const buggy = bucketOffenders(mutateSrc(BUG2_FROM, BUG2_TO));
    expect(buggy.badSuffix.length, '回退形态必须被后缀规则抓到').toBe(1);
    expect(buggy.badSuffix[0].raw).toContain("'urlsBlocked'");
    expect(buggy.counters.length, '回退形态必须被"计数器当桶"规则抓到').toBe(1);
  });

  it('注入点必须命中（否则上面三条判别力证明会静默失效）', () => {
    expect(() => mutateSrc('这段源码里不存在的一段', 'x')).toThrow(/要求 1 次/);
  });
});

/* ---------------------------------------------------------------------------
 * 其余契约（防止本批的修法把别的东西改坏）
 * ------------------------------------------------------------------------- */

describe('消毒的其余契约（防止本批的修法把别的东西改坏）', () => {
  it('文档级标签进 head ⇒ report.head 且 changed === true（否则 meta refresh 会"活着"回来）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize('<meta http-equiv="refresh" content="0;url=https://example.invalid/">');
    expect(r.report.head).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.html).not.toMatch(/meta/i);
    expect(S.state().headDropped).toBe(1);
  });

  it('`<body onload=…>` 这类**文档级属性** ⇒ report.docAttrs 且 changed === true', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize('<body onload="window.__pwned=1"><p>正文</p></body>');
    expect(r.report.docAttrs).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.html).not.toMatch(/onload/i);
    expect(r.html).toContain('正文');
  });

  it('整棵子树删的一族（style/iframe/script/svg/form）一个都不留，但**文字保留**', () => {
    const { S } = loadSanitize();
    S.resetState();
    const evil = '<p>前置段落</p>'
      + '<style>body{display:none}</style><iframe src="data:text/html,x"></iframe>'
      + '<script>window.__pwned=1</script><svg onload="window.__pwned=2"><circle r="4"></circle></svg>'
      + '<form action="https://example.invalid/"><input name="x"></form><p>这段文字必须留下</p>';
    const r = S.sanitize(evil);
    expect(r.changed).toBe(true);
    ['style', 'iframe', 'script', 'svg', 'form', 'input', 'circle'].forEach((t) => {
      expect(r.html.toLowerCase(), t + ' 不许留下').not.toMatch(new RegExp('<' + t + '\\b'));
    });
    expect(r.html).toContain('这段文字必须留下');
    expect(r.report.dropped.indexOf('style') >= 0).toBe(true);
    expect(r.report.dropped.indexOf('iframe') >= 0).toBe(true);
    expect(S.state().droppedByTag['style']).toBe(1);
  });

  it('`a[href=javascript:…]` ⇒ 摘 href + 可见标记 + changed === true（文字保留）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize('<p><a href="javascript:window.__pwned=3">点我</a></p>');
    expect(r.changed).toBe(true);
    expect(r.html).toContain('fd-link-blocked');
    /* 判"没有活的 href"：原文会被写进 `title`（那是**文案**，不是可点的面）⇒ 不能拿"字面里没有
     * `javascript:`"当判据，要判的是**属性**。 */
    expect(r.html).not.toMatch(/\bhref\s*=/i);
    expect(r.html).toContain('点我');
    expect(r.report.urls.length).toBe(1);
  });

  it('注释节点被删（nodeType 8 那一支）且 changed === true；统计键是 `#8`', () => {
    const { S } = loadSanitize();
    S.resetState();
    const r = S.sanitize('<p>甲<!-- 藏起来的话 -->乙</p>');
    expect(r.changed).toBe(true);
    expect(r.html).toContain('甲');
    expect(r.html).toContain('乙');
    expect(r.html).not.toContain('藏起来的话');
    expect(S.state().droppedByTag['#8']).toBe(1);
  });

  it('**干净输入** ⇒ changed === false，且 `inject` 注入的是**原始字节**（默认档逐字节不变的保证）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const clean = '<h3>标题</h3><p>正文 <strong>粗体</strong></p>';
    const r = S.sanitize(clean);
    expect(r.changed).toBe(false);
    const dc = new MiniDocument().createElement('div');
    const inj = S.inject(dc, clean);
    expect(inj.changed).toBe(false);
    expect(inj.injected).toBe(clean);
    expect(S.state().changed).toBe(0);
  });

  it('空输入 / null / undefined 不抛，且 changed === false', () => {
    const { S } = loadSanitize();
    S.resetState();
    expect(S.sanitize('').changed).toBe(false);
    expect(S.sanitize(null).changed).toBe(false);
    expect(S.sanitize(undefined).changed).toBe(false);
    expect(S.inject(new MiniDocument().createElement('div'), null).injected).toBe('');
  });

  it('白名单内的标签原样留着（消毒不是"清空"）', () => {
    const { S } = loadSanitize();
    S.resetState();
    const keep = '<h2>二</h2><details><summary>折</summary><p>内</p></details>'
      + '<table><tbody><tr><td>格</td></tr></tbody></table>';
    const r = S.sanitize(keep);
    expect(r.changed).toBe(false);
    expect(r.html).toBe(keep);
  });
});
