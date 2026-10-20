/* ============================================================
 * scripts/vision/roi-assertions.js — L2「关键区域」视觉断言
 * ------------------------------------------------------------
 * **存在的唯一理由**：L1（整图有效帧）抓不到"**整图看着正常、但关键区域是空白**"。
 * 实测过的判据边界（见 `docs/ARCHITECTURE.md` §4b ADR「静默验证分层（L0–L4）与工程偏离」）：只做 L1 时，"取景漂移"抓不到；
 * 而"导图区没渲染出来、工具栏却是好的"这类回归，L1 也是绿的 —— 那正是本模块要抓的。
 *
 * ## 有意偏离：ROI 矩形**从 DOM 现取**，不写死像素坐标
 * 常见做法是调用方传显式矩形。若在本工程写死（如 `{x:0,y:0,width:1424,height:36}`），
 * 就变成一组**易腐数字**：改一次布局即失效，而且失效方式是"**静默地测错地方**"。
 * 所以这里在渲染进程里用 `getBoundingClientRect()` 现取，并按 `devicePixelRatio` 缩放到设备像素
 * （截图是设备像素，`getBoundingClientRect` 是 CSS 像素 —— 缩放比不为 1 时两者不等）。
 *
 * ## 两条纪律
 * 1. **采不到矩形 = 红**：取不到 ROI（元素不存在、页面没加载好）不许跳过再宣称通过 ——
 *    与工程既有红线同源（"采不到真值 = 红；跳过不得伪装成一致"）。
 * 2. **阈值单源**：判定阈值只在 `scripts/vision/thresholds.js`，本文件不写数字。
 *
 * ⚠️ **明确不进 ROI 的元素**：`#status-text`。阶段 2 为了消除"时间戳导致截图逐次不同"
 * **刻意清空**了它（见 `main.js` `prepareCapture`）⇒ 它**按设计就是空的**，拿它做 ROI 会**永远判红**。
 * 这条记在这里，是因为它是"看起来该测、其实不能测"的典型。
 *
 * ## ⚠️ 已实测的**残留局限**（别以为它比实际更强）
 * `#mindmap-container` 实测矩形是 `{x:0,y:46,width:1424,height:789}` —— 即**整个内容区**，
 * 而它**包含覆盖在导图之上的浮层**（浮层不是它的后代，所以隐藏它的子元素并不能让该区域变空：
 * 真机实测注入后 `unique` 只从 383 降到 173、仍判 **PASS**）。
 * ⇒ **残留缝隙：导图没画出来、但同时有个可见浮层占着这块区域时，本断言仍会绿。**
 * ⇒ 收窄到 `#jsmind_container` **没有用**：它是 `width:100%;height:100%`（`style.css:399`），矩形完全一样。
 * 要真正补上这条缝隙，得把"导图层"与"浮层"分开测（例如按 z 序 / 按浮层矩形做**排除区**），
 * 那属于阶段 3 的 L3 范畴（需要基线），**本阶段不做**。此处如实标注，不做过度承诺。
 * ============================================================ */
'use strict';

const path = require('path');
const frameStats = require('./frame-stats.js');
const THRESHOLDS = require('./thresholds.js');

/** 仓库根（`smoke-shot.png` / `smoke-frame.json` 由 `main.js` 写在**这里**） */
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * ROI 清单 —— **唯一来源**。加一个区域只改这里（`run()` 的返回条数 = 本数组长度，
 * 阶段 5 的"视觉断言数进真值"直接取 `ROIS.length`，**不需要运行时才能算**）。
 * `id` 是 DOM 里的元素 id（`#` 后那段）；`why` 说明"它空了意味着什么"。
 */
const ROIS = Object.freeze([
  {
    id: 'toolbar',
    label: '工具栏',
    why: '工具栏整条没渲染出来（按钮全无）'
  },
  {
    id: 'mindmap-container',
    label: '导图区',
    why: '导图没画出来 —— 整图仍然是"有效帧"，L1 抓不到这一类'
  }
]);

/** 在渲染进程里取 ROI 矩形（CSS 像素）+ 缩放比。返回 {rects:{id:{x,y,width,height}}, dpr} */
const RECT_SCRIPT = `(() => {
  const ids = ${JSON.stringify(ROIS.map((r) => r.id))};
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out[id] = null; continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out[id] = (r.width <= 0 || r.height <= 0 || cs.display === 'none' || cs.visibility === 'hidden')
      ? null
      : { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return { rects: out, dpr: window.devicePixelRatio || 1 };
})()`;

/* ============================================================
 * L4 读图证据落盘（台账 `G-07`）—— **挂在这里的唯一理由**
 * ------------------------------------------------------------
 * 台账原话是「让 L4 读图证据真的落盘（`.review/vision/` 现在不存在）」。改造前的实测形状：
 * 截图只活在**工程根**的 `smoke-shot.png`（每次全量冒烟覆盖、跑完就没了），而
 * `scripts/vision/record.js` 的读图结论虽然写 `.review/vision/`，却**从来没归档过那张图**，
 * 而且要人手敲参数 ⇒ 这条线一直空转。落盘/完整性/清理的唯一实现是 `scripts/vision/evidence.js`。
 *
 * **为什么是 L2 收尾这一跳、而不是别处**：`main.js` 只在这里把「**本次判过的那一帧**」
 * （同一个 `img`）交给下游，而它紧接着刚写完 `smoke-shot.png` 与 `smoke-frame.json`。
 * ⇒ 判定用的帧与归档的帧**同源**（`testing-for-ai` H1b ③），不需要第二次截图。
 * `main.js` 不在本批可改范围内，所以挂载点只能是这里 —— 这是**取舍**，不是理想位置。
 *
 * **只在真帧上做**：判据是 `typeof img.toPNG === 'function'`（真实 `NativeImage` 才有；
 * 单测里的假图只有 `toBitmap`/`getSize`）⇒ 单测与探针**不会**往证据库里写假记录。
 * 需要连真图也跳过（探针场景）时给 `ctx.evidence === false`；要改落盘目录给
 * `ctx.evidence = { dir, tier, scope }`。
 *
 * **失败必须抛**（不许静默）：归档写不出去、或写完复核判红，都当作本次运行的失败 ——
 * 证据存不下与"没取证"是同一件事，而"没取证却看起来跑过了"正是本工程最重的损害类别。
 * ============================================================ */
function archiveFrame(ctx) {
  const evidence = require('./evidence.js');
  const o = (ctx && ctx.evidence && typeof ctx.evidence === 'object') ? ctx.evidence : {};
  const res = evidence.archiveFromFrame({
    pngPath: o.png ? path.resolve(o.png) : path.join(ROOT, 'smoke-shot.png'),
    framePath: o.frame ? path.resolve(o.frame) : path.join(ROOT, 'smoke-frame.json'),
    dir: o.dir,
    tier: o.tier,
    scope: o.scope
  });
  if (!res.ok) {
    throw new Error('L4 读图证据**没落盘**（`scripts/vision/evidence.js` 拒绝归档）：' + res.problems.join('；'));
  }
  // 写完立刻把**整个证据目录**复核一遍（不是只复核刚写的那一条）：
  // 一条旧记录坏了同样意味着"证据库不可信"，而这次不查就要等到下一次运行。
  const j = evidence.judge({ dir: res.dir });
  if (!j.ok) {
    throw new Error('L4 读图证据**完整性判红**（' + j.problems.length + ' 条）：'
      + j.problems.map((p) => '[' + p.kind + '] ' + p.file).join('；')
      + '。逐条读数：`node scripts/vision/evidence.js --check`');
  }
  return res;
}

/**
 * 跑全部 ROI 断言。
 * @param {{exec:Function, img:object, evidence?:object|false}} ctx `exec` = 渲染进程执行器；
 *   `img` = **本次已截好的** NativeImage；`evidence` 见 `archiveFrame`
 * @returns {Promise<Array<{name:string, ok:boolean, text:string}>>} 长度恒等于 `ROIS.length`
 *   （**除非** L4 证据落盘失败 —— 那条路会抛，因为"证据没落盘"必须让本次运行失败）
 */
async function run(ctx) {
  let probe;
  try {
    probe = await ctx.exec(RECT_SCRIPT);
  } catch (err) {
    // 取不到矩形 = 红（不是跳过）
    return ROIS.map((r) => ({
      name: '视觉断言 L2：「' + r.label + '」区域有效（非空、非纯色）',
      ok: false,
      text: '取不到 ROI 矩形（渲染进程执行失败）: ' + (err && err.message)
    }));
  }
  const dpr = (probe && probe.dpr) || 1;
  const results = [];
  for (const r of ROIS) {
    const css = probe && probe.rects ? probe.rects[r.id] : null;
    if (!css) {
      results.push({
        name: '视觉断言 L2：「' + r.label + '」区域有效（非空、非纯色）',
        ok: false,
        text: '#' + r.id + ' 取不到可见矩形（元素不存在 / 尺寸为 0 / 被隐藏）⇒ 可判定为「' + r.why + '」'
      });
      continue;
    }
    const rect = {
      x: Math.round(css.x * dpr), y: Math.round(css.y * dpr),
      width: Math.round(css.width * dpr), height: Math.round(css.height * dpr)
    };
    let stats;
    try {
      stats = frameStats.analyzeRegion(ctx.img, rect);
    } catch (err) {
      results.push({
        name: '视觉断言 L2：「' + r.label + '」区域有效（非空、非纯色）',
        ok: false,
        text: 'ROI 统计失败: ' + (err && err.message)
      });
      continue;
    }
    const v = frameStats.passRegion(stats, THRESHOLDS.roi);
    results.push({
      name: '视觉断言 L2：「' + r.label + '」区域有效（非空、非纯色）',
      ok: v.ok,
      text: v.text + ' dpr=' + dpr + (v.ok ? '' : '（该区域疑似空白/纯色 ⇒ ' + r.why + '）')
    });
  }
  /* ---- L4 读图证据落盘（G-07）----
   * 放在**最后**：先跑完 L2（判定），再归档（取证据）—— 顺序反了就成了"先存图后判"，
   * 而存下来的图必须是**判过的那一帧**（同一 `img`，不同一次采集）。
   * ⚠️ 边界：`ctx.exec` **整体失败**时走上面的早返回、**不归档** —— 那一帧已经让 L2 全部判红，
   * 先修页面；不在这里抛是为了不让"证据没落盘"盖掉"页面没加载好"这条真因。 */
  if (!(ctx && ctx.evidence === false) && ctx && ctx.img && typeof ctx.img.toPNG === 'function') {
    archiveFrame(ctx);
  }
  return results;
}

module.exports = { ROIS, run, archiveFrame };
