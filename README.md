# AI MindMap

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 入口
作用: 产品门面：是什么、能做什么、怎么跑、怎么打包
不该写: 模块表、验证数字、事故记录、路线图
更新方式: 手写
-->

面向 **AI 与人协作** 的智能笔记工具（思维导图式），人机共建并维护笔记：

- **人用**：Electron 桌面界面（滚轮缩放、点击下钻、双击改名、节点上方浮动详情、图片双击预览、**中键拖动平移画布**、**md/pdf 附件内预览**）
- **AI 用**：CLI（`cli/mm-cli.js`）+ MCP（`scripts/mcp-server.js`）
- **数据**：`projects/<项目>/<项目>.json`（JSON 节点树，单一事实来源），图片存同项目 `assets/`（**每图必带 caption 备注**），附件文件存 `attachments/`（**每附件必带 caption**，随项目保存/打包）
- **可移植**：`npm run dist` 打包 Windows 安装包（electron-builder NSIS）

当前版本：0.18.0（v0.14.0：附件挂载 + 文件夹导出 + 中键平移 + 工具栏精简；v0.13.0 更名 AI MindMap + 事故恢复重建）

---

## 一、快速开始

```bash
npm install          # 安装依赖（electron / jsmind / vitest / electron-builder）
npm start            # 启动桌面界面
npm run verify       # 全部门禁 G1–G9（编码/文档登记/规则自洽/单测/CLI集成/冒烟/数据/文档基线），全绿才算可发版
npm run check:encoding  # 仅编码完整性门禁（BOM / 乱码）
npm run check:docs   # 仅文档登记门禁（表外文档 / 散落文档 / 悬挂登记）
npm run check:rules  # 仅规则文件自洽门禁（RULES.md 的条数/表格结构/编号引用/实现列）
npm test             # 单元测试（vitest）
node scripts/cli-integration.js  # CLI 全命令集成回归（临时项目，自动清理）
npm run smoke        # 冒烟自检（Electron 无头 + 窗口离屏不弹出、隐藏仍出帧，产出 smoke-shot.png；在项目副本上跑，不碰真实数据）
node scripts/doc-facts.js   # 打印权威事实（命令数/工具数/用例数/断言数/版本号）
npm run facts:write  # 重生成 docs/VERIFY.md（上述事实的唯一权威副本）
node cli/mm-cli.js --help   # CLI 帮助
node scripts/mcp-server.js  # MCP stdio 服务器（供其他 AI 工具调用）
npm run dsh:vendor          # 制作独立 DSH 运行包（vendor/dsh；一次性/更新时重跑）
npm run dsh:e2e             # DSH 独立实例端到端验证（孵化→401/200→收割，7 步）
npm run dsh:resident        # DSH 驻留语义端到端验证（孵化→宿主退出→服务存活→新宿主接管→显式停止）
npm run dsh:maint -- verify # 校验当前激活的 DSH 运行包（全量哈希）
npm run dist         # 打包安装包（build/AIMindMap-<版本>-setup.exe）
```

> **必须遵守什么 → `docs/RULES.md`**（规则唯一权威副本：门禁 / 铁律 / 约定）。

## 二、功能

| 能力 | 说明 |
|------|------|
| 思维导图 | jsMind 渲染，逐层下钻、搜索直达、展开/收起 |
| 手动编辑 | 工具栏 + 对话框（标题/详情 HTML/展开状态）、快捷键（F2 编辑、Delete 删除、Ctrl+Z/Y 撤销重做、Ctrl+N 新建） |
| 滚轮缩放 | 主画布滚轮 = 以指针位置为中心的缩放（替代默认滚动），范围 **0.15×–4×**（可总览整棵树）；Ctrl+滚轮同样生效；滚动条保留 |
| 中键平移 | **鼠标中键拖动 = 自由平移画布**（替代上下滚动），与缩放/选择互不干扰（v0.14） |
| **拖动树模式** | 右键**树内任意节点**（如「802.11 无线网络」根节点）→ 菜单「**拖动树：移动『802.11 无线网络』**」→ 进入拖动模式后**左键按住拖动 = 只移动这棵树，其他顶层主题树原地不动**（树偏移视图机制，与中键同一套 transform 坐标系）。模式内：**虚线框框住整棵目标树**（含折叠 +/− 号，随拖动移动）、**光标恒为 grab（按住时 grabbing）**、折叠用的 **+/− 号随树一起移动**；**在任意位置（节点/背景）右键即退出且不弹菜单**，Esc 也可退出（退出时树偏移保留，不弹回）。左键单击不选节点不弹详情。「还原视图」/切换项目/撤销重做复位树偏移；**连线端直接取节点实际左右边框中点（nodeBorderRect，节点任意移动后重画即跟随，为移动所有节点奠基）；位图随树偏移动态扩展不裁切，逻辑原点经 transform 承载、缩放不错位** |
| 浮动详情 | 选中节点后详情显示在**节点上方**（放不下时自动转到下方），点击空白处隐藏 |
| 图片挂载 | 节点可挂图片（`assets/`），caption 必填；浮动详情展示缩略图，**双击放大预览**（灯箱内滚轮缩放，Esc/双击关闭） |
| 文件附件 | 节点可挂任意附件文件（`attachments/`），caption 必填；**md 内联渲染预览、pdf 内嵌预览**（Chromium PDF viewer），其他类型系统打开；导出/打包随项目带走（v0.14） |
| 节点标签 | 节点 `tags[]`（编辑对话框/CLI `edit --tags`）；浮动详情显示标签 chips，**点击即按标签搜索** |
| 全文搜索 | 工具栏搜索框：标题/详情/图片备注/标签全文匹配（`search --full`），结果面板点击跳转 |
| 相关知识点 | 浮动详情「相关知识点」区：**出边（我引用谁）+ 入边（谁引用我，含跨项目反查）合并去重**，方向以 → / ← / ↔ 标注；点击即在详情框中打开该节点（未锁定的框被复用，用 📌/🖥 锁住即可并排对比多个关联节点） |
| **关联笔记** | **N 元关联实体**：介绍二者/多者之间关系的笔记，不挂在 `links` 上（故改链接不会抹掉它）。界面里是二级页面，**只能从「相关知识点」区进入**，界面与节点详情一致（拖动/改大小/📌 小锁/🖥 大锁/多框并存）；可在页内编辑标题与正文（写操作走 CLI）；由 AI/CLI 创建（`assoc-add`：成员 ≥2、可跨项目） |
| 反向链接 | CLI `backlinks` / IPC `app:backlinks`：单向反查（谁引用了某节点，含跨项目） |
| 关系审计 | CLI `orphans`：找出**无任何引用关系但有内容**的节点（区分"该处理"与"纯结构正常"） |
| 未链接提及 | CLI `mentions`：找出**正文提到了却没建 links** 的地方 —— `orphans` 的另一半，直接告诉你"该往哪连"；`--cross` 还扫跨项目两个方向（同名歧义标记而非乱猜） |
| 两跳邻域 | CLI `related <项目> <id> --depth 2`：把「相关知识点」从直接关联扩到**两跳**，看得出知识簇（局部图，不是全量图谱） |
| **静态站点导出** | CLI `export-html`：项目 → 自包含 `index.html`（树 + 搜索 + 面包屑），可分享/部署；**「相关知识点」内联为可跳转链接**（Obsidian/Quartz 需要插件才有） |
| **关系审计面板** | 工具栏「关系审计」：把上述孤立/漏链接清单搬进界面，**漏链接可直接一键补链接**（写操作走 CLI 闸门） |
| **命令面板** | `Ctrl+P`（或工具栏「⌘ 命令」）：一个框里模糊搜索**节点与命令**；`↑↓` 选择、`Enter` 执行、`Esc` 关闭 |
| 跨项目链接 | 节点可链接到其他项目节点（`links[]`）；**跳转统一走「相关知识点」**（跨项目条目带 `[项目]` 标记，点击即切项目并选中目标）。详情框的图片区只放图片，不再单列链接行 |
| Markdown 导入导出 | `import-md` 导入；`export-md` **导出为文件夹**（`<项目>.md` 含相对路径图片/附件链接 + `assets/` + `attachments/`，v0.14 起） |
| **JSON 打包导入导出** | `export-json` / `import-json`（**aimap v1 单文件**，图片 base64 内嵌，跨电脑可移植/备份） |
| **大文档导入建树** | CLI `import-project <新项目名> <文件.md｜.txt｜.docx｜.pdf>`：一个文件 → **新项目 + 一棵新树**（1 级标题成为顶层主题，"一个文件里两本书 ⇒ 两棵树"）。**PDF 有书签走书签、无书签自动回退文字层**（字号/编号/居中三判据；基准字号按字符数取众数）；疑似扫描页、剔掉的页眉页脚、目录条目、没进树的字符都会**如实打印**；两样都拿不到才**响亮拒绝**并给出路。`--dry-run` 只预览（含来源）不写盘 |
| **PNG 图片导出** | `electron . --export-image <项目> <输出.png>`；UI 菜单「文件 → 导出当前导图为 PNG…」 |
| 撤销重做 | 快照式 UndoStack（src/history.js），上限 50 |
| 数据安全 | 写盘前 CLI validate 闸门，坏数据拒收；**多路同时编辑有并发处理**：改**不同对象**（不同节点 / 不同父节点下的子节点 / 不同关联条目）**自动合并**（两边改动都保留）；只有改**同一对象**才拦，并**报出是哪个对象**、让你选「用磁盘上的版本（只丢这些对象上的改动）」或「保留我的、本次不保存」 |
| **多路同时编辑（可查）** | 多个 AI 会话与界面同时改一个项目时的完整链条：**事前避让** —— `changes` 命令答"最近是谁、什么时候、改了哪些对象"，`--since <锚点>` 答"自那以来改了什么"（⚠ 它报错＝**答不了**，不等于"没有变更"）；**事后兜底** —— 不相交自动合并、相交指名叫出对象。写入者身份可分辨（`cli:` / `mcp:` / `gui` / `gui-cli:`） |
| **节点 ↔ 本机文件夹** | 节点可带 `localPath`（本机目录绝对路径）：**详情框里一条可点链接** + **右键菜单「📁 打开文件夹」**，点击即用系统文件管理器打开该目录。适合"从本地 Markdown/源码目录建知识树"——导图与真目录随时互跳（换机器/换盘后可能失效，点开时报错而不是没反应）。CLI：`add`/`edit --local-path <绝对路径>` / `--clear-local-path` |
| AI 接口 | CLI + MCP（每个 MCP 工具透传同名 CLI 能力），零第三方依赖 |
| 多笔记项目 | `projects/` 下任意多个项目，工具栏切换。内置 `comnet` 现含**三棵主题树**：教材《计算机网络·自顶向下》（8 章）+「802.11 无线网络」知识树（54 节点，参考《802.11 无线网络权威指南》、按知识主题组织；树内 39 条知识链 + 18 条跨树链指向教材树 + 跨树关联笔记）+「**课程笔记**」（按**文件夹结构**镜像 `E:\markdown`：根 → 月份 → 周 → 天/任务 → 专题，每个结构节点带 `localPath` 可点开真目录；day3/day4 的笔记全文与案例程序源码已录入） |
| **主题左右分侧** | 顶层主题可配置**左右分布**（CLI `theme-layout <项目> --left a,b --right c,d`，方向唯一真源 `meta.layout`，界面保存不丢）。`comnet` 中「计算机网络」在**左**、「802.11 无线网络」在**右**，两棵主题树横向并排展示 |
| **DSH 侧边栏** | 菜单「视图 → 切换 DSH 侧边栏」（**Ctrl+B**）：主窗口右侧停靠**应用内嵌的独立 DeepSeek Harness 实例**（完整对话界面 + 插件），**默认打开、宽度可在交界处拖拽调节（280–720px）、服务驻留独立于主界面**（重启/升级主界面时侧栏对话不中断，新主界面自动接管既有服务），**专为边对话边让 AI 编辑笔记设计**——侧栏 AI 自动获得本工程的操作 skill（指针注入），改完笔记导图实时刷新；有未保存编辑时冲突保护优先保人的改动。运行包 `vendor/dsh`（捆绑 Node + DSH + pnpm，SHA256 清单锁定，**体积随 DSH 版本变化故不写数字**）随应用打包；数据目录 `userData/dsh-home` **完全独立**于全局 DSH；随机端口、token 认证。服务生命周期见下方「DSH 侧边栏的三条操作语义」。更新：`npm run dsh:maint -- import <包目录>` 原子切换，`rollback` 一键回退 |
| **仅 DSH 侧边栏** | 菜单「视图 → 仅 DSH 侧边栏（主界面迭代中用）」（「视图」菜单末项）：主界面（工具栏 + 画布）隐藏、侧栏铺满全窗 —— 给**外部 AI 迭代主界面代码**时用（改坏了也不挡着对话）。此模式下 **✕ = 隐藏窗口到后台**（不退出应用、服务不动，任务栏图标可点回）、**「—」= 最小化到任务栏**；取消勾选即恢复正常窗口 |
> **只改一边，不用全部重启（两条对称能力，2026-09-30 定）**：
>
> | 你要改哪一侧 | 用哪个出口 | 结果 |
> |---|---|---|
> | **思维导图主界面** | 导图页**右上角那个 ✕**（工具栏右端） | 只关左边导图页（`#main`/`#toolbar` 与菜单栏一起隐掉），**DSH 侧栏继续显示、对话保活**；侧栏右上角按钮变「⤢ 恢复思维导图页」 |
> | **内置 DSH 那一侧**（插件/配置/运行包） | **侧栏右上角的 ✕**（在「—」**下面**） | 收起侧栏**并停掉 DSH 服务**，**主界面继续用**（让位宽度归零 ⇒ 导图铺满）；点主界面右缘的 🤖 即重新打开（服务不在会自动重新孵化/接管） |
>
> · **窗口 ✕** = 关整个应用（连侧栏一起）；菜单里的「退出」已按用户要求删除，退出就用窗口 ✕。
> · **侧栏的「—」** = 只**收起**侧栏（服务继续驻留，🤖 一点就回来）—— 与它下面那个 ✕（连服务一起停）分工不同。
> · 两个角标按钮钉在**左侧原生控制栏**里（不是浮在页面上 ✓）：拖宽热区 + 「—」+「✕」都在这一条 30px 宽的栏里，
>   DSH 页面从它右边开始排 ⇒ **与页面零重叠** ⇒ 以后装什么 UI 插件都不会被我们的按钮挡住 ✓。
> · **内核「打开侧边栏」右栏会自动加宽**：那个面板要 `view ≥ 756px` 才渲染得出来（内核
>   `available = view − 56 − 400 ≥ 300`），原来上限 720 根本够不着 ⇒ 点了只会"闪一下没" ✗。
>   现在检测到你要开它就自动把侧栏加宽到 **900**（上限也从 720 提到 900 ✓），关掉再还原原宽度 ✓。
> · DSH 服务按驻留语义处理：退出**不收割已就绪的服务** ⇒ 下次打开对话还在。
>
> **给 AI 用的接口**（人类用按钮即可；两个方向对称，界面没在运行时**报错退出**、不会静默假装成功）：
> ```bash
> node cli/mm-cli.js sidebar-only on|off   # on=只留侧栏（关导图页）；off=恢复导图页
> node cli/mm-cli.js dsh-sidebar  on|off   # on=打开侧栏 DSH；off=关掉侧栏 DSH（连服务停，主界面不受影响）
> ```
> 走的是文件式控制通道（`src/control.js`：`mm-control.json` 命令 + `…-result.json` 回执，
> 界面每 400ms 轮询一次）—— **没有回执 = 没生效**，所以命令会报错而不是假装成功。

| 打包 | electron-builder NSIS 安装包 / portable 绿色版 |

### DSH 侧边栏的三条操作语义（v0.16 系列起）

侧边栏的 DSH 是一个**独立进程**（`vendor/dsh` 里的 node + dsh web），三条语义决定了
"关掉什么会连带关掉什么"：

| # | 语义 | 行为与边界 |
|---|------|-----------|
| 1 | **服务驻留** | 关闭主界面（✕ / 退出）**不会**停掉 DSH 服务：服务 detached、日志落 `userData/dsh-service.log`、凭据留在 `userData/dsh-service.json` —— 下次启动**直接接管**（对话与上下文原样回来，不是冷启动）。副作用：退出应用后 `node`/`dsh` 进程仍在后台驻留，要停请看第 3 条 |
| 2 | **仅侧边栏模式** | 「视图 → 仅 DSH 侧边栏」勾选后主界面隐藏、侧栏铺满。此模式 **✕ = 隐藏到后台**（不退出、服务不动，任务栏可点回）、**「—」= 最小化到任务栏**。用途：外部 AI 迭代 `renderer/` 时导图可能被改坏，仍要能继续对话 |
| 3 | **显式停止** | 菜单「视图 → 停止 DSH 服务」= 收割服务进程树 + 释放运行锁（下次切换侧边栏会重新孵化，冷启动）。「重启 DSH 服务」= 收割后重新孵化（**接管来的服务也能正确收割** —— 旧实现在接管场景只清凭据不杀进程，重启必然失败） |

维护互斥（`npm run dsh:maint -- import`）依赖运行锁 `dsh-runtime.lock`，而该锁的 pid
指向**服务进程**（不是孵化它的主界面）—— 于是"主界面已退出但服务还在"时维护照样被拒，
不会在活服务脚下换运行包。锁、凭据、日志都在 `userData`，不进渲染层、不进网络。

## 三、架构

**分层设计（核心原则：CLI 是唯一逻辑源，渲染层不复制业务逻辑）**

```
┌─────────────────────────────────────────────────────────┐
│ 人：Electron 界面                                        │
│   renderer/  app.js(接线+对外API) + app-*.js(视图/详情/媒体/操作) │
│              + editor.js(交互) + contextmenu.js + vendor/        │
│   main.js(主进程) + preload.js(IPC桥)                    │
│             │ window.desktop IPC（读/写走 CLI validate） │
├─────────────────────────────────────────────────────────┤
│ AI：CLI（cli/mm-cli.js） ←─ MCP 服务器（scripts/）       │
│   main.js(入口) + registry.js + commands/*.js            │
│   core.js(上下文) + docs-gen 自动生成 CLI.md             │
├─────────────────────────────────────────────────────────┤
│ 共享核心 src/（UMD：Node + 浏览器双端）                  │
│   schema.js(校验/版本) markdown.js convert.js(HTML⇄MD)   │
│   tree-utils.js history.js(撤销栈) relations.js(引用关系) │
│   config.js data-store                                   │
├─────────────────────────────────────────────────────────┤
│ 数据层 projects/<name>/<name>.json + assets/（唯一真源） │
└─────────────────────────────────────────────────────────┘
```

**模块职责表、加载顺序、设计原则与演进指引，见 `docs/ARCHITECTURE.md`**（不在本文件重复维护）。

**文档地图（只列人最常翻的几份；完整清单与每份的边界见 `docs/ARCHITECTURE.md` §5）**

> 为什么这里只列 4 份：**文档清单只有一处权威** —— `docs/ARCHITECTURE.md` §5 的登记表
> （它由门禁 G8 校验）。本文再抄一份完整清单，就等于制造第二份副本、迟早漂移
> （历史上 README 与 SKILL 各写一份文档/规则清单，已经不一致过一次）。

| 文档 | 作用 |
|------|------|
| `docs/RULES.md` | **规则唯一权威副本**（门禁 / 铁律 / 约定 + 强制方式 + 来源 + 元规则） |
| `docs/ARCHITECTURE.md` | 分层决策与理由、模块职责表、**文档架构与准入（§5）**、改代码找哪里 |
| `CHANGELOG.md` | 变更轨迹；查历史用 `node cli/mm-cli.js changelog --grep 关键词`（含滚动归档） |
| `docs/ROADMAP.md` | 路线图（已完成 / 待办 / **在飞 / 未收口** / 已否决） |

> 其余文档（`DATA-FORMAT` / `CLI` / `EXTENSIONS` / `AI-GUIDE` / `VERIFY` / `INCIDENTS`，
> 以及两个归档目录 `archive/` 与 `changelog/`）**见 §5 登记表**；AI 的任务路由见 `SKILL.md` 导航。

## 四、数据格式（概要）

```json
{
  "meta": { "name": "我的知识库", "version": "0.14.0", "formatVersion": 2 },
  "format": "node_tree",
  "data": {
    "id": "root", "topic": "我的知识库", "expanded": true,
    "children": [
      {
        "id": "sample-topic", "topic": "示例主题",
        "tags": ["标签1", "标签2"],
        "detail": "该主题的说明内容（Markdown）。……",
        "images": [{ "file": "assets/x.png", "caption": "整体结构示意图：展示主要模块与关系", "source": "出处（可选）" }],
        "links": [{ "project": "other-project", "id": "some-node", "caption": "相关章节" }],
        "children": []
      }
    ]
  }
}
```

- `id` 规范：小写字母/数字/连字符（`my-node`），全树唯一。
- `detail` 的**存储格式是 HTML**（渲染层以 `innerHTML` 注入）；用 `--detail-md` 可提交 Markdown 并自动转 HTML。
- `tags` 为可选字符串数组（标签，按标签搜索/统计用）。
- 图片 `caption` 必填；链接 `project`/`id` 必填（validate 会检测悬挂链接）。
- 完整格式见 `docs/DATA-FORMAT.md`。

## 五、CLI 速查

```bash
node cli/mm-cli.js read my-notes --json        # 读项目（树+详情+图片）
node cli/mm-cli.js add my-notes root --topic 新节点 --detail-md "**Markdown** 详情"
node cli/mm-cli.js edit my-notes my-node --detail-md "新内容"
node cli/mm-cli.js add-image my-notes my-node --file a.png --caption "图说明"
node cli/mm-cli.js link my-notes note-a --to my-notes --id note-b
node cli/mm-cli.js search my-notes 关键词 --full --json    # 全文搜索（detail/caption/标签）
node cli/mm-cli.js backlinks my-notes my-node   # 反向链接（谁引用了我，单向）
node cli/mm-cli.js related my-notes my-node     # 相关知识点（我引用谁 + 谁引用我，双向合并）
node cli/mm-cli.js orphans my-notes             # 关系审计：找出"有内容却无人引用"的笔记
node cli/mm-cli.js mentions my-notes            # 未链接提及：正文提到却没建链接的地方
node cli/mm-cli.js ui-state my-notes --json     # 写前协调：界面有没有未保存编辑（AI 动笔前先查）
node cli/mm-cli.js export-md my-notes out.md --with-detail
node cli/mm-cli.js export-json my-notes backup.aimap.json   # 备份/迁移（含图）
node cli/mm-cli.js import-md my-notes in.md --parent root
node cli/mm-cli.js changelog --grep 关键词 --full   # 查变更轨迹（工程命令，无须项目名；索引/检索，只读）
node cli/mm-cli.js validate my-notes
```

完整命令表见 `docs/CLI.md`（由 `docs-gen` 自动生成）。

## 六、MCP（供其他 AI 工具调用）

```bash
node scripts/mcp-server.js
```

标准 MCP 2024-11-05 stdio 协议。**每个工具都透传同名 CLI 能力**，不包含独立逻辑；
完整工具清单与参数见 `scripts/mcp-server.js` 的 `TOOLS`（已导出，可直接 `require`），
语义对照 `docs/CLI.md`，工具总数见 `docs/VERIFY.md`。
DeepSeek Harness / Claude Desktop / Cursor 等按各自 MCP 客户端配置方式指向本命令即可。

## 七、测试与验证（headless，禁键盘鼠标）

| 步骤 | 命令 | 覆盖 |
|------|------|------|
| 单元测试 | `npm test` | `src/` 共享核心：data-store（**写入中断不损坏原文件**、BOM 容错）/ history / schema（环+重复id+字段+**待写数据语义**）/ tree-utils（move 防环）/ markdown（导出→导入往返）/ convert / relations / assoc（关联实体与剪枝）/ links（链接剪枝） |
| CLI 集成 | `node scripts/cli-integration.js` | 全部 CLI 命令端到端（临时项目，自动清理）：防环、防穿越、roundtrip、tags/搜索/反链/相关知识点/两跳邻域/附件/顶层主题/clone 字段保真/get path/read --brief/detail 格式/orphans/mentions（含跨项目）/export-html/**失败退出码契约**/**关联笔记**/**删节点后的清理与备份恢复** |
| 冒烟自检 | `npm run smoke` | 渲染层全部交互（Electron 无头 + 窗口离屏不弹出 + 视觉断言：隐藏仍出帧/非纯色 + 截图）：详情框、锁、缩放平移、标签、相关知识点、搜索、保存闸门、撤销重做、附件、主题模式、**监听器泄漏回归**、**关联笔记二级页面与"保存不丢 assoc"**、**离屏窗口契约** |
| 数据校验 | `node cli/mm-cli.js validate-all` | 全部项目格式 + 悬挂链接 + 悬挂关联成员 + 环检测 |
| 文档基线 | `node scripts/doc-facts.js --check` | 文档中的计数与版本号是否与真值一致 |

> **各步的用例数/断言数不在此维护**，见 `docs/VERIFY.md`（自动生成，由 `doc-facts --check` 强制）。

改完功能必须：`npm run verify` 全绿（= 单测 → CLI 集成 → 冒烟 → validate-all 按序跑），且：
- 新增 CLI 命令 → `cli/registry.js` 登记 + `docs-gen` + `scripts/cli-integration.js` 加断言
- 新增渲染功能 → 在 `scripts/smoke/NN-*.js` 的**对应分域文件**加断言（入口 `smoke-assertions.js` 只做顺序拼接）
- 改核心模块（data-store/schema/tree-utils/markdown/convert）→ 对应 `tests/*.test.js` 加用例
- **纯笔记内容新增/修改**（`add`/`edit`/`link`/`assoc-add` 等）→ **只需** `node cli/mm-cli.js validate <项目>`
  （数据闸门）。这类改动不碰任何代码，跑全量链（vitest + 集成 + 冒烟）是**多余的**；
  `npm run verify` 是**改代码/改门禁**时才需要的
- `npm test` 固定走 `--pool=threads`：默认 `forks` 池会 fork 子进程并用**管道 stdio** 收集结果，在受限环境（企业 EDR / 沙箱禁止管道 stdio 子进程）下会 `spawn EPERM` 报 "no tests" —— 那是**假失败**，会掩盖真实结果

## 八、打包

```bash
npm run dist           # NSIS 安装包 → build/AIMindMap-<版本>-setup.exe
npm run dist:portable  # 绿色免安装 → build/AIMindMap-<版本>-portable.exe
```

已实测：v0.13.0 安装包约 106MB（Electron 44 运行时）。目标 Windows x64。
**发版前清单**（v0.16 起）：`npm run verify` 全绿 → **动了侧栏/服务生命周期时追加 `npm run dsh:e2e` 与 `npm run dsh:resident`** → `npm run dsh:maint -- verify`（DSH 运行包哈希校验）→ `npm run dist` → 打包后冒烟一次。

## 九、规则与维护约定

> **规则的唯一权威副本是 `docs/RULES.md`**（分级为门禁 / 铁律 / 约定，每条含强制方式与来源）。
> 本节只做**给人看的摘要**：门禁已收敛为一句"跑 `npm run verify`"（清单见 RULES §2），
> 下面只留**人需要记住的**几条铁律 —— 更细的边界与来源去 RULES 看。

**门禁**：**清单与说明的权威在 `docs/RULES.md` §2**（每条含"防的损害 / 实现 / 挂载点 / **能力边界**"），
执行顺序与耗时预算的权威是 `docs/VERIFY.md`（由 `scripts/verify.js` 生成）。
本文**不再抄一份** —— 门禁清单曾经有三份副本（README / RULES / VERIFY），是"同一事实多副本"的典型；
三方里只要有一份手工维护就会漂移。要跑就一句：**`npm run verify`**。

**铁律（无法机械化，共 6 条；详见 `docs/RULES.md` §3）**

1. **断言必须来自执行，而非推理**（R1）—— 写下"支持/会/返回"之前先跑一次；跑不了就写"未验证"。
2. **双文档同步**（R2）—— 每次变更同步 `CHANGELOG.md`（`[Unreleased]`）+ `README.md`，缺一不可；发版用 `node cli/mm-cli.js release [版本号]`。
3. **分层测试**（R3）—— 改核心加单测、加命令加集成断言、加渲染功能加冒烟断言。
4. **编辑笔记 ≠ 功能迭代**（R3a）—— 纯笔记增删改（`add`/`edit`/`link`/`assoc-*` 等）**只跑一次 `node cli/mm-cli.js validate <项目>`**，
   **不要跑 `npm run verify`**（那是改应用代码才跑的；误跑会白等整条验证链）。
5. **测试一律 headless**（R4）—— 禁止用鼠标键盘操作界面来测试。
6. **改动即连带**（R5）—— 改变「某功能如何被使用」（数据形状/命令语义/交互模型/字段含义/默认值）时，
   同一次改动里列出受影响的**使用者可见面**（GUI 交互、断言、文档示例、渲染入口）并逐个核对，结论（含"无影响"）写进 CHANGELOG。
   **判据不是"测试是否还绿"，而是"人按原有习惯操作，得到的还是不是设计意图"** —— 冒烟门禁（G5）只验证行为级可用性，验证不了这一点。

**约定与架构决策**（低损害或一次性决策，**不是**铁律）：单一真源（只维护本目录）、
数据改动走 CLI、写盘一律复用 `writeFileAtomic` —— 见 `docs/ARCHITECTURE.md`。

> **文档分工**（每份文档的作用与边界见 `docs/ARCHITECTURE.md` §文档架构）：
> `docs/RULES.md` 规则单源 · `CHANGELOG.md` 变更轨迹 · `docs/ROADMAP.md` 规划 ·
> `docs/INCIDENTS.md` 事故与派生禁令 · `docs/VERIFY.md` 验证基线 · `docs/archive/` 历史快照。

事故与操作禁令见 **`docs/INCIDENTS.md`**（两次文件系统级全损的经过与派生禁令）。

## 十、路线图

见 **`docs/ROADMAP.md`**（含已完成、待办与已否决事项）。

