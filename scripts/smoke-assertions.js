/* ============================================================
 * scripts/smoke-assertions.js —— 冒烟断言清单（入口，v0.7.0 从 main.js 提取；
 * 按功能分域拆分为 scripts/smoke/*.js，本文件**自动发现并按文件名顺序拼接**）
 *
 * main.js 的 --smoke 分支加载本清单逐条执行并汇总 PASS/FAIL。
 * **新增渲染层功能时，到对应分域文件（scripts/smoke/NN-*.js）追加一条断言**：
 *   { name: '描述', run: async (ctx) => ({ ok: boolean, text: string }) }
 * ctx.exec(js) 封装 win.webContents.executeJavaScript（返回 Promise）。
 * ctx.runCli(args) 跑一次 CLI 并拿回 stdout。
 *
 * ── 为什么是"自动发现"而不是硬编码 require 列表 ──
 * 原先是一串手写的 `require('./smoke/NN-*.js')`。它有一个**静默失效**模式：
 * 新增 `scripts/smoke/NN-*.js` 却忘了在本文件登记时，该文件的断言**一条都不会跑**，
 * 而且计数（`module.exports.length` → 写进 `docs/VERIFY.md` 的"冒烟断言"）
 * 也一起少掉 —— 从输出上**看不出任何异常**，只会以为"冒烟少了点东西"。
 * 这与本工程已修过的几次是同一种病：**没做，却看不出没做**
 * （`--brief` 在文本模式是空操作、`--detail` 在 read 上是空操作、
 *  G6 曾"真值算不出来就跳过"却照样宣称一致）。
 * 改为自动发现后，**新文件天然生效**，不存在"忘了登记"这一步。
 *
 * 顺序即契约：`01-`…`07-` 是拆分前 45 条断言的原始先后顺序（前缀零填充 ⇒
 * 字典序 == 数字序，与原先手写顺序逐条一致），**不得调整**；`08-` 起为后续新增，追加在末尾。
 *
 * 分域文件（仅索引，不再用于登记）：
 *   01-core.js          核心加载与视图基线
 *   02-detail-media.js  详情图片 / 灯箱 / 序列化 / 内存态编辑
 *   03-edit-search.js   编辑入口与检索
 *   04-detail-box.js    浮动详情框的布局与锁定
 *   05-pan-lock.js      拖动/平移边界与锁切换
 *   06-topic-theme.js   顶层主题、主题模式与窗口尺寸
 *   07-data-safety.js   数据安全、保存链路与隔离
 *   08-audit-palette.js 关系审计面板与命令面板（Ctrl+P）
 *   09-save-persistence.js 保存落盘与未保存改动保护
 *   10-assoc.js         关联笔记二级页面与「保存不丢 assoc」回归
 *   11-dsh-sidebar.js   DSH 侧边栏（容器/让位机制；真实孵化由 dsh:e2e 单独覆盖）
 *   12-dsh-drag.js      拖宽分隔条机制（宽度跟随链路 + IPC 健壮性）
 *   13-ui-state.js      「写前协调」通道（渲染层脏标记 → 磁盘 → CLI ui-state）
 *   14-headless-window.js 离屏窗口契约（隐藏 + 隐藏仍出帧，见 main.js createWindow）
 *   15-write-conflict.js  多路同时编辑（GUI 侧：**不相交自动合并** / 撞同一对象才拒绝且盘上不动）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const smokeDir = path.join(__dirname, 'smoke');

/** 只认「NN-名字.js」这一种命名，字典序即数字序 */
const files = fs.readdirSync(smokeDir)
  .filter((f) => /^\d+-.+\.js$/.test(f))
  .sort();

const assertions = [].concat(...files.map((f) => require(path.join(smokeDir, f))));

module.exports = assertions;
