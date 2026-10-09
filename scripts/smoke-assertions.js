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
 *   16-local-path.js      节点「本机文件夹」链接（localPath：CLI 设 → 界面可点 → 保存不丢 → 点错会报错）
 *   17-ui-polish.js       体验四项（行内 Markdown 加粗 / 展开状态以数据为准 / 加减号尺寸 / 预览可用区）
 *   25-related-view.js    关联节点可视化（功能 2：按钮 → 高亮/虚化/缩放到刚好框住 + 关系虚线 + 点线按鼠标位置开笔记）
 *   26-ai-ask.js          节点悬浮工具条 + AI 问答浮窗（功能 1 界面层；冒烟里后端返回桩，不烧额度）
 *   18-overlay-sidebar.js 弹窗让位给 DSH 侧栏（原生 view 盖不住就躲开）+ PDF 缩放控制
 *   19-view-offset-pin.js 重排锚点保持（展开/收起不再整页瞬移）
 *   20-preview-buttons.js PDF 预览的缩放按钮与 ✕ 关闭（含"同 URL 异 hash 不重载"的机制取证）
 *   21-sidebar-first-paint.js 刚打开时工具栏不被侧栏盖住（首帧就得让位，不必先拖一下）
 *   35-rel-edit.js        关联视图的「关联信息」编辑条（加/删链接 + 新建关联笔记；写操作经 CLI 且写完回读同步内存）
 *   36-real-input.js      **真输入域**：用 `webContents.sendInputEvent` 发真实鼠标/键盘（走 Chromium 命中测试 ✓，
 *                         不是 `dispatchEvent` 合成事件）+ `capturePage` 截图证据（落 `.review/…/shots/`，可判读、
 *                         前后差分、与读数同源）。底座与用法见 `scripts/smoke-input.js` 文件头；
 *                         本域锁 5 条真机契约：①真点中 <jmnode> ②Ctrl 加选 3 个都真的带虚线描边且无大框
 *                         ③再点一次真能取消加选（N 回落）④「💬 问这 N 个」的 N = 真送出去的集合
 *                         ⑤点空白清选区不留残影。判别力证明：`MM_SMOKE_INJECT=<key>`（见该文件头）
 *   37-圆钮工具栏绑定.js   圆钮 🔗 与悬浮工具条和**节点详情框严格绑定**：同生命周期 / 同渲染时机与坐标
 *                         （位置只由框的几何推导）/ **大小锁（🖥）时关工具条、留圆钮且几何不变**；
 *                         并钉住"圆钮被框自己的 overflow 裁掉"这个真因（它一度是"断言全绿但看不见"）。
 *                         判别力证明：`MM_SMOKE_INJECT=37-<key>`（7 个键，见该文件头）
 *
 * ★ **判据纪律（写新断言前先读这一条）**：「可见性」断言**不得只用
 *   `getBoundingClientRect()` / 类名 / 计算样式** —— 该 API 对 `overflow` 裁切是**盲的**
 *   （本工程实测：一个被完全裁掉的圆钮，`rect` 报"在框外、在面板内"、断言全绿，
 *   而 `elementFromPoint(圆心)` 命中普通 DIV、真帧里 0 像素 ⇒ **看不见也点不到**）。
 *   要判"看得见"就用 ① `document.elementFromPoint(圆心)` 命中它自己，或
 *   ② 数真帧像素（`scripts/vision/frame-stats.js` 的 `scanRegion`）；
 *   `rect` **只用来判几何**（位置 / 尺寸 / 相对坐标）。范例：`scripts/smoke/37-圆钮工具栏绑定.js`。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const smokeDir = path.join(__dirname, 'smoke');

/** 只认「NN-名字.js」这一种命名，字典序即数字序 */
const files = fs.readdirSync(smokeDir)
  .filter((f) => /^\d+-.+\.js$/.test(f))
  .sort();

/** 每个文件各自的断言（供"单跑"选择器按文件取子集；仍是纯数据） */
const groups = files.map((f) => ({ file: f, assertions: require(path.join(smokeDir, f)) }));

const assertions = [].concat(...groups.map((g) => g.assertions));

module.exports = assertions;
// 单跑（SMOKE_ONLY / --smoke-only）用：文件清单与分组。
// 注意 `.length` 仍然等于**全量**断言数 —— `scripts/doc-facts.js` 的冒烟真值就是它，
// 不能因为加了单跑而改变（改的是"跑哪些"，不是"有多少条"）。
module.exports.files = files;
module.exports.groups = groups;
