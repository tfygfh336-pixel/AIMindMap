/* ============================================================
 * scripts/smoke/55-草稿图.js — 草稿图 / 临时导图窗口（功能代号 `DM` · 台账 `W11`）
 * ------------------------------------------------------------
 * 七条，全部是**机制**判据（不判"看起来做了"）：
 *   1) 人那半的入口：主图选中一个节点 ⇒ 菜单「新建草稿图（从选中节点）」⇒ 草稿窗出现；
 *      **置顶**（`isAlwaysOnTop`）、**没有父窗**（`getParentWindow()===null` —— child window 会随主窗
 *      最小化一起隐藏，那就是 a–e 的 a 被破坏的结构形状）、页面里根节点**真的画出来了**
 *      （`elementFromPoint(根节点中心)` 命中它自己 —— V1 要求的真判据；rect 对遮挡/裁切是盲的）；
 *   2) **按内容决定窗口大小**（a–e 的 a）：同一次开窗，页面报的内容 bbox == 主进程实际内容尺寸
 *      （在钳制范围内）；换一份**更大**的内容 ⇒ 尺寸跟着变；**同一份内容再开一次 ⇒ 窗口数不变**
 *      （a–e 的 d：更新到原来那张，不新开）；
 *   3) **草稿不写盘**（台账硬要求）：开草稿窗之前记下项目 JSON 的 sha256 + 项目目录文件清单，
 *      开窗之后逐项比对 —— 一个字节都不许变；且草稿的**决定性 id 前缀**在盘上 `search` 零命中
 *      （草稿不参与检索/校验/统计）；
 *   4) **并入 = 一次原子写 + 回读**（台账验收 ②）：从草稿页的按钮走真 UI 路径 ⇒ 选「作为新顶层主题」
 *      ⇒ 确认 ⇒ 盘上多出那棵子树（**读盘**，不读界面自报），节点数与逐条 topic 都对得上；
 *   5) **重复并入幂等并指名**（台账验收 ③）：同指纹再点一次 ⇒ 被拒绝，报文**点名**"已经并入过"，
 *      且盘上节点数与文件 sha256 **一个字节都没变**；
 *   6) **导出 md / json 的内容对得上**（a–e 的 c）：走与按钮**同一条**序列化 + 写盘路径
 *      （只跳过原生保存对话框 —— headless 里没人应答会挂死），写出后解析回来逐节点比对；
 *   7) **关窗即弃 + 零残留**：点「丢弃」⇒ 那张窗没了；`closeAll` 之后窗口数 0；
 *      盘上仍等于"合并后"的状态（关窗不写盘）；本域自己造的节点**全部删掉**（不留污染）。
 *
 * ⚠️ 样本为什么这么挑（`W9` 刚栽过"样本让判据永不触发"）：
 *   `01-core` 预热打开的是 `comnet`（**889 个节点**）。用它当草稿内容有两个后果：
 *   ① 任何顶层主题的子树都可能超过 `MAX_NODES`(500) ⇒ 开窗直接被拒；
 *   ② 就算不超，内容 bbox 也会被屏幕工作区夹住 ⇒ 第 2 条永远走"钳制"那一支，
 *      "按内容定尺寸"这件事**一次都没被判到**（那就是空转判据）。
 *   ⇒ 本域先切到 `book-wifi7`（**89 个节点**，域 54 同款样本），并且**从叶子/小子树取内容**：
 *   第 1 条取的子树 ≤3 个节点、第 2 条取的 ≤12 个节点 ⇒ 尺寸小到**一定不会被钳制**，
 *   "跟着内容变"这一支才真的被判到一次。跑完还原本域开始时那个项目。
 *
 * ⚠️ 本域**不点**导出按钮（原生保存对话框在 headless 里没人应答 ⇒ 点下去挂死）：
 *   导出走 `ctx.draft.exportTo`（**同一条**序列化 + 写盘路径，只跳过对话框那一步）。
 *   对话框那一步**只能人看** —— 这条边界如实写在定题 §3.2，不含糊。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 本域的样本项目（小树：89 个节点 ⇒ 内容尺寸不会被屏幕工作区夹住） */
const PROJ = 'book-wifi7';

/** 本域运行时攒下来的读数（供后面几条复用；顺序依赖是**本域内**的，跨域不依赖） */
let ENTRY_PROJECT = '';      // 本域开始时界面开着的项目（跑完还原）
let SNAP0 = null;            // 开任何草稿窗**之前**的项目指纹（第 3 条的比对基准）
let SMALL = null;            // 第 1 条用的那棵小子树 { id, topic, size }
let BIG = null;              // 第 2 条用的那棵大一点的子树
let FP_SMALL = '';           // 第 1 条开出来的草稿窗指纹
let FP_BIG = '';             // 第 2 条开出来的草稿窗指纹
let SIZE_SMALL = null;       // 两张窗的内容尺寸读数
let SIZE_BIG = null;
let BIG_NODES = 0;           // BIG 那棵子树有几个节点（= 并入后盘上应当新增几个）
let MERGED_ID = '';          // 并入后新建的根节点 id（清场用）

function execJson(ctx, js) {
  return ctx.exec(js).then((raw) => {
    try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
  });
}

/** 在**草稿窗**里跑一段只读 JS（`ctx.draft.exec` 是主进程内的桥，见 main.js 的同名注释） */
function draftJson(ctx, fp, js) {
  return ctx.draft.exec(fp, js).then((raw) => {
    try { return JSON.parse(raw); } catch (e) { return { ok: false, text: String(raw).slice(0, 300) }; }
  });
}

async function waitJs(ctx, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 50); i++) {
    last = await ctx.exec(js);
    try { if (JSON.parse(last).ok) return JSON.parse(last); } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  try { return JSON.parse(last); } catch (e) { return { ok: false, text: String(last).slice(0, 300) }; }
}

async function waitDraft(ctx, fp, js, tries) {
  let last = '';
  for (let i = 0; i < (tries || 60); i++) {
    try { last = await ctx.draft.exec(fp, js); } catch (e) { return { ok: false, text: 'err:' + ((e && e.message) || e) }; }
    try { if (JSON.parse(last).ok) return JSON.parse(last); } catch (e) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  try { return JSON.parse(last); } catch (e) { return { ok: false, text: String(last).slice(0, 300) }; }
}

function sha256File(p) {
  try { return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return '?(读不到: ' + ((e && e.code) || e) + ')'; }
}

function listFiles(dir, base, out) {
  const acc = out || [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
  for (const e of ents) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) listFiles(path.join(dir, e.name), rel, acc);
    else acc.push(rel);
  }
  return acc;
}

/** 项目的数据指纹 + 文件清单（**排除 `.ui-state.json`**：那是界面心跳，与"数据有没有变"无关） */
function snapProject(proj) {
  const base = path.join(process.env.AI_MINDMAP_PROJECTS_DIR || '', proj);
  const dataFile = path.join(base, proj + '.json');
  const files = listFiles(base, '', []).filter((f) => f !== '.ui-state.json').sort();
  return { base: base, dataFile: dataFile, files: files, sha: sha256File(dataFile) };
}

/** 把界面切到某个项目（切项目会撞"界面脏"确认框 ⇒ 按产品自己的打桩口回答；域 54 同款） */
async function openProject(ctx, name) {
  const r = await ctx.exec(`(async function () {
    try {
      var MM = window.MM;
      if (MM && MM.setConfirmStub) MM.setConfirmStub(function () { return true; });
      var r2 = await Promise.race([
        Promise.resolve(window.MMApp.openProject(${JSON.stringify(name)})).then(function () { return 'opened'; },
          function (e) { return 'rejected:' + ((e && e.message) || e); }),
        new Promise(function (res) { setTimeout(function () { res('timeout'); }, 15000); })
      ]);
      if (MM && MM.setConfirmStub) MM.setConfirmStub(null);
      var now = window.MMApp.getState().project;
      return JSON.stringify({ ok: r2 === 'opened' && !!now && now.name === ${JSON.stringify(name)},
        text: r2 + ' / 现在=' + (now ? now.name : '') });
    } catch (e) { return JSON.stringify({ ok: false, text: 'err:' + ((e && e.message) || e) }); }
  })()`);
  await new Promise((res) => setTimeout(res, 400));
  try { return JSON.parse(r); } catch (e) { return { ok: false, text: String(r).slice(0, 200) }; }
}

/** 在界面里挑一棵尺寸落在 [lo,hi]、**深度 ≥ 2** 的子树（从深处往上找），选中它并回读数。
 *  为什么必须深度 ≥ 2（实测撞过一次）：并入默认落点是「作为新顶层主题」，
 *  若草稿根的标题正好等于某个**顶层主题**的标题，`apply` 的 add 会因为"同父同题同内容"
 *  把整份 ops 拒掉（第二次跑就红在这里）⇒ 选样本时就避开"标题与顶层主题重名"的节点。 */
function pickSubtreeJs(lo, hi) {
  return `(function () {
    var st = window.MMApp.getState();
    var ad = window.MM.adapter;
    var root = ad.getRoot(st.jm);
    function count(n) { var k = 1; (n.children || []).forEach(function (c) { k += count(c); }); return k; }
    var rootTopics = {};
    (root.children || []).forEach(function (c) { rootTopics[String(c.topic)] = 1; });
    var best = null;
    (function walk(n, d) {
      if (!n) return;
      if (d >= 2 && String(n.id) !== 'root' && !rootTopics[String(n.topic)]) {
        var k = count(n);
        if (k >= ${lo} && k <= ${hi}) {
          // 取**最浅**的那棵（越浅越像人真的会选的节点）；同深度取第一个
          if (!best || d < best.depth) best = { id: String(n.id), topic: String(n.topic || n.id), size: k, depth: d };
        }
      }
      (n.children || []).forEach(function (c) { walk(c, d + 1); });
    })(root, 1);
    if (!best) return JSON.stringify({ ok: false, text: '这棵树里没有尺寸落在 [${lo},${hi}] 且不与顶层主题重名的子树' });
    /* ⚠️ 选中之前必须**展开祖先链**：库的 select_node 对**不可见**的节点是**静默无效**的
     *  （layout.is_visible 为假就直接 return）—— 实测踩过：挑中了一个收起的深层节点，
     *  select 没生效 ⇒ 菜单拿到的是空的选中 ⇒ 草稿窗一张都没开，而报文只说"数量=0"。
     *  展开会重排整棵树（expand_node 同步重算），所以展开之后再 select 才有效。 */
    if (window.MM && window.MM.expandAncestors) { try { window.MM.expandAncestors(st.jm, best.id); } catch (e) { /* 单点失败不影响后面判 */ } }
    ad.selectNode(st.jm, best.id);
    var nowSel = ad.getSelected(st.jm);
    return JSON.stringify({ ok: true, id: best.id, topic: best.topic, size: best.size, depth: best.depth,
      selected: nowSel ? String(nowSel.id) : '', selOk: !!(nowSel && String(nowSel.id) === best.id) });
  })()`;
}

/** 盘上这个项目里的全部节点（**扁平清单**：`read --json --subtree root` 的返回形状
 *  是 `{meta, nodeCount, nodes:[{id,topic,depth,…}], images}` —— 不是一棵树，实测确认）。
 *  ⚠️ 为什么不用 `search`：它的命中谓词是**非连续子序列**（`FH` / `src/palette-rank.js` 的 `fuzzyMatch`），
 *  一串十六进制前缀可以"散落命中"到任何正文里 —— 实测用它判"盘上有没有草稿痕迹"会**假红**
 *  （`dm001fe6f2` 在真实书里命中过）。判 id 就老老实实走平铺清单。 */
function listNodes(ctx, proj) {
  const parsed = JSON.parse(ctx.runCli(['read', proj, '--json', '--subtree', 'root']));
  return Array.isArray(parsed.nodes) ? parsed.nodes : [];
}

/** 盘上 id 以某个前缀开头的节点 */
function nodesWithIdPrefix(ctx, proj, prefix) {
  return listNodes(ctx, proj).filter((n) => String(n.id).indexOf(prefix) === 0);
}

/** 点菜单「新建草稿图（从选中节点）」（人那半的唯一正门；菜单项不存在就是接线断了） */
function clickNewDraftMenu() {
  let Menu = null;
  try { Menu = require('electron').Menu; } catch (e) { Menu = null; }
  if (!Menu || !Menu.getApplicationMenu) return { ok: false, text: '拿不到 Menu（不在主进程？）' };
  const m = Menu.getApplicationMenu();
  const item = m ? m.getMenuItemById('menu-new-draft') : null;
  if (!item) return { ok: false, text: '应用菜单里没有 menu-new-draft（入口没接上）' };
  if (item.enabled === false) return { ok: false, text: 'menu-new-draft 是灰的' };
  item.click();
  return { ok: true, text: '已点「' + item.label + '」' };
}

/** 等草稿窗出现 / 数量到位 */
async function waitDraftCount(ctx, want, tries) {
  let last = [];
  for (let i = 0; i < (tries || 60); i++) {
    last = ctx.draft.list();
    if (last.length === want) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

const assertions = [
  {
    name: '草稿图入口：主图选中节点 ⇒ 菜单「新建草稿图」⇒ 草稿窗出现（置顶 / 无父窗 / 页面真画出来了）',
    run: async (ctx) => {
      if (!ctx.draft) return { ok: false, text: 'ctx.draft 不可用（主进程没挂上草稿图读数面）' };
      // 切到小样本项目（**在记指纹之前**：切项目本身会写 .ui-state.json，那是产品行为、不是草稿写的）
      const cur = await execJson(ctx, '(function(){var p=window.MMApp.getState().project;return JSON.stringify({name:p?p.name:""});})()');
      ENTRY_PROJECT = cur.name || '';
      if (cur.name !== PROJ) {
        const opened = await openProject(ctx, PROJ);
        if (!opened.ok) return { ok: false, text: '切不到 ' + PROJ + '：' + opened.text };
      }
      SNAP0 = snapProject(PROJ);            // ★ 第 3 条的比对基准：**开任何草稿窗之前**
      const picked = await execJson(ctx, pickSubtreeJs(1, 3));
      if (!picked.ok) return { ok: false, text: '挑不到 ≤3 个节点的小子树：' + picked.text };
      if (!picked.selOk) return { ok: false, text: '选中没生效（库对不可见节点静默无效）：期望 ' + picked.id + ' 实得 ' + picked.selected };
      SMALL = picked;
      const clicked = clickNewDraftMenu();
      if (!clicked.ok) return { ok: false, text: clicked.text };
      const list = await waitDraftCount(ctx, 1);
      if (list.length !== 1) return { ok: false, text: '草稿窗数量=' + list.length + '（期望 1）｜' + clicked.text };
      const w = list[0];
      FP_SMALL = w.fp;
      // 页面里等它把树画完
      const page = await waitDraft(ctx, FP_SMALL, `(function () {
        var s = window.MM.draftPageState ? window.MM.draftPageState() : null;
        if (!s) return JSON.stringify({ ok: false, text: '草稿页没有 draftPageState' });
        return JSON.stringify({ ok: !!(s.jm && s.rendered > 0), rootTopic: s.rootTopic, rendered: s.rendered, nodes: s.nodes });
      })()`);
      if (!page.ok) return { ok: false, text: '草稿页没画出来：' + JSON.stringify(page).slice(0, 200) };
      /* ★ V1 要求的真判据：草稿页里根节点元素中心点上到底是谁（`rect` 对遮挡/裁切是盲的）。
       * 这里不是主窗口的页面，而是**草稿窗自己的页面** —— `elementFromPoint` 在它自己那侧跑。 */
      const hit = await draftJson(ctx, FP_SMALL, `(function () {
        var n = document.querySelector('jmnode[nodeid="d0"]');
        if (!n) return JSON.stringify({ ok: false, text: '页面里没有根节点元素 jmnode[d0]' });
        var r = n.getBoundingClientRect();
        var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
          return JSON.stringify({ ok: false, text: '根节点中心点在视口外: (' + cx + ',' + cy + ') 视口=' + window.innerWidth + 'x' + window.innerHeight });
        }
        var at = document.elementFromPoint(cx, cy);
        var self = !!(at && at.closest && at.closest('jmnode[nodeid]') === n);
        return JSON.stringify({ ok: self, text: '中心点(' + cx + ',' + cy + ') 命中自身=' + self
          + ' 命中元素=' + (at ? (at.tagName + '.' + (at.className || '')) : 'null')
          + ' rect=' + Math.round(r.width) + 'x' + Math.round(r.height) });
      })()`);
      const okProps = w.alwaysOnTop === true && w.parentWindow === false;
      return {
        ok: okProps && page.rootTopic === SMALL.topic && hit.ok,
        text: '置顶=' + w.alwaysOnTop + ' 有父窗=' + w.parentWindow
          + ' ｜ 子树=' + SMALL.id + '(' + SMALL.size + ' 节点) 页面根标题=' + JSON.stringify(page.rootTopic)
          + ' 对上=' + (page.rootTopic === SMALL.topic) + ' 页面节点=' + page.rendered
          + ' ｜ ' + hit.text
      };
    }
  },
  {
    name: '草稿图按内容定窗口大小：内容 bbox == 实际内容尺寸；换更大内容尺寸跟着变；同内容再开不新开窗',
    run: async (ctx) => {
      if (!FP_SMALL) return { ok: false, text: '上一条没开出草稿窗（本域顺序依赖）' };
      const readSize = async (fp) => {
        let s = null;
        // 内容 bbox 是**两帧之后**才量得到的（jsMind 的 show_nodes 之后元素才带几何）⇒ 等它自己报上来
        for (let i = 0; i < 40; i++) {
          s = await draftJson(ctx, fp, '(function () { var s = window.MM.draftPageState();'
            + ' return JSON.stringify({ ok: !!s.want, want: s.want, nodes: s.nodes }); })()');
          if (s.ok) break;
          await new Promise((r) => setTimeout(r, 120));
        }
        const list = ctx.draft.list().filter((x) => x.fp === fp);
        return { want: s.want, nodes: s.nodes, contentSize: list.length ? list[0].contentSize : null };
      };
      const a = await readSize(FP_SMALL);
      if (!a.want || !a.contentSize) return { ok: false, text: '读不到内容尺寸：' + JSON.stringify(a).slice(0, 200) };
      SIZE_SMALL = a.contentSize;
      // 钳制口径与 main.js 的 draft:fit 同一份规则（这里**自己算一遍**，不读产品返回值 —— 同源自证等于没证）
      let wa = { width: 1280, height: 800 };
      try { wa = require('electron').screen.getDisplayMatching(ctx.win.getBounds()).workAreaSize; } catch (e) { /* 兜底 */ }
      const maxW = Math.max(360, wa.width - 40), maxH = Math.max(240, wa.height - 60);
      const expectW = Math.min(Math.max(Math.round(a.want.w), 360), maxW);
      const expectH = Math.min(Math.max(Math.round(a.want.h), 240), maxH);
      const fitOk = Math.abs(a.contentSize[0] - expectW) <= 1 && Math.abs(a.contentSize[1] - expectH) <= 1;
      const clamped = (expectW < Math.round(a.want.w) || expectH < Math.round(a.want.h));

      // 换一份**更大**的内容（≤12 个节点）⇒ 尺寸应当跟着变
      const picked = await execJson(ctx, pickSubtreeJs(4, 12));
      if (!picked.ok) return { ok: false, text: '挑不到 4–12 个节点的子树：' + picked.text };
      if (!picked.selOk) return { ok: false, text: '选中没生效（挑中的 ' + picked.id + ' 实得 ' + picked.selected + '）' };
      BIG = picked;
      BIG_NODES = picked.size;
      const clicked = clickNewDraftMenu();
      if (!clicked.ok) return { ok: false, text: clicked.text };
      const list2 = await waitDraftCount(ctx, 2);
      if (list2.length !== 2) return { ok: false, text: '草稿窗数量=' + list2.length + '（期望 2：不同内容 ⇒ 可以是不同的窗）' };
      FP_BIG = list2.filter((x) => x.fp !== FP_SMALL)[0].fp;
      const b = await readSize(FP_BIG);
      SIZE_BIG = b.contentSize;
      if (!b.want || !b.contentSize) return { ok: false, text: '读不到第二张窗的内容尺寸：' + JSON.stringify(b).slice(0, 200) };
      const differs = a.contentSize[0] !== b.contentSize[0] || a.contentSize[1] !== b.contentSize[1];

      // 同一份内容再开一次 ⇒ **不新开窗**（a–e 的 d）
      const back = await execJson(ctx, `(function () {
        var st = window.MMApp.getState();
        if (window.MM && window.MM.expandAncestors) { try { window.MM.expandAncestors(st.jm, ${JSON.stringify(SMALL.id)}); } catch (e) {} }
        window.MM.adapter.selectNode(st.jm, ${JSON.stringify(SMALL.id)});
        var sel = window.MM.adapter.getSelected(st.jm);
        return JSON.stringify({ ok: !!(sel && String(sel.id) === ${JSON.stringify(SMALL.id)}) });
      })()`);
      if (!back.ok) return { ok: false, text: '选不回原节点' };
      clickNewDraftMenu();
      await new Promise((r) => setTimeout(r, 900));
      const list3 = ctx.draft.list();
      const fps3 = list3.map((x) => x.fp).sort().join(',');
      // 顺带：第 1 条的窗还活着（"更新到原来那张"不是"关掉重开"）
      const smallAlive = list3.some((x) => x.fp === FP_SMALL);
      return {
        ok: fitOk && differs && list3.length === 2 && smallAlive,
        text: '小内容=' + JSON.stringify(a.want) + '→ 实际 ' + a.contentSize.join('x')
          + '（期望 ' + expectW + 'x' + expectH + ' 吻合=' + fitOk + ' 被钳制=' + clamped + '）'
          + ' ｜ 大内容=' + JSON.stringify(b.want) + '→ 实际 ' + b.contentSize.join('x')
          + '（' + b.nodes + ' 节点）尺寸不同=' + differs
          + ' ｜ 同内容再开 ⇒ 窗口数=' + list3.length + '（期望 2）原来那张还在=' + smallAlive + ' 指纹集=' + fps3
      };
    }
  },
  {
    name: '草稿不写盘：开草稿窗前后项目 JSON 的 sha256 与项目目录文件清单逐项相同（草稿不参与检索）',
    run: async (ctx) => {
      if (!SNAP0) return { ok: false, text: '上一条没记下基线（本域顺序依赖）' };
      const now = snapProject(PROJ);
      const filesSame = JSON.stringify(now.files) === JSON.stringify(SNAP0.files);
      const shaSame = now.sha === SNAP0.sha;
      // 草稿的**决定性 id 前缀**在盘上必须一个都搜不到（并入之前它不存在于任何项目里）
      let prefixHits = null;
      let prefixText = '';
      try {
        prefixHits = nodesWithIdPrefix(ctx, PROJ, 'dm' + String(FP_SMALL).slice(0, 8));
        prefixText = '盘上同前缀节点 ' + prefixHits.length + ' 个';
      } catch (e) {
        prefixHits = null;
        prefixText = '读盘失败：' + String((e && e.message) || e).slice(0, 80);
      }
      return {
        ok: filesSame && shaSame && prefixHits !== null && prefixHits.length === 0,
        text: '数据文件 sha256 相同=' + shaSame + '（' + String(SNAP0.sha).slice(0, 12) + '）'
          + ' ｜ 文件清单相同=' + filesSame + '（' + SNAP0.files.length + ' 个文件）'
          + ' ｜ 草稿 id 前缀在' + prefixText
          + (filesSame ? '' : ' ｜ 清单差异：' + JSON.stringify({ before: SNAP0.files, after: now.files }).slice(0, 300))
      };
    }
  },
  {
    name: '并入 = 一次原子写 + 回读：草稿页按钮 ⇒ 选「作为新顶层主题」⇒ 盘上多出那棵子树（读盘，不读界面自报）',
    run: async (ctx) => {
      if (!FP_BIG) return { ok: false, text: '没有第二张草稿窗（本域顺序依赖）' };
      // 真 UI 路径：点「并入主导图」⇒ 拉候选 ⇒ 选「作为新顶层主题」⇒ 确认
      await ctx.draft.exec(FP_BIG, '(function () { document.getElementById("btn-merge").click(); return 1; })()');
      const pickOpen = await waitDraft(ctx, FP_BIG, '(function () { var s = window.MM.draftPageState();'
        + ' return JSON.stringify({ ok: !!s.pickOpen, text: s.status }); })()', 40);
      if (!pickOpen.ok) return { ok: false, text: '点了「并入」但落点面板没出来：' + JSON.stringify(pickOpen).slice(0, 200) };
      const opts = await draftJson(ctx, FP_BIG, `(function () {
        var sel = document.getElementById('pick-parent');
        var vals = Array.prototype.map.call(sel.options, function (o) { return o.value; });
        return JSON.stringify({ ok: vals.length > 0 && vals[0] === 'root', count: vals.length, first: vals[0],
          text: vals.slice(0, 6).join(' | ') });
      })()`);
      if (!opts.ok) return { ok: false, text: '落点下拉框不对（首项应为 root=新顶层主题）：' + JSON.stringify(opts).slice(0, 220) };
      await ctx.draft.exec(FP_BIG, '(function () { document.getElementById("pick-parent").value = "root";'
        + ' document.getElementById("pick-ok").click(); return 1; })()');
      const done = await waitDraft(ctx, FP_BIG, '(function () { var s = window.MM.draftPageState();'
        + ' return JSON.stringify({ ok: s.status.indexOf("已并入") >= 0 || s.status.indexOf("没有并入") >= 0, text: s.status }); })()', 120);
      if (!done.ok) return { ok: false, text: '并入没有终局回执（既没有"已并入"也没有"没有并入"）：' + JSON.stringify(done).slice(0, 240) };
      if (String(done.text).indexOf('已并入') < 0) return { ok: false, text: '并入被拒绝：' + done.text };

      // ---- 回读：**读盘**（不读界面自报） ----
      const ops = await draftJson(ctx, FP_BIG, '(function () { var s = window.MM.draftPageState();'
        + ' return JSON.stringify({ ok: true, fp: s.fp, nodes: s.nodes, rootTopic: s.rootTopic }); })()');
      const prefix = 'dm' + String(ops.fp).slice(0, 8);
      let actual = null;
      try {
        const flat = listNodes(ctx, PROJ);
        const mine = flat.filter((n) => String(n.id).indexOf(prefix + '-') === 0);
        const rootNode = flat.filter((n) => String(n.id) === prefix + '-0')[0] || null;
        if (rootNode) {
          MERGED_ID = String(rootNode.id);
          actual = { id: MERGED_ID, count: mine.length, ptopic: String(rootNode.topic || '') };
        }
      } catch (e) {
        return { ok: false, text: '回读失败：' + String((e && e.message) || e).slice(0, 300) };
      }
      if (!actual) return { ok: false, text: '并入回执说成功，但盘上找不到 ' + prefix + '-0（这就是"界面说成了、盘上没有"）' };
      const countOk = actual.count === BIG_NODES;
      const rootOk = actual.ptopic === BIG.topic;
      return {
        ok: countOk && rootOk,
        text: '新建节点=' + actual.id + ' 盘上节点数=' + actual.count + '（草稿 ' + BIG_NODES + '）'
          + ' 根标题对上=' + rootOk + '（' + actual.ptopic + ' vs ' + BIG.topic + '）'
          + ' ｜ 落点选项=' + opts.count + ' 项（首项 ' + opts.first + '）｜ 回执=' + String(done.text).slice(0, 120)
      };
    }
  },
  {
    name: '重复并入幂等并指名：同指纹再并入 ⇒ 拒绝 + 点名"已经并入过"，盘上一个字节都没变',
    run: async (ctx) => {
      if (!FP_BIG || !MERGED_ID) return { ok: false, text: '上一轮没有真正并入过（本域顺序依赖）' };
      const before = snapProject(PROJ);
      const countMine = () => {
        try { return nodesWithIdPrefix(ctx, PROJ, 'dm' + String(FP_BIG).slice(0, 8) + '-').length; }
        catch (e) { return -1; }
      };
      const beforeNodes = countMine();
      await ctx.draft.exec(FP_BIG, '(function () { document.getElementById("btn-merge").click(); return 1; })()');
      await waitDraft(ctx, FP_BIG, '(function () { var s = window.MM.draftPageState();'
        + ' return JSON.stringify({ ok: !!s.pickOpen }); })()', 40);
      await ctx.draft.exec(FP_BIG, '(function () { document.getElementById("pick-parent").value = "root";'
        + ' document.getElementById("pick-ok").click(); return 1; })()');
      const done = await waitDraft(ctx, FP_BIG, '(function () { var s = window.MM.draftPageState();'
        + ' return JSON.stringify({ ok: s.status.indexOf("没有并入") >= 0 || s.status.indexOf("已并入") >= 0, text: s.status }); })()', 120);
      const after = snapProject(PROJ);
      const afterNodes = countMine();
      const named = String(done.text || '').indexOf('已经并入过') >= 0;
      const refused = String(done.text || '').indexOf('没有并入') >= 0;
      const same = before.sha === after.sha && beforeNodes === afterNodes;
      return {
        ok: refused && named && same,
        text: '被拒绝=' + refused + ' 点名"已经并入过"=' + named
          + ' ｜ 盘上 sha256 相同=' + (before.sha === after.sha) + ' 节点数 ' + beforeNodes + '→' + afterNodes
          + ' ｜ 回执=' + String(done.text).slice(0, 160)
      };
    }
  },
  {
    name: '导出 md / json：导出内容解析回来与草稿树逐节点对得上（走与按钮同一条序列化与写盘路径）',
    run: async (ctx) => {
      if (!FP_BIG) return { ok: false, text: '没有草稿窗（本域顺序依赖）' };
      const tmp = path.join(os.tmpdir(), 'mm-draft-export-' + Date.now());
      const mdPath = tmp + '.md';
      const jsonPath = tmp + '.json';
      const rmd = ctx.draft.exportTo(FP_BIG, 'md', mdPath);
      const rjson = ctx.draft.exportTo(FP_BIG, 'json', jsonPath);
      let mdText = '', jsonText = '';
      try { mdText = fs.readFileSync(mdPath, 'utf8'); } catch (e) { mdText = ''; }
      try { jsonText = fs.readFileSync(jsonPath, 'utf8'); } catch (e) { jsonText = ''; }
      try { fs.unlinkSync(mdPath); } catch (e) { /* 清不掉不影响结论 */ }
      try { fs.unlinkSync(jsonPath); } catch (e) { /* 同上 */ }
      if (!rmd.ok || !rjson.ok) return { ok: false, text: '导出失败：' + JSON.stringify({ md: rmd, json: rjson }).slice(0, 300) };
      // 自己从导出文本里数节点（md 用行首 "- " 计；json 直接数树），与草稿页的节点数对拍
      const mdNodes = mdText.split(/\r?\n/).filter((l) => /^\s*- /.test(l)).length;
      let jsonNodes = 0;
      let jsonRoot = '';
      try {
        const t = JSON.parse(jsonText);
        jsonRoot = String(t.topic || '');
        (function walk(n) { jsonNodes += 1; (n.children || []).forEach(walk); })(t);
      } catch (e) { return { ok: false, text: '导出的 json 解析不了：' + ((e && e.message) || e) }; }
      const page = await draftJson(ctx, FP_BIG, '(function () { var s = window.MM.draftPageState();'
        + ' return JSON.stringify({ ok: true, nodes: s.nodes, rootTopic: s.rootTopic }); })()');
      return {
        ok: mdNodes === page.nodes && jsonNodes === page.nodes && jsonRoot === page.rootTopic,
        text: 'md 行数=' + mdNodes + ' / json 节点=' + jsonNodes + ' / 草稿节点=' + page.nodes
          + ' ｜ json 根标题=' + JSON.stringify(jsonRoot) + ' 对上=' + (jsonRoot === page.rootTopic)
          + ' ｜ md 首行=' + JSON.stringify((mdText.split(/\r?\n/)[0] || '').slice(0, 40))
          + ' ｜ 字节 md=' + rmd.bytes + ' json=' + rjson.bytes
      };
    }
  },
  {
    name: '关窗即弃 + 零残留：丢弃后窗口数归零、盘上不变，本域自己造的节点全部删掉',
    run: async (ctx) => {
      const beforeClose = snapProject(PROJ);
      if (FP_BIG) {
        // 真 UI 路径：点「丢弃」（草稿没落过盘 ⇒ 关窗就是删掉它）
        try { await ctx.draft.exec(FP_BIG, '(function () { document.getElementById("btn-discard").click(); return 1; })()'); }
        catch (e) { /* 已经没了也算 */ }
        await new Promise((r) => setTimeout(r, 600));
      }
      const n1 = ctx.draft.list().length;
      ctx.draft.closeAll();
      await new Promise((r) => setTimeout(r, 300));
      const n2 = ctx.draft.list().length;
      const afterClose = snapProject(PROJ);
      // 清场：把并入进来的那棵子树删掉（本域**自己造的**，别的域不该看到它）
      let cleaned = '（没有可清的）';
      if (MERGED_ID) {
        try {
          ctx.runCli(['remove', PROJ, MERGED_ID]);
          cleaned = '已删 ' + MERGED_ID;
        } catch (e) { cleaned = '删不掉：' + String((e && e.message) || e).slice(0, 160); }
      }
      let residue = '?';
      try {
        const left = nodesWithIdPrefix(ctx, PROJ, 'dm')
          .filter((id) => /^dm[0-9a-f]{8}-/.test(id));
        residue = left.length === 0 ? '0' : ('还有 ' + left.length + ' 个：' + left.slice(0, 4).join(','));
      } catch (e) { residue = '读盘失败：' + String((e && e.message) || e).slice(0, 80); }
      // 还原项目（本域开头切过来的那个）
      let restored = '（本来就是 ' + PROJ + '）';
      if (ENTRY_PROJECT && ENTRY_PROJECT !== PROJ) {
        const back = await openProject(ctx, ENTRY_PROJECT);
        restored = back.text;
      }
      const sameWhileClosing = beforeClose.sha === afterClose.sha;
      return {
        ok: n1 <= 1 && n2 === 0 && sameWhileClosing && residue === '0',
        text: '丢弃后剩 ' + n1 + ' 张 ⇒ closeAll 后 ' + n2 + ' 张（期望 0）'
          + ' ｜ 关窗期间盘上数据未变=' + sameWhileClosing
          + ' ｜ 清场=' + cleaned + ' ｜ 草稿痕迹在盘上残留=' + residue
          + ' ｜ 还原项目=' + restored
      };
    }
  }
];

module.exports = assertions;
