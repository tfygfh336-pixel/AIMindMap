/* ============================================================
 * scripts/smoke-assertions.js —— 冒烟断言清单（入口，v0.7.0 从 main.js 提取；
 * 按功能分域拆分为 scripts/smoke/*.js，本文件**自动发现并按文件名顺序拼接**）
 *
 * main.js 的 --smoke 分支加载本清单逐条执行并汇总 PASS/FAIL。
 * **新增渲染层功能时，到对应分域文件（scripts/smoke/NN-*.js）追加一条断言**：
 *   { name: '描述', run: async (ctx) => ({ ok: boolean, text: string }) }
 * `ctx.exec(js)` 封装 win.webContents.executeJavaScript（返回 Promise）。
 * ctx.runCli(args) 跑一次 CLI 并拿回 stdout。
 *
 * ⚠️ **可选的第三态** `unverified: '<为什么本项未验证>'`（2026-10-12 加，域 39 的剪贴板判据先吃）：
 *   只在"环境坏了、真值根本采不到"时用 —— 它让这条结果**响亮地说"本项未验证"、不计入
 *   "通过/总数"、也不阻断**（形状照第八批"撕裂快照指纹采不到"那一档；计数在下面的 `tally()`）。
 *   两条铁律：① 它**只许**出现在 `ok === true` 的结果上（fail-safe，见 `tally()`）；
 *   ② 用之前先证明"这是**环境**问题而不是产品问题"——判据里要有一条**独立于产品链路**的环境探针
 *   （例：`scripts/smoke/39-item-detail.js` 的 `clipboardEnvProbe`：本进程直接 writeText→readText 往返，
 *   **不走**产品那条 IPC）⇒ 探针说可用而产品没写进去，照样**判红** ✓。
 *
 * ⚠️ **严格档 `MM_SMOKE_CLIP_STRICT`（2026-10-13 加，默认关）** —— 上面这套三态有一个已知盲区：
 *   **环境坏的时候，产品真回归会被降级成"未验证"**（探针说不可用 ⇒ 我们连"值对不对"都无从判）
 *   ⇒ 在 CI / 受控环境里想要"**宁可红，不许悄悄放过**"。开关的语义只有一条：
 *     · **关（未设 / `0` / `false`）** ⇒ 与加它之前**逐字节相同**（三个数、报文、退出码全都不动 ✓）；
 *     · **开（`1` / `true` / 裸写空串）** ⇒ `unverified` 那几条**如实打印、仍点名原因**，
 *       但**按失败计**（进 `failed`、进 `total`、并让退出码 ≠ 0）。
 *   解析只有一处（本文件导出的 `parseStrictEnv`，纯函数）：**值非法当场报错**，绝不静默当 false/true
 *   （照 `src/item-index.js` 的 `parseFlag` 先例）—— 一个写错的开关值若是静默失效，
 *   等于"你以为在受控环境里跑，其实没有"。接线（校验 / 响亮行 / 退出码）在 `main.js` 的 `runSmoke`。
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
 *   17-ui-polish.js       体验四项（行内 Markdown 加粗 / **折叠默认**：打开项目只展开根、`elementFromPoint`
 *                         判可见性 / 加减号尺寸 / 预览可用区）
 *   22-sidebar-gap.js     侧栏隔壁那道"灰色背景"（页面预留宽度 vs 原生侧栏实际宽度必须相等）
 *   23-dsh-only.js        「导图页 ✕ = **真关**」这条语义（卸载导图页、只留侧栏；重开 = 重新加载）
 *   24-sidebar-close.js   「保留主界面、独立关掉侧栏 DSH」+ 侧栏 ✕ = **真销毁视图**（viewEpoch +1）
 *   25-related-view.js    关联节点可视化（功能 2：按钮 → 高亮/虚化/缩放到刚好框住 + 关系虚线 + 点线按鼠标位置开笔记）
 *   26-ai-ask.js          节点悬浮工具条 + AI 问答浮窗（功能 1 界面层；冒烟里后端返回桩，不烧额度）
 *   18-overlay-sidebar.js 弹窗让位给 DSH 侧栏（原生 view 盖不住就躲开）+ PDF 缩放控制
 *   19-view-offset-pin.js 重排锚点保持（展开/收起不再整页瞬移）
 *   20-preview-buttons.js PDF 预览的缩放按钮与 ✕ 关闭（含"同 URL 异 hash 不重载"的机制取证）
 *   21-sidebar-first-paint.js 刚打开时工具栏不被侧栏盖住（首帧就得让位，不必先拖一下）
 *   27-import-doc.js      大文件导入成新项目（功能 5a 的界面入口：扩展名判定 + 真导入一条链）
 *   28-msgbar.js          下方消息栏（功能 5a 入口③：虚体字提示一字不差，空输入什么都不发）
 *   29-multiselect.js     多选与"整批问 AI"（用户反馈④⑥：**全部用真鼠标事件**走 Chromium 命中测试）
 *   30-sidebar-drop.js    ⑨「拖到面板最右侧 = 丢给 DSH 侧栏」的手势（拖不动要**如实说原因**）
 *   31-sel-outline.js     P5：真正被框选的节点各自画虚线描边（跨父也能同时上色）
 *   33-drag-sel-to-sidebar.js P4：框选后**直接**拖给侧栏（不进拖动模式；离右缘 80px 松手什么都不该发生）
 *   34-user-paths.js      「用户会怎么点」路径探针（用户 2026-10-08 复测；只用公开接口 MMApp/MM 驱动）
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
 *   38-ai-落盘.js         AI 产出**落到节点上**的界面侧（功能 1 的下半截）：盘上的字节 + 界面上的 DOM
 *   39-item-detail.js     条目层 v3 界面侧：详情框「逐条」呈现（清单/归属/复制）+ 保存与撤销不丢 items
 *                         两样都要判（只判 DOM 抓不到"界面说成功、盘上什么都没有"）
 *   40-heat-bars.js       详情框里的**两条热度条**（热度条第三件·A）：① 界面上的每一个数都与 CLI
 *                         `heat --json --node <id>` 逐字段相同（防"界面自己算一份"）；② 打开详情框**恰好**
 *                         多一条 `human-detail`、**重绘不记**、关掉重开才记，且项目目录/项目 JSON 逐字节不变
 *                         （看热度不留下写）；③ 零访问节点如实说"未访问"（不画成"热度 0"）；
 *                         ④ 回归：正文 DOM 逐字节等于 CLI 的 detail（"正文只有一份"没被碰坏）；
 *                         ⑤ 读数/采样失败都**响亮**（框里与状态栏各有可见提示）—— 采样那半边是
 *                         **真造**"日志写不进去"：一条**三档的梯子**（日志文件只读 / 日志那一格被目录
 *                         占住 / 原招：`.visits` 整格让开），**三档都造不出来 ⇒ 第三态"未验证"**
 *                         （响亮点名每一档为什么没成、不计入"通过/总数"、也不阻断）。
 *                         ⚠️ 本域**没有** `MM_SMOKE_INJECT` 键（渲染层注入实测无效，见该文件头）；
 *                         判别力证明靠"临时改产品代码那一轮"+ "临时让梯子造不出条件那一轮"
 *   41-collapse-default.js 折叠默认（用户 2026-10-13 反馈："新开的树/新编辑的子树应当默认折叠"）：
 *                         甲 新建节点是**折叠**的且盘上 `expanded` **键存在**（缺键=展开 ⇒ 靠省略折不起来）；
 *                         乙 三条导入路（md / project / dir）产生的新子树一律折叠，且 `import-md` 后
 *                            **父节点除 children 外逐字节未变**（父节点不许被顺带展开）；
 *                         丙 手动展开过的节点在**别处**被增量编辑 + 重开项目之后仍在（数据 + 视图两侧）
 *                            —— 这条守的是"把'新建即折叠'实现成每次写盘都整树 normalize"。
 *                         判据③（打开项目只展开根、`elementFromPoint` 判可见性）落在 17 域。
 *   42-bindings-ui.js     绑定工作区文件夹（R4 第④步「界面」+ 第⑥步「删除提议确认流」；引擎在第①②③步已落地）：
 *                         入口选目录 ⇒ **绑定前预览**（读数来自 CLI 既有 `--dry-run`，在一份**演练副本**上算 ⇒ 此刻用户
 *                         项目零写入）⇒ 真鼠标确认后节点出现；状态区（守护中/已暂停 · 上次同步 · 本次 +N 改 M ·
 *                         待确认删 K · 未转换 K）+ 暂停/立即同步/解绑三个按钮；变更播报**复用并发可见性那套**
 *                         banner 与面板渲染器，点一行跳到这次新增的那个节点。判据一律 `elementFromPoint`
 *                         命中测试 + 真鼠标输入 + **沙箱项目 JSON 逐字节**，并与 CLI 的 `--json` 报告对拍。
 *                         【第⑥步】待确认删 K 旁多一个入口 ⇒ **逐条点名**（名字/来源文件/来源节点）的面板 +
 *                         「确认删除这 N 个节点」/「稍后再说（什么都不做）」两个出口：确认前跑多少轮**盘上一个
 *                         节点都不许少**（逐字节），确认只走引擎那**一条**既有出口（`plan.confirmedNodeIds`）
 *                         ⇒ 恰好摘掉被确认的那些、提议清零、K 回 0、播报写清"按你的确认删掉了 N 个节点"；
 *                         提议**读不到**（旁路快照坏了）⇒ 状态区把 K 报成 `?` 并响亮说原因，确认**拒绝执行**。
 *                         ⚠️ 选目录那一跳在 `--smoke` 下是脚本化答案（无头跑点不动原生模态，界面会把
 *                         `stub:true` 如实显示出来）；其余每一跳都是产品真路径。
 *
 * ⚠️ **本索引是"断言注册面"**：新增一个 `scripts/smoke/NN-*.js` 就要在这里补一行 ——
 *   少了它，域**照样会跑**（自动发现），但接手者不知道它存在。由门禁 **S2** 判红
 *   （`node scripts/collateral-check.js`，表里那一行 = 改动类型「新增冒烟域」）。
 * ★ **判据纪律（写新断言前先读这一条）**：「可见性」断言**不得只用
 *   `getBoundingClientRect()` / 类名 / 计算样式** —— 该 API 对 `overflow` 裁切是**盲的**
 *   （本工程实测：一个被完全裁掉的圆钮，`rect` 报"在框外、在面板内"、断言全绿，
 *   而 `elementFromPoint(圆心)` 命中普通 DIV、真帧里 0 像素 ⇒ **看不见也点不到**）。
 *   要判"看得见"就用 ① `document.elementFromPoint(圆心)` 命中它自己，或
 *   ② 数真帧像素（`scripts/vision/frame-stats.js` 的 `scanRegion`）；
 *   `rect` **只用来判几何**（位置 / 尺寸 / 相对坐标）。范例：`scripts/smoke/37-圆钮工具栏绑定.js`。
 *
 * ★ **收尾纪律（动了 addNode/addTopic 的域必须读）**：`MMApp.addNode()`/`addTopic()` 会顺手
 *   打开「编辑节点」模态，而"每域隔离"收不掉 DOM 模态（它只还原项目数据 + 重开项目）
 *   ⇒ 那个框会**跨域存活**、盖住后面的真输入域（实测：域 16 一处漏关 ⇒ 域 36/37 连锁红 11 条）。
 *   收尾一律调本文件导出的共用工具：`require('../smoke-assertions.js').closeDialogs(ctx)`
 *   （渲染层的唯一实现在 `renderer/app-actions.js` 的 `closeAllDialogs`），并把条数写进报文。
 *   框架侧还有一道判据（`main.js` 的"域开始的干净前置"）：**谁没收拾干净，下一个域开始时判红并点名**。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const smokeDir = path.join(__dirname, 'smoke');

/** 只认「NN-名字.js」这一种命名，字典序即数字序 */
const files = fs.readdirSync(smokeDir)
  .filter((f) => /^\d+-.+\.js$/.test(f))
  .sort();

/* ================= 冒烟断言的**共用工具**（只放"每个域都要做、做错了会互相污染"的那件事） =================
 * `mm.closeDialogs(ctx)`：收干净**产品自己打开的模态**（`window.MMApp.closeAllDialogs`，唯一实现在
 * `renderer/app-actions.js`；渲染层侧一行 DOM 都不重复写 ✓）。
 *
 * 为什么必须有这么一个共用入口（它是本轮修的一个**真事故**的收口）：
 *   `MMApp.addNode()` / `addTopic()` 会**顺手打开**「编辑节点」模态（产品行为，没错），
 *   而冒烟里的"每域隔离"只还原**项目数据文件 + 重开项目** ⇒ DOM 模态**跨域存活**：
 *   域 16 的 `addNode` 留下的编辑框盖住画布 ⇒ 域 36/37（真鼠标输入 + `elementFromPoint`）
 *   连锁红 11 条（报文 `点不到 comp-net …→DIV.dialog-box`），而那两个文件一行都没改过 ✗。
 *   全量跑当时还绿，只是因为后面的域**各自顺手**擦桌子（12-dsh-drag 扫 `.overlay`、
 *   27-import-doc 点 `edit-cancel`）—— 五份拷贝、各写各的，于是必然有域漏掉（实测漏了 4 个）✗。
 *
 * 用法（**任何**动了 `addNode`/`addTopic` 的域都要在断言体结束前调一次，并把 `n` 写进报文）：
 *   const mm = require('../smoke-assertions.js');
 *   const cleaned = await mm.closeDialogs(ctx);     // → { n, names }
 * 框架侧对应的是 main.js 的"域开始的干净前置"（**那一层是判据**：有残留 ⇒ 该域判红并点名）——
 * 两者分工：域自己收尾（这里）；框架保证"谁没收尾"会被看见（main.js）。
 * ⚠️ 只收模态/浮层（`.overlay` 一族 + 命令面板 + 审计面板）；浮动详情框、选区块、大小锁
 *    是**另一类**状态，不在它的责任内（那些由各自的域收拾）。
 *
 * ⚠️⚠️ **它必须在本文件 `require` 各分域之前挂上**：分域文件在**加载期**就 `require` 本文件
 *   拿这个函数（Node 的循环 require 会把"当前已填好的那份 exports"给它）——挂晚了拿到的是
 *   `undefined`，域一跑就是 `mm.closeDialogs is not a function`（实测踩到：5 个域一起红 ✗）。
 *   这也是本文件唯一一处"先给工具、后 require 分域"的顺序约束。 */
module.exports.closeDialogs = async function closeDialogs(ctx) {
  const raw = await ctx.exec('(function () { return (window.MMApp && window.MMApp.closeAllDialogs)'
    + ' ? window.MMApp.closeAllDialogs() : []; })()');
  const list = Array.isArray(raw) ? raw : [];
  return { n: list.length, names: list.map((d) => d && d.name).filter(Boolean) };
};

/** 每个文件各自的断言（供"单跑"选择器按文件取子集；仍是纯数据）
 *  ⚠️ 顺序：必须在上面挂好 `closeDialogs` **之后** —— 分域文件加载期就会用它 ✓ */
const groups = files.map((f) => ({ file: f, assertions: require(path.join(smokeDir, f)) }));

const assertions = [].concat(...groups.map((g) => g.assertions));

module.exports = assertions;
// 单跑（SMOKE_ONLY / --smoke-only）用：文件清单与分组。
// 注意 `.length` 仍然等于**全量**断言数 —— `scripts/doc-facts.js` 的冒烟真值就是它，
// 不能因为加了单跑而改变（改的是"跑哪些"，不是"有多少条"）。
module.exports.files = files;
module.exports.groups = groups;

/* ================= 冒烟「严格档」开关的解析（纯函数，零副作用 ⇒ 可被单测引入 ✓） =================
 * 环境变量只有一个名字：`MM_SMOKE_CLIP_STRICT`（名字的来历：域 39 的剪贴板判据是最先吃三态、
 * 也是"环境坏会把真回归洗成未验证"这个盲区第一次被看见的地方；它管的是**所有**域的第三态）。
 * 接受的值**只有下面这几种**，别的**当场报错**（让调用方 exit 1，不许静默落回某一档）：
 *   · 未设 / `undefined` / `null` ⇒ **关（默认）**，且**一条额外输出都不打** ⇒ 与加这个开关之前逐字节相同 ✓
 *   · `0` / `false` ⇒ 关（显式关：与默认档走同一条路径，也不打额外输出）
 *   · `1` / `true` / 空串（**裸写**：`bash` 里 `MM_SMOKE_CLIP_STRICT= npm run smoke` 拿到的就是空串）⇒ 开
 *   · 其它（`nonsense` / `yes` / `2` / `True` …）⇒ `{ok:false}` ⇒ 调用方**当场报错 + exit 1**
 * 为什么把值收窄（照 `src/item-index.js` 的 `parseFlag` 先例）：一个写错的开关值若被静默当成 false，
 * "我这一轮真的在严格档里跑"就永远不成立 —— 而这正是**没人会去核对**的那一类静默失效 ✗。
 * @param {string|boolean|undefined|null} raw 环境变量的原值（**由调用方读**：本函数不碰 `process.env` ✓）
 * @returns {{ok:boolean, strict:boolean, reason:string}}
 */
module.exports.parseStrictEnv = function parseStrictEnv(raw) {
  if (raw === undefined || raw === null) return { ok: true, strict: false, reason: '' };
  if (raw === true || raw === '' || raw === '1' || raw === 'true') return { ok: true, strict: true, reason: '' };
  if (raw === false || raw === '0' || raw === 'false') return { ok: true, strict: false, reason: '' };
  return { ok: false, strict: false,
    reason: '只能是 1 / true / 空串（裸写=开）或 0 / false（关），收到 ' + JSON.stringify(String(raw)) };
};

/* ================= 冒烟结果的**三态计数**（纯函数，零副作用 ⇒ 可被单测引入 ✓） =================
 * 为什么需要第三档（真实形状，2026-10-12）：域 39 的剪贴板判据在本机**稳定红**，
 * 而根因是**环境**（系统剪贴板不可用：主进程写后回读为空，同机 `Get-Clipboard` 与
 * `[System.Windows.Forms.Clipboard]::GetText()` 两个独立 API 也全都失败）。这种红既不是产品缺陷，
 * 也不该静默当通过 —— 它把全链按在 13/14 连着好几批，而两边都是错的答案。
 * 口径（照第八批"撕裂快照指纹采不到"那一档）：**采不到真值 ⇒ 响亮说"本项未验证"、不计入、不阻断**。
 *
 * 三档 = { 通过, 失败, 未验证 }（`B4c`：数数型判据也要数清"能输出几种判定"）：
 *   · `ok:true` 且**没有** `unverified` ⇒ 通过（进分子分母）；
 *   · `ok:true` 且**有** `unverified`   ⇒ **未验证**（两个数都不进！只进第三个计数）；
 *   · `ok:false`（哪怕同时带了 `unverified`）⇒ **失败** —— **fail-safe**：`unverified` 只允许出现在
 *     通过的结果上；一条结果既说"未验证"又说"失败"时**按失败计**，绝不能让"未验证"变成掩盖真失败的后门
 *     （本工程最重的损害类别："没做，却看不出没做"）。
 *
 * **严格档**（`opts.strict`，对应环境变量 `MM_SMOKE_CLIP_STRICT`，默认关）：`unverified` 那一档
 * 从"两个数都不进"改成"**进失败**"（`failed` +1、`total` +1、`unverified` 照样单独计数并列出原因）
 * —— 这就是"宁可红，不许悄悄放过"。两档用的是**同一个函数**，不许在别处再算一份（`B1`）。
 * ⚠️ 默认档（`opts` 不给 / `strict` 假）**一个字节都不许变**：它是既有口径，改了就是改读数。
 *
 * @param {Array<{ok?:boolean, unverified?:string}>} results
 * @param {{strict?:boolean}} [opts] 不给 ⇒ 默认档（未验证不进通过/总数，见上面口径）
 * @returns {{passed:number, failed:number, unverified:number, total:number, unverifiedList:string[]}}
 *   `total` = **参与计数**的条数（= passed + failed）；默认档**不含**未验证，严格档**含**（它已进 failed）；
 *   `unverifiedList` 给"响亮行"用（**两档都照列**：严格档也要看得见"是哪几条、为什么"）。
 */
module.exports.tally = function tally(results, opts) {
  const strict = !!(opts && opts.strict);
  const list = Array.isArray(results) ? results : [];
  let passed = 0;
  let failed = 0;
  let unverified = 0;
  const unverifiedList = [];
  list.forEach((r) => {
    const ok = !!(r && r.ok);
    const why = (r && typeof r.unverified === 'string' && r.unverified) ? r.unverified : null;
    if (ok && why) {
      unverified++;
      unverifiedList.push(why);
      if (strict) failed++;      // 严格档：未验证**按失败计**（不再有"两个数都不进"的第三档）
      return;                    // 默认档：不计入通过/总数（见上面口径）
    }
    if (ok) { passed++; return; }
    failed++;                                                            // fail-safe：ok:false 一律算失败
  });
  return { passed: passed, failed: failed, unverified: unverified, total: passed + failed,
    unverifiedList: unverifiedList };
};

/* ================= 冒烟断言的**共用工具**（只放"每个域都要做、做错了会互相污染"的那件事） =================
 * `mm.closeDialogs(ctx)`：收干净**产品自己打开的模态**（`window.MMApp.closeAllDialogs`，唯一实现在
 * `renderer/app-actions.js`；渲染层侧一行 DOM 都不重复写 ✓）。
 *
 * 为什么必须有这么一个共用入口（它是本轮修的一个**真事故**的收口）：
 *   `MMApp.addNode()` / `addTopic()` 会**顺手打开**「编辑节点」模态（产品行为，没错），
 *   而冒烟里的"每域隔离"只还原**项目数据文件 + 重开项目** ⇒ DOM 模态**跨域存活**：
 *   域 16 的 `addNode` 留下的编辑框盖住画布 ⇒ 域 36/37（真鼠标输入 + `elementFromPoint`）
 *   连锁红 11 条（报文 `点不到 comp-net …→DIV.dialog-box`），而那两个文件一行都没改过 ✗。
 *   全量跑当时还绿，只是因为后面的域**各自顺手**擦桌子（12-dsh-drag 扫 `.overlay`、
 *   27-import-doc 点 `edit-cancel`）—— 五份拷贝、各写各的，于是必然有域漏掉（实测漏了 4 个）✗。
 *
 * 用法（**任何**动了 `addNode`/`addTopic` 的域都要在断言体结束前调一次，并把 `n` 写进报文）：
 *   const mm = require('../smoke-assertions.js');
 *   const cleaned = await mm.closeDialogs(ctx);     // → { n, names }
 * 框架侧对应的是 main.js 的"域开始的干净前置"（**那一层是判据**：有残留 ⇒ 该域判红并点名）——
 * 两者分工：域自己收尾（这里）；框架保证"谁没收尾"会被看见（main.js）。
 * ⚠️ 只收模态/浮层（`.overlay` 一族 + 命令面板 + 审计面板）；浮动详情框、选区块、大小锁
 *    是**另一类**状态，不在它的责任内（那些由各自的域收拾）。
 */
module.exports.closeDialogs = async function closeDialogs(ctx) {
  const raw = await ctx.exec('(function () { return (window.MMApp && window.MMApp.closeAllDialogs)'
    + ' ? window.MMApp.closeAllDialogs() : []; })()');
  const list = Array.isArray(raw) ? raw : [];
  return { n: list.length, names: list.map((d) => d && d.name).filter(Boolean) };
};
