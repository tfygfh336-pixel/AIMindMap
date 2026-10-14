/* ============================================================
 * scripts/smoke/40-heat-bars.js —— 详情框里的两条热度条（热度条第三件 · A 块）
 * ------------------------------------------------------------
 * ## 这个域防的是哪几种损害（每条断言都对应一种）
 *
 * ① **界面自己算热度 ⇒ 与 CLI 显示不一致**（"同一事实两处表达"在本件的形态）：
 *    热度是"名次 → 十档"，口径只在 `src/heat.js`。若渲染层自己在 `human`/`ai` 数组里找节点、
 *    自己算分位，改一次映射两边就分叉 —— 而且**看不出来**（界面照样画得挺好看）。
 *    ⇒ 断言①把"界面上的 `data-heat`/`data-bands`/`listed`/样本量"与 CLI 的
 *    `heat --json --node <id>` **逐字段对拍**（界面显示的就是 CLI 给的那一份）。
 *
 * ② **看热度留下写 / 触发保存**（用户只是看热度，不该有写）：两条热度条是**展示**，
 *    唯一允许的写是"往访问日志追加一行"（旁路产物，在项目目录**之外**）。
 *    ⇒ 断言②：① 打开详情框**恰好**多一条 `human-detail`；② 框内重绘**零增长**；
 *    ③ 关掉重开才再来一条；④ 项目目录清单与项目 JSON 在全程**逐字节不变**、无未保存标记。
 *
 * ③ **"没被访问过"被画成"热度 0"**（"采不到"与"真的是 0"必须可分辨）：
 *    ⇒ 断言③取一个"该通道从没访问过"的节点（日志里该侧事件为 0 **且** CLI 读数 `listed:false`
 *    两个条件同时成立才用它），要求界面**明说未访问**。
 *
 * ④ **"正文只有一份"被顺带破掉**（本工程铁律：`dc.innerHTML = detail` 是正文唯一来源）：
 *    ⇒ 断言④：详情框正文的 DOM **逐字节等于** CLI `get --json --detail` 的那一份（过浏览器解析器后比）。
 *
 * ⑤ **失败被静默吞掉**（"没记上"与"记上了"分不出来）：埋点失败必须**响亮**。
 *    ⇒ 断言⑤**真造两份失败条件**（不用桩：渲染层注入实测无效，见文末那一段）：
 *    ① 往日志里塞一行截断的 JSON ⇒ 框里必须出现"热度读不出来"；
 *    ② 把"日志那一格"弄成**写不进去** ⇒ 状态栏必须出现**红色**错误提示（"没能记进访问热度"）。
 *    ⚠️ ② 造条件是**三档的梯子**，三档都造不出来时走**第三态**（如实的"本项未验证"）：
 *    第十九批实测 —— `fs.renameSync(<`.visits` 目录>)` 在 %TEMP% 里**间歇** `EPERM`
 *    ⇒ 故障条件根本没造出来，而旧口径**硬红**（报文只有 `② 日志路径被堵住=false`）✗。
 *    口径、等价性论证与判别力证明见文末"三档一起声明""三档为什么等价""判别力证明"三节。
 *
 * ## 探针与自收尾
 *   探针项目 `smoke-heat-40` 建在**冒烟沙箱副本**里（`AI_MINDMAP_PROJECTS_DIR`）⇒ 真实 `projects/` 零触碰；
 *   访问日志落在沙箱根的 `.visits/` 下（**在项目目录之外** —— 这正是"只读路径在项目目录内零字节"
 *   那条不变量的形状）。
 *   本域**自建自删**，跑完切回原项目，不留脏状态给后续域。
 *
 * ## 两条测法上的坑（写在这里，免得下一个人再踩）
 *   · **不能只数"热度条有没有两行"**：`showDetail` 复用跟随框，上一位节点留下的那两行**还在 DOM 里**，
 *     只判行数会把**旧读数**当新读数（实测报过一次假红）。所以行上带 `data-node`（画的是哪个节点）。
 *   · **只判 `data-node` 还不够**：同一个节点、**更早时刻**取回来的那一份也是"名字对、内容旧"。
 *     所以再等一步"**这一份稳定下来**"（`waitStableBars`：连续两次读数一模一样 ⇒ 没有更大的饼在路上）。
 *     第一版等的是"行文本变了"——**实测假红**：`showNode` 里那句 `SETTLE`（300ms）通常已经等过了
 *     取数与重画 ⇒ 文本早在读基线之前就变完了，"等它变"永远等不到。
 *
 * ## 改版批（2026-10-16）：热度条搬进「标题框」（血条形态）+ 信息改走**悬停**
 *   **用户原话（第一轮）**：「热度条只用两个很细的长横着的颜色条，类似游戏里面血条的效果，放在节点详情的
 *   "标题框"里面，也就是大小锁左边和节点名字右边。」
 *   **用户原话（追加，优先级更高）**：「新热度条 UI 设计就不需要打印文字信息在旁边了，信息靠鼠标悬停在
 *   热度条上显示，尽可能利用好节点详情标题框」。
 *   · **改了**：① 位置从"标题框下面的正文区里两行「人/AI + 十格 + 数值」"搬到**标题框内**（DOM 上
 *     `.fd-heat` 从 `.fd-scroll` 挪进 `.fd-head`，在名字与 `.fd-head-btns` 之间）；
 *     ② 形态改成**两根 3px 的长横条**（底槽 + 按比例填充）；
 *     ③ **条带上零文字**：数值 / 口径 / 样本量只在那层**悬停才画出来**的**应用自绘**浮层
 *     `.fd-heat-tip` 里（**不是**原生 `title` —— 原生弹窗是操作系统级的，无头截图/真帧里抓不到
 *     ⇒ 证不出来 ✗），无障碍名字走 `aria-label` ✓。
 *   · **没改（判据盯着）**：数值与颜色映射一个字节都没动 —— 填充比例仍是读数给的 `bands / bandMax`
 *     （改版前是"亮 bands 格"，同一个分数；那一次除法交给 CSS 的 `calc()` 算）；两个颜色仍是原来那两颗
 *     语义色（人 `#1664ff` / AI `#ff7d00`）；数值串（`档/档位总数（事件数）` · `#名次` · 窗口样本量那一句）
 *     **一个字都没改**（只是不再印在标题框里）。渲染层仍是**一处实现**（`renderRow` + `attachTip`，
 *     空槽走 `renderEmptySlots`）。
 *   · ⚠️ **一处要如实说明的边界**：浮层元素**挂在那一行内部**（默认 `hidden`），所以"行"里仍有**一个
 *     文字子节点**（它不画任何像素：矩形 0×0、命中不到、真帧里 0 像素 —— 判据⑩ 逐条判）。
 *     为什么不能把它挪出去：`tests/heat-bars.test.js` 的 A1/A2 判的是 `row.textContent` 含数值
 *     （改版前"行内印字"那份 DOM 契约，本批**不许改那个文件**）—— 用户要的是"别把字**印**在标题框里"，
 *     不是"DOM 里不许有字" ⇒ 可见性判据全部落在**真帧像素 + 命中测试**上 ✓。
 *
 * ## 改版批新增的七条判据（⑦–⑬，全部只读；读数底座在文件中部那几个函数里）
 *   ⑦ **位置**：两根条都落在标题框矩形内；**名字右缘 ≤ 条左缘**、**条右缘 ≤ 大小锁左缘**；
 *      条中心的 `elementFromPoint` 命中 `.fd-heat` 内的元素（判"看得见"用命中测试，不用 rect ✗）。
 *   ⑧ **形态**：每条高 2–4px（本实现取 3px：2px 在 1x 下贴着噪点、4px 已读成"块"）、
 *      宽 ≥ **标题框宽的 25%**（默认面板 380px ⇒ 标题框内容宽 ~348 ⇒ 25% = 87px，正对 CSS 那条
 *      `min-width: 88px` 的地板 ⇒ 阈值与实现同一口径）；两根**上下叠**（并排会各自变短）；
 *      两条颜色**从真帧最饱和像素采样**（BGRA，通道序见 `scripts/vision/window-shot.js`）：
 *      人须 B 主导、AI 须 R 主导、两条主通道必须不同 —— **不读 CSS** ✗。
 *   ⑨ **比例可判 + 随值改变**：`填充宽 ÷ 槽宽 ≈ bands / bandMax`（容差 2 个百分点：矩形是小数像素、
 *      实测偏差 ≪ 0.5%；而一个档位 = 10 个百分点 ⇒ 有分辨力）；再**真改一个值**
 *      （CLI `visit` 往访问日志加事件 ⇒ 名次/档位真的变，走的是产品自己那条写路径）⇒ 比例随之改变
 *      （证不是空转 ✓）。
 *   ⑩ **条带无文字**：track 子节点只有填充（文字节点 0）· 热条 DOM 里**没有一个原生 `title`** ·
 *      没悬停时浮层**不画**（矩形 0×0、`elementFromPoint` 命中不到它）· **真帧**两处采样：
 *      条带内非调色板像素 ≤ 1%、**标题框空档**（整条标题框挖掉名字与三颗按钮）内 ≤ 0.5%
 *      —— "调色板"= 底槽灰 / 两色填充 / 它们与浅底的抗锯齿混合（判法：三通道都 ≥ 200，或极差 ≥ 60
 *      且主通道是 B / R）；文字色 `#4e5969`（极差 27）与 `#a9aeb8`（极差 15）两条都不满足 ⇒ 会被数出来 ✓。
 *   ⑪ **悬停真出现**（真鼠标，`ctx.input.moveTo`）：停到第一根条上 ⇒ 浮层 `hidden=false`、
 *      **`elementFromPoint(浮层中心)` 命中它自己**、**真帧逐像素比有变化**（实测 7000+ 像素）；
 *      换到第二根条 ⇒ 换的是**另一颗条的浮层**（文案以另一个量开头）；移开 ⇒ 全部 `hidden=true`、
 *      矩形 0×0、命中测试回到条、**真帧差值回到 0**（"消失"也是像素级的，不是 DOM 自证 ✓）。
 *   ⑫ **文案可读且正确**：悬停后读到的浮层文本里能读到**两个量的名字与数值**（人 / AI 各自
 *      `档/档位总数（次数） · 名次 #N`）与窗口样本量，逐项与**画这份 DOM 用的那一份读数现算对拍**
 *      （一个字都不写死）。⚠️ 真值取**画这份 DOM 用的那一份载荷**（`readGeo` 同一快照）—— 面板每取数
 *      都会记一条 `ai-read-view`，拿"现读的 CLI"比"早先画好的 DOM"必然差几条（实测假红过一次）✗。
 *   ⑬ **无回归**：标题框高 = 本批改前实测 **33px**，且**把 `.fd-heat` 藏起来再量一次仍是 33**
 *      （差分 ⇒ 条不参与高度）；名字/锁/关闭的矩形在"藏/显"两态**逐项相同**（条只吃空档、
 *      不挤名字、不推锁）；**把浮层强开再量**：标题框/名字/面板/正文区逐项不变（浮层不扰动版式 ✓）；
 *      两把锁 `elementFromPoint` 仍命中自己；名字仍是 `nowrap + ellipsis`；
 *      正文区首元素贴在正文区顶（= 内边距 10px ⇒ **没有残留空档**）；面板高 = 标题框 + 内容 + 2 边框
 *      （⇒ 没有别的元素被顺带改动）。
 *
 * ## 改版批的实测基线（**改前**，同一台机、同一探针；供 ⑬ 与 CHANGELOG 引用）
 *   标题框 `[342,436,378,33]`（高 **33px**）· 名字 `[354,443.5,104,17]` · 两把锁
 *   `[629.7,443,26.48,18] / [658.19,443,22,18]` · 关闭 `[682.19,443,19.81,18]` ·
 *   面板高 **311.94px** · 正文区内容高 277 · 被搬走的热度块高 **73**（+ 下边距 8 = **81**）。
 *   改后（同一探针）：标题框仍是 `[342,436,378,33]`、名字/锁/关闭矩形逐项相同；两条 = 高 3px、
 *   宽 155.7px（占标题框宽 **41.2%**）；面板高 311.94 → 230.94（**只少了被搬走的那 81px**，
 *   正文区其余元素与原样**只有一个共同的上移量**）—— 这是"把条搬进标题框"的必然结果，
 *   不是别的元素被动了 ✓（也是本批**唯一**的几何变化，⑬ 的报文里如实印出来）。
 *
 * ## 改版批的判别力证明（**三条**，都**临时改产品代码**那一轮；照本域既有的规矩）
 *   ① **填充恒 100%**（`fillWidth()` 恒返回 `calc(100% * 1)`）⇒ **只有判据⑨红**（其余全绿 ✓）；
 *   ② **把浮层改挂原生 `title`**（不建自绘浮层、不挂悬停开关）⇒ 判据⑪必红（浮层不出现、
 *      真帧差 0 像素；同一条损害还被 ⑩"原生 title 计数"与 ⑫"悬停读不到文案"各抓一次 ✓）；
 *   ③ **在条上印一句可见文字**（行内绝对定位一个 11px 深灰 span）⇒ 判据⑩必红：真帧条带
 *      **3.33%** 非调色板像素、标题框空档 **3.14%**，越界像素样本 `105,89,78` 正是文字色
 *      `#4e5969` 的 BGRA（同一条损害还会把悬停抢走 ⇒ ⑪ 也红，如实报）。
 *   三次改完都 `sha256` **逐字节还原**并复绿；实测报文见交付说明（本批的 CHANGELOG 段）。
 *
 * ## 未做 / 未核实（如实写在这里，免得下一个人以为验过了）
 *   · **真机观感**（3px 条在 125%/150% 缩放下像不像"血条"、浮层的字号/留白好不好看）只有人能判；
 *     本域判的是几何、比例、像素颜色、悬停三态与文案一致性这几件可机械判定的部分。
 *   · 浮层**只由鼠标悬停驱动**（`mouseenter`/`mouseleave`；移开**立刻**消失，不做延时）；键盘/读屏
 *     走 `aria-label`（不是"打印文字" ✓），没有做键盘焦点触发 —— 没验过、也没做，如实写在这里。
 *   · 条**不吃键盘事件**；标题框仍是拖动把手 —— 按在条上拖框与按在名字上一致（沿用改版前的行为）。
 *
 * ## 判别力证明（新断言先注入一次违规、确认变红、再撤销）
 *   ① **界面自己算**：把 `renderer/app-heat-bars.js` 里写 `data-heat` 的那个值 +1
 *      ⇒ **断言①必红**，还原后复绿；
 *   ② **多记一次**：把 `app-detail.js` 的 `MM.heatBarsRecordVisit(node)` **从 showDetail 里**
 *      挪到 `app-detail-content.js` 的 `renderFdBox` 里（= 每次重绘都记一次）⇒ **断言②必红**。
 *   两条的实测报文见交付说明（`.review/20261012-热度条/S3-交付与读数.md`）；
 *   产品代码还原后 sha256 逐字节回到原值（`b321009516f8f30b` / `99171b3d19a9a703` / `55397a2243eff40a`）。
 *
 * ## 三档一起声明：这条判据"能判红 / 只报告 / 跳过"三种结局（2026-10-13 加）
 * 断言⑤的第 ② 档（采样失败必须响亮）在**造故障条件**这一步上曾经把环境问题判成了产品问题，
 * 所以它的能力边界**三档一起写明**（F19：采不到真值 ≠ 红 ≠ 绿）：
 *   · **判红**：故障条件**真造出来了**（每一档造完都**当场自证**：自己往那一格追加一行、**抛错才算数**），
 *     而界面上没有响亮的失败读数 ⇒ 产品回归，红 ✓；
 *   · **通过**：条件真造出来 + 界面上既有框里的读数提示、又有状态栏的**红色**提示 ✓；
 *   · **未验证**（第三态）：**三档都造不出"写不进去"**（各试一遍 + 隔 250ms 再走一遍）⇒
 *     响亮打印"本项未验证 + **每一档为什么没成**"、**不计入"通过/总数"、也不阻断**
 *     （计数口径只在 `scripts/smoke-assertions.js` 的 `tally()`；形状照域 39 剪贴板那一档、
 *     以及第八批"撕裂快照指纹采不到"那一档）。
 * 两条纪律（第三态最容易变成后门的地方，所以写在这里）：
 *   ① **跳过必须与通过可区分** —— 那一条在输出里是 `[未验证]` 而不是 `[PASS]`，而且汇总行把
 *      "通过 / 总数 / 未验证"**三个数**都印出来（`main.js` 打印；未验证的那条**从两个数里分出去**）✓；
 *   ② **fail-safe** —— `unverified` 只在"另一档（坏日志 ⇒ 可见提示）**真的通过**"时才给；
 *      同一批里另一档没过 ⇒ 照样**判红**（不许拿"环境坏了"当真缺陷的挡箭牌 ✗）。
 *
 * ## 三档为什么等价（"原本要防的损害"一个字都没换）
 *   原判据防的是：**日志写不进去时，产品必须把这次失败说出来**（`app:visit` 失败 ⇒ 状态栏红色提示，
 *   不许静默吞掉）。三档 —— ① **日志文件只读**（chmod 0444）/ ② **日志那一格被一个目录占住** /
 *   ③ **原招**：`.visits` 整格让开 + 原地放一个同名文件 —— 都让产品那一次追加**必然抛错**；
 *   而产品对"追加失败"的处理**与 errno 无关**：`src/heat-sensor.js` 的 `recordVisit` 捕获
 *   `heat.appendEvent`（唯一一次 `appendFileSync`）抛出的**任何**错误 ⇒ 折成 `errors[]` +
 *   `ok:false` + `reason:'all-failed'`；`main.js` 的 `app:visit` 原样回传；`renderer/app-heat-bars.js`
 *   据此把状态栏染红 ⇒ 三档对这条判据是**同一件事**，只是"造条件的侵入性"不同（档① 连目录都不动）。
 *   档③ 是**原招**、保留为兜底 ⇒ 原条件的"原样"一档没丢 ✓（它在能改名的环境里照样先生效）。
 *   档①/② 还比原招多覆盖一段：原招的失败落在 `store.visitLogFile()` 的 `mkdirSync`
 *   （实测报文是 `EEXIST: file already exists, mkdir '…\.visits'`），**没有**走到 `recordVisit`
 *   里"把追加失败折成 errors[]"那一步；档①/② 的失败正落在**追加**那一步 ✓。
 *   ⚠️ 唯一要如实说明的边界：档① 时日志**读得通**（路径在、只是写不进）—— 若哪天产品改成
 *   "追加失败就删掉日志文件重写"，档① 与档②/③ 的行为会分叉；那一刻要回到档②/③ 并重新论证。
 *
 * ## 判别力证明（两条，都真跑过；报文见交付说明）
 *   ① **产品侧真坏了 ⇒ 必红**：把 `renderer/app-heat-bars.js` 的 `recordHumanOpen` 失败分支改成
 *      **静默吞掉**（不调 `MM.setStatus`，并把 `lastVisit` 写成 `ok:true`）⇒ 断言⑤**必红**，
 *      报文点名"条件造出来了 ⇒ 界面上没有响亮的失败读数"；还原后 `sha256` 逐字节回到原值 ⇒ 复绿 ✓。
 *   ② **条件造不出 ⇒ 必进未验证档**：临时在 `buildFailCondition()` 开头 `return false;`（三档全不生效）
 *      ⇒ 输出里是 `[未验证]` + `[smoke]` 响亮行（点名每一档为什么没成），汇总行三个数**如实**
 *      （未验证 +1，且它**不在**"通过/总数"里，槽位数仍不变），**退出码 0**（不阻断）；
 *      再叠 `MM_SMOKE_CLIP_STRICT=1` 时它**按失败计** ⇒ 退出码 1（"宁可红，不许悄悄放过"）✓。
 *   两次注入都是**临时改**（照本域既有的"改产品代码那一轮"的规矩），改完就还原、并核 `sha256`。
 *
 * ## ⚠️ 本域**没有**提供环境开关注入（写在这里免得下一个人找）
 *   第一版试过 `MM_SMOKE_INJECT=40-<key>`（在渲染层给 `window.desktop.app.heat` / `.visit` 换桩）。
 *   **实测不成立**：`window.desktop` 是 contextBridge 暴露的对象，给它挂方法**不生效**
 *   （`ctx.exec` 返回 1 也不代表改上了），于是"注入没发生"而断言变红 —— 红的原因指向产品，
 *   其实是测法失灵。所以本域的判别力证明只能靠**改产品代码**那一轮（见上），
 *   而"失败响亮"那两条改成了**真造失败条件**（坏日志 / 把日志那一格弄成写不进去），不需要桩；
 *   上面"判别力证明②"照同一条规矩办（改的是**造条件的那几行**，不是判据）—— 不新增常驻开关。 */
'use strict';

const fs = require('fs');
const path = require('path');
const frameStats = require('../vision/frame-stats.js');   // 真帧像素（判据⑧）：与 36/37 域同一套底座 ✓

const PROJ = 'smoke-heat-40';
const NODE_A = 'sh40-a';      // 被访问过（人 + AI 都有）
const NODE_B = 'sh40-b';      // 候选：AI 从没访问过（断言③自己去找一个真的没访问过的）
const HOME_PROJECT = 'comnet';

const INJECT = process.env.MM_SMOKE_INJECT || '';
/** 本域**没有**可用的注入开关（理由见文件头"⚠️ 本域没有提供环境开关注入"）。
 *  留着这个判定只是为了：别人照别域的惯例传 `MM_SMOKE_INJECT=40-*` 时，
 *  我们**不假装它生效** —— 而是**响亮忽略**（下面断言①里那行 `no switch` 的读数就是证据）。 */
const MY_KEY = (k) => INJECT === '40-' + k;

const SETTLE = 'new Promise(function (res) { setTimeout(res, 300); })';

/* ---------------- 沙箱路径与日志（都在副本里 ✓） ---------------- */
const sandboxRoot = () => process.env.AI_MINDMAP_PROJECTS_DIR || '';
const probeDir = () => path.join(sandboxRoot(), PROJ);
const probeFile = () => path.join(probeDir(), PROJ + '.json');
/** 访问日志的**真位置**：`<项目根>/.visits/<项目名>.jsonl`（**在项目目录之外**） */
const logFile = () => path.join(sandboxRoot(), '.visits', PROJ + '.jsonl');

function readLogLines() {
  try {
    const f = logFile();
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  } catch (e) { return []; }
}
function logCount(ch) {
  let n = 0;
  readLogLines().forEach((l) => { try { if (JSON.parse(l).ch === ch) n++; } catch (e) { /* 坏行另算 */ } });
  return n;
}
/** 全部 `human-detail` 事件（**不按节点过滤**）：那条不变的判据是"打开一次只记一条"，
 *  按节点过滤会漏掉"记到了别的节点上"这种错法（实测把它当成注入的判别力缺口补齐了）。 */
function humanDetailEvents() {
  const out = [];
  readLogLines().forEach((l) => {
    try { const e = JSON.parse(l); if (e.ch === 'human-detail') out.push(e.node); } catch (err) { /* 坏行另算 */ }
  });
  return out;
}
/** 某个节点上"该侧"（human / ai）的事件条数 —— 断言③用它找真·没被访问过的节点 */
function sideEvents(nodeId, side) {
  const prefix = side === 'ai' ? 'ai-' : 'human-';
  return readLogLines().filter((l) => {
    try { const e = JSON.parse(l); return e.node === nodeId && String(e.ch).indexOf(prefix) === 0; }
    catch (err) { return false; }
  }).length;
}
function probeExists() { try { return fs.existsSync(probeFile()); } catch (e) { return false; } }
function dirList() {
  try { return fs.readdirSync(probeDir()).sort().join(','); } catch (e) { return '(读不到)'; }
}
function probeBytes() {
  try { return fs.readFileSync(probeFile()); } catch (e) { return null; }
}
function removeProbe() {
  try { fs.rmSync(probeDir(), { recursive: true, force: true }); return !fs.existsSync(probeDir()); }
  catch (e) { return false; }
}

/* ---------------- CLI 小工具（`ctx.runCli` 非 0 时会抛 ⇒ 统一兜住） ---------------- */
function cli(ctx, args) {
  try { return { ok: true, out: String(ctx.runCli(args)) }; }
  catch (e) { return { ok: false, out: String((e && e.message) || e) }; }
}
function cliJson(ctx, args) {
  try { return JSON.parse(cli(ctx, args).out); } catch (e) { return null; }
}
/** 异常 → 一句"代码 + 消息"（造故障条件的梯子、还原读数、自证读数都用它：
 *  **不许静默** —— 失败要连理由打印，否则"哪一档没成、为什么"就没人看得见 ✗） */
function errOf(e) {
  if (!e) return String(e);
  return String(e.code ? (e.code + ': ') : '') + String(e.message || e);
}
async function execJson(ctx, js) {
  const raw = await ctx.exec(js);
  try { return JSON.parse(raw); }
  catch (e) { return { ok: false, text: '渲染层返回值不是 JSON：' + String(raw).slice(0, 200) }; }
}

/* ---------------- 铺场：探针项目 ---------------- */
let built = null;
function buildProbe(ctx) {
  const steps = [];
  steps.push('清理旧探针=' + removeProbe());
  steps.push(cli(ctx, ['init', PROJ]).out.trim() || '（init 无输出）');
  steps.push(cli(ctx, ['add', PROJ, 'root', '--topic', '第一章', '--id', NODE_A,
    '--detail', '<h3>甲</h3><p>热度条不该改这里的一个字节</p>']).out.trim());
  steps.push(cli(ctx, ['edit', PROJ, NODE_A, '--tags', '门禁,热度']).out.trim());
  steps.push(cli(ctx, ['add', PROJ, NODE_A, '--topic', '第二章', '--id', NODE_B,
    '--detail', '<p>零访问节点</p>']).out.trim());
  steps.push(cli(ctx, ['edit', PROJ, NODE_B, '--tags', '门禁']).out.trim());
  // 给"人"一次基线访问（**经 CLI 记**）：断言②数的是**增量**，这条让基线非空
  steps.push(cli(ctx, ['visit', PROJ, NODE_B, '--channel', 'human-detail']).out.trim() || '（已记一次人访问）');
  const broken = probeExists() ? null : ('探针项目没建起来：' + steps.join(' ｜ '));
  return { broken: broken, steps: steps };
}
const ensureProbe = (ctx) => (built || (built = buildProbe(ctx)));

/** 探针项目在不在**当前视图**里（自愈：不在就硬 reload 一次再开） */
async function openProbeOnce(ctx) {
  const r = await execJson(ctx, `(async function () {
    var app = window.MMApp, want = ${JSON.stringify(PROJ)};
    if (!app) return JSON.stringify({ ok: false, text: '没有 MMApp' });
    var st = app.getState();
    if (st.project && st.project.name === want) return JSON.stringify({ ok: true, text: '已在探针项目' });
    if (app.isDirty && app.isDirty()) { await app.save(); }
    var r2 = await app.openProject(want);
    var now = (app.getState().project || {}).name;
    return JSON.stringify({ ok: r2 !== false && now === want, text: 'openProject=' + r2 + ' 当前=' + now });
  })()`);
  await ctx.exec(SETTLE);
  return r;
}
async function probeInView(ctx) {
  const r = await execJson(ctx, `(function () {
    var st = window.MMApp.getState();
    var n = st.jm ? window.MM.adapter.getNode(st.jm, ${JSON.stringify(NODE_A)}) : null;
    return JSON.stringify({ ok: !!n, text: (st.project || {}).name || '' });
  })()`);
  return !!(r && r.ok);
}
async function hardReload(ctx) {
  try { ctx.win.webContents.reload(); } catch (e) { /* 能不能用下面靠轮询判 */ }
  for (let i = 0; i < 60; i++) {
    await ctx.exec('new Promise(function (r) { setTimeout(r, 100); })');
    try {
      const r = await execJson(ctx, 'JSON.stringify({ ok: !!(window.MMApp && window.MMApp.getState'
        + ' && window.MMApp.getState().jm) })');
      if (r && r.ok) return true;
    } catch (e) { /* reload 中 */ }
  }
  return false;
}
async function openProjectReady(ctx) {
  const first = await openProbeOnce(ctx);
  if (!first.ok) return first;
  if (await probeInView(ctx)) return first;
  await hardReload(ctx);
  const second = await openProbeOnce(ctx);
  if (!second.ok) return second;
  return (await probeInView(ctx))
    ? second
    : { ok: false, text: '视图里没有探针节点 ' + NODE_A + '（reload 后仍没有；' + second.text + '）' };
}
/** 打开某节点的详情框（走产品内部路径 `MM.showDetail` —— 与"点节点"落到的是同一个函数） */
async function showNode(ctx, nodeId) {
  const r = await execJson(ctx, `(function () {
    var MM = window.MM, app = window.MMApp;
    var st = app.getState();
    if (!st.jm) return JSON.stringify({ ok: false, text: '没有打开的导图' });
    var n = MM.adapter.getNode(st.jm, ${JSON.stringify(nodeId)});
    if (!n) return JSON.stringify({ ok: false, text: '节点不在视图：' + ${JSON.stringify(nodeId)} });
    MM.showDetail(n);
    return JSON.stringify({ ok: true, text: '详情框已打开' });
  })()`);
  await ctx.exec(SETTLE);
  return r;
}

/** DOM 上这两行的读数（断言用；**只读属性**，不改任何状态） */
async function readBarsDom(ctx) {
  return execJson(ctx, `(function () {
    var box = window.MM.fdPrimaryNodeBox ? window.MM.fdPrimaryNodeBox() : null;
    if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
    var host = box.el.querySelector('.fd-heat');
    if (!host) return JSON.stringify({ ok: false, text: '详情框里没有 .fd-heat 容器' });
    var rows = Array.prototype.slice.call(host.querySelectorAll('.fd-heat-row'));
    var out = {};
    rows.forEach(function (r) {
      out[r.getAttribute('data-side')] = {
        heat: r.getAttribute('data-heat'), bands: r.getAttribute('data-bands'),
        listed: r.getAttribute('data-listed'), node: r.getAttribute('data-node'), text: r.textContent
      };
    });
    var st = window.MM.heatBarsState ? window.MM.heatBarsState() : null;
    return JSON.stringify({ ok: true, rows: out, hostText: host.textContent, boxNode: box.node ? box.node.id : null,
      payloadNode: st && st.payload && st.payload.node ? st.payload.node.node : null });
  })()`);
}

/** 等这一块热度条**画完并稳定下来**（两次连续读数一模一样 ⇒ 没有更大的饼在路上）。
 *
 * ⚠️ **绝不能在这里重开详情框**（第一版这么干过，实测把判据变成不可能满足）：每开一次
 * 详情框都会**记一条访问**（那是本件要验的行为）⇒ 日志在涨、读数在变，"稳定"永远等不到。
 * 所以这里只**看**，不碰；要"逼它重新取数"只能由调用方在**测量之前**做一次。
 * 为什么不是"等行文本变了"（第二版）：`showNode` 里那句 `SETTLE`（300ms）通常已经等过了取数与重画
 * ⇒ 文本早在读基线之前就变完了，"等它变"永远等不到。
 * @param {(r:object)=>boolean} [pred] 额外要满足的条件（如"这一行是 listed=false"）
 */
async function waitStableBars(ctx, pred, timeoutMs) {
  const t0 = Date.now();
  const cap = timeoutMs || 8000;
  let lastText = null;
  for (;;) {
    const r = await readBarsDom(ctx);
    const okPred = !pred || (r && r.ok && pred(r));
    if (r && r.ok && okPred && lastText !== null && r.hostText === lastText) {
      return { ok: true, dom: r, text: r.hostText };
    }
    lastText = (r && r.ok) ? r.hostText : null;
    if (Date.now() - t0 > cap) {
      return { ok: false, text: (r && r.hostText) || (r && r.text) || '超时', dom: r };
    }
    await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
  }
}

/* ---------------- 改版批（2026-10-16）新增判据的读数底座 ----------------
 * 判据 ⑦⑧⑨⑩⑪ 全部只读，且**只用一处 DOM 读法**（下面这三个函数）——
 * 免得五条判据各写一份"标题框 / 条 / 命中测试"的读法，各自漂移 ✗（B1 的口径）。
 * 可见性一律 `elementFromPoint` 命中测试（本域文件头那条纪律：rect 对裁切是盲的）。 */

/** 详情框的**几何全量读数**（现算；不看 CSS 文本、不看类名判可见性）。
 *  返回：面板 / 标题框 / 名字 / 两根条（track+fill 的 rect、填充比例）/ 三颗按钮 / 正文区各元素。 */
async function readGeo(ctx) {
  return execJson(ctx, `(function () {
    function rr(el) { if (!el) return null; var b = el.getBoundingClientRect();
      return [+b.left.toFixed(2), +b.top.toFixed(2), +b.width.toFixed(2), +b.height.toFixed(2)]; }
    var box = window.MM.fdPrimaryNodeBox ? window.MM.fdPrimaryNodeBox() : null;
    if (!box) return JSON.stringify({ ok: false, text: '没有详情框' });
    var el = box.el;
    var head = el.querySelector('.fd-head'), title = el.querySelector('.fd-title');
    var host = el.querySelector('.fd-heat'), scroll = el.querySelector('.fd-scroll');
    if (!host) return JSON.stringify({ ok: false, text: '详情框里没有 .fd-heat 容器' });
    var tr0 = title ? getComputedStyle(title) : null;
    var out = {
      ok: true, node: box.node ? box.node.id : null, dpr: window.devicePixelRatio || 1,
      panel: rr(el), head: rr(head), title: rr(title), host: rr(host), scroll: rr(scroll),
      btns: rr(el.querySelector('.fd-head-btns')),
      lockMap: rr(el.querySelector('.fd-lock-map')), lockScreen: rr(el.querySelector('.fd-lock-screen')),
      close: rr(el.querySelector('.fd-close')),
      scrollPadTop: scroll ? parseFloat(getComputedStyle(scroll).paddingTop) : null,
      scrollContentH: scroll ? scroll.scrollHeight : null,
      hostParent: host.parentNode ? String(host.parentNode.className || host.parentNode.tagName) : '',
      /* 条带里**有没有文字**：① 原生的 title 计数（机制必须是自绘浮层，不是原生弹窗 ⇒ 必须是 0）；
       * ② 宿主自己的文字子节点数（空白文本节点也算）；③ 宿主 textContent 长度（**只报告**，
       * 不用它判可见性 —— 可见性一律命中测试 / 真帧像素 ✓） */
      nativeTitles: host.querySelectorAll('[title]').length,
      hostTextNodes: Array.prototype.slice.call(host.childNodes || [])
        .filter(function (n) { return n.nodeType === 3 && String(n.nodeValue || '').trim() !== ''; }).length,
      hostTextLen: String(host.textContent || '').length,
      hostLabel: String(host.getAttribute('aria-label') || ''),
      /* 画这份 DOM 用的**那一份原始载荷**（同一时刻的快照 ⇒ 判"条上的数 = 读数"时没有竞态 ✓）。
       * 为什么要它：面板每取一次数都会往日志记一条 ai-read-view ⇒ 窗口样本量一直在涨，
       * 拿"现读的 CLI"去比"早先画好的 DOM"必然差几条（判据会假红，实测踩到一次）✗ */
      payload: (function () {
        var s = window.MM.heatBarsState ? window.MM.heatBarsState() : null;
        var p = s && s.payload;
        return p ? { hasLog: !!p.hasLog, node: p.node || null } : null;
      })(),
      titleStyle: tr0 ? { whiteSpace: tr0.whiteSpace, textOverflow: tr0.textOverflow, overflow: tr0.overflow } : null,
      hits: {}, rows: [], body: {}
    };
    out.rows = Array.prototype.slice.call(host.querySelectorAll('.fd-heat-row')).map(function (r) {
      var track = r.querySelector('.fd-heat-track'), fill = r.querySelector('.fd-heat-fill');
      var tr = rr(track), fr = rr(fill);
      var at = tr ? document.elementFromPoint(tr[0] + tr[2] / 2, tr[1] + tr[3] / 2) : null;
      /* 悬停浮层（**应用自绘**那一层）：它的矩形 / 文本 / hidden 状态 / 命中测试 —— 判据⑪⑫ 用它。
       * ⚠️ hidden 只是**报告的读数**；"看得见"一律靠 elementFromPoint + 真帧像素 ✓ */
      var tip = r.querySelector('.fd-heat-tip');
      var ir = rr(tip);
      var tipHit = (ir && ir[2] > 0 && ir[3] > 0)
        ? document.elementFromPoint(ir[0] + ir[2] / 2, ir[1] + ir[3] / 2) : null;
      var kids = Array.prototype.slice.call(track ? (track.childNodes || []) : []);
      return {
        side: r.getAttribute('data-side'), heat: r.getAttribute('data-heat'),
        bands: r.getAttribute('data-bands'), bandMax: r.getAttribute('data-band-max'),
        listed: r.getAttribute('data-listed'), pending: r.getAttribute('data-pending'),
        node: r.getAttribute('data-node'), label: String(r.getAttribute('aria-label') || ''),
        text: String(r.textContent), track: tr, fill: fr,
        ratio: (tr && tr[2] > 0 && fr) ? +(fr[2] / tr[2]).toFixed(4) : null,
        trackHits: at ? String(at.className || at.tagName) : null,
        trackHitInHeat: !!(at && at.closest && at.closest('.fd-heat')),
        parentCls: r.parentNode ? String(r.parentNode.className || '') : '',
        trackKids: kids.map(function (n) { return String(n.className || n.nodeName); }),
        trackTextNodes: kids.filter(function (n) { return n.nodeType === 3; }).length,
        rowKids: Array.prototype.slice.call(r.childNodes || []).map(function (n) {
          return String(n.className || n.nodeName);
        }),
        tipRect: ir, tipText: String(tip ? tip.textContent : ''), tipHidden: !!(tip && tip.hidden),
        tipHitSelf: !!(tip && tipHit === tip), tipHitCls: tipHit ? String(tipHit.className || tipHit.tagName) : null,
        nativeTitles: r.querySelectorAll('[title]').length
      };
    });
    ['.fd-tags', '.fd-localpath', '.fd-detail-content', '.fd-images-content', '.fd-assoc',
      '.fd-related', '.fd-files-content'].forEach(function (s) { out.body[s] = rr(el.querySelector(s)); });
    [['lockMap', '.fd-lock-map'], ['lockScreen', '.fd-lock-screen']].forEach(function (p) {
      var r = out[p[0]];
      var at = r ? document.elementFromPoint(r[0] + r[2] / 2, r[1] + r[3] / 2) : null;
      out.hits[p[0]] = at ? String(at.className || at.tagName) : null;
    });
    return JSON.stringify(out);
  })()`);
}

/** 等两根条**真的画出来**（不是"正在取"那一档）并稳定：rows 齐、`data-pending` 不在、
 *  且这一份读数属于 `nodeId`。测法与 `waitStableBars` 同一口径：**只许看、不重开框**
 *  （重开会记一条访问 ⇒ 读数永远在变）。 */
async function waitRows(ctx, nodeId, timeoutMs) {
  const t0 = Date.now();
  const cap = timeoutMs || 8000;
  let last = null;
  for (;;) {
    last = await readGeo(ctx);
    const rows = (last && last.ok && last.rows) || [];
    const mine = rows.filter((r) => r.node === nodeId);
    const done = mine.length === 2 && mine.every((r) => r.pending !== '1' && r.track && r.fill);
    if (done) return { ok: true, geo: last };
    if (Date.now() - t0 > cap) return { ok: false, geo: last, text: '超时：两根条没画齐（rows=' + rows.length + '）' };
    await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
  }
}

/** DOM 两根条与 CLI `heat --json --node <id>` **同刻对拍**（照断言①的口径：多轮到达成一致；
 *  ⚠️ 逼它重画只走渲染层自己的刷新入口 —— **不重开详情框**，否则又记一条访问、读数永远在变）。 */
async function measureBars(ctx, nodeId, tries) {
  for (let i = 0; i < (tries || 12); i++) {
    const g = await readGeo(ctx);
    const truth = cliJson(ctx, ['heat', PROJ, '--json', '--node', nodeId]);
    const rows = (g && g.ok && g.rows) || [];
    const by = {};
    rows.forEach((r) => { by[r.side] = r; });
    const h = by.human, a = by.ai;
    if (truth && truth.node && h && a && h.node === nodeId && a.node === nodeId
      && h.bands === String(truth.node.human.bands) && a.bands === String(truth.node.ai.bands)
      && h.bandMax === String(truth.node.human.bandMax) && a.bandMax === String(truth.node.ai.bandMax)) {
      return { ok: true, geo: g, truth: truth, human: h, ai: a };
    }
    await execJson(ctx, `(function () {
      var box = window.MM.fdPrimaryNodeBox();
      if (box && box.node && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
      return JSON.stringify({ ok: true });
    })()`);
    await ctx.exec(SETTLE);
  }
  return { ok: false, geo: await readGeo(ctx) };
}

/** 真帧里取一个矩形内**最饱和**的那个像素（返回 BGRA 四元组 + 通道极差）。
 *  为什么取"最饱和"而不是"中心点"：条只有 3px 高、还可能落在半像素上 ⇒ 边缘像素是与底槽混过的；
 *  最饱和的那个像素才是"这条到底画成什么颜色"的真值 ✓（通道序见 `scripts/vision/window-shot.js`：BGRA）。 */
function pickPixel(info, rect, dpr) {
  if (!info || !info.ok || !rect) return null;
  const x0 = Math.floor(rect[0] * dpr), y0 = Math.floor(rect[1] * dpr);
  const x1 = Math.floor((rect[0] + rect[2]) * dpr), y1 = Math.floor((rect[1] + rect[3]) * dpr);
  let best = null;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const off = (y * info.width + x) * 4;
      if (off < 0 || off + 3 >= info.bmp.length) continue;
      const b = info.bmp[off], g = info.bmp[off + 1], r = info.bmp[off + 2];
      const spread = Math.max(b, g, r) - Math.min(b, g, r);
      if (!best || spread > best.spread) best = { b: b, g: g, r: r, spread: spread, x: x, y: y };
    }
  }
  return best;
}

/** 这个像素的"主通道"是哪个（0=B / 1=G / 2=R）—— 用它判"两条是不是真的不同色"（通道序无关地比较两根条） */
function dominant(p) {
  if (!p) return null;
  if (p.b >= p.g && p.b >= p.r) return 'B';
  return (p.r >= p.g) ? 'R' : 'G';
}

/** 一个像素是否**属于预期调色板**（底槽灰 / 两色填充 / 它们与浅底的抗锯齿混合）——
 *  判法只有两条：**亮**（三通道都 ≥ 200）或**饱和且主通道是 B / R**（极差 ≥ 60）。
 *  为什么这样定：文字色 `#4e5969`（极差 27）与 `#a9aeb8`（极差 15）以及它们与浅底混出的浅灰
 *  **两条都不满足** ⇒ 会被数成"非调色板像素" ✓（注入②"在条带上印一句话"会当场变红，见文件头）。 */
function palettePixel(b, g, r) {
  const mn = Math.min(b, g, r), mx = Math.max(b, g, r);
  if (mn >= 200) return true;
  return (mx - mn) >= 60 && (mx === b || mx === r);
}

/** 扫一个矩形里"不属于调色板"的像素（= 文字色的候选）；返回 {off, px, sample}。
 *  `excludes` = 要从统计里挖掉的矩形（同 dpr 口径，给的是 CSS px 矩形）：标题框里**合法的文字**
 *  只有节点名字（`.fd-title`）与三颗按钮（`.fd-head-btns`：emoji 本来就五颜六色）⇒ 挖掉它们，
 *  剩下的"标题框空档 + 条带"里**一个文字色像素都不许有** ✓ */
function offPalette(info, rect, dpr, excludes) {
  const out = { off: 0, px: 0, sample: [] };
  if (!info || !info.ok || !rect) return out;
  const ex = (excludes || []).filter(Boolean).map((r) => ({
    x0: Math.floor(r[0] * dpr), y0: Math.floor(r[1] * dpr),
    x1: Math.ceil((r[0] + r[2]) * dpr), y1: Math.ceil((r[1] + r[3]) * dpr)
  }));
  const hit = (x, y) => ex.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
  const x0 = Math.floor(rect[0] * dpr), y0 = Math.floor(rect[1] * dpr);
  const x1 = Math.floor((rect[0] + rect[2]) * dpr), y1 = Math.floor((rect[1] + rect[3]) * dpr);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (hit(x, y)) continue;
      const off = (y * info.width + x) * 4;
      if (off < 0 || off + 2 >= info.bmp.length) continue;
      out.px++;
      const b = info.bmp[off], g = info.bmp[off + 1], r = info.bmp[off + 2];
      if (!palettePixel(b, g, r)) {
        out.off++;
        if (out.sample.length < 4) out.sample.push(b + ',' + g + ',' + r);
      }
    }
  }
  return out;
}

/** 两帧之间**不同像素**的计数（给定设备像素矩形）—— 判"悬停真的画出了东西 / 移开真的收干净了"。
 *  单通道差 > 2 才算"不同"（滤掉截图自身的 1–2 级噪声）✓ */
function pixelDiff(infoA, infoB, rect, dpr) {
  if (!infoA || !infoB || !infoA.ok || !infoB.ok || !rect) return null;
  const x0 = Math.floor(rect[0] * dpr), y0 = Math.floor(rect[1] * dpr);
  const x1 = Math.floor((rect[0] + rect[2]) * dpr), y1 = Math.floor((rect[1] + rect[3]) * dpr);
  let diff = 0, px = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const off = (y * infoA.width + x) * 4;
      if (off < 0 || off + 2 >= infoA.bmp.length) continue;
      if (off + 2 >= infoB.bmp.length || infoB.width !== infoA.width) return null;
      px++;
      if (Math.abs(infoA.bmp[off] - infoB.bmp[off]) > 2
        || Math.abs(infoA.bmp[off + 1] - infoB.bmp[off + 1]) > 2
        || Math.abs(infoA.bmp[off + 2] - infoB.bmp[off + 2]) > 2) diff++;
    }
  }
  return { diff: diff, px: px };
}

/** 把真鼠标挪到一个**安全**位置（画布左下角空白处；只移动、不点击 ⇒ 不改任何状态） */
async function mouseAway(ctx) {
  const p = await execJson(ctx, 'JSON.stringify({ ok: true, x: 40, y: Math.round(window.innerHeight * 0.62) })');
  if (!p || !p.ok) return false;
  await ctx.input.moveTo({ x: p.x, y: p.y });
  await ctx.input.settle({ delayMs: 220 });
  return true;
}

/* ---------------- 判别力证明：**本域不提供渲染层注入**（见文件头） ----------------
 * 曾经在这里定义过 `INJECT_HEAT_PLUS1` / `INJECT_ERR_BARS` / `INJECT_ERR_VISIT` 三个渲染层桩，
 * 全部**实测无效**（contextBridge 的对象挂不上方法）⇒ 已删掉：留着它们只会让下一个接手者
 * 以为"有开关可用"，然后在"注入没生效"的情况下得到一条红 —— 那比没有开关更坏。
 * 现在的口径：判别力证明靠**改产品代码**那一轮（文件头有记录）；
 * "失败响亮"靠**真造失败条件**（坏日志 / 把日志路径堵住）—— 见断言⑤。
 * 改版批（2026-10-16）新增的 ⑦⑧⑨⑩⑪ 照同一条规矩：两次注入都**临时改产品代码**
 * （① 填充恒 100% / ② 把两颗条搬出标题框），见文件头"改版批的判别力证明"那一节 ✓。
 */


/* ============================================================================
 * 断言
 * ========================================================================== */
const assertions = [

  /* ---- ① 界面显示的两条热度值 = CLI 的读数（逐字段对拍） ---- */
  {
    name: 'smoke-heat-40 ① 界面上两条热度条的每一个数都与 CLI `heat --json --node <id>` '
      + '**逐字段相同**（防"界面自己算一份"）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      if (MY_KEY('heat-plus1')) {
        // **不假装注入生效**：本域没有可用的渲染层注入（见文件头）⇒ 显式说出来并继续。
        console.log('[smoke] ⚠ MM_SMOKE_INJECT=' + INJECT + ' 在本域**不生效**'
          + '（渲染层注入实测无效，见 scripts/smoke/40-heat-bars.js 文件头）—— 本次按正常路径跑');
      }
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };

      /** 读一次"界面上这两行"，并与 CLI 刚给出的真值对拍（返回明细）。
       * 为什么要**循环读**（实测出来的）：进度是异步的，而且**开局那次取数可能早于探针把日志写完**
       * —— 实测形状：界面显示 `AI 0/0（未访问）`，而 CLI 同一时刻读到 `10/10`（探针铺场时那次
       * `get` 记下的 `ai-get` 事件还没落地就被界面读走了）。而"看热度"这件事**本身也会记一条**
       * （人打开详情框 ⇒ `human-detail`）⇒ 两侧永远可能差一条。所以判据落成
       * "**在多轮里达成一致**"：每轮重画一次、再对拍一次，一致即通过；
       * 一直不一致就**如实把两侧读数报出来**（不静默判绿）。 */
      const compareOnce = async () => {
        const truthNow = cliJson(ctx, ['heat', PROJ, '--json', '--node', NODE_A, '--limit', '1']);
        const domNow = await readBarsDom(ctx);
        if (!truthNow || !truthNow.node || !domNow.ok) return null;
        const h = domNow.rows.human || {};
        const a = domNow.rows.ai || {};
        const okHuman = h.heat === String(truthNow.node.human.heat)
          && h.bands === String(truthNow.node.human.bands)
          && h.listed === (truthNow.node.human.listed ? '1' : '0');
        const okAi = a.heat === String(truthNow.node.ai.heat)
          && a.bands === String(truthNow.node.ai.bands)
          && a.listed === (truthNow.node.ai.listed ? '1' : '0');
        const s = truthNow.node.sample || {};
        const okSample = domNow.hostText.indexOf(String(s.nodes)) >= 0
          && domNow.hostText.indexOf(String(s.events)) >= 0;
        const okText = truthNow.node.human.listed ? h.text.indexOf(String(truthNow.node.human.visits)) >= 0 : true;
        return { ok: okHuman && okAi && okSample && okText, okHuman: okHuman, okAi: okAi,
          okSample: okSample, okText: okText, dom: domNow, truth: truthNow, h: h, a: a };
      };
      let measured = null;
      for (let i = 0; i < 12; i++) {
        measured = await compareOnce();
        if (measured && measured.ok) break;
        /* 逼它重画一次（**渲染层自己的刷新入口**，与框内重绘走的是同一条路）——
         * 这一条与"重开详情框"不同：它不记访问，只重取读数。 */
        await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          if (box && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
          return JSON.stringify({ ok: true });
        })()`);
        await ctx.exec(SETTLE);
      }
      if (!measured) return { ok: false, text: '前置失败：读数拍不到（界面上没有那两行）' };
      return {
        ok: measured.ok,
        text: '人 ' + measured.h.heat + '/' + measured.h.bands
          + '（CLI ' + measured.truth.node.human.heat + '/' + measured.truth.node.human.bands + '）'
          + ' · AI ' + measured.a.heat + '/' + measured.a.bands
          + '（CLI ' + measured.truth.node.ai.heat + '/' + measured.truth.node.ai.bands + '）'
          + ' · 逐字段相同=' + (measured.okHuman && measured.okAi) + ' · 样本量在文本里=' + measured.okSample
          + ' · 数值串含次数=' + measured.okText + ' ｜ 行文本：' + String(measured.h.text).slice(0, 60)
      };
    }
  },

  /* ---- ② 采样：打开记一次、重绘不记、关掉重开才记、项目目录零变化 ---- */
  {
    name: 'smoke-heat-40 ② 采样点：打开详情框 ⇒ 日志恰好多一条 `human-detail`；'
      + '**重绘不记 / 关掉重开才记**；且项目目录与项目 JSON 逐字节不变（看热度不留下写）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };

      // —— (a) 关掉所有框（干净基线）→ 打开 NODE_A：应当**恰好**多一条 human-detail ——
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      await ctx.exec(SETTLE);
      const before = humanDetailEvents().length;
      const dirBefore = dirList();
      const bytesBefore = probeBytes();
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      await waitStableBars(ctx, (r) => r.boxNode === NODE_A);
      const afterOpen = humanDetailEvents().length;
      const grew = afterOpen - before;

      // —— (b) 框内重绘（既有的刷新路径 **不经** showDetail）：一条都不该多 ——
      await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        if (window.MM.refreshNodeDetailBox) window.MM.refreshNodeDetailBox(box.node.id);
        return JSON.stringify({ ok: true });
      })()`);
      await ctx.exec(SETTLE);
      const afterRepaint = humanDetailEvents().length;

      // —— (c) 关掉再开一次：**再来一条**（那确实是一次新的"打开"） ——
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      await ctx.exec(SETTLE);
      const reopened = await showNode(ctx, NODE_A);
      if (!reopened.ok) return { ok: false, text: '前置失败（重开）：' + reopened.text };
      await ctx.exec(SETTLE);
      const afterReopen = humanDetailEvents().length;

      // —— (d) 项目目录零变化（热度条是展示：不改项目数据、不产生未保存标记） ——
      const dirAfter = dirList();
      const bytesAfter = probeBytes();
      const dirty = await execJson(ctx, 'JSON.stringify({ ok: true, dirty: !!(window.MMApp.isDirty && window.MMApp.isDirty()) })');

      const sameBytes = !!bytesBefore && !!bytesAfter && bytesBefore.equals(bytesAfter);
      const ok = grew === 1 && (afterRepaint - afterOpen) === 0 && (afterReopen - afterRepaint) === 1
        && dirAfter === dirBefore && sameBytes && dirty.dirty === false;
      return {
        ok: ok,
        text: '打开 ⇒ 多 ' + grew + ' 条（应 1）· 重绘 ⇒ 多 ' + (afterRepaint - afterOpen)
          + ' 条（应 0）· 关掉重开 ⇒ 多 ' + (afterReopen - afterRepaint) + ' 条（应 1）'
          + ' ｜ 项目目录不变=' + (dirAfter === dirBefore) + '（' + dirAfter + '）'
          + ' ｜ 项目 JSON 逐字节不变=' + sameBytes + ' ｜ 未保存标记=' + dirty.dirty
      };
    }
  },

  /* ---- ③ 该通道从没访问过 ⇒ 明说"未访问"，不画成"热度 0" ---- */
  {
    name: 'smoke-heat-40 ③ 某条通道**从没访问过**这个节点时：读数 `listed=false` ⇒ 界面明说"未访问"，'
      + '**不画成"热度 0"**（"采不到"与"真的是 0"必须可分辨）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      /* 取一个**AI 通道从没碰过**的节点：日志里该侧事件为 0 **且** CLI 读数 `listed:false`
       * 两个条件同时成立才用它 —— 这样"界面上写未访问"才有真值兜底。 */
      const cands = [NODE_B, NODE_A];
      let chosen = null;
      for (let i = 0; i < cands.length; i++) {
        const id = cands[i];
        const j = cliJson(ctx, ['heat', PROJ, '--json', '--node', id]);
        if (sideEvents(id, 'ai') === 0 && j && j.node && j.node.ai.listed === false) { chosen = { id: id, cli: j }; break; }
      }
      if (!chosen) {
        return {
          ok: false,
          text: '前置失败：找不到"AI 从没访问过"的候选节点 —— 日志：' + JSON.stringify(readLogLines().map((l) => {
            try { const e = JSON.parse(l); return e.node + ':' + e.ch; } catch (err) { return '?'; }
          }))
        };
      }
      /* 这一档的取样口径要写清楚：**"从没访问过"在"打开详情框"之后就必然不成立了** ——
       * 打开那一刻人会记一条（`human-detail`），而面板一取数又要跑一次 `read`（记 `ai-read-view`）。
       * 所以本断言判的不是"界面显示 0"，而是**"界面显示的那一档与 CLI 同一时刻的读数逐字段相同"**
       * —— 包括 `listed` 这个"在不在榜上"的语义（`heat=0/rank=null/listed=false` 是**三件一起**读的）。
       * 这样判据既守住了"采不到 ≠ 热度 0"（`listed:false` ⇒ 界面必须写"本窗口未访问"），
       * 又不会因为探针自己记了一条就恒红。 */
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      await ctx.exec(SETTLE);
      const shown = await showNode(ctx, chosen.id);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      let ai = null;
      let human = null;
      let truth = null;
      let hit = false;
      let lastText = '';
      for (let i = 0; i < 12; i++) {
        const dom = await readBarsDom(ctx);
        truth = cliJson(ctx, ['heat', PROJ, '--json', '--node', chosen.id]);
        if (dom.ok && truth && truth.node) {
          ai = dom.rows.ai || {};
          human = dom.rows.human || {};
          lastText = String(ai.text || '');
          // `listed` 两侧一致 + heat 两侧一致 + **`listed:false` 时界面必须明说"未访问"**（不许画成 0）
          hit = ai.listed === (truth.node.ai.listed ? '1' : '0')
            && ai.heat === String(truth.node.ai.heat)
            && human.listed === (truth.node.human.listed ? '1' : '0')
            && (truth.node.ai.listed ? true : lastText.indexOf('本窗口未访问') >= 0);
          if (hit) break;
        }
        /* 逼它重画一次（渲染层自己的刷新入口；**不重开详情框** —— 重开会记一条访问，把判据搅乱）。 */
        await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          if (box && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
          return JSON.stringify({ ok: true });
        })()`);
        await ctx.exec(SETTLE);
      }
      if (!ai || !truth) return { ok: false, text: '前置失败：读数拍不到（日志只有 ' + readLogLines().length + ' 行）' };
      return {
        ok: hit,
        text: '候选 ' + chosen.id + '（该节点的 ai-* 事件 ' + sideEvents(chosen.id, 'ai') + ' 条）'
          + '· AI 侧 listed/heat（界面 vs CLI）=' + ai.listed + '/' + ai.heat
          + ' vs ' + (truth.node.ai.listed ? '1' : '0') + '/' + truth.node.ai.heat
          + ' · 人侧 listed=' + human.listed + '/' + (truth.node.human.listed ? '1' : '0')
          + ' ｜ 行文本：' + String(lastText).slice(0, 60)
      };
    }
  },

  /* ---- ④ 正文只有一份（回归：热度条不许碰正文） ---- */
  {
    name: 'smoke-heat-40 ④ 回归：详情框正文的 DOM **逐字节等于** CLI `get --json --detail` 的那一份'
      + '（"正文只有一份"这条铁律没被热度条碰坏）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const view = cliJson(ctx, ['get', PROJ, NODE_A, '--json', '--detail']);
      if (!view || typeof view.detail !== 'string') {
        return { ok: false, text: '前置失败：CLI 读不到该节点的 detail' };
      }
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      await ctx.exec(SETTLE);         // 等热度条也画完（它**不许**碰正文；正文与它无关）
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var dc = box.el.querySelector('.fd-detail-content');
        var base = document.createElement('div');
        base.innerHTML = ${JSON.stringify(view.detail)};
        return JSON.stringify({ ok: true, textSame: dc.textContent === base.textContent,
          htmlSame: dc.innerHTML === base.innerHTML, cli: base.innerHTML,
          got: dc.innerHTML, heatInBody: dc.querySelector('.fd-heat') !== null });
      })()`);
      if (!r.ok) return { ok: false, text: '渲染层读数失败：' + r.text };
      const ok = r.textSame === true && r.htmlSame === true && r.heatInBody === false;
      return {
        ok: ok,
        text: '文本相同=' + r.textSame + ' · HTML 逐字节相同=' + r.htmlSame
          + ' · 正文里混进热度条=' + r.heatInBody
          + ' ｜ 正文 ' + String(r.got).length + ' B'
      };
    }
  },

  /* ---- ⑤ 失败响亮（读数 / 采样两条路都不许静默） ---- */
  {
    name: 'smoke-heat-40 ⑤ 失败响亮：① 读数失败（**真造一份坏日志**）⇒ 框里出现可见提示；'
      + '② 采样失败（**真把日志路径堵住**）⇒ 状态栏带错误标记（**不许静默**）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };

      /* —— ① 读数失败：**真造一份坏日志**（一行 JSON 截断）⇒ 那条读路径必然失败 ⇒
       *    界面上必须出现可见提示。为什么不用"换掉 window.desktop.app.heat"那种桩：
       *    实测**注入不生效**（contextBridge 暴露的对象挂不上方法）—— 桩没生效而断言变红，
       *    红的原因指向产品，其实是测法失灵。真造错误条件没有这个风险。 */
      const logPath = logFile();
      const savedLog = fs.existsSync(logPath) ? fs.readFileSync(logPath) : null;
      fs.appendFileSync(logPath, '{"v":1,"at":"懒得写了"\n', 'utf8');
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      let errBars = null;
      for (let i = 0; i < 16; i++) {
        errBars = await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          var err = box.el.querySelector('.fd-heat-err');
          return JSON.stringify({ ok: true, has: !!err, text: err ? err.textContent : '' });
        })()`);
        if (errBars.has) break;
        await execJson(ctx, `(function () {
          var box = window.MM.fdPrimaryNodeBox();
          if (box && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
          return JSON.stringify({ ok: true });
        })()`);
        await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
      }
      // 还原日志（把那一行坏行去掉）：**后面还有断言要用它**
      if (savedLog) fs.writeFileSync(logPath, savedLog); else { try { fs.unlinkSync(logPath); } catch (e) {} }

      /* —— ② 采样失败：**真把"日志写不进去"造出来** ⇒ 状态栏必须出现**红色**提示（不许静默）——
       *    为什么是一条**三档的梯子**（第十九批实测的形状）：原来只有一招（下称"原招"：把 `.visits`
       *    整格改名 + 原地放一个同名**文件**）。它在本机**间歇**失败：`fs.renameSync(<目录>)` 抛 `EPERM`
       *    （%TEMP% 里那一格被外面的句柄占着；同一批紧接着的单跑又绿 ⇒ 环境抖动，不是产品回归）；
       *    而故障条件**没造出来**时旧代码只记 `blocked=false` ⇒ 断言**硬红**，报文里只有
       *    `② 日志路径被堵住=false` —— **"采不到真值"被当成了"产品坏了"** ✗（F19 的第三态）。
       *    口径、三档的等价性论证与判别力证明都在本文件头的"三档一起声明"三节 ✓。
       *    ⚠️ 判据 `okVisit` **一个字都没改**：变的只是"怎么把路径弄成写不进去"。 */
      const visitsDir = path.join(sandboxRoot(), '.visits');
      // ⚠️ **不要读目录本身**（`readFileSync(目录)` 会 EISDIR 把整条断言炸掉 —— 实测踩到）。
      // 需要留的是**目录里那份日志**，它已经在上面 `savedLog` 里了。
      const rungErrors = [];   // 每一档为什么没成（**连理由打印**：静默换档 = 藏起"这条究竟验了什么" ✗）
      let blockedBy = '';      // 造出来了的是哪一档（'' = 一档都没造出来 ⇒ 走第三态）
      let unblock = null;      // 该档的还原函数（**必须还原**：后面还有断言要用这份日志）
      /** 自证：**自己**往"日志那一格"再加一行 —— 抛错才算故障条件**真造出来了**。
       *  ⚠️ 必须用**非空**载荷：`appendFileSync(路径, '')` 连写都不写（实测：目录占位那一档会**假通过**）。
       *  没抛错 = 条件没造出来 ⇒ 把我们刚写进去的字节按写入前的大小**截回去**（绝不污染日志）。 */
      const appendSureFails = () => {
        let sizeBefore = -1;
        try { sizeBefore = fs.statSync(logPath).size; } catch (e) { /* 路径不可用本身也可能是条件成立 */ }
        try {
          fs.appendFileSync(logPath, '{"v":1,"smoke":"failcond-probe"}\n', 'utf8');
        } catch (e) { return { fails: true, how: errOf(e) }; }
        let cleaned = '没写进任何字节';
        try {
          if (sizeBefore >= 0 && fs.statSync(logPath).size > sizeBefore) {
            fs.truncateSync(logPath, sizeBefore);
            cleaned = '已把多写的字节截回 ' + sizeBefore + ' B';
          }
        } catch (e2) { cleaned = '⚠️ 多写的字节**没能截回**：' + errOf(e2); }
        return { fails: false, how: '仍写得进去（' + cleaned + '）' };
      };
      /** 走一遍梯子；造出来就把 `blockedBy` / `unblock` 填上并返回 true */
      const buildFailCondition = () => {
        /* 档①（首选，最不侵入）：把**日志文件**改成只读（chmod 0444）。
         *   现实里它的形状很常见 —— 日志文件被备份/同步工具、或"从别处恢复"标成了只读。
         *   只动一个属性：不动目录、不改名字、**读路径照旧通**（"路径在、就是写不进去"）。
         *   ⚠️ 实测：只读文件上 `appendFileSync` 必 EPERM ✓（`accessSync(W_OK)` 也如实报 EPERM）。 */
        if (fs.existsSync(logPath)) {
          const mode = fs.statSync(logPath).mode & 0o777;
          try {
            fs.chmodSync(logPath, 0o444);
            const sc = appendSureFails();
            if (sc.fails) {
              blockedBy = '① 日志文件只读（chmod 0444；自证=' + sc.how + '）';
              unblock = () => fs.chmodSync(logPath, mode);
              return true;
            }
            fs.chmodSync(logPath, mode);
            rungErrors.push('① 只读文件：' + sc.how);
          } catch (e) {
            try { fs.chmodSync(logPath, mode); } catch (e2) { rungErrors.push('① 还原失败：' + errOf(e2)); }
            rungErrors.push('① 只读文件：' + errOf(e));
          }
        } else {
          rungErrors.push('① 只读文件：日志文件不存在（' + logPath + '）');
        }

        /* 档②（次选）：把"日志那一格"**占成一个目录** —— 这正是原判据的语义（"那一格不是可写的文件"），
         *   但改名的是**文件**（不依赖目录改名），因此绕开了本机那条 `renameSync(<目录>)` EPERM。
         *   ⚠️ 实测：目录占位时 `mkdirSync(recursive)` **不报错**（产品的 ensureDir 会顺利通过），
         *   真正的失败落在**追加**那一步（EISDIR）—— 判据要的正是那一步 ⇒ 仍然等价 ✓。 */
        if (!blockedBy) {
          const bak2 = logPath + '.smoke40bak';
          let moved = false;
          try {
            try { fs.rmSync(bak2, { recursive: true, force: true }); } catch (e) { /* 旧残留 */ }
            fs.renameSync(logPath, bak2); moved = true;
            fs.mkdirSync(logPath);
            const sc = appendSureFails();
            if (sc.fails) {
              blockedBy = '② 日志那一格被一个目录占住（自证=' + sc.how + '）';
              unblock = () => { try { fs.rmdirSync(logPath); } catch (e) { /* 见下面还原读数 */ } fs.renameSync(bak2, logPath); };
              return true;
            }
            fs.rmdirSync(logPath); fs.renameSync(bak2, logPath);
            rungErrors.push('② 目录占位：' + sc.how);
          } catch (e) {
            if (moved) { try { fs.renameSync(bak2, logPath); } catch (e2) { rungErrors.push('② 还原失败：' + errOf(e2)); } }
            rungErrors.push('② 目录占位：' + errOf(e));
          }
        }

        /* 档③（**原招**，留作兜底）：把 `.visits` 整格让开 + 原地放一个同名**文件**
         *   （父路径不是目录 ⇒ `mkdirSync`/追加必然失败）。本机 %TEMP% 里它**间歇** `EPERM`，
         *   所以排在最后；在能改名的环境里它照样生效 —— 原判据的那一档**原样没丢** ✓。
         *   ⚠️ 用**改名**而不是删除：目录里那个日志文件可能被另一个进程占着（实测 `rmdir` EPERM）。 */
        if (!blockedBy) {
          const bak3 = visitsDir + '.smoke40bak';
          let swapped = false;
          try {
            try { fs.rmSync(bak3, { recursive: true, force: true }); } catch (e) { /* 旧残留 */ }
            fs.renameSync(visitsDir, bak3); swapped = true;
            fs.writeFileSync(visitsDir, 'not a directory', 'utf8');
            const sc = appendSureFails();
            if (sc.fails) {
              blockedBy = '③ 原招：.visits 整格让开 + 原地一个同名文件（自证=' + sc.how + '）';
              unblock = () => { fs.unlinkSync(visitsDir); fs.renameSync(bak3, visitsDir); };
              return true;
            }
            fs.unlinkSync(visitsDir); fs.renameSync(bak3, visitsDir);
            rungErrors.push('③ 原招：' + sc.how);
          } catch (e) {
            if (swapped) {
              try { fs.unlinkSync(visitsDir); } catch (e2) { /* 还没放成文件 */ }
              try { fs.renameSync(bak3, visitsDir); } catch (e2) { rungErrors.push('③ 还原失败：' + errOf(e2)); }
            }
            rungErrors.push('③ 原招：' + errOf(e));
          }
        }
        return !!blockedBy;
      };
      buildFailCondition();
      /* 只多试**一遍**的兜底：本机实测那条 `EPERM` 是**间歇**的（同一批紧接着的单跑就绿）⇒
       * 隔 250ms 再走一遍梯子，能把"抖动"救回来当成"真判过"。仍然造不出 ⇒ 第三态（下面 return）。 */
      if (!blockedBy) {
        rungErrors.push('（第 1 遍三档全没造出来 ⇒ 等 250ms 再走一遍）');
        await ctx.exec('new Promise(function (r) { setTimeout(r, 250); })');
        buildFailCondition();
      }
      await execJson(ctx, '(function () { window.MM.setStatus("热度条前置", false); return JSON.stringify({ ok: true }); })()');
      let errVisit = null;
      if (blockedBy) {
        const shown2 = await showNode(ctx, NODE_B);
        if (shown2.ok) {
          for (let i = 0; i < 16; i++) {
            errVisit = await execJson(ctx, `(function () {
              var el = document.getElementById('status-text');
              var st = window.MM.heatBarsState ? window.MM.heatBarsState() : null;
              return JSON.stringify({ ok: true, text: el ? el.textContent : '',
                color: el ? String(el.style.color) : '', visit: st ? st.visit : null });
            })()`);
            if (errVisit.visit && errVisit.visit.ok === false) break;
            await execJson(ctx, `(function () {
              var box = window.MM.fdPrimaryNodeBox();
              if (box && window.MM.heatBarsRefresh) window.MM.heatBarsRefresh(box, box.node);
              return JSON.stringify({ ok: true });
            })()`);
            await ctx.exec('new Promise(function (res) { setTimeout(res, 250); })');
          }
        }
      }
      /* 收尾：还原（**必须还原**：后面还有断言要用它）—— 还原结果**响亮入报文**。
       * ⚠️ 还原失败**不并入 ok**（它会把"测试脚手架没收拾干净"伪装成产品缺陷 ✗），但**绝不能静默**
       * —— 旧代码那句 swallow 的收尾（catch 后什么都不报）就是这个形状：后面若要连锁红，没人找得到源头。 */
      let restoreRead = '（本次没有要还原的东西）';
      if (unblock) {
        try { unblock(); restoreRead = 'ok'; }
        catch (e) {
          restoreRead = '⚠️ **失败**：' + errOf(e) + '（日志那一格可能还堵着 ⇒ 后面的断言会连锁报错，先看这一行）';
        }
      }

      /* 错误标记的判据落在**颜色**上（`MM.setStatus(text, true)` 的口径是 `style.color = #f53f3f`，
       * 不是加 class —— 第一版按 class 判，读到的 class 恒为空 ⇒ 假红）。 */
      const okBars = errBars.has === true && String(errBars.text).indexOf('热度读不出来') >= 0;
      const okVisit = !!blockedBy && !!(errVisit && errVisit.visit && errVisit.visit.ok === false)
        && String(errVisit.text).indexOf('没能记进访问热度') >= 0
        && /245,\s*63,\s*63|f53f3f/i.test(String(errVisit.color));
      /* 报文里三件事**都要在**：① 那一档的读数；② **造出来的是哪一档**（附先前各档为什么没成）；
       * ③ 还原结果。少了②，读的人无从知道"这条判据这次究竟验了什么"；少了③，
       * 一次没收拾干净的脚手架只会以"后面的域莫名红"的形式出现（找不到源头 ✗）。 */
      const brief = '① 坏日志 ⇒ 框里可见提示=' + okBars + '（' + String(errBars.text).slice(0, 46) + '）'
        + ' ｜ ② 造出的故障条件=' + (blockedBy || '**三档都没造出来**')
        + (rungErrors.length ? '（各档读数：' + rungErrors.join(' ｜ ') + '）' : '')
        + ' ⇒ 状态栏=' + JSON.stringify(String(errVisit ? errVisit.text : '').slice(0, 50))
        + ' 颜色=' + (errVisit ? errVisit.color : '') + ' ｜ 采样读数=' + JSON.stringify(errVisit ? errVisit.visit : null)
        + ' ｜ 还原=' + restoreRead;
      /* ⭐ 第三态（"判红 / 只报告 / 跳过"三档里的第三档）：**故障条件造不出来** ⇒
       *   既不判绿、也不判红 —— 响亮地说"本项未验证 + 每一档为什么没成"、**不计入"通过/总数"、
       *   也不阻断**（计数口径只在 `scripts/smoke-assertions.js` 的 `tally()`；`main.js` 打响亮行）。
       *   ⚠️ fail-safe（照域 39 剪贴板那一档）：`unverified` **只在"坏日志 ⇒ 可见提示"那一档真的通过**
       *   时才给 —— 否则"环境坏了"就成了把真缺陷一起洗白的大伞 ✗（`main.js` 另有一道：
       *   万一 `ok:false` 却带了 `unverified`，它按失败计并把矛盾打出来）。 */
      if (!blockedBy) {
        return {
          ok: okBars,
          unverified: okBars
            ? ('热度条"采样失败必须响亮"这一档**本项未验证**：造不出"日志写不进去"这个故障条件'
              + '（三档各走一遍 + 隔 250ms 再走一遍，都没成；各档读数：' + rungErrors.join(' ｜ ') + '）⇒ '
              + '**不参与"通过/总数"计数、也不阻断**（采不到真值不许判红冒充产品缺陷，也不许静默当通过 ✗）；'
              + '同一条里的另一档（坏日志 ⇒ 框里可见提示）已判过并通过 ✓'
              + '（严格档 `MM_SMOKE_CLIP_STRICT=1` 下这一档按失败计 ⇒ 退出码 ≠ 0）')
            : null,
          text: brief + ' ⇒ ' + (okBars
            ? '**故障条件造不出来** ⇒ 这一档**未验证**：不计入通过/总数、也不阻断'
            : '⚠️ 故障条件造不出来，**且**"坏日志 ⇒ 可见提示"那一档本身没通过 ⇒ **判红**'
              + '（不许拿"环境坏了"当真缺陷的挡箭牌 ✗）')
        };
      }
      return {
        ok: okBars && okVisit,
        text: brief + ' ⇒ ' + (okBars && okVisit
          ? '条件真造出来了（自证抛错）、产品也真把失败说了出来 ✓'
          : '⚠️ 条件造出来了但界面上**没有响亮的失败读数** ⇒ **判红**：这是产品回归，不是环境问题 ✗')
      };
    }
  },

  /* ---- ⑦ 改版判据①包容 + ②顺序：两条都在标题框内、名字与大小锁之间 ---- */
  {
    name: 'smoke-heat-40 ⑦ 【改版·位置】两根很细的长横条都**落在标题框矩形内**，且**节点名字右边 ≤ 条左边**、'
      + '**条右边 ≤ 大小锁左边**（几何现算；可见性用 `elementFromPoint` 命中条自己 —— 不看类名/rect）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const w = await waitRows(ctx, NODE_A);
      if (!w.ok) return { ok: false, text: '前置失败：' + w.text };
      const g = w.geo;
      const head = g.head, title = g.title, lock = g.lockMap;
      const rows = g.rows;
      const EPS = 0.5;                       // 亚像素版式（矩形是小数）⇒ 0.5px 的宽容，不是"差不多"
      const inside = rows.every((r) => r.track
        && r.track[0] >= head[0] - EPS && r.track[1] >= head[1] - EPS
        && r.track[0] + r.track[2] <= head[0] + head[2] + EPS
        && r.track[1] + r.track[3] <= head[1] + head[3] + EPS);
      const order = rows.every((r) => r.track
        && title[0] + title[2] <= r.track[0] + EPS
        && r.track[0] + r.track[2] <= lock[0] + EPS);
      const hitSelf = rows.every((r) => r.trackHitInHeat === true);
      const inHead = g.hostParent === 'fd-head';          // 宿主就在标题框里（结构，不是样式）
      const oneImpl = rows.every((r) => String(r.parentCls).indexOf('fd-heat') >= 0);
      const ok = rows.length === 2 && inside && order && hitSelf && inHead && oneImpl;
      const seg = (r) => r.side + '[' + r.track[0].toFixed(1) + '…' + (r.track[0] + r.track[2]).toFixed(1) + ']';
      return {
        ok: ok,
        text: '标题框=' + JSON.stringify(head) + '（宿主父亲=' + g.hostParent + '）· 名字右缘='
          + (title[0] + title[2]).toFixed(1) + ' · 条=' + rows.map(seg).join(' ')
          + ' · 大小锁左缘=' + lock[0].toFixed(1)
          + ' ⇒ 都在标题框内=' + inside + ' · 名字≤条≤锁=' + order
          + ' · 条中心命中 .fd-heat 内=' + hitSelf + ' · 行挂在 .fd-heat 下=' + oneImpl
      };
    }
  },

  /* ---- ⑧ 改版判据③形态：细且长 + 上下叠 + **真帧像素**两色不同 ---- */
  {
    name: 'smoke-heat-40 ⑧ 【改版·形态】两根条都**细且长**（高 2–4px、宽 ≥ 标题框宽的 25%）、**上下叠放**'
      + '（不是并排），且两条颜色**从真帧像素采样**得到、互不相同（人蓝 / AI 橙；**不读 CSS**）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const w = await waitRows(ctx, NODE_A);
      if (!w.ok) return { ok: false, text: '前置失败：' + w.text };
      const g = w.geo;
      const h = g.rows.filter((r) => r.side === 'human')[0];
      const a = g.rows.filter((r) => r.side === 'ai')[0];
      /* 阈值与理由：高度 2–4px（口径给的区间；本实现取 3px —— 2px 在 1x 下贴着噪点、4px 已读成"块"）；
       * 宽度 ≥ 标题框宽的 25%（默认面板 380px ⇒ 标题框内容宽 ~348 ⇒ 25% = 87px，正对 CSS 里那条
       * `min-width: 88px` 的地板 ⇒ 阈值与实现同一口径，不是随手挑的数）。 */
      const thin = g.rows.every((r) => r.track && r.track[3] >= 2 && r.track[3] <= 4);
      const long = g.rows.every((r) => r.track && r.track[2] >= 0.25 * g.head[2]);
      const stacked = !!(h && a) && Math.abs(h.track[0] - a.track[0]) <= 1
        && Math.abs(h.track[2] - a.track[2]) <= 1
        && a.track[1] >= h.track[1] + h.track[3] - 0.5;         // 第二根的顶 ≥ 第一根的底 ⇒ 上下叠
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 真帧采不到真值 = 红' };
      await ctx.input.settle({ delayMs: 200 });
      const img = await ctx.input.capture();
      const info = frameStats.bitmapInfo(img);
      const ph = pickPixel(info, h.fill, g.dpr);
      const pa = pickPixel(info, a.fill, g.dpr);
      const bh = dominant(ph), ba = dominant(pa);
      // 通道序 BGRA（`scripts/vision/window-shot.js` 记的）：人 #1664ff ⇒ B 主导；AI #ff7d00 ⇒ R 主导
      const humanOk = !!ph && bh === 'B' && ph.b >= ph.g + 40 && ph.b >= ph.r + 60;
      const aiOk = !!pa && ba === 'R' && pa.r >= pa.b + 60 && pa.r >= pa.g + 40;
      const differ = !!bh && !!ba && bh !== ba;
      const ok = thin && long && stacked && humanOk && aiOk && differ
        && ph.spread >= 70 && pa.spread >= 70;
      const px = (p) => p ? ('b' + p.b + '/g' + p.g + '/r' + p.r) : 'null';
      return {
        ok: ok,
        text: '高=' + g.rows.map((r) => r.track[3].toFixed(1)).join(',') + 'px（2–4 ✓ =' + thin + '）· 宽='
          + g.rows.map((r) => r.track[2].toFixed(1)).join(',') + 'px / 标题框宽 ' + g.head[2].toFixed(1)
          + ' ⇒ 占比=' + g.rows.map((r) => (r.track[2] / g.head[2] * 100).toFixed(1) + '%').join(',')
          + '（≥25% =' + long + '）· 上下叠=' + stacked
          + ' ｜ 真帧像素（最饱和那个，dpr=' + g.dpr + '）：人 ' + px(ph) + '（期望 #1664ff）· AI ' + px(pa)
          + '（期望 #ff7d00）⇒ 人蓝主导=' + humanOk + ' · AI 橙主导=' + aiOk + ' · 两条主通道不同=' + differ
          + '（' + bh + ' vs ' + ba + '）· 位图=' + info.width + 'x' + info.height + ' ok=' + info.ok
      };
    }
  },

  /* ---- ⑨ 改版判据④比例可判 + 随值改变（判别力：不是空转） ---- */
  {
    name: 'smoke-heat-40 ⑨ 【改版·比例】填充宽度 ÷ 槽宽 ≈ 读数给的 `bands / bandMax`（容差 2 个百分点）；'
      + '再**真改一个值**（CLI 往访问日志加事件 ⇒ 名次/档位真的变）⇒ 比例**随之改变**（证不是空转）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      /* 容差 2 个百分点（0.02）的理由：矩形是**小数像素**（亚像素版式）⇒ 实测偏差 ≪ 0.5%；而一个档位
       * = 10 个百分点 ⇒ 2pp 既不会把亚像素误差判成红，又远小于"一个档位"⇒ 判据有分辨力 ✓ */
      const TOL = 0.02;
      const chk = (row, side) => {
        const want = Number(side.bands) / Number(side.bandMax);
        return { want: +want.toFixed(4), got: row ? row.ratio : null,
          ok: !!row && row.ratio !== null && Math.abs(row.ratio - want) <= TOL };
      };
      const shownA = await showNode(ctx, NODE_A);
      if (!shownA.ok) return { ok: false, text: '前置失败（A）：' + shownA.text };
      const mA = await measureBars(ctx, NODE_A);
      if (!mA.ok) return { ok: false, text: '前置失败：A 的两根条与 CLI 拍不到一致' };
      const a1 = chk(mA.human, mA.truth.node.human);
      const a2 = chk(mA.ai, mA.truth.node.ai);
      // —— 换一个节点量第二个已知值（B 的人侧此时是"被访问过但不是第一名"⇒ 中间那一档）——
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      await ctx.exec(SETTLE);
      const shownB = await showNode(ctx, NODE_B);
      if (!shownB.ok) return { ok: false, text: '前置失败（B）：' + shownB.text };
      const mB1 = await measureBars(ctx, NODE_B);
      if (!mB1.ok) return { ok: false, text: '前置失败：B 的两根条与 CLI 拍不到一致' };
      const b1 = chk(mB1.human, mB1.truth.node.human);
      /* —— 真改这个值：**走产品自己那条路**（CLI `visit` 往访问日志追加事件 ⇒ 名次与档位真的变）——
       * 加的次数 = A 人侧的访问数 + 2 ⇒ B 人侧必超过 A ⇒ 升到第 1 名（最高那一档）。 */
      const nA = Number(mA.truth.node.human.visits) || 0;
      const add = nA + 2;
      for (let i = 0; i < add; i++) cli(ctx, ['visit', PROJ, NODE_B, '--channel', 'human-detail']);
      const mB2 = await measureBars(ctx, NODE_B);           // 内部会逼渲染层重取读数（不重开框）
      if (!mB2.ok) return { ok: false, text: '前置失败：改值之后 B 的两根条与 CLI 拍不到一致' };
      const b2 = chk(mB2.human, mB2.truth.node.human);
      const bandsMoved = Number(mB2.truth.node.human.bands) !== Number(mB1.truth.node.human.bands);
      const ratioMoved = Math.abs((b2.got || 0) - (b1.got || 0))
        >= Math.abs((b2.want || 0) - (b1.want || 0)) - TOL;
      const ok = a1.ok && a2.ok && b1.ok && b2.ok && bandsMoved && ratioMoved;
      return {
        ok: ok,
        text: 'A ' + NODE_A + '：人 bands=' + mA.truth.node.human.bands + '/' + mA.truth.node.human.bandMax
          + '（CLI heat=' + mA.truth.node.human.heat + '）比例 期望' + a1.want + ' 实测' + a1.got
          + ' · AI bands=' + mA.truth.node.ai.bands + '/' + mA.truth.node.ai.bandMax
          + ' 比例 期望' + a2.want + ' 实测' + a2.got
          + ' ｜ B ' + NODE_B + ' 人侧改前 bands=' + mB1.truth.node.human.bands + '/' + mB1.truth.node.human.bandMax
          + '（heat=' + mB1.truth.node.human.heat + '，visits=' + mB1.truth.node.human.visits + '）比例 期望'
          + b1.want + ' 实测' + b1.got
          + ' ⇒ 加 ' + add + ' 条 `human-detail` 之后 bands=' + mB2.truth.node.human.bands + '/'
          + mB2.truth.node.human.bandMax + '（heat=' + mB2.truth.node.human.heat + '，visits='
          + mB2.truth.node.human.visits + '）比例 期望' + b2.want + ' 实测' + b2.got
          + '（容差 ' + TOL + '）⇒ 值真的变了=' + bandsMoved + ' · 比例随之改变=' + ratioMoved
      };
    }
  },

  /* ---- ⑩ 改版判据①（用户追加要求）：条带上**零文字** + 真帧调色板 ---- */
  {
    name: 'smoke-heat-40 ⑩ 【改版·条带无文字】标题框里**不再印文字信息**：条内只有底槽 + 填充'
      + '（track 子节点 = 填充 1 个、文字节点 0 个）· 条带区域的**真帧像素**只来自预期调色板'
      + '（底槽灰 / 两色填充 / 抗锯齿），**文字色像素 ≈ 0** · 热条 DOM 里**一个原生 `title` 都没有**'
      + '（机制必须是应用自绘浮层 ✓）· 没悬停时浮层**不画**（矩形 0×0、命中不到）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const w = await waitRows(ctx, NODE_A);
      if (!w.ok) return { ok: false, text: '前置失败：' + w.text };
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 真帧采不到真值 = 红' };
      // 先把真鼠标挪开：否则"上一次悬停留下的浮层"还在 ⇒ 这一条会去测另一个状态（不是我们要判的）
      await mouseAway(ctx);
      const g = await readGeo(ctx);
      const rows = g.rows;
      const structural = rows.length === 2 && rows.every((r) => r.trackKids.length === 1
        && r.trackTextNodes === 0 && String(r.trackKids[0]).indexOf('fd-heat-fill') >= 0);
      const noNativeTitle = g.nativeTitles === 0 && g.hostTextNodes === 0
        && rows.every((r) => r.nativeTitles === 0 && r.label.indexOf('人：') + r.label.indexOf('AI：') > -2);
      const tipOff = rows.every((r) => r.tipHidden === true
        && (!r.tipRect || (r.tipRect[2] === 0 && r.tipRect[3] === 0)) && r.tipHitSelf === false);
      const img = await ctx.input.capture();
      const info = frameStats.bitmapInfo(img);
      /* 两处真帧读数（都是"从真帧采样像素"，不读 CSS）：
       *  · **条带**（两根条各自的矩形）：非调色板像素必须是 0（最紧的那把尺）
       *  · **标题框空档**（整条标题框挖掉节点名字与三颗按钮）：任何"印在旁边的文字"都会在这里露出来 ✓ */
      let off = 0, px = 0, sample = [];
      rows.forEach((r) => {
        const s = offPalette(info, r.track, g.dpr);
        off += s.off; px += s.px;
        if (sample.length < 4) sample = sample.concat(s.sample);
      });
      const share = px ? off / px : 1;
      const band = offPalette(info, g.head, g.dpr, [g.title, g.btns]);
      const bandShare = band.px ? band.off / band.px : 1;
      const TOL = 0.01;        // 条带：1%（圆角与上下边缘的抗锯齿）；实测 0.00% 见报文
      const BAND_TOL = 0.005;  // 标题框空档：0.5%（面板圆角外的画布像素 + 抗锯齿）；实测见报文
      const ok = structural && noNativeTitle && tipOff && px > 0 && share <= TOL
        && band.px > 0 && bandShare <= BAND_TOL;
      return {
        ok: ok,
        text: '结构：track 子节点=' + JSON.stringify(rows[0] ? rows[0].trackKids : null)
          + '（文字节点 ' + (rows[0] ? rows[0].trackTextNodes : '?') + '）· 行子节点='
          + JSON.stringify(rows[0] ? rows[0].rowKids : null)
          + ' ⇒ 条内无文字=' + structural
          + ' ｜ 原生 title 计数：容器 ' + g.nativeTitles + ' / 行 ' + rows.map((r) => r.nativeTitles).join(',')
          + ' · 宿主文字节点 ' + g.hostTextNodes + '（`aria-label` 仍在：' + JSON.stringify(
            String(rows[0] ? rows[0].label : '').slice(0, 40)) + '…）⇒ 机制=自绘浮层 ' + noNativeTitle
          + ' ｜ 未悬停时浮层：hidden=' + rows.map((r) => r.tipHidden).join(',') + ' 矩形='
          + JSON.stringify(rows.map((r) => r.tipRect && r.tipRect[2] + 'x' + r.tipRect[3])) + ' 命中自身='
          + rows.map((r) => r.tipHitSelf).join(',') + ' ⇒ 不画=' + tipOff
          + ' ｜ 真帧·**条带**：非调色板 ' + off + ' / ' + px + ' = ' + (share * 100).toFixed(2)
          + '%（容差 ' + (TOL * 100) + '%）· 越界样本（b,g,r）=' + JSON.stringify(sample)
          + ' ｜ 真帧·**标题框空档**（挖掉名字 ' + JSON.stringify(g.title) + ' 与按钮 '
          + JSON.stringify(g.btns) + '）：非调色板 ' + band.off + ' / ' + band.px + ' = '
          + (bandShare * 100).toFixed(2) + '%（容差 ' + (BAND_TOL * 100) + '%）· 越界样本='
          + JSON.stringify(band.sample) + ' ⇒ 标题框里没有印字=' + (bandShare <= BAND_TOL)
          + ' · 位图=' + info.width + 'x' + info.height
      };
    }
  },

  /* ---- ⑪ 改版判据②（用户追加要求）：悬停 ⇒ **真出现**（真鼠标 + elementFromPoint + 真帧像素） ---- */
  {
    name: 'smoke-heat-40 ⑪ 【改版·悬停出现】真鼠标停到第一根条上 ⇒ `elementFromPoint(浮层中心)` '
      + '**命中那层应用自绘的浮层**，且**画面像素真的变了**（真帧逐像素比，给差值计数）；'
      + '换到第二根条 ⇒ 浮层换成另一颗条的（文案以**另一个量**开头）；移开 ⇒ 消失'
      + '（浮层矩形 0×0、命中测试回到条、画面回到悬停前）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const w = await waitRows(ctx, NODE_A);
      if (!w.ok) return { ok: false, text: '前置失败：' + w.text };
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 真帧采不到真值 = 红' };
      const g0 = await readGeo(ctx);
      const rows0 = g0.rows;
      const h0 = rows0.filter((r) => r.side === 'human')[0];
      const a0 = rows0.filter((r) => r.side === 'ai')[0];
      const center = (r) => ({ x: Math.round(r.track[0] + r.track[2] / 2), y: Math.round(r.track[1] + r.track[3] / 2) });
      // (0) 基线帧：先把鼠标挪开（保证"没悬停"）
      await mouseAway(ctx);
      const base = frameStats.bitmapInfo(await ctx.input.capture());
      // (1) 真鼠标停到**第一根条**上
      await ctx.input.moveTo(center(h0));
      await ctx.input.settle({ delayMs: 260 });
      const g1 = await readGeo(ctx);
      const h1 = g1.rows.filter((r) => r.side === 'human')[0];
      const a1 = g1.rows.filter((r) => r.side === 'ai')[0];
      const shot1 = frameStats.bitmapInfo(await ctx.input.capture());
      const d1 = pixelDiff(base, shot1, h1.tipRect, g1.dpr);
      const hover1 = h1.tipHidden === false && h1.tipHitSelf === true
        && a1.tipHitSelf === false && !!d1 && d1.diff >= 100;
      // (2) 换到**第二根条**：可见的浮层应换成 AI 那一根（文案以另一个量开头）
      await ctx.input.moveTo(center(a0));
      await ctx.input.settle({ delayMs: 260 });
      const g2 = await readGeo(ctx);
      const h2 = g2.rows.filter((r) => r.side === 'human')[0];
      const a2 = g2.rows.filter((r) => r.side === 'ai')[0];
      const switched = a2.tipHidden === false && a2.tipHitSelf === true && h2.tipHidden === true
        && a2.tipText !== h1.tipText
        && a2.tipText.indexOf('AI：') === 0 && h1.tipText.indexOf('人：') === 0;
      // (3) 移开 ⇒ 消失（矩形 0×0、命中测试回到条、画面回到悬停前）
      await mouseAway(ctx);
      const g3 = await readGeo(ctx);
      const rows3 = g3.rows;
      const shot3 = frameStats.bitmapInfo(await ctx.input.capture());
      const backDiff = pixelDiff(base, shot3, h1.tipRect, g3.dpr);
      const gone = rows3.every((r) => r.tipHidden === true && r.tipHitSelf === false
        && (!r.tipRect || (r.tipRect[2] === 0 && r.tipRect[3] === 0)))
        && rows3.every((r) => r.trackHitInHeat === true)
        && !!backDiff && backDiff.diff === 0;
      const ok = hover1 && switched && gone;
      return {
        ok: ok,
        text: '① 停到人条上：浮层 hidden=' + h1.tipHidden + ' 命中自身=' + h1.tipHitSelf
          + '（AI 条那层命中自身=' + a1.tipHitSelf + '）· 真帧差 ' + (d1 ? d1.diff + '/' + d1.px : 'null')
          + ' 像素 ⇒ 出现=' + hover1
          + ' ｜ ② 换到 AI 条：AI 层 hidden=' + a2.tipHidden + ' 命中自身=' + a2.tipHitSelf
          + ' · 人条那层 hidden=' + h2.tipHidden + ' · 文案变了=' + (a2.tipText !== h1.tipText)
          + '（"' + h1.tipText.slice(0, 12) + '…" vs "' + a2.tipText.slice(0, 12) + '…"）'
          + ' ⇒ 换成另一个量=' + switched
          + ' ｜ ③ 移开：全部 hidden=' + rows3.map((r) => r.tipHidden).join(',') + ' · 矩形='
          + JSON.stringify(rows3.map((r) => r.tipRect && r.tipRect[2] + 'x' + r.tipRect[3]))
          + ' · 条又命中自己=' + rows3.map((r) => r.trackHitInHeat).join(',') + ' · 真帧差回到 '
          + (backDiff ? backDiff.diff : 'null') + ' 像素 ⇒ 消失=' + gone
          + ' ｜ 消失时机：**移开立刻**（不做延时；浮层贴在条下面，指针停在条上才留得住）'
      };
    }
  },

  /* ---- ⑫ 改版判据③（用户追加要求）：浮层文案可读且**与数据真值现算一致** ---- */
  {
    name: 'smoke-heat-40 ⑫ 【改版·文案正确】悬停后读到的浮层文本里能读到**两个量的名字与数值**'
      + '（人 / AI 各自 `档/档位总数（次数） · 名次 #N`）与窗口样本量，且与**画这份 DOM 用的那一份读数'
      + '现算对拍**一致（不写死一个字）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const w = await waitRows(ctx, NODE_A);
      if (!w.ok) return { ok: false, text: '前置失败：' + w.text };
      if (!ctx.input) return { ok: false, text: '没有真输入底座（ctx.input 缺失）⇒ 悬停采不到真值 = 红' };
      await mouseAway(ctx);
      const g0 = await readGeo(ctx);
      const h0 = g0.rows.filter((r) => r.side === 'human')[0];
      // 真鼠标停在**第一根条**上，再读那一刻的浮层文本与同一快照里的读数
      await ctx.input.moveTo({ x: Math.round(h0.track[0] + h0.track[2] / 2), y: Math.round(h0.track[1] + h0.track[3] / 2) });
      await ctx.input.settle({ delayMs: 260 });
      const g = await readGeo(ctx);
      if (!g.payload || !g.payload.node) return { ok: false, text: '前置失败：读不到画 DOM 用的那份载荷' };
      const prof = g.payload.node;
      const hh = prof.human, ai = prof.ai;
      const h = g.rows.filter((r) => r.side === 'human')[0];
      const a = g.rows.filter((r) => r.side === 'ai')[0];
      const tip = h.tipHidden === false ? String(h.tipText) : '';
      const line = (side, row) => (row.listed ? side + '：' + row.heat + '/' + row.bandMax
        + '（' + row.visits + ' 次） · 名次 #' + row.rank : side + '：本窗口未访问');
      const needHuman = line('人', hh);
      const needAi = line('AI', ai);
      const sample = prof.sample || {};
      const checks = {
        humanLine: tip.indexOf(needHuman) >= 0,
        aiLine: tip.indexOf(needAi) >= 0,
        sampleNodes: tip.indexOf(String(sample.nodes)) >= 0,
        sampleEvents: tip.indexOf(String(sample.events)) >= 0,
        windowDays: tip.indexOf(String(sample.windowDays)) >= 0,
        // 名字（"人 / AI"两个量都在）与数值都在 ⇒ "哪一颗是什么量 + 数值"都读得到 ✓
        bothNames: tip.indexOf('人：') >= 0 && tip.indexOf('AI：') >= 0,
        // 无障碍名字与浮层文案同源（不是"打印文字"，但读屏也要读到同一串）
        labelSame: String(h.label) === tip,
        // 第二根条那层文案**以另一个量开头**（两层的文本不同 ⇒ 悬停哪一根读到哪个量）
        otherSide: String(a.tipText).length > 0 && String(a.tipText) !== tip
      };
      const bad = Object.keys(checks).filter((k) => !checks[k]);
      return {
        ok: bad.length === 0,
        text: '浮层文案=' + JSON.stringify(tip.slice(0, 120)) + '…'
          + ' ｜ 现算期望：' + JSON.stringify(needHuman) + ' + ' + JSON.stringify(needAi)
          + ' · 样本（节点 ' + sample.nodes + ' / 事件 ' + sample.events + ' / 窗口 ' + sample.windowDays + ' 天）'
          + ' ｜ 逐项=' + JSON.stringify(checks) + (bad.length ? ' ⇒ 缺 ' + bad.join(',') : ' ⇒ 全部对上 ✓')
      };
    }
  },

  /* ---- ⑬ 改版判据⑤无回归：标题框高度 / 大小锁命中与位置 / 名字行为 / 其它元素矩形 ---- */
  {
    name: 'smoke-heat-40 ⑬ 【改版·无回归】标题框高度**与本批之前相同**（33px，且把条藏起来再量一次不变）·'
      + '大小锁 `elementFromPoint` 仍命中它自己且矩形不变 · 名字的省略/命中行为不变 ·'
      + '悬停浮层**不扰动版式**（强开浮层再量：标题框/名字/面板矩形逐项不变）·'
      + '面板只少了被搬走的那块（面板高 = 标题框 + 正文内容，无残留空档）',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      const w = await waitRows(ctx, NODE_A);
      if (!w.ok) return { ok: false, text: '前置失败：' + w.text };
      const g = w.geo;
      /* 差分判据（**不看写死的数**也能判）：把 `.fd-heat` 整个藏起来再量一次 —— 条若参与高度/挤压名字/
       * 推动锁，这些读数就会变 ⇒ 必红。测量与还原在**同一段脚本**里（try/finally），不会把框留在坏状态。 */
      const d = await execJson(ctx, `(function () {
        function rr(el) { if (!el) return null; var b = el.getBoundingClientRect();
          return [+b.left.toFixed(2), +b.top.toFixed(2), +b.width.toFixed(2), +b.height.toFixed(2)]; }
        var box = window.MM.fdPrimaryNodeBox(); var el = box.el;
        var host = el.querySelector('.fd-heat'), scroll = el.querySelector('.fd-scroll');
        function snap() {
          var head = el.querySelector('.fd-head');
          return { panel: rr(el), head: rr(head), title: rr(el.querySelector('.fd-title')),
            lockMap: rr(el.querySelector('.fd-lock-map')), lockScreen: rr(el.querySelector('.fd-lock-screen')),
            close: rr(el.querySelector('.fd-close')), scroll: rr(scroll), scrollH: scroll.scrollHeight,
            host: rr(host),
            tagsTopMinusScrollTop: +(el.querySelector('.fd-tags').getBoundingClientRect().top
              - scroll.getBoundingClientRect().top).toFixed(2),
            heatParent: host.parentNode ? String(host.parentNode.className || host.parentNode.tagName) : '' };
        }
        var on = snap();
        var off = null;
        try { host.style.display = 'none'; off = snap(); }
        finally { host.style.display = ''; }
        /* 再差一次：把**悬停浮层强开**（两行都显示）再量 —— 浮层是绝对定位的一层，
         * 它若挤动版式（把标题框/名字/面板顶大），这三处读数就会变 ⇒ 必红 ✓ */
        var tips = Array.prototype.slice.call(host.querySelectorAll('.fd-heat-tip'));
        var saved = tips.map(function (t) { return t.hidden; });
        var tipOn = null;
        try { tips.forEach(function (t) { t.hidden = false; }); tipOn = snap(); }
        finally { tips.forEach(function (t, i) { t.hidden = saved[i]; }); }
        var back = snap();
        return JSON.stringify({ ok: true, on: on, off: off, tipOn: tipOn, tipCount: tips.length, back: back });
      })()`);
      if (!d || !d.ok) return { ok: false, text: '渲染层读数失败：' + JSON.stringify(d && d.text) };
      const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
      const HEAD_BASELINE = 33;              // 本批改前实测（见 CHANGELOG：标题框 33px / 面板 311.94px）
      const headSame = Math.abs(g.head[3] - HEAD_BASELINE) <= 0.5;
      const headNoBars = Math.abs(d.on.head[3] - d.off.head[3]) <= 0.01;   // 条不参与高度（差分）
      const locksSame = eq(d.on.lockMap, d.off.lockMap) && eq(d.on.lockScreen, d.off.lockScreen)
        && eq(d.on.close, d.off.close);
      const titleSame = eq(d.on.title, d.off.title);                       // 条不吃名字的宽度
      const hitMap = g.hits.lockMap === 'fd-lock-map';
      const hitScreen = g.hits.lockScreen === 'fd-lock-screen';
      const nameStyle = g.titleStyle && g.titleStyle.whiteSpace === 'nowrap'
        && g.titleStyle.textOverflow === 'ellipsis';
      const noLeftover = Math.abs(d.on.tagsTopMinusScrollTop - g.scrollPadTop) <= 0.5;  // 正文首元素就贴在正文区顶
      const panelIdentity = Math.abs(d.on.panel[3] - (d.on.head[3] + d.on.scrollH + 2)) <= 1.5;
      const restored = eq(d.on, d.back);
      const tipFloats = d.tipCount === 2 && eq(d.on.head, d.tipOn.head) && eq(d.on.title, d.tipOn.title)
        && eq(d.on.panel, d.tipOn.panel) && eq(d.on.scroll, d.tipOn.scroll);
      const ok = headSame && headNoBars && locksSame && titleSame && hitMap && hitScreen
        && nameStyle && noLeftover && panelIdentity && tipFloats && restored;
      return {
        ok: ok,
        text: '标题框高=' + d.on.head[3] + 'px（基线 ' + HEAD_BASELINE + ' ✓=' + headSame + '·藏起条再量='
          + d.off.head[3] + ' 不变=' + headNoBars + '）· 名字矩形不变=' + titleSame + '（nowrap+ellipsis='
          + nameStyle + '）· 锁/关闭矩形不变=' + locksSame + ' · 锁命中自身=' + (hitMap && hitScreen)
          + '（' + g.hits.lockMap + ' / ' + g.hits.lockScreen + '）'
          + ' · 悬停浮层不扰动版式=' + tipFloats + '（强开 ' + d.tipCount + ' 层再量：标题框/名字/面板/正文区逐项不变）'
          + ' ｜ 面板=' + JSON.stringify(d.on.panel) + ' · 正文区=' + JSON.stringify(d.on.scroll)
          + '（内容高 ' + d.on.scrollH + '）· 正文首元素距正文区顶=' + d.on.tagsTopMinusScrollTop
          + 'px（= 内边距 ' + g.scrollPadTop + ' ⇒ 没有残留空档=' + noLeftover + '）'
          + ' · 面板高 = 标题框 + 内容 + 2 边框=' + panelIdentity + ' · 量完已还原=' + restored
          + ' ｜ ⚠️ **本批唯一的几何变化**：被搬走的那块（改前实测高 73 + 下边距 8 = 81px）不再占正文区，'
          + '面板因此从改前实测 311.94px 矮到 ' + d.on.panel[3] + 'px —— 这是"条搬进标题框"的必然结果，'
          + '不是别的元素被动了（正文区其余元素与原样**逐个只有一个共同的上移量**）'
      };
    }
  },

  /* ---- Z 诊断（临时）：原始载荷 vs DOM ---- */
  {
    name: 'smoke-heat-40 Z 诊断：原始载荷 vs DOM',
    run: async (ctx) => {
      const probe = ensureProbe(ctx);
      if (probe.broken) return { ok: false, text: '前置失败：' + probe.broken };
      const opened = await openProjectReady(ctx);
      if (!opened.ok) return { ok: false, text: '前置失败：' + opened.text };
      const cliNow = cliJson(ctx, ['heat', PROJ, '--json', '--node', NODE_A]);
      const shown = await showNode(ctx, NODE_A);
      if (!shown.ok) return { ok: false, text: '前置失败：' + shown.text };
      await waitStableBars(ctx, (r) => r.boxNode === NODE_A);
      const r = await execJson(ctx, `(function () {
        var box = window.MM.fdPrimaryNodeBox();
        var host = box.el.querySelector('.fd-heat');
        var st = window.MM.heatBarsState();
        return JSON.stringify({ ok: true,
          boxNode: box.node ? box.node.id : null,
          payloadNode: st && st.payload && st.payload.node ? st.payload.node.node : null,
          staleDropped: st ? st.staleDropped : null,
          prof: st && st.payload ? st.payload.node : null,
          domRows: Array.prototype.slice.call(host.querySelectorAll('.fd-heat-row')).map(function (x) {
            return [x.getAttribute('data-side'), x.getAttribute('data-heat'), x.getAttribute('data-bands'), x.getAttribute('data-listed'), x.getAttribute('data-node')];
          }),
          text: host.textContent });
      })()`);
      return { ok: true, text: '日志行数=' + readLogLines().length
        + ' ｜ CLI 现在=' + JSON.stringify(cliNow && cliNow.node
          ? { h: cliNow.node.human.heat, a: cliNow.node.ai.heat } : null)
        + ' ｜ 被丢弃的过期读数=' + r.staleDropped
        + ' ｜ payload=' + JSON.stringify(r.prof && r.prof.ai ? { a: r.prof.ai.heat, ha: r.prof.human.heat, s: r.prof.sample } : null)
        + ' ｜ DOM=' + JSON.stringify(r.domRows)
        + ' ｜ text=' + JSON.stringify(String(r.text).slice(0, 90)) };
    }
  },

  /* ---- ⑥ 自收尾 ---- */
  {
    name: 'smoke-heat-40 ⑥ 自收尾：探针项目删干净 + 关框 + 切回原项目（不留脏状态给后续域）',
    run: async (ctx) => {
      await execJson(ctx, '(function () { window.MM.closeAllFloatDetail(); return JSON.stringify({ ok: true }); })()');
      const removed = removeProbe();
      const back = await execJson(ctx, `(async function () {
        var app = window.MMApp;
        if (!app) return JSON.stringify({ ok: false, text: '没有 MMApp' });
        var r = await app.openProject(${JSON.stringify(HOME_PROJECT)});
        var now = (app.getState().project || {}).name;
        return JSON.stringify({ ok: r !== false && now === ${JSON.stringify(HOME_PROJECT)}, text: '当前=' + now });
      })()`);
      const noSel = await execJson(ctx, 'JSON.stringify({ ok: !window.MMApp.getState().selectedNode })');
      const ok = removed && back.ok && noSel.ok;
      return { ok: ok, text: '探针已删=' + removed + ' ｜ 切回=' + back.ok + '（' + back.text + '）' };
    }
  }
];

module.exports = assertions;
