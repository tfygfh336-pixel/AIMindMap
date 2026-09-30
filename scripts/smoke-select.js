/* ============================================================
 * scripts/smoke-select.js —— 冒烟「单跑」选择器（**纯函数，零副作用**）
 * ------------------------------------------------------------
 * 为什么要有它：全链一次约 100–120 s，其中冒烟（Electron 无头 + 截图 + 视觉断言）占大头。
 * 改一条断言就得等整轮，而且这轮会真启动 Electron、真占内存 —— 实测反复跑会把整机提交内存
 * 推到 80%，连带把同机的浏览器/界面拖卡甚至拖崩。所以提供"只跑选中的那几个断言文件"。
 *
 * 用法（两种写法等价）：
 *     SMOKE_ONLY=20,21 npm run smoke            （环境变量）
 *     electron . --smoke-only=20,21             （命令行参数）
 * 选择串的每一项按**文件名前缀**匹配：`20` 命中 `20-preview-buttons.js`，
 * `19-anchor` 命中 `19-layout-anchor.js`。逗号分隔，可给多项。
 *
 * 三条硬规则（每一条都对应一种"看着通过、其实没跑"的失效）：
 *   ① **一项都没匹配上 ⇒ 抛错**，绝不返回空集。筛错名字却打印 "0/0 passed" 是最坏的假绿
 *      （本工程已多次栽在"没做，却看不出没做"上，见 scripts/smoke-assertions.js 的头部说明）。
 *   ② **永远并入 `01-*`**（预热：它负责加载渲染层并打开 comnet，后面的断言都假设这个前提）。
 *   ③ 过滤运行**不是全量真值**：`docs/VERIFY.md` 的冒烟条数只由全量运行代表；
 *      调用方（main.js）必须打印显著标记，并跳过截图/视觉断言/取景记录。
 *
 * 本模块不碰文件系统、不 require Electron —— `tests/smoke-select.test.js` 直接 require 它做单测。
 * ============================================================ */
'use strict';

/** 预热文件前缀：它把渲染层加载起来并打开 comnet，其它断言依赖这个前提 */
const WARMUP_PREFIX = '01-';

/** 解析选择串：''/undefined ⇒ null（表示全量）；有内容 ⇒ 去空白后的项数组（空项忽略，全空则抛错） */
function parseSpec(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return null;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new Error('冒烟选择串里没有有效项：' + JSON.stringify(spec));
  return items;
}

/** 从全部文件名里选出要跑的（保序）。spec 为空 ⇒ 全量（原样返回） */
function selectFiles(files, spec) {
  const all = Array.isArray(files) ? files.slice() : [];
  const items = parseSpec(spec);
  if (!items) return all;
  const picked = new Set();
  const unmatched = [];
  for (const it of items) {
    const hit = all.filter((f) => f === it || f.startsWith(it));
    if (!hit.length) { unmatched.push(it); continue; }
    hit.forEach((f) => picked.add(f));
  }
  if (unmatched.length) {
    throw new Error('冒烟选择串有 ' + unmatched.length + ' 项没匹配到任何断言文件：' + unmatched.join(', ')
      + '\n  可选文件（前缀即可）：' + all.join(', '));
  }
  all.filter((f) => f.startsWith(WARMUP_PREFIX)).forEach((f) => picked.add(f));  // 规则②
  return all.filter((f) => picked.has(f));
}

module.exports = { parseSpec, selectFiles, WARMUP_PREFIX };
