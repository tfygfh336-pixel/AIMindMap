/* ============================================================
 * tests/item-commands.test.js — 条目写原语（S2）
 * 运行：npx vitest run tests/item-commands.test.js
 * ------------------------------------------------------------
 * ## 这个文件守什么（每条都对着一个**能红**的判据）
 *   A. `item-add` 的**自动条目化**：未条目化节点上直接加条目 ⇒ 旧 detail 被解析成条目、
 *      新条目落位、detail 立刻重渲染成派生缓存（写后回读 = `renderDetail(items)` 逐字节）；
 *   B. **逐字节回放前置校验**：detail 回放不了 ⇒ **拒绝**、盘上逐字节不变（不许悄悄改写内容）；
 *   C. **语义去重**：同节点同 type 同正文 ⇒ 默认拒绝并**点名那一条**，`--force` 放行；
 *      并有**判别力证明**（用 `--no-dedup` 关掉这道闸 ⇒ 同一条断言**必红**）；
 *   D. 端到端 add → edit → remove → move → order：**每步写后回读校验**；
 *   E. 条目 id 在 edit / order / move 之后**不变**；
 *   F. `item-remove` 被引用时**默认拒绝并逐个点名**（`links[].item` / `assoc.members[].item`），
 *      显式 `--clean-links` / `--clean-assoc` 才连带清理，清理后项目仍能过数据闸门；
 *   G. `item-move`：跨节点搬运 + 两侧 detail 同时重渲染 + **一条日志 / 一个 rev**；
 *   H. `item-order`：`--ids` 不是完整排列 ⇒ 逐项点名"少了谁 / 多了谁 / 重复了谁"；
 *   I. `render-detail`：**幂等**（已一致 ⇒ `changed:0` 且盘上逐字节不变）；
 *   J. 拒绝的出口必须**指路**（item-* / migrate / links-prune / assoc-prune）；
 *   K. `--idem` 重放 ⇒ 不重复执行、回显含「幂等命中」、项目文件逐字节不变、日志只多 1 条。
 *   L. `--json` 的**报文纪律**（契约 §3）：`item-remove` 带 `--clean-*` 真清理时 stdout
 *      只许有**一份**可解析 JSON（清理结果进 `cleaned`），不再是"半截文本 + JSON"；
 *      含**结构判据**（JSON 档下 `ctx.out` 一次都没被调）与**注入证明**（见该段头注）。
 *
 * ## ⚠️ 当前读数（交付时如实登记：27 passed / 8 failed）
 * 8 条红**全部**来自两处**本流之外的**依赖，不是 S2 代码的问题（S2 自己的差异全部绿）：
 *
 *  ① **S1 的 `renderDetail` 往返契约未成立**（5 条红：S2-A ×2 / S2-B ×2 / S2-D/E ×1）
 *     直调实测（临时探针，已撤）：
 *       `parseDetail('<p>旧内容</p><ul><li>甲</li><li>乙</li></ul>')` → 3 items（解析本身**是**无损的）
 *       `renderDetail(那 3 条)` → `'<p>旧内容</p>\n<ul>…'`  ← **多插了一个 `\n`**
 *     即 `renderDetail(parseDetail(d)) !== d`，违反 `docs/ITEM-MODEL.md` §5.1 的硬约束
 *     "`renderDetail(parseDetail(detail)) === detail` 逐字节成立"。于是 `item-add` 的
 *     **逐字节回放前置校验**（本流被 F0 点名的那条）按设计把自动条目化全部拦下 ——
 *     闸在正确地工作，红的是它拦下的那份数据。**修在 S1**（`src/item-model.js`），
 *     修好后这 5 条自动转绿，本文件一个字都不用改。
 *
 *  ② **I 还没落 `WRITE_COMMANDS`**（2 条红：S2-K 两条）—— 见交付②，落地即绿。
 *
 *  另 1 条红是 S2-J 的**当前生效实现**往返断言（与 ① 同一个根因，它照实报红而不掩盖）。
 *
 * ⚠️ 也因此：本文件**当前跑在 S1 的真模块上**（`src/item-model.js` 已落地，`USING_REAL_MODEL=true`），
 *    文件顶部那份契约等价替身此刻**没有生效**（只有注入用例会短暂换上它）。
 *
 * ## ⚠️ 两个环境要点（改这个文件前先读）
 *   1) **绝不许碰真实 `projects/`**：`AI_MINDMAP_PROJECTS_DIR` 必须在 require `cli/main.js`
 *      **之前**设好 —— `cli/core.js` 的 `PROJECTS_DIR` 是**模块加载时**定型的。本文件在加载时
 *      先自证重定向生效，不生效就**当场红**（夹具写进真实项目是最坏的一类错误）。
 *   2) **不起子进程**：用进程内 `invokeSync`（与 tests/cli-options.test.js / link-caption.test.js 同口径）。
 *
 * ## ⚠️ 依赖 S1 + I（两条，都不在本流的文件所有权里 —— 见交付说明）
 *   · `src/item-model.js`（S1 的文件）**此刻可能还没落地**。本文件顶部带一份**契约等价的参照实现**
 *     （`tests` 内的替身，不落进 `src/`），通过 `cli/commands/item.js` 的 `setItemModel()` 注入；
 *     真模块一落地，`beforeAll` 里**自动切回真模块**并把同一批断言再跑一遍 ⇒ 这份替身不会变成
 *     第二套生产实现。文件末尾有一条**自证**：替身只在真模块缺席时生效。
 *   · `cli/registry.js` 的 6 条 register 由 **I** 落盘（本流只交原文）。为了让本文件**今天就能真跑**，
 *     这里在 import 时按交付原文**自注册一次**（`register()` 是 registry 的公开 API，
 *     **不改 registry.js 一个字节**）；`I` 落盘之后这步自动跳过（`registry.get` 已存在），
 *     且两处原文逐字相同（`REGISTER_LINES` 是唯一来源）。
 *
 * ## 唯一一处"今天必然红"的断言
 *   K 段要求 `WRITE_COMMANDS` 里有这六个命令名（`--idem` 的守卫在 `cli/core.js`：**只读命令/未登记
 *   命令带 `--idem` 会被响亮拒绝**）。那行归 **I** 落盘 ⇒ 落地之前 K 段按设计报红，
 *   **不是本流代码的问题**（报文里会直接说"请把 item-* 加进 cli/core.js 的 WRITE_COMMANDS"）。
 * ============================================================ */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- ① 先在临时目录上建项目根（必须在 require cli/main.js 之前） ----
 * 建目录走 `tests/_tmp-cleanup.js` 的 `makeTmp`（创建即登记），收尾只此一处（文末 `afterAll`）。 */
const SANDBOX = makeTmp('mm-s2-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');
const registry = require('../cli/registry.js');
const itemCmd = require('../cli/commands/item.js');
const changes = require('../src/changes.js');

/* 重定向必须**当场**生效：否则夹具会建进真实 `projects/`。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效（cli/core.js 已被更早加载）：PROJECTS_DIR='
    + core.PROJECTS_DIR + ' 期望=' + SANDBOX + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

/* ============================================================================
 * ② 交付给 I 的 registry 原文（**唯一来源**：既是注册用的常量，也是交付②的内容）
 * ==========================================================================
 * ⚠️ 用法串与 `options` 必须一一对上（`tests/cli-options.test.js` 机械核对）。
 * ========================================================================== */
const REGISTER_LINES = [
  {
    name: 'item-add',
    usage: 'item-add <项目> <节点id> --md "Markdown" | --html "HTML" [--src 出处] [--tags a,b] '
      + '[--type text|rich] [--after itemId | --before itemId] [--force]',
    options: ['md', 'html', 'src', 'tags', 'type', 'after', 'before', 'force'],
    // `--no-dedup` = **测试用的注入开关**（关掉语义去重，用来证明那道闸真的在拦）。
    // 按 registry 的既有约定放 `compatOptions`：**照旧可用但不写进 usage**
    // （与 `read --detail` 同一待遇 —— 它不该出现在任何人的用法提示里）。
    compatOptions: ['noDedup'],
    desc: '新增**一条**条目（改一条不必重写整块 detail）。未条目化的节点会**自动条目化**'
      + '（先把旧 detail 解析成条目，**且必须能逐字节回放**才动它）。'
      + '--md 转 Markdown、--html 原样存（表格/代码块要用 --html）；同 type 同正文默认拒绝并点名，--force 放行',
    fn: itemCmd.itemAdd
  },
  {
    name: 'item-edit',
    usage: 'item-edit <项目> <节点id> <itemId> [--md "Markdown" | --html "HTML"] [--src 出处 | --clear-src] '
      + '[--tags a,b | --clear-tags] [--type text|rich] [--verified --how "怎么核的" | --clear-verified]',
    options: ['md', 'html', 'src', 'clearSrc', 'tags', 'clearTags', 'type', 'verified', 'how', 'clearVerified'],
    desc: '改写**一条**条目（只动指定字段，回显**真的变了的字段名**）。'
      + '--verified 必须同时给 --how（核验是三字段全必填的记录：at/by/how）',
    fn: itemCmd.itemEdit
  },
  {
    name: 'item-remove',
    usage: 'item-remove <项目> <节点id> <itemId> [--clean-links] [--clean-assoc]',
    options: ['cleanLinks', 'cleanAssoc'],
    desc: '删除**一条**条目。被 links[].item / assoc.members[].item 引用时**默认拒绝并逐个点名**，'
      + '显式 --clean-links / --clean-assoc 才连带清理（不许静默删出悬挂引用）',
    fn: itemCmd.itemRemove
  },
  {
    name: 'item-move',
    usage: 'item-move <项目> <节点id> <itemId> --to 目标节点id [--after itemId | --before itemId]',
    options: ['to', 'after', 'before'],
    desc: '把一条条目移到**另一个节点**（一次原子写同时重渲染两侧 detail）。'
      + '目标节点必须已条目化；只调顺序请用 item-order',
    fn: itemCmd.itemMove
  },
  {
    name: 'item-order',
    usage: 'item-order <项目> <节点id> --ids i-a,i-b,…',
    options: ['ids'],
    desc: '重排条目顺序（--ids 必须是该节点现有条目的**完整排列**；只重排、不增删）',
    fn: itemCmd.itemOrder
  },
  {
    name: 'render-detail',
    usage: 'render-detail <项目> <节点id> | --all',
    options: ['all'],
    desc: '按 items 重新渲染 detail（**G2 判"detail 与 items 不一致"时的唯一修法**）。'
      + '幂等：已一致 ⇒ 实际变化 0。只处理条目化节点（没有 items 的节点 detail 是真源，不碰）',
    fn: itemCmd.renderDetail
  }
];

/* `I` 未落盘时按原文自注册（用 registry 的公开 API，不改 registry.js）；
 * `I` 落盘之后 `registry.get` 已有 ⇒ 跳过，两处原文逐字相同故不会漂移。 */
REGISTER_LINES.forEach((e) => { if (!registry.get(e.name)) registry.register(e); });

/** 我这一批命令名（`WRITE_COMMANDS` 要加的就是这六个） */
const ITEM_COMMANDS = REGISTER_LINES.map((e) => e.name);

/* ============================================================================
 * ③ 参照实现：`src/item-model.js` 的**契约等价**替身（只在真模块缺席时生效）
 * ==========================================================================
 * 它只实现 `docs/ITEM-MODEL.md` §5.1 冻结的四个签名，且**逐字节回放**这条硬约束是它的设计骨架
 * （切块时保留原文，渲染就是拼接 ⇒ `renderDetail(parseDetail(d)) === d` 对合法输入必然成立）。
 * ⚠️ 它是**测试替身**，不是第二套生产实现：真模块一落地就自动被换掉（见末尾自证段）。
 * ========================================================================== */

/** 顶层块标签（会独立成条的富内容） */
const BLOCK_TAGS = ['p', 'div', 'section', 'ul', 'ol', 'table', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'figure', 'dl', 'li'];

/** 契约要求 `newItemId()` 只产候选；**唯一性由调用方在全项目 id 集合里查重**（ITEM-MODEL §5.1） */
let idSeq = 0;
function refNewItemId() {
  idSeq++;
  return 'i-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + '-' + idSeq;
}

/** 标签 → "同名"的判定键：`<p id="a">` 与 `<p data-id="b">` 是**不同**的 name ⇒ 不是同一个块 */
const idKeyOf = (tag, attr) => tag + ':' + (attr === null ? '' : attr);
/** 从一段属性文本里取 `id`（没有 = `null`） */
const ID_ATTR_RE = /(?:^|\s)id\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
function idAttrOf(attrs) {
  const a = ID_ATTR_RE.exec(attrs || '');
  if (!a) return null;
  const v = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : a[4]);
  return v === undefined ? null : v;
}

/**
 * 把 HTML 切成**顶层块**（保序、**保留原文**）。
 *
 * 两条硬要求决定了它不能是一条正则：
 *   ① `<li>甲</li><li>乙</li>` 必须是**两个**块（贪婪正则会把乙吞进甲）；
 *   ② 回放要**逐字节**相等 ⇒ 块与块之间的**结构外壳**（`<ul>` / `</ul>` / 缩进空白）不能丢。
 *
 * 于是：外壳（`<ul>` 的开 / 闭标签、以及它们之间的空白）各自作为 `rich` 块保留，
 * 内部的**直接子项**（`<li>`）作为独立块 —— 这一条正是"`<li>` ⇒ `text`，其余顶层块 ⇒ `rich`"
 * 的可操作口径（ITEM-MODEL §5.1）。
 */
const WRAPPER_TAGS = ['ul', 'ol', 'dl'];
const ITEM_TAGS = ['li', 'dt', 'dd'];

function splitTopBlocks(s) {
  const nameAlt = BLOCK_TAGS.join('|');
  const openRe = new RegExp('<(' + nameAlt + ')\\b([^>]*?)(/?)>', 'i');
  const tagRe = new RegExp('</?(' + nameAlt + ')\\b([^>]*?)(/?)>', 'gi');
  const out = [];
  const push = (text, type) => { if (text !== '') out.push({ text: text, type: type }); };

  /**
   * 扫容器：`from` = 其开标签之后的偏移；返回配对闭标签的**位置区间**
   * `{ innerEnd, end }`（innerEnd = 闭标签起点，end = 闭标签之后）。
   */
  function scan(from, key) {
    let cur = from;
    let depth = 1;
    for (;;) {
      tagRe.lastIndex = cur;                      // 显式给位置：绝不依赖遗留的 lastIndex
      const t = tagRe.exec(s);
      if (!t) break;
      const tn = t[1].toLowerCase();
      if (idKeyOf(tn, idAttrOf(t[2])) === key) {
        if (t[0].charAt(1) === '/') {
          depth--;
          if (depth === 0) return { innerEnd: t.index, end: tagRe.lastIndex };
        } else if (t[3] !== '/' && tn !== 'hr') {
          depth++;
        }
      }
      cur = tagRe.lastIndex;
    }
    throw new Error('顶层块没有配对的闭标签（截断的 HTML？）：' + s.slice(from, from + 40));
  }

  /**
   * 产出 `[from, to)` 区间里的块。`gap`（父容器的**闭合标签**等外壳缝隙）
   * 必须**原样保留**，否则回放不可能逐字节相等。
   *
   * 每次只用 `openRe` 找**下一个开标签**，于是"下一个块的起点 / 前一段空白"都有唯一答案。
   */
  function feed(from, to, gap) {
    if (gap) { push(s.slice(from, to), 'rich'); return; }
    let cur = from;
    for (;;) {
      openRe.lastIndex = 0;
      const chunk = s.slice(cur, to);
      const mt = openRe.exec(chunk);
      if (!mt) break;
      const start = cur + mt.index;
      const name = mt[1].toLowerCase();
      const key = idKeyOf(name, idAttrOf(mt[2]));
      const selfClosed = mt[3] === '/' || name === 'hr';
      const close = selfClosed ? start + mt[0].length : scan(start + mt[0].length, key).end;
      push(s.slice(cur, start), 'rich');                   // 前面的空白：保留（回放要逐字节）
      if (!selfClosed && WRAPPER_TAGS.indexOf(name) >= 0) {
        const inner = scan(start + mt[0].length, key).innerEnd;
        push(s.slice(start, start + mt[0].length), 'rich'); // 开标签：原样保留
        feed(start + mt[0].length, inner, false);           // 直接子项各自成块
        push(s.slice(inner, close), 'rich');                // 闭标签 + 子项间隙：原样保留
      } else {
        push(s.slice(start, close), name === 'li' ? 'text' : 'rich');   // 整段原文（含闭合标签）
      }
      cur = close;
    }
    push(s.slice(cur, to), 'rich');
  }

  feed(0, s.length, false);
  // 纯空白的 "富内容块" 不是条目（否则会生出空条目）：那只是排版，不是知识
  return out.filter((b) => b.type === 'text' || b.text.trim() !== '');
}

function refParseDetail(html, opts) {
  const o = opts || {};
  const s = (html === undefined || html === null) ? '' : String(html);
  return splitTopBlocks(s).map((b) => {
    const it = { id: refNewItemId(), type: b.type, html: b.text };
    if (o.src !== undefined) it.src = o.src;
    if (o.tags !== undefined) it.tags = o.tags;
    if (o.at !== undefined) it.at = o.at;
    if (o.by !== undefined) it.by = o.by;
    return it;
  });
}

function refRenderDetail(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map((it) => {
    if (it && it.type === 'qa') {
      // 真实现必须调 src/qa.js 的 appendHtml（契约 §5.1）；替身只需要"非空且稳定"。
      const q = it.qa || {};
      return '<div class="qa"><p>' + String(q.q || '') + '</p><p>' + String(q.a || '') + '</p></div>';
    }
    return (it && typeof it.html === 'string') ? it.html : '';
  }).join('');
}

function refValidateItems(items) {
  const errors = [];
  if (!Array.isArray(items)) return ['items 必须是数组'];
  const seen = new Set();
  items.forEach((it, i) => {
    const at = 'items[' + i + ']';
    if (!it || typeof it !== 'object' || Array.isArray(it)) { errors.push(at + ' 不是对象'); return; }
    if (typeof it.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(it.id)) {
      errors.push(at + '.id 不合规范（小写字母/数字/连字符）' + (it.id === undefined ? '：缺失' : '：' + it.id));
    } else if (seen.has(it.id)) errors.push(at + '.id 节点内重复: ' + it.id);
    else seen.add(it.id);
    if (it.type !== 'text' && it.type !== 'rich' && it.type !== 'qa') {
      errors.push(at + '.type 取值非法: ' + JSON.stringify(it.type));
    }
    if (it.type === 'qa') {
      if (it.html !== undefined) errors.push(at + '.html 与 type:qa 互斥');
      if (!it.qa || typeof it.qa !== 'object') errors.push(at + '.qa 缺失（type:qa 必填）');
    } else if (typeof it.html !== 'string') errors.push(at + '.html 必须是字符串');
    if (it.verified !== undefined) {
      const v = it.verified;
      if (!v || typeof v !== 'object') errors.push(at + '.verified 必须是对象');
      else ['at', 'by', 'how'].forEach((k) => {
        if (typeof v[k] !== 'string' || !v[k].trim()) errors.push(at + '.verified.' + k + ' 必填');
      });
    }
  });
  return errors;
}

const REF_MODEL = {
  parseDetail: refParseDetail,
  renderDetail: refRenderDetail,
  validateItems: refValidateItems,
  newItemId: refNewItemId
};

/**
 * "**有损**"模型：只做一件事 —— 把标签之间的空白吃掉（`>\s+<` → `><`）。
 * 它是 S2-B 两段的**注入夹具**（不是第二套生产实现）：用来**可复现**地造出"回放不了"这一档，
 * 好证明"逐字节回放前置校验"那道闸真的在拦（闸本身在 `cli/commands/item.js` 的 `itemizeNode`）。
 * ⚠️ 它只在**含跨标签空白**的 detail 上才有损 ⇒ S2-B 的夹具必须带空白（见那一段的注释）。
 * ⚠️ 两段共用同一份构造（别各写一份）：两处"有损"口径漂移会让"必拒/必放行"这对判据失效。
 */
const LOSSY_MODEL = {
  newItemId: REF_MODEL.newItemId,
  validateItems: REF_MODEL.validateItems,
  parseDetail: (html, opts) => REF_MODEL.parseDetail(String(html).replace(/>\s+</g, '><'), opts),
  renderDetail: REF_MODEL.renderDetail
};

/** 真模块在不在（决定用哪一份实现；末尾有一条自证断言钉住这个判定） */
let USING_REAL_MODEL = false;
/** 当前该用的那份实现：真模块在就用真的，不在就用参照替身 */
function liveModel() { return USING_REAL_MODEL ? require('../src/item-model.js') : REF_MODEL; }
/** 还原成"当前该用的那一份"（注入替身之后**必须**还原，否则后面的用例全被污染） */
function restoreModel() { itemCmd.setItemModel(USING_REAL_MODEL ? null : REF_MODEL); }
function modelPath() { return path.resolve(__dirname, '..', 'src', 'item-model.js'); }

beforeAll(() => {
  if (fs.existsSync(modelPath())) {
    USING_REAL_MODEL = true;                       // S1 已落地 ⇒ 用真的
  } else {
    itemCmd.setItemModel(REF_MODEL);               // S1 未落地 ⇒ 注入契约等价替身
  }
  // 沙箱自证：本文件全部写操作落在临时目录
  expect(path.resolve(core.PROJECTS_DIR)).toBe(path.resolve(SANDBOX));
});

afterAll(() => {
  itemCmd.setItemModel(null);
  /* 收尾只此一处：删掉**所有**登记过的临时根（含将来新加的）。 */
  cleanupAll();
});

/* ============================================================================
 * ④ 夹具与工具
 * ========================================================================== */
const P = 'it-s2-probe';
/** 各段用自己的节点（互不干扰；顺序无关也能单跑） */
const N_AUTO = 'it-s2-auto';     // A：自动条目化
const N_RICH = 'it-s2-rich';     // A：富文本节点（必须拒绝）
const N_BAD = 'it-s2-bad';       // B：detail 回放不了（必须拒绝）
const N_DEDUP = 'it-s2-dedup';   // C：语义去重
const N_CHAIN = 'it-s2-chain';   // D/E/H：端到端
const N_MOVE = 'it-s2-move';     // G：搬运目标
const N_REF = 'it-s2-ref';       // F：被引用的条目
const N_LINKER = 'it-s2-linker'; // F：引用者
const N_RD = 'it-s2-rd';         // I：render-detail

const projFile = (name) => path.join(SANDBOX, name, name + '.json');
const readBytes = (name) => fs.readFileSync(projFile(name));      // Buffer：**逐字节**判据
const readJson = (name) => JSON.parse(fs.readFileSync(projFile(name), 'utf8').replace(/^\uFEFF/, ''));
const journal = (name) => changes.parseLog(fs.readFileSync(path.join(SANDBOX, name, '.changes.jsonl'), 'utf8')).entries;

/** 跑一条命令（进程内同步）：返回 { code, out }（stdout+stderr 合并，与集成脚本同口径） */
function run(...args) {
  const r = invokeSync(args);
  return { code: r.code, out: (r.stdout + r.stderr).trim() };
}

/** 取节点（**读盘真值**，不是命令回显） */
function nodeOf(id, name) {
  const d = readJson(name || P);
  return (function walk(n) {
    if (!n) return null;
    if (n.id === id) return n;
    for (const c of (n.children || [])) { const r = walk(c); if (r) return r; }
    return null;
  })(d.data);
}
const itemsOf = (id, name) => (nodeOf(id, name) || {}).items || [];
const idsOf = (id, name) => itemsOf(id, name).map((x) => x.id);

/** 用**同一个渲染实现**回放盘上的 items —— 这是"写后回读校验"的唯一判据 */
function renderOf(items) {
  const M = USING_REAL_MODEL ? require('../src/item-model.js') : REF_MODEL;
  return M.renderDetail(items);
}

/** 从回显里抠出条目 id（写命令的回显必须点名 itemId —— 契约 §3 通用约定） */
function itemIdFrom(out) {
  const m = /(i-[a-z0-9-]+)/.exec(out);
  return m ? m[1] : null;
}

beforeAll(() => {
  expect(run('init', P, '--title', 'S2 条目写原语探针').code).toBe(0);
});

/* ============================================================================
 * A. item-add：未条目化节点**自动条目化** + 前置校验
 * ========================================================================== */
describe('S2-A item-add：参数 / 自动条目化 / 前置校验', () => {
  it('--md 与 --html 两个正文选项：都没给 ⇒ 拒绝并说清两个选项；都给 ⇒ 拒绝', () => {
    expect(run('add', P, 'root', '--id', N_AUTO, '--topic', 'S2 自动条目化', '--detail', '<p>旧内容</p><ul><li>甲</li><li>乙</li></ul>').code).toBe(0);
    const none = run('item-add', P, N_AUTO);
    expect(none.code).not.toBe(0);
    expect(none.out).toContain('--md');
    expect(none.out).toContain('--html');
    const both = run('item-add', P, N_AUTO, '--md', '甲', '--html', '<p>甲</p>');
    expect(both.code).not.toBe(0);
    expect(both.out).toContain('不能同时给');
    expect(nodeOf(N_AUTO).items).toBeUndefined();      // 两次拒绝 ⇒ 一个字节都没写
    expect(nodeOf(N_AUTO).detail).toBe('<p>旧内容</p><ul><li>甲</li><li>乙</li></ul>');
  });

  it('未条目化节点 ⇒ **自动条目化**：旧 detail 变成条目、新条目落位、detail 立刻重渲染', () => {
    const r = run('item-add', P, N_AUTO, '--html', '<p>新加的一条</p>', '--src', 'CHANGELOG.md:1-2', '--tags', '门禁,检索');
    expect(r.code).toBe(0);
    const n = nodeOf(N_AUTO);
    expect(Array.isArray(n.items)).toBe(true);
    // 旧 detail 的三个顶层块（<p> + 两个 <li>）都进了条目层，顺序保持；第 4 条是本次新加的
    // （没给 --type ⇒ 默认类型）。
    // ⚠️ **判据修正（2026-10-11）**：原文期望第 4 条是 `'rich'` —— 错的，且与本文件 S2-C 互斥：
    //    S2-C 的「换个正文 / 换个 type 都照常放行」要求
    //      `item-add --html '<p>同一段内容</p>' --type rich` **成功**（判据 = type + 正文两项）。
    //    若"不给 --type"的默认是 rich，那一条就与本节点已有的同正文条目语义重复 ⇒ 必被去重闸拦下
    //    ⇒ S2-C 必红。两份断言只能有一份对：`docs/ITEM-MODEL.md` §1 的字段表把 `type` 的默认值
    //    冻结为 `text`，故这里是 'text'。
    //    （新条目的 type 由 `cli/commands/item.js` 决定，模型不参与 —— 模型只决定旧 detail 那三条。）
    expect(n.items.map((x) => x.type)).toEqual(['rich', 'text', 'text', 'text']);
    expect(n.items[1].html).toBe('<li>甲</li>');
    expect(n.items[2].html).toBe('<li>乙</li>');
    // 新条目的字段
    const fresh = n.items[n.items.length - 1];
    expect(fresh.html).toBe('<p>新加的一条</p>');
    expect(fresh.src).toBe('CHANGELOG.md:1-2');
    expect(fresh.tags).toEqual(['门禁', '检索']);
    expect(fresh.by).toBe('cli:item-add');                   // 与 .changes.jsonl 的 writer 同源
    expect(typeof fresh.at).toBe('string');
    // 回显点名 itemId + 条数
    expect(r.out).toContain('已添加条目 ' + fresh.id);
    expect(r.out).toContain('共 4 条');
    // **写后回读校验**：detail 是派生缓存，必须逐字节等于 renderDetail(items)
    expect(renderOf(n.items)).toBe(n.detail);
  });

  it('--before / --after 只在**同一节点内**定位；锚点不在该节点 ⇒ 拒绝并列出可用条目', () => {
    const ids = idsOf(N_AUTO);
    const anchor = ids[1];
    const b = run('item-add', P, N_AUTO, '--html', '<p>插到甲前面</p>', '--before', anchor);
    expect(b.code).toBe(0);
    expect(idsOf(N_AUTO)[1]).toBe(itemIdFrom(b.out));        // 新条目正好插在锚点**之前**
    const a = run('item-add', P, N_AUTO, '--html', '<p>插到甲后面</p>', '--after', anchor);
    expect(a.code).toBe(0);
    // ⚠️ **判据修正（2026-10-11）**：原文期望 index **2** —— 错的。上一行刚把新条目插在锚点
    //    **之前**，锚点因此从 1 号位挪到了 **2** 号位；`--after 锚点` = 紧跟在锚点之后 ⇒ 落在
    //    **3** 号位（这正是本行自己的注释说的"插在锚点之后"）。命中 2 号位的唯一办法是让
    //    `--after` 与 `--before` 行为完全相同 —— 那是把命令语义改错去迁就断言，不是修断言。
    //    实测（真 CLI）：[i0, 新插在前的, i1(锚点), 本条, ...] ⇒ 本条在 3 号位。
    expect(idsOf(N_AUTO)[3]).toBe(itemIdFrom(a.out));        // 插在锚点**之后**（锚点已被上一条挤到 2 号位）
    const bad = run('item-add', P, N_AUTO, '--html', '<p>x</p>', '--after', 'i-not-here-xyz');
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('i-not-here-xyz');
    expect(bad.out).toContain('不在节点');                    // 点名对象
    const both = run('item-add', P, N_AUTO, '--html', '<p>x</p>', '--before', anchor, '--after', anchor);
    expect(both.code).not.toBe(0);
    expect(both.out).toContain('不能同时给');
    expect(renderOf(nodeOf(N_AUTO).items)).toBe(nodeOf(N_AUTO).detail);
  });

  it('`--type qa` 被拒并指路 `ask-apply`；别的取值也被拒', () => {
    const qa = run('item-add', P, N_AUTO, '--html', '<p>问</p>', '--type', 'qa');
    expect(qa.code).not.toBe(0);
    expect(qa.out).toContain('ask-apply');                    // **指路**
    const bad = run('item-add', P, N_AUTO, '--html', '<p>问</p>', '--type', 'fact');
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('text');
    expect(bad.out).toContain('rich');
  });

  it('富文本节点（detailMode:rich）与条目层互斥 ⇒ 拒绝并指路 --clear-detail-mode', () => {
    expect(run('add', P, 'root', '--id', N_RICH, '--topic', 'S2 富文本节点', '--detail', '<table><tr><td>x</td></tr></table>').code).toBe(0);
    const raw = readJson(P);
    (function patch(n) { if (n.id === N_RICH) n.detailMode = 'rich'; (n.children || []).forEach(patch); })(raw.data);
    fs.writeFileSync(projFile(P), JSON.stringify(raw, null, 2));   // 直接造一个"迁移不会自动写"的显式标记
    const before = readBytes(P);
    const r = run('item-add', P, N_RICH, '--html', '<p>加一条</p>');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('富文本');
    expect(r.out).toContain('--clear-detail-mode');            // **指路**
    expect(readBytes(P).equals(before)).toBe(true);            // 盘上逐字节不变
  });
});

/* ============================================================================
 * B. 逐字节回放前置校验（自动条目化的准入闸）
 * ========================================================================== */
describe('S2-B 自动条目化的**逐字节回放前置校验**', () => {
  // ⚠️ **本段当前红，原因不在 S2 的代码**（已定位到 S1 侧，见文件头"当前读数的原因"）：
  //    `renderDetail(parseDetail(d))` 在两个相邻顶层块之间**插了一个换行** ⇒ 回放不逐字节，
  //    因此 item-add 的自动条目化闸（本段正是它的守门人）按设计全部拦下。
  //    修好那条往返契约之后，本段两条会同时转绿（"拒绝"那半会变成"放行"那半的对照）。
  it('detail 无法回放 ⇒ **拒绝**、盘上逐字节不变、指路 migrate', () => {
    // ⚠️ **判据修正（2026-10-11）**：夹具必须**含跨标签空白**，下面那份"有损注入"才真的生效。
    //    注入是 `replace(/>\s+</g, '><')`（吃掉标签之间的空白），而原先的夹具是单行无空白的一串
    //    ⇒ 那条 replace 是**空操作** ⇒ 替身照样逐字节回放成功 ⇒ item-add 必然放行 ⇒ 本段要证明的
    //    "回放不了 ⇒ 拒绝"**永远证明不了**（实测：原文 code 0；夹具加换行后 code 1 +
    //    「无法逐字节回放」+ 盘上零改动）。
    //    ⚠️ 夹具形状本身是**合规**的：契约要求嵌套列表也能逐字节回放（见文件末尾 S2-J 那条
    //    "含嵌套列表"的断言）—— 所以它只有在"被吃掉空白"之后才回放不了，正是本段要的那一档。
    const nested = '<ul>\n<li>甲<ul><li>甲1</li></ul></li>\n<li>乙</li>\n</ul>';
    expect(run('add', P, 'root', '--id', N_BAD, '--topic', 'S2 不可回放', '--detail', nested).code).toBe(0);
    // 人为把模型换成"有损"的那一档：解析时把标签之间的空白吃掉 ⇒ 回放必然不逐字节。
    // 这是**注入**：可复现地造出"回放不了"这一档，不依赖任何一份具体实现的口径差别
    // （若靠"某种怪 HTML 让某份实现回放不了"，那测的是那份实现，不是这道闸）。
    // 定义见文件顶部 `LOSSY_MODEL`（与下一段共用同一份构造）。
    itemCmd.setItemModel(LOSSY_MODEL);
    const detail = nodeOf(N_BAD).detail;
    const before = readBytes(P);
    let r;
    try {
      r = run('item-add', P, N_BAD, '--html', '<p>新条目</p>');
    } finally {
      restoreModel();
    }
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('无法逐字节回放');            // 报文必须说清拒绝的理由
    expect(r.out).toContain('migrate items');             // **指路**
    expect(readBytes(P).equals(before)).toBe(true);       // **一个字节都不动**
    expect(nodeOf(N_BAD).items).toBeUndefined();
    expect(nodeOf(N_BAD).detail).toBe(detail);
  });

  it('判别力：**同一份 detail**，模型能无损回放时就放行（证明上一段拒绝的是"回放不了"，不是"一律拒绝"）', () => {
    // 同一个节点、同一条命令、同一个 detail —— 只把模型从"有损"换成"无损"，结局必须反过来。
    // 这比"换一个节点试"严格得多：它排除了"拒绝是因为别的什么原因"。
    const detail = nodeOf(N_BAD).detail;
    // ⚠️ **判据修正（2026-10-11，两处）**：
    //  ① 原先这一半直接跑"当前生效的实现"、指望它是"有损的"（`// 当前模型仍是有损的`）——
    //     那是把"此刻恰好坏的那份实现"当判据：S1 一修好，这一句就变成要求"好实现也必拒"，
    //     而它下面那一半又要求"好实现必放行" ⇒ 同一命令/同节点/同 detail/同模型给出相反期望，
    //     任何实现都过不了。改成**显式注入**有损那一档（与上一段同一个 `LOSSY_MODEL`）：
    //     "有损 ⇒ 拒"不再依赖任何一份具体实现的状态，与下一半合起来才真正证明
    //     "拒绝的原因是回放不了，不是一律拒绝"。
    //  ② 末尾原先要求 `detail` 逐字节不变 —— 与上面两行自相矛盾：那次 item-add 是**成功**的，
    //     它必然给节点加了一条 `<p>甲</p>`，而 `detail` 是 items 的派生值
    //     （契约 §2：`detail === renderDetail(items)`）⇒ 追加一条非空条目后它**必须**变长。
    //     正确判据（也正是原文注释"内容逐字节不变，换的是表达"的本意）：
    //     **旧内容一个字节都不变**，新条目追加在末尾 ⇒ `detail + '<p>甲</p>'`。
    itemCmd.setItemModel(LOSSY_MODEL);                    // 有损那一档 ⇒ **必拒**
    let r0;
    try {
      r0 = run('item-add', P, N_BAD, '--html', '<p>甲</p>');
    } finally {
      restoreModel();
    }
    expect(r0.code).not.toBe(0);
    expect(r0.out).toContain('无法逐字节回放');            // 与上一段同一句理由（同一道闸）
    expect(nodeOf(N_BAD).items).toBeUndefined();           // 拒绝 ⇒ 没有条目层
    expect(nodeOf(N_BAD).detail).toBe(detail);             // 拒绝 ⇒ 盘上零改动
    // 换成无损（= 契约要求的那一档；真模块在场时 `liveModel()` 就是真模块）⇒ 同一条命令必须放行
    itemCmd.setItemModel(liveModel());
    let r;
    try {
      r = run('item-add', P, N_BAD, '--html', '<p>甲</p>');
    } finally {
      restoreModel();
    }
    expect(r.code).toBe(0);
    expect(Array.isArray(nodeOf(N_BAD).items)).toBe(true);
    expect(nodeOf(N_BAD).detail).toBe(detail + '<p>甲</p>');   // 旧内容逐字节不变，新条目追加在末尾
  });
});

/* ============================================================================
 * C. 语义去重（默认拒绝 + 点名 + --force）+ **判别力证明**
 * ========================================================================== */
describe('S2-C 语义去重：默认拒绝并点名，--force 放行', () => {
  it('同 type 同正文重放 ⇒ 默认拒绝、点名那一条、盘上零改动', () => {
    expect(run('add', P, 'root', '--id', N_DEDUP, '--topic', 'S2 去重').code).toBe(0);
    const first = run('item-add', P, N_DEDUP, '--html', '<p>同一段内容</p>');
    expect(first.code).toBe(0);
    const firstId = itemIdFrom(first.out);
    const mid = readBytes(P);
    const second = run('item-add', P, N_DEDUP, '--html', '<p>同一段内容</p>');   // 逐字重放
    expect(second.code).not.toBe(0);
    expect(second.out).toContain(firstId);                       // **点名是那一条**
    expect(second.out).toContain('--force');                     // 给出出路
    expect(readBytes(P).equals(mid)).toBe(true);                 // 拒绝 = 盘上零改动
    expect(itemsOf(N_DEDUP).length).toBe(1);
  });

  it('--force 放行有意重复（那是显式意图，不是手滑）', () => {
    const forced = run('item-add', P, N_DEDUP, '--html', '<p>同一段内容</p>', '--force');
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('有意重复');
    expect(itemsOf(N_DEDUP).length).toBe(2);
  });

  it('换个正文 / 换个 type 都照常放行（判据是 type + 正文两项）', () => {
    expect(run('item-add', P, N_DEDUP, '--html', '<p>另一段内容</p>').code).toBe(0);
    expect(run('item-add', P, N_DEDUP, '--html', '<p>同一段内容</p>', '--type', 'rich').code).toBe(0);
    expect(itemsOf(N_DEDUP).length).toBe(4);
  });

  it('**判别力证明**：用 `--no-dedup` 关掉这道闸 ⇒ 同一条断言**必红**', () => {
    // 去向：既然闸能关，就必须证明"关掉之后真的会重复"。两半合起来才说明：
    //   ① 上一段那次拒绝**是这道闸拦的**（不是别的原因碰巧报错）；
    //   ② 关掉之后重复**真的会落盘**（否则"拒绝"可能只是解析/校验在拦，与本段无关）。
    const n0 = itemsOf(N_DEDUP).length;
    const injected = run('item-add', P, N_DEDUP, '--html', '<p>同一段内容</p>', '--no-dedup');
    expect(injected.code).toBe(0);                               // ← **关闸即重复成立**
    expect(injected.out).toContain('已添加条目');
    const n1 = itemsOf(N_DEDUP).length;
    expect(n1).toBe(n0 + 1);
    const fp = (html) => readBytes(P).toString('utf8').split(JSON.stringify(html)).length - 1;
    expect(fp('<p>同一段内容</p>')).toBeGreaterThanOrEqual(3);   // 那条正文在盘上出现了 3 次
    // 而"闸开着"的同一条命令，盘上**一个字节都不多**：
    const mid = readBytes(P);
    const closed = run('item-add', P, N_DEDUP, '--html', '<p>同一段内容</p>');
    expect(closed.code).not.toBe(0);
    expect(readBytes(P).equals(mid)).toBe(true);
    expect(itemsOf(N_DEDUP).length).toBe(n1);
  });
});

/* ============================================================================
 * D/E. 端到端：add → edit → move → order → remove（每步写后回读）
 * ========================================================================== */
describe('S2-D/E 端到端链 + 条目 id 与其余条目逐字节不动', () => {
  it('add ×3 ⇒ edit 一条 ⇒ 其余两条**逐字节不变**、被改的那条 id 不变', () => {
    expect(run('add', P, 'root', '--id', N_CHAIN, '--topic', 'S2 端到端').code).toBe(0);
    ['甲', '乙', '丙'].forEach((t) => {
      expect(run('item-add', P, N_CHAIN, '--html', '<p>' + t + '</p>').code).toBe(0);
    });
    const ids = idsOf(N_CHAIN);
    expect(ids.length).toBe(3);
    const snapshot = JSON.stringify(itemsOf(N_CHAIN));

    const e = run('item-edit', P, N_CHAIN, ids[1], '--html', '<p>乙（改写）</p>', '--tags', '改写');
    expect(e.code).toBe(0);
    expect(e.out).toContain('已更新条目 ' + ids[1]);
    expect(e.out).toContain('html');                            // 回显**真的变了的字段名**
    expect(e.out).toContain('tags');
    const after = itemsOf(N_CHAIN);
    expect(after.map((x) => x.id)).toEqual(ids);                // **id 不变、顺序不变**
    expect(after[0]).toEqual(JSON.parse(snapshot)[0]);          // 其余两条**逐字节不变**
    expect(after[2]).toEqual(JSON.parse(snapshot)[2]);
    expect(after[1].html).toBe('<p>乙（改写）</p>');
    expect(after[1].tags).toEqual(['改写']);
    expect(after[1].by).toBe('cli:item-edit');
    // 写后回读：detail 仍是 items 的派生
    expect(renderOf(nodeOf(N_CHAIN).items)).toBe(nodeOf(N_CHAIN).detail);
  });

  it('item-edit 的其余字段：--src / --clear-src / --clear-tags / --verified --how / --clear-verified', () => {
    const id = idsOf(N_CHAIN)[0];
    expect(run('item-edit', P, N_CHAIN, id, '--src', 'CHANGELOG.md:713-717').code).toBe(0);
    let it = itemsOf(N_CHAIN).find((x) => x.id === id);
    expect(it.src).toBe('CHANGELOG.md:713-717');
    expect(run('item-edit', P, N_CHAIN, id, '--src', 'a.md:1,b.md:2').code).toBe(0);
    it = itemsOf(N_CHAIN).find((x) => x.id === id);
    expect(it.src).toEqual(['a.md:1', 'b.md:2']);               // 逗号形态 ⇒ 数组（契约允许 string|string[]）
    expect(run('item-edit', P, N_CHAIN, id, '--clear-src').code).toBe(0);
    expect(itemsOf(N_CHAIN).find((x) => x.id === id).src).toBeUndefined();

    const noHow = run('item-edit', P, N_CHAIN, id, '--verified');
    expect(noHow.code).not.toBe(0);
    expect(noHow.out).toContain('--how');                       // "取不到就不写"口径
    expect(run('item-edit', P, N_CHAIN, id, '--verified', '--how', '读了 src 指向的源码行').code).toBe(0);
    it = itemsOf(N_CHAIN).find((x) => x.id === id);
    expect(it.verified.how).toBe('读了 src 指向的源码行');
    expect(it.verified.by).toBe('cli:item-edit');
    expect(typeof it.verified.at).toBe('string');
    expect(run('item-edit', P, N_CHAIN, id, '--clear-verified').code).toBe(0);
    expect(itemsOf(N_CHAIN).find((x) => x.id === id).verified).toBeUndefined();
    // 什么都没变的重放：不要产生噪音
    const e = run('item-edit', P, N_CHAIN, id, '--html', itemsOf(N_CHAIN).find((x) => x.id === id).html);
    expect(e.code).toBe(0);
    expect(e.out).toContain('无实际变化');
  });

  it('item-edit 改**别的节点**的条目 ⇒ 拒绝并指名它实际属于哪个节点', () => {
    const foreign = idsOf(N_AUTO)[0];
    const r = run('item-edit', P, N_CHAIN, foreign, '--html', '<p>x</p>');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(foreign);
    expect(r.out).toContain(N_AUTO);                            // 指名"它在哪个节点"
  });

  it('空参数 / 不存在的节点：全部响亮拒绝', () => {
    expect(run('item-edit', P, N_CHAIN, idsOf(N_CHAIN)[0]).code).not.toBe(0);
    expect(run('item-edit', P, 'no-such-node', idsOf(N_CHAIN)[0], '--html', '<p>x</p>').out).toContain('节点不存在');
    expect(run('item-edit', P, N_CHAIN, 'i-nope', '--html', '<p>x</p>').out).toContain('条目不存在');
  });

  it('item-move：跨节点搬运 ⇒ 两侧 detail 同时重渲染、**一条日志 / 一个 rev**', () => {
    expect(run('add', P, 'root', '--id', N_MOVE, '--topic', 'S2 搬运目标').code).toBe(0);
    expect(run('item-add', P, N_MOVE, '--html', '<p>目标节点已有的一条</p>').code).toBe(0);
    const moving = idsOf(N_CHAIN)[2];
    const beforeItems = itemsOf(N_CHAIN).length;
    const n0 = journal(P).length;
    const r = run('item-move', P, N_CHAIN, moving, '--to', N_MOVE);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已移动条目 ' + moving);
    expect(r.out).toContain(N_CHAIN + ' → ' + N_MOVE);
    expect(journal(P).length).toBe(n0 + 1);                     // **一条日志**（不是两条）
    expect(itemsOf(N_CHAIN).length).toBe(beforeItems - 1);
    expect(idsOf(N_MOVE)).toContain(moving);                    // id 跨节点不变
    // 两侧 detail 都在**同一次写**里重渲染好了
    expect(renderOf(nodeOf(N_CHAIN).items)).toBe(nodeOf(N_CHAIN).detail);
    expect(renderOf(nodeOf(N_MOVE).items)).toBe(nodeOf(N_MOVE).detail);
  });

  it('item-move 的必错情形：目标不存在 / 目标未条目化（指路）/ 源=目标（指路 item-order）', () => {
    const anyItem = idsOf(N_MOVE)[0];
    expect(run('item-move', P, N_MOVE, anyItem, '--to', 'no-such-node').out).toContain('目标节点不存在');
    expect(run('add', P, 'root', '--id', 'it-s2-plain', '--topic', 'S2 未条目化节点').code).toBe(0);
    const toPlain = run('item-move', P, N_MOVE, anyItem, '--to', 'it-s2-plain');
    expect(toPlain.code).not.toBe(0);
    expect(toPlain.out).toContain('还没有条目层');
    expect(toPlain.out).toContain('item-add');                  // **指路**
    expect(toPlain.out).toContain('migrate items');
    const same = run('item-move', P, N_MOVE, anyItem, '--to', N_MOVE);
    expect(same.code).not.toBe(0);
    expect(same.out).toContain('item-order');                   // **指路**
  });

  it('item-order：--ids 必须是**完整排列**，否则逐项点名少了谁 / 多了谁 / 重复了谁', () => {
    ['一', '二', '三'].forEach((t) => { expect(run('item-add', P, N_MOVE, '--html', '<p>' + t + '</p>').code).toBe(0); });
    const ids = idsOf(N_MOVE);
    expect(ids.length).toBeGreaterThanOrEqual(4);

    const missing = run('item-order', P, N_MOVE, '--ids', ids.slice(0, ids.length - 1).join(','));
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain('少了');
    expect(missing.out).toContain(ids[ids.length - 1]);

    const extra = run('item-order', P, N_MOVE, '--ids', ids.concat('i-extra-xyz').join(','));
    expect(extra.code).not.toBe(0);
    expect(extra.out).toContain('多了');
    expect(extra.out).toContain('i-extra-xyz');

    const dup = run('item-order', P, N_MOVE, '--ids', ids.map((x, i) => (i === 1 ? ids[0] : x)).join(','));
    expect(dup.code).not.toBe(0);
    expect(dup.out).toContain('重复');
    expect(dup.out).toContain(ids[0]);

    const before = readBytes(P);
    expect(readBytes(P).equals(before)).toBe(true);             // 三次拒绝 ⇒ 盘上零改动
  });

  it('item-order 成功重排 ⇒ 顺序变了、**id 集合与内容逐字节不变**、detail 随之重渲染', () => {
    const ids = idsOf(N_MOVE);
    const rev = ids.slice().reverse();
    const snapshot = new Map(itemsOf(N_MOVE).map((x) => [x.id, JSON.stringify(x)]));
    const r = run('item-order', P, N_MOVE, '--ids', rev.join(','));
    expect(r.code).toBe(0);
    expect(r.out).toContain('已重排 ' + ids.length + ' 条');
    expect(idsOf(N_MOVE)).toEqual(rev);                          // 顺序真的变了
    itemsOf(N_MOVE).forEach((x) => {
      expect(JSON.stringify(x)).toBe(snapshot.get(x.id));        // 每条**逐字节不变**（只换了位置）
    });
    expect(renderOf(nodeOf(N_MOVE).items)).toBe(nodeOf(N_MOVE).detail);
  });

  it('item-remove：删一条 ⇒ 剩 N-1 条、id 不再出现、detail 随之重渲染', () => {
    const ids = idsOf(N_MOVE);
    const doomed = ids[ids.length - 1];
    const r = run('item-remove', P, N_MOVE, doomed);
    expect(r.code).toBe(0);
    expect(r.out).toContain('已删除条目 ' + doomed);
    expect(r.out).toContain('剩 ' + (ids.length - 1) + ' 条');
    expect(idsOf(N_MOVE)).not.toContain(doomed);
    expect(renderOf(nodeOf(N_MOVE).items)).toBe(nodeOf(N_MOVE).detail);
  });
});

/* ============================================================================
 * F. item-remove 被引用 ⇒ 默认拒绝并点名（不许静默删出悬挂引用）
 * ========================================================================== */
describe('S2-F 被引用的条目：默认拒绝 + 点名引用者 + --clean-* 才连带清理', () => {
  it('被 links[].item 引用 ⇒ 默认拒绝、点名引用者、给两条出口、盘上零改动', () => {
    expect(run('add', P, 'root', '--id', N_REF, '--topic', 'S2 被引用条目').code).toBe(0);
    expect(run('add', P, 'root', '--id', N_LINKER, '--topic', 'S2 引用者').code).toBe(0);
    const added = run('item-add', P, N_REF, '--html', '<p>被指向的那一条</p>');
    const itemId = itemIdFrom(added.out);
    // 直接造一条带 item 的链接（跨项目链接的写入归 S6，这里只造数据形状；
    // `links-prune` 的既有实现按 shape 剪枝，与谁写的无关）
    const raw = readJson(P);
    (function patch(n) {
      if (n.id === N_LINKER) n.links = [{ project: P, id: N_REF, item: itemId, caption: '指向该条目' }];
      (n.children || []).forEach(patch);
    })(raw.data);
    fs.writeFileSync(projFile(P), JSON.stringify(raw, null, 2));
    const before = readBytes(P);

    const r = run('item-remove', P, N_REF, itemId);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(itemId);                            // 点名对象
    expect(r.out).toContain('--clean-links');                   // 出口一
    expect(r.out).toContain('links-prune');                     // 出口二
    expect(r.out).toContain(N_LINKER);                          // **点名引用者**
    expect(readBytes(P).equals(before)).toBe(true);             // 拒绝 ⇒ 盘上零改动
    expect(idsOf(N_REF)).toContain(itemId);
  });

  it('显式 --clean-links ⇒ 连带剪掉引用者那条链接，项目仍能过数据闸门', () => {
    const itemId = idsOf(N_REF)[0];
    const r = run('item-remove', P, N_REF, itemId, '--clean-links');
    expect(r.code).toBe(0);
    expect(r.out).toContain('已删除条目 ' + itemId);
    expect(r.out).toContain('已同步清理链接');
    expect(idsOf(N_REF)).not.toContain(itemId);
    const linker = nodeOf(N_LINKER);
    expect(linker.links).toBeUndefined();                       // 引用被剪掉（不留空数组噪音）
    expect(run('validate', P).code).toBe(0);                    // 闸门 G2（数据面）照常过
  });

  it('被 assoc.members[].item 引用 ⇒ 默认拒绝并点名；--clean-assoc 连带清理', () => {
    const added = run('item-add', P, N_REF, '--html', '<p>被关联引用的那一条</p>');
    const itemId = itemIdFrom(added.out);
    const raw = readJson(P);
    raw.assoc = [{
      id: 'a-s2-probe', title: 'S2 关联探针',
      members: [{ project: P, id: N_REF, item: itemId }, { project: P, id: N_LINKER }]
    }];
    fs.writeFileSync(projFile(P), JSON.stringify(raw, null, 2));

    const refused = run('item-remove', P, N_REF, itemId);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('assoc');
    expect(refused.out).toContain('--clean-assoc');
    expect(refused.out).toContain('assoc-prune');
    expect(idsOf(N_REF)).toContain(itemId);

    const cleaned = run('item-remove', P, N_REF, itemId, '--clean-assoc');
    expect(cleaned.code).toBe(0);
    expect(cleaned.out).toContain('已同步清理关联');
    expect(idsOf(N_REF)).not.toContain(itemId);
    expect(nodeOf(N_REF).items.some((x) => x.id === itemId)).toBe(false);
    expect(run('validate', P).code).toBe(0);
  });
});

/* ============================================================================
 * L. `--json` 的报文纪律（契约 §3）：stdout 只许有**一份**可解析 JSON
 *
 * （放在 F 之后、不另起文件末尾：它与 F 是**同一条命令**的两面 —— F 管"默认拒绝 / 显式清理"，
 *   本段管"清理结果在 JSON 档下的形态"。文件头的清单里它登记为 **L**。）
 *
 * 缺陷（S4 实测发现）：`item-remove` 带 `--clean-links/--clean-assoc` 真清理时，先
 * `ctx.out('已同步清理链接…')` 再 `emit()` ⇒ stdout 成了"半截文本 + JSON" ⇒ 解析失败。
 * MCP 因此不敢在 `item_remove` 上透传 `--json`（`scripts/mcp-server.js` 那边留着注释）——
 * 那等于把"我清理了什么"这条事实从机器接口上抹掉。
 *
 * ⚠️ 修法**不是**"把两行 `ctx.out` 挪到 `emit()` 之后"：`ctx.out` 在 `--json` 下**照常**
 * 写 stdout（`cli/core.js` 的 `out` 不看 `args.json`）⇒ 挪位置只是把"文本 + JSON"换成
 * "JSON + 文本"，消费者**照样**解析失败。按本工程既有口径（§I 的 render-detail：
 * **文本形态说人话、JSON 形态给字段**）：文本照旧**分行**打印，JSON 把同一份结果放进
 * `cleaned` —— 信息一条不少，只是换了容器。
 *
 * 断言分三层，缺一层就只是"看起来绿"：
 *   ① 端到端：`JSON.parse(stdout)` 必须成功，且 `cleaned` 里有清理结果；
 *   ② 结构：**假 ctx 分开数两条通道** ⇒ JSON 档下 `ctx.out` 一次都没被调（谁挪回去谁红）；
 *   ③ 注入：把修复前那半截文本加回去 ⇒ 同一句 `JSON.parse` 必红（判据不是空转）。
 * ========================================================================== */
describe('S2-L `--json` 的报文纪律：清理行不许先打出去', () => {
  const NJ = 'it-s2-json-ref';        // 被引用条目所在节点
  const NL = 'it-s2-json-linker';     // 引用者（那条边挂在它上面）
  const NO = 'it-s2-json-other';      // 关联篇的第三个成员（让 assoc 剪完仍有 2 个，走 touched 档）

  const ensure = (id, topic) => {
    if (nodeOf(id)) return;
    expect(run('add', P, 'root', '--id', id, '--topic', topic).code).toBe(0);
  };
  /** 造状态：NJ 上一条新条目 + NL 上一条指向它的**条目级**链接（与 F 段同款，直接改盘造边） */
  const arm = () => {
    ensure(NJ, 'S2 JSON 被引用条目');
    ensure(NL, 'S2 JSON 引用者');
    // 先把 NJ 清空：本段任何一处红都会**跳过收尾**（假 ctx 那一段尤其），盘上可能还留着
    // 上一次那条 —— 不清掉，一处红会把后面几段连坐成"假红"（读数要能分得清主次）。
    // 顺带它也钉住"清理真的生效"（每一条都必须 exit 0）。
    itemsOf(NJ).forEach((x) => {
      expect(run('item-remove', P, NJ, x.id, '--clean-links', '--clean-assoc').code).toBe(0);
    });
    const added = run('item-add', P, NJ, '--html', '<p>JSON 档的那一条</p>');
    expect(added.code).toBe(0);
    const itemId = itemIdFrom(added.out);
    const raw = readJson(P);
    (function patch(n) {
      if (n.id === NL) n.links = [{ project: P, id: NJ, item: itemId, caption: '指向该条目' }];
      (n.children || []).forEach(patch);
    })(raw.data);
    fs.writeFileSync(projFile(P), JSON.stringify(raw, null, 2));
    return itemId;
  };
  /** 把 NL 上的边摘掉（关联篇只留 assoc 一处引用 —— 否则剪完 assoc 仍剩一条悬挂的链接边） */
  const unlink = () => {
    const raw = readJson(P);
    (function patch(n) { if (n.id === NL) delete n.links; (n.children || []).forEach(patch); })(raw.data);
    fs.writeFileSync(projFile(P), JSON.stringify(raw, null, 2));
  };

  /**
   * 假 ctx：只提供 `itemRemove` 真正用到的那几项，**把两条输出通道分开计数**。
   * 为什么值得手搭一个（house style，见 `tests/dsh-ask.test.js` 的 `outJson`）：
   * `JSON.parse` 只是间接证据；"JSON 档下 `ctx.out` **一次都没被调**"是**结构证据** ——
   * 谁把 `ctx.out` 挪回去、或漏了 `if (!ctx.args.json)` 守卫，它立刻红。
   */
  function fakeCtx(data, args) {
    const calls = { out: [], json: [], idem: undefined };
    const ctx = {
      args: args,
      projectName: P,
      PROJECTS_DIR: SANDBOX,
      error(msg) { throw new Error(msg); },
      mutate(fn) { return fn(data); },          // 只跑改动函数，**不写盘**（这一档只验通道）
      tree: {
        find(root, id) {
          return (function w(n) {
            if (!n) return null;
            if (n.id === id) return n;
            for (const c of (n.children || [])) { const r = w(c); if (r) return r; }
            return null;
          })(root);
        }
      },
      out(s) { calls.out.push(String(s)); },
      outJson(o) { calls.json.push(o); },
      setIdemResult(v) { calls.idem = v; }
    };
    return { ctx: ctx, calls: calls };
  }

  it('★`--clean-links` + `--json` ⇒ stdout 是**一份** JSON，清理结果在 `cleaned` 里', () => {
    const itemId = arm();
    const r = run('item-remove', P, NJ, itemId, '--clean-links', '--json');
    expect(r.code).toBe(0);
    expect(r.out.slice(0, 1)).toBe('{');                 // 首字符就是 `{`：前面一个文本字符都没有
    const obj = JSON.parse(r.out);                       // ← 判据本体：必须能**一次性**解析
    expect(obj.ok).toBe(true);
    expect(obj.itemId).toBe(itemId);
    expect(obj.items).toBe(0);
    // 清理结果**进了 JSON**（不是只在文本里）：机器消费者要的正是"清理了哪几条"
    expect(obj.cleaned).toBeTruthy();
    expect(obj.cleaned.links).toHaveLength(1);
    expect(obj.cleaned.links[0].node).toBe(NL);          // 点名**引用者**
    expect(obj.cleaned.links[0].target).toBe(P + '/' + NJ);
    expect(obj.cleaned.links[0].item).toBe(itemId);      // 以及**哪一层**（条目级，不是节点级）
    expect(obj.cleaned.assoc).toBeUndefined();           // 没清 assoc ⇒ 不产生噪音键
    expect(r.out).not.toContain('已同步清理链接');        // 文本形态的话不许混进来
    expect(nodeOf(NL).links).toBeUndefined();            // 边确实剪了（不是只报了个数）
    expect(run('validate', P).code).toBe(0);
  });

  it('文本形态**一个字没变**：清理话照旧分行打印（行数与措辞与修复前逐字相同）', () => {
    const itemId = arm();
    const r = run('item-remove', P, NJ, itemId, '--clean-links');
    expect(r.code).toBe(0);
    const lines = r.out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);                       // 就两行：清理行 + 收尾行
    expect(lines[0]).toBe('已同步清理链接：' + NL + ' → ' + P + '/' + NJ);
    expect(lines[1]).toBe('已删除条目 ' + itemId + '（节点 ' + NJ + '，剩 0 条）');
  });

  it('★结构判据（假 ctx 分开数两条通道）：`--json` 下 `ctx.out` **一次都没被调**', () => {
    const itemId = arm();
    const j = fakeCtx(readJson(P), {
      _: ['item-remove', NJ, itemId], json: true, cleanLinks: true, cleanAssoc: false
    });
    itemCmd.itemRemove(j.ctx);
    expect(j.calls.json).toHaveLength(1);                // JSON 通道：恰好一份对象
    expect(j.calls.out).toEqual([]);                     // ★文本通道：一次都没走
    expect(j.calls.json[0].cleaned.links).toHaveLength(1);

    // 对照组：**同一份盘上数据**换文本档 ⇒ 同一个假 ctx 必须**看得见**那两行。
    // 没有它，"out 是空数组"也可能只是探针失灵；有了它，上面那条才有判别力。
    const t = fakeCtx(readJson(P), {
      _: ['item-remove', NJ, itemId], json: false, cleanLinks: true, cleanAssoc: false
    });
    itemCmd.itemRemove(t.ctx);
    expect(t.calls.json).toEqual([]);
    expect(t.calls.out).toHaveLength(2);                 // 清理行 + 收尾行
    expect(t.calls.out[0]).toContain('已同步清理链接：');
    expect(t.calls.out[1]).toContain('已删除条目 ' + itemId);
    // 两趟都只跑了改动函数（假 ctx 不写盘）⇒ 盘上仍是"待清理"的状态
    expect(idsOf(NJ)).toContain(itemId);
    expect(nodeOf(NL).links).toHaveLength(1);
    // 收尾：假 ctx 不写盘，真跑一次把它清掉（后面两段还要用同一对节点重新造状态）
    expect(run('item-remove', P, NJ, itemId, '--clean-links').code).toBe(0);
  });

  it('`--clean-assoc` + `--json` 同款：关联清理也进 `cleaned`，stdout 仍是一份 JSON', () => {
    const itemId = arm();
    unlink();                                            // 这一篇只留 assoc 一处引用
    ensure(NO, 'S2 JSON 关联第三成员');
    const raw = readJson(P);
    raw.assoc = [{ id: 'a-s2-json', title: 'S2 JSON 关联', members: [
      { project: P, id: NJ, item: itemId }, { project: P, id: NL }, { project: P, id: NO }
    ] }];
    fs.writeFileSync(projFile(P), JSON.stringify(raw, null, 2));

    const r = run('item-remove', P, NJ, itemId, '--clean-assoc', '--json');
    expect(r.code).toBe(0);
    expect(r.out.slice(0, 1)).toBe('{');
    expect(r.out).not.toContain('已同步清理关联');         // 关联那一行文本同样不许混进来
    const obj = JSON.parse(r.out);
    expect(obj.cleaned.assoc).toBeTruthy();
    expect(obj.cleaned.assoc.touched).toHaveLength(1);    // 关联还在、只少了一个成员
    expect(obj.cleaned.assoc.touched[0]).toEqual({ id: 'a-s2-json', removed: 1 });
    expect(obj.cleaned.links).toBeUndefined();            // 没清链接 ⇒ 不产生噪音键
    expect(readJson(P).assoc[0].members).toHaveLength(2); // 真剪了成员（不是只报了个数）
    expect(run('validate', P).code).toBe(0);
  });

  it('★注入证明：把"修复前那半截文本"加回 stdout ⇒ 同一句 `JSON.parse` 必红', () => {
    const itemId = arm();
    const r = run('item-remove', P, NJ, itemId, '--clean-links', '--json');
    expect(() => JSON.parse(r.out)).not.toThrow();       // 修好后：一份完整 JSON
    // 修复前 stdout 的**实际形态**（S4 实测的那种"半截文本 + JSON"）：一行清理话 + 同一份 JSON
    const before = '已同步清理链接：' + NL + ' → ' + P + '/' + NJ + '\n';
    expect(() => JSON.parse(before + r.out)).toThrow();  // 加回去 ⇒ 必红
    expect((before + r.out).slice(0, 1)).not.toBe('{');  // 首字符判据同样抓得住它
  });
});

/* ============================================================================
 * G/I. render-detail：幂等 + 只碰条目化节点
 * ========================================================================== */
describe('S2-I render-detail：幂等、只修条目化节点', () => {
  it('注入一次不一致 ⇒ 修回；再跑一次 ⇒ **changed:0 且盘上逐字节不变**', () => {
    expect(run('add', P, 'root', '--id', N_RD, '--topic', 'S2 重建').code).toBe(0);
    expect(run('item-add', P, N_RD, '--html', '<p>甲</p>').code).toBe(0);
    expect(run('item-add', P, N_RD, '--html', '<p>乙</p>').code).toBe(0);
    // 注入不一致（模拟"人工改了一个 items 元素" ⇒ G2 会判红的那种状态）
    const raw = readJson(P);
    (function patch(n) { if (n.id === N_RD) n.detail = '<p>被注入的不一致内容</p>'; (n.children || []).forEach(patch); })(raw.data);
    fs.writeFileSync(projFile(P), JSON.stringify(raw, null, 2));

    const fixed = run('render-detail', P, N_RD, '--json');
    expect(fixed.code).toBe(0);
    const obj = JSON.parse(fixed.out);
    expect(obj.changed).toBe(1);                                // **实际变化 1**（修好了那一处）
    expect(obj.scanned).toBe(1);
    expect(nodeOf(N_RD).detail).toBe(renderOf(nodeOf(N_RD).items));

    const mid = readBytes(P);
    const again = run('render-detail', P, N_RD, '--json');
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).changed).toBe(0);              // **幂等**
    expect(readBytes(P).equals(mid)).toBe(true);                // 第二次一个字节都没写
    // `--json` 时 stdout 必须是**一份**可解析 JSON（末尾不许追加文本行）⇒ "无需重建"这句
    // 只能出现在文本形态里；JSON 形态下"无需重建"由 `changed:0` 表达。
    const text = run('render-detail', P, N_RD);
    expect(text.code).toBe(0);
    expect(text.out).toContain('无需重建');
    expect(text.out).toContain('实际变化 0');
  });

  it('--all 扫全项目；没有 items 的节点**一个字节都不碰**（它们的 detail 是真源）', () => {
    const plain = nodeOf('it-s2-plain');
    const plainDetail = plain.detail;
    const all = run('render-detail', P, '--all', '--json');
    expect(all.code).toBe(0);
    const obj = JSON.parse(all.out);
    expect(obj.scanned).toBeGreaterThan(0);                     // 项目里确实有条目化节点
    expect(nodeOf('it-s2-plain').detail).toBe(plainDetail);     // 未条目化节点不动
    expect(plain.items).toBeUndefined();
  });

  it('必错情形：缺目标 / <节点id> 与 --all 同给 / 节点不存在', () => {
    expect(run('render-detail', P).code).not.toBe(0);
    expect(run('render-detail', P, N_RD, '--all').out).toContain('不能同时给');
    expect(run('render-detail', P, 'no-such-node').out).toContain('节点不存在');
  });

  it('未条目化节点上跑它 ⇒ 明确说"不会碰"（不假装重建过）', () => {
    const r = run('render-detail', P, 'it-s2-plain', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).scanned).toBe(0);
    // JSON 形态只给结构化读数（一份可解析 JSON）；"它是真源、不碰它"这句在文本形态里
    const text = run('render-detail', P, 'it-s2-plain');
    expect(text.code).toBe(0);
    expect(text.out).toContain('不是条目化节点');
    expect(text.out).toContain('不会');
  });
});

/* ============================================================================
 * J. 守卫自检（防"绿得没意义"）
 * ========================================================================== */
describe('S2-J 守卫自检', () => {
  it('六条命令都已登记在 registry 里（否则本文件全部断言都是假绿）', () => {
    const missing = ITEM_COMMANDS.filter((n) => !registry.get(n));
    expect(missing).toEqual([]);
  });

  it('registry 的 usage ⇄ options 自洽（同 tests/cli-options.test.js 的判据）', () => {
    REGISTER_LINES.forEach((e) => {
      const camel = (t) => core.optionKey(t);
      const docs = [...e.usage.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => camel(m[0]));
      // 与 `registry.allowedOptions` 同口径：options ∪ compatOptions（后者**故意**不写进 usage）
      const allowed = (e.options || []).concat(e.compatOptions || []);
      allowed.forEach((k) => {
        if ((e.compatOptions || []).indexOf(k) >= 0) {
          expect(docs, e.name + ' 的 --' + k + ' 是 compatOptions，**不许**出现在 usage 里').not.toContain(k);
        } else {
          expect(docs, e.name + ' 的 --' + k + ' 必须出现在 usage 里').toContain(k);
        }
      });
      docs.forEach((k) => {
        expect(allowed, e.name + ' 的 usage 里的 --' + k + ' 必须被 options 接受').toContain(k);
      });
    });
  });

  it('参照实现的自证：真模块在就用真的，不在才用替身（替身不会变成第二套生产实现）', () => {
    if (USING_REAL_MODEL) {
      // S1 已落地：替身必须已经完全退场，本文件跑的是真模块
      const M = require('../src/item-model.js');
      expect(typeof M.renderDetail).toBe('function');
      expect(typeof M.parseDetail).toBe('function');
      expect(typeof M.validateItems).toBe('function');
      expect(typeof M.newItemId).toBe('function');
    } else {
      // S1 未落地：如实登记本文件此刻依赖测试替身（交付的"未核实"里也写着这一条）
      expect(typeof REF_MODEL.renderDetail).toBe('function');
    }
    expect(typeof USING_REAL_MODEL).toBe('boolean');
  });

  it('当前生效的实现守往返契约：renderDetail(parseDetail(d)) 逐字节等于 d（含富块与列表）', () => {
    // 这条**不注入**：按当前生效的那一份实现跑（现在 S1 的真模块已落地 ⇒ 跑的就是真模块）。
    const M = liveModel();
    const samples = [
      '<p>甲</p>',
      '<p>甲</p><li>乙</li>',
      '<p>旧内容</p><ul><li>甲</li><li>乙</li></ul>',            // 典型的自动条目化输入
      '<table><tr><td>a</td></tr></table><p>尾</p>',
      '<ul><li>甲</li><li>乙</li></ul><p>尾</p>',
      ''
    ];
    samples.forEach((s) => {
      const p = M.parseDetail(s);
      if (p === null) return;                                   // `null` = 该实现明确声明"切不了"
      expect(M.renderDetail(p)).toBe(s);
    });
    expect(M.renderDetail([])).toBe('');
  });

  it('参照替身自己：平衡标签一律逐字节回放（含嵌套列表），标签不闭合必须抛', () => {
    const samples = ['<p>甲</p>', '<p>旧内容</p><ul><li>甲</li><li>乙</li></ul>', ''];
    samples.forEach((s) => { expect(refRenderDetail(refParseDetail(s))).toBe(s); });
    // 嵌套列表**也要**回放：只承认"扁平列表"会漏掉真实笔记里最常见的形状之一
    const nested = '<ul><li>甲<ul><li>甲1</li></ul></li><li>乙</li></ul>';
    expect(refRenderDetail(refParseDetail(nested))).toBe(nested);
    // 真表达不了的形状**必须抛**（不许静默切坏）：标签不闭合
    expect(() => refParseDetail('<p>甲')).toThrow();
    expect(() => refParseDetail('<ul><li>甲</ul>')).toThrow();
    expect(refRenderDetail([])).toBe('');
    expect(refRenderDetail(refParseDetail('<p>x</p>'))).toBe(refRenderDetail(refParseDetail('<p>x</p>')));
  });

  it('渲染幂等：同 items 两次逐字节相同', () => {
    const items = itemsOf(N_RD);
    expect(renderOf(items)).toBe(renderOf(items));
    expect(renderOf(items)).toBe(nodeOf(N_RD).detail);
  });
});

/* ============================================================================
 * K. --idem 重放（依赖 I 把命令名加进 cli/core.js 的 WRITE_COMMANDS）
 * ==========================================================================
 * ⚠️ 这一段与本文件其它段**不同**：它依赖**别的文件**（`cli/core.js` 的 `WRITE_COMMANDS`，
 * 归 I 落盘，见交付②）。`--idem` 的守卫在 core 里 —— **没登记的命令带 `--idem` 会被响亮拒绝**，
 * 于是"幂等重放"这件事在登记之前**根本跑不到命令体**。
 * ⇒ 处理方式：**先如实登记这道依赖**（登记之前断言按设计报红，报文直接告诉你缺什么），
 *   一旦 I 落盘，下面两条自动转绿、**不需要改这个文件**。
 * ========================================================================== */
const IDEM_READY = ITEM_COMMANDS.every((n) => core.WRITE_COMMANDS.indexOf(n) >= 0);

describe('S2-K --idem 重放：不重复执行 + 数据逐字节不变', () => {
  it('--idem 已对 item-* 生效（WRITE_COMMANDS 必须含这六个命令名）', () => {
    const missing = ITEM_COMMANDS.filter((n) => core.WRITE_COMMANDS.indexOf(n) < 0);
    expect(missing, '请把 item-* 加进 cli/core.js 的 WRITE_COMMANDS（见交付②）：缺 ' + missing.join(', '))
      .toEqual([]);
  });

  it('同键重放 ⇒ 回显含「幂等命中」、项目文件逐字节不变、日志只多 1 条', () => {
    if (!IDEM_READY) {
      // 依赖未落地：**如实红**（不许静默跳过 —— 静默跳过等于"这条判据从没被证明过"）
      throw new Error('依赖未落地：cli/core.js 的 WRITE_COMMANDS 还缺 item-*，'
        + '--idem 会在守卫处被拒 ⇒ 幂等重放这条判据此刻证明不了（见交付②，由 I 落盘后自动转绿）');
    }
    expect(run('add', P, 'root', '--id', 'it-s2-idem', '--topic', 'S2 幂等').code).toBe(0);
    const n0 = journal(P).length;
    const before = readBytes(P);
    const first = run('item-add', P, 'it-s2-idem', '--html', '<p>幂等条目</p>', '--idem', 'it-s2-k1');
    expect(first.code).toBe(0);
    const mid = readBytes(P);
    const n1 = journal(P).length;
    const second = run('item-add', P, 'it-s2-idem', '--html', '<p>幂等条目</p>', '--idem', 'it-s2-k1');
    expect(second.code).toBe(0);                                // 命中不是失败
    expect(second.out).toContain('幂等命中');
    // ⚠️ 命中路径**会**复述首次回显（`cli/main.js` 的 replayIdem 就是"回放首次结果"——
    //    那正是契约 §5.2 要的：同键重放 ⇒ 不重复执行 + **返回首次结果**）。
    //    ⇒ 判据不是"回显里没有'已添加条目'"，而是**两层都到位且可分辨**：
    //      ① 「幂等命中」那一行在（说明这次没执行）；② 首次那句在（说明复述的是首次结果）。
    expect(second.out).toContain('已在本项目生效过');            // ① 不重复执行
    expect(second.out).toContain('未执行');                      // ① 同上（点名本次没跑）
    expect(second.out).toContain(itemIdFrom(first.out));         // ② 复述的是**首次**那个 itemId
    expect(readBytes(P).equals(mid)).toBe(true);                // 第二遍**逐字节不动**
    expect(mid.equals(before)).toBe(false);                     // 第一遍确实写了（否则"不变"是假绿）
    expect(n1).toBe(n0 + 1);                                    // 只多 1 条日志
    expect(journal(P).length).toBe(n1);                         // 重放不写日志
    expect(itemsOf('it-s2-idem').length).toBe(1);
  });
});
