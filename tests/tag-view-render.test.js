/* ============================================================
 * tests/tag-view-render.test.js — 标签视图的**渲染层接线**（vitest · 无 Electron）
 * ------------------------------------------------------------
 * 为什么有这个文件（而不是只靠冒烟域 54）：
 *   本批按 `R7` **不许跑 `npm run smoke`** ⇒ 冒烟域 54 的 6 条断言是"已写、未执行"。
 *   而"渲染层到底接得对不对"这件事，有一半**不需要真 Electron**：选择器有没有命中、
 *   类有没有落在正确的节点上、面板计数/标题/成员条是否与派生结果同源、Esc 有没有清干净、
 *   成员条点击是否走 `MM.jumpToNode`、`fitToNodes` 有没有被喂到成员 id —— 这些用**手写的最小 DOM 桩**
 *   就能真跑。剩下一半（几何、遮挡、真帧）只能在真窗口里判，留给冒烟域 54。
 *
 * 桩的边界（如实写）：`renderer/app-tag-view.js` 在浏览器里拿到的 `window / document /
 *   requestAnimationFrame` 由本文件替换成桩；jsMind 的节点元素也是桩（`getAttribute('nodeid')`
 *   + `classList`）。所以本文件证明的是**本模块自己的接线**，不证明 jsMind 的真实行为、
 *   也不证明任何几何 —— 那两条只有 `scripts/smoke/54-标签视图.js` 能判。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tree from '../src/tree-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'renderer', 'app-tag-view.js'), 'utf8');

/** 一棵小树（节点带 tags；`work` 用的就是它） */
function mkTree() {
  return {
    id: 'root', topic: '根', children: [
      { id: 'a', topic: 'A 节点', tags: ['工具', '调试'], children: [
        { id: 'b', topic: 'B 节点', tags: ['工具'], children: [] }
      ] },
      { id: 'c', topic: 'C 节点', children: [
        { id: 'd', topic: 'D 节点', tags: ['工作工具'], children: [] }
      ] },
      { id: 'e', topic: 'E 节点', tags: ['工具'], children: [] }
    ]
  };
}

/** 最小元素桩：够 app-tag-view.js 用（属性表 / style / 子选择器 / 监听 / innerHTML） */
function mkEl(id) {
  const el = {
    id, attrs: {}, style: {}, textContent: '', innerHTML: '',
    offsetTop: 46, offsetHeight: 120, listeners: {}, kids: {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    querySelector(sel) { return el.kids[sel] || null; },
    fire(t, ev) { (el.listeners[t] || []).forEach((fn) => fn(ev || {})); }
  };
  return el;
}

/** jsMind 节点元素桩：真实模块只读两样东西 —— `nodeid` 属性与 classList */
function mkNodeEl(id) {
  const cls = new Set();
  const el = {
    id, cls,
    getAttribute(k) { return k === 'nodeid' ? id : null; },
    classList: {
      toggle(c, on) { if (on) cls.add(c); else cls.delete(c); },
      add(c) { cls.add(c); },
      // ⚠️ 真实 DOM 的 `classList.remove(...tokens)` 是**多参**的（`remove(A, B)` 两个都去）。
      //    桩写成单参会让"Esc 清两类类名"看起来没清干净 —— 本桩第一版就是这样，测试当场抓到。
      remove(...cs) { cs.forEach((c) => cls.delete(c)); },
      contains(c) { return cls.has(c); }
    }
  };
  return el;
}

/** 装一次真实的渲染层模块（每次都是全新闭包 ⇒ 模块级状态不互相污染） */
function mount() {
  const nodes = tree.flatten(mkTree()).map((n) => mkNodeEl(n.id));
  const panelEl = mkEl('tag-view-panel');
  ['#tag-view-title', '#tag-view-count', '#tag-view-body', '#tag-view-close', '#tag-view-search']
    .forEach((sel) => { panelEl.kids[sel] = mkEl(sel); });
  const searchBox = mkEl('search-box');
  const doc = {
    listeners: {},
    getElementById(id) {
      if (id === 'tag-view-panel') return panelEl.style.display === 'none' || panelEl.style.display ? panelEl : panelEl;
      if (id === 'search-box') return searchBox;
      return null;
    },
    addEventListener(t, fn) { (doc.listeners[t] = doc.listeners[t] || []).push(fn); },
    fire(t, ev) { (doc.listeners[t] || []).forEach((fn) => fn(ev)); }
  };
  const win = { MMTree: tree, MM: {} };
  const calls = { fit: [], jump: [], search: [], status: [] };
  const MM = win.MM;
  MM.getState = () => ({ project: { name: 'p' }, jm: {} });
  MM.serializeTree = () => ({ meta: {}, format: 'node_tree', data: mkTree() });
  MM.fdPanel = () => ({ querySelectorAll: () => nodes });
  MM.fitToNodes = (ids, inset) => { calls.fit.push({ ids: ids.slice(), inset }); return { s: 1 }; };
  MM.expandAncestors = () => {};
  MM.jumpToNode = (id) => calls.jump.push(id);
  MM.runSearch = (kw) => calls.search.push(kw);
  MM.setStatus = (t, isErr) => calls.status.push({ t, isErr: !!isErr });
  // 下一帧立即执行（只为把 rAF 里的补色跑到，测的就是"补色有没有发生"）
  const raf = (fn) => { fn(); return 1; };
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'document', 'requestAnimationFrame', SRC);
  factory(win, doc, raf);
  panelEl.style.display = 'none';
  return { MM, doc, panelEl, nodes, calls, searchBox };
}

const HIT = 'mm-tag-hit';
const DIM = 'mm-tag-dim';

describe('标签视图渲染层（TV · W9）：接线与派生', () => {
  it('成员逐 id 落在 mm-tag-hit 上、其余落 mm-tag-dim（类名不串到非成员）', () => {
    const h = mount();
    const r = h.MM.showTagView('工具');
    expect(r).toBeTruthy();
    expect(r.count).toBe(3);                                  // a / b / e
    expect(r.ids).toEqual(['a', 'b', 'e']);
    const hit = h.nodes.filter((n) => n.cls.has(HIT)).map((n) => n.id);
    const dim = h.nodes.filter((n) => n.cls.has(DIM)).map((n) => n.id);
    expect(hit).toEqual(['a', 'b', 'e']);
    expect(dim).toEqual(['root', 'c', 'd']);                  // 非成员才虚化
    expect(h.nodes.find((n) => n.id === 'd').cls.has(HIT)).toBe(false);
  });

  it('面板的三件读数与派生结果同源：标题 / 计数属性 / 成员条个数', () => {
    const h = mount();
    h.MM.showTagView('工具');
    expect(h.panelEl.getAttribute('data-tag')).toBe('工具');
    expect(h.panelEl.getAttribute('data-count')).toBe('3');
    expect(h.panelEl.style.display).toBe('flex');
    expect(h.panelEl.kids['#tag-view-title'].textContent).toBe('#工具');
    expect(h.panelEl.kids['#tag-view-count'].textContent).toBe('3 个节点');
    const body = h.panelEl.kids['#tag-view-body'].innerHTML;
    expect((body.match(/class="tv-item"/g) || []).length).toBe(3);
    // 树序（a 在 b 前、b 在 e 前）—— 清单顺序必须与导图位置一致
    expect(body.indexOf('data-node="a"')).toBeLessThan(body.indexOf('data-node="b"'));
    expect(body.indexOf('data-node="b"')).toBeLessThan(body.indexOf('data-node="e"'));
  });

  it('派生而非存清单：树里多一个带该标签的节点 ⇒ 成员自己多一个（没有任何清单被更新）', () => {
    const h = mount();
    expect(h.MM.showTagView('工具').count).toBe(3);
    // 直接改"树"（= serializeTree 的下一次返回），**不碰任何清单**
    const t = mkTree();
    t.children[1].children.push({ id: 'f', topic: 'F 节点', tags: ['工具'], children: [] });
    h.MM.serializeTree = () => ({ meta: {}, format: 'node_tree', data: t });
    const r2 = h.MM.showTagView('工具');
    expect(r2.count).toBe(4);
    // 树序（不是插入序）：a → b → **c 的子节点 f** → e
    expect(r2.ids).toEqual(['a', 'b', 'f', 'e']);
  });

  it('缩放到刚好框住：fitToNodes 收到的是**成员 id**，且带上顶部条带让位高度', () => {
    const h = mount();
    h.MM.showTagView('工具');
    expect(h.calls.fit.length).toBe(1);
    expect(h.calls.fit[0].ids).toEqual(['a', 'b', 'e']);
    // 条带 = offsetTop 46 + offsetHeight 120 + 8
    expect(h.calls.fit[0].inset).toBe(174);
  });

  it('Esc ⇒ 两类标记归零、面板收起、状态归 null（不留残影）', () => {
    const h = mount();
    h.MM.showTagView('工具');
    expect(h.MM.isTagViewActive()).toBe(true);
    h.doc.fire('keydown', { key: 'Escape' });
    expect(h.nodes.some((n) => n.cls.has(HIT) || n.cls.has(DIM))).toBe(false);
    expect(h.panelEl.style.display).toBe('none');
    expect(h.MM.isTagViewActive()).toBe(false);
    expect(h.MM.tagViewState()).toBe(null);
  });

  it('成员条点击 ⇒ 走 MM.jumpToNode（跳转的唯一实现），不自己拼跳转', () => {
    const h = mount();
    h.MM.showTagView('工具');
    h.panelEl.kids['#tag-view-body'].fire('click', {
      target: { closest: (sel) => (sel === '.tv-item[data-node]' ? { getAttribute: () => 'b' } : null) }
    });
    expect(h.calls.jump).toEqual(['b']);
  });

  it('「用搜索看」⇒ 回到改造前那条路（runSearch 收到标签名、面板先关）', () => {
    const h = mount();
    h.MM.showTagView('工具');
    h.panelEl.kids['#tag-view-search'].fire('click');
    expect(h.calls.search).toEqual(['工具']);
    expect(h.panelEl.style.display).toBe('none');
    expect(h.searchBox.value).toBe('#工具');
  });

  it('零成员的标签 ⇒ 计数 0 + 如实说明（不抛、不冒充"空视图正常"）', () => {
    const h = mount();
    const r = h.MM.showTagView('这个标签不存在');
    expect(r.count).toBe(0);
    expect(h.panelEl.getAttribute('data-count')).toBe('0');
    expect(h.panelEl.kids['#tag-view-body'].innerHTML).toContain('没有节点带这个标签');
    expect(h.nodes.some((n) => n.cls.has(HIT))).toBe(false);
  });

  it('前置不满足时**响亮**（没项目 / 空标签 / 树取不到），不静默返回空视图', () => {
    const h = mount();
    h.MM.getState = () => ({ project: null, jm: null });
    expect(h.MM.showTagView('工具')).toBe(null);
    expect(h.calls.status.some((s) => s.isErr)).toBe(true);
    const h2 = mount();
    expect(h2.MM.showTagView('   ')).toBe(null);              // 空标签
    const h3 = mount();
    h3.MM.serializeTree = () => null;
    expect(h3.MM.showTagView('工具')).toBe(null);             // 拿不到树
  });
});
