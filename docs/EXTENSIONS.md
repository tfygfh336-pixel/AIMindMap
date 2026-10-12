# 扩展契约（EXTENSIONS）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 契约
作用: 扩展契约：稳定性等级、如何新增命令/工具
不该写: CLI 全量签名（指向 CLI.md）
更新方式: 手写
-->

> 作用：写给**要在本工程上加东西的人 / AI** —— 能扩展什么、怎么扩展、哪些接口可以依赖。
> 边界：命令**完整用法**见 `docs/CLI.md`（自动生成）；架构理由见 `docs/ARCHITECTURE.md`。
> 前置认知：本工程没有插件市场，也**不打算有**（原因见 §5）。扩展 = 改源码 + 跑验证。

---

## 1. 可依赖的稳定接口

只有以下三类是**对外承诺**的接口。其余（内部函数、文件布局、DOM 结构）随时可能变。

### 1.1 数据格式（最稳定）

`projects/<name>/<name>.json` 是**唯一真源**，格式契约见 `docs/DATA-FORMAT.md`。
承诺：**只增不改**（新增可选字段不破坏旧解析器；破坏性变更递增 `formatVersion`）。
→ 外部工具应直接读 JSON 文件，而不是调 CLI 来读。

### 1.2 CLI 命令（稳定的自动化入口）

`node cli/mm-cli.js <命令>`，退出后：stdout 输出结果；**失败时退出码非 0** 且 stdout 以
`error: <原因>` 开头（两重判据）。`--json` 提供机器可读输出。

稳定性分三级 —— 改动前请确认你在依赖哪一级：

| 级别 | 含义 | 命令 |
|------|------|------|
| **稳定** | 名称、参数、JSON 字段结构不会在非大版本中变更 | 数据读写类：`read`/`list`/`get`/`search`/`add`/`edit`/`move`/`remove`/`validate`/`validate-all`/`projects`/`stats`/`assets`/`files`/`init` |
| **演进中** | 可用，但字段可能增补（不影响既有字段） | 树与资源：`backlinks`/`related`/`orphans`/`mentions`/`clone`/`add-root`/`expand-depth`/`theme-layout`/`link`/`unlink`/`links`/`links-prune`/`add-image`/`remove-image`/`add-file`/`remove-file`<br>导入导出：`import-md`/`import-project`/`import-dir`/`export-md`/`export-json`/`export-html`/`import-json`<br>事务（操作清单一次生效）：`apply`<br>条目层写原语（契约 `docs/ITEM-MODEL.md` §3）：`item-add`/`item-edit`/`item-remove`/`item-move`/`item-order`/`render-detail`、`migrate`（`migrate items` 子命令：v2→v3 条目层迁移）<br>条目层复校与体检：`recheck`/`health`<br>关联笔记：`assoc-list`/`assoc-add`/`assoc-edit`/`assoc-remove`/`assoc-prune`<br>AI 问答：`ask`/`ask-apply`<br>界面协作：`ui-state`/`sidebar-only`/`dsh-sidebar`/`dsh-status`/`dsh-prefill`/`dsh-caps`<br>历史：`changes`/`changelog` |
| **内部** | 工程维护用，不保证兼容 | `docs-gen`/`release` |

> ⚠️ **本表必须覆盖 `cli/registry.js` 里的全部命令**（每条命令**恰好**落在某一级里）——
> 门禁 G8 的第 ⑮ 条判定（`scripts/docs-registry-check.js` 的 `checkStabilityCoverage`）机械核对。
>
> **`search` 的条目层增补（v3，2026-10）**：仍列「**稳定**」—— 名称、参数、**既有**字段结构未变；
> 但默认搜索口径从"只搜节点"改为"**默认搜条目**"（`--topic-only` 回退到旧口径），并**增补**了命中字段
> `itemId`/`type`/`itemized`/`matchIn`（只增不改、不影响既有字段消费方）。理由与签名冻结在 `docs/ITEM-MODEL.md` §3。
> 加这条判定的原因是一次真实的漏登记：`import-project` 一度**不在任何一级**，
> 而同批清点又查出 11 条同型漏登记（`ask`/`ask-apply`/`theme-layout`/`expand-depth`/
> `ui-state`/`sidebar-only`/`dsh-sidebar`/`dsh-status`/`dsh-prefill`/`dsh-caps`/`changelog`）。
> 病根是老病：**表在文档里、命令在代码里，两边都没有守望者** —— 新增命令时忘了改文档，
> 没有任何东西会红 ✗。现在有门禁了 ⇒ 新增/改名/删除命令时本表与 `cli/registry.js` 要**同批**改 ✓。
> 判"放哪一级"是人的判断（门禁只判"有没有落在某一级"）：会被外部工具/AI 依赖的放**演进中**，
> 工程自用的放**内部**。

### 1.3 MCP 工具（面向支持 MCP 的 agent）

`node scripts/mcp-server.js` 启动 stdio MCP 服务器（协议 2024-11-05）。
**每个 MCP 工具都是某个 CLI 命令的透传**，不包含独立业务逻辑 ——
所以「CLI 能做的，MCP 都能做；MCP 没暴露的，直接用 CLI」。工具清单见 `docs/VERIFY.md` 与
`scripts/mcp-server.js` 的 `TOOLS`（已导出，可 `require` 读取）。

---

## 2. 如何新增一个 CLI 命令

1. 在 `cli/commands/<域>.js` 中实现，函数签名 `fn(ctx)`：
   - `ctx.read()` / `ctx.write(data)` —— 读/写当前项目（**写会过校验闸门**）
   - `ctx.args._` 位置参数、`ctx.args.<key>` 具名参数（`--key value`）
   - `ctx.projectName`、`ctx.out()` / `ctx.outJson()`、`ctx.error(msg)` 抛错
   - `ctx.tree`（共享树函数）、`ctx.store`（存取层，含 `writeFileAtomic`）
2. 在 `cli/registry.js` 的 `init()` 中登记 `{ name, aliases, usage, desc, fn }`。
3. 在 `scripts/cli-integration.js` 追加断言（**新增命令必须加**）。
   断言要测**真实副作用**，而不是"命令没报错"：例如 `export-html` 的断言会校验
   "模型引用的每个资源都真的复制到了输出目录"（否则分享出去的站点会图挂）。
   造测试图时注意：**目标节点必须真的存在且真的建成了链接**，否则 `link` 会静默失败、
   断言假通过/假失败 —— 必要时先加一条"前置条件断言"。
4. 重生成文档：`node cli/mm-cli.js docs-gen`。
5. 若需暴露给 MCP：在 `scripts/mcp-server.js` 的 `TOOLS` 加定义、在 `callTool` 加 `case`
   （**只允许拼参数转发 CLI，不得复制业务逻辑**）。
6. 同步 `CHANGELOG.md` 的 `[Unreleased]` 与 `README.md`（规则 R2，见 `docs/RULES.md`）。

**红线**：不要在命令里手写 `fs.writeFileSync` —— 一律用 `ctx.store.write()` /
`ctx.store.writeFileAtomic()`，否则绕过校验闸门或产生非原子写。

---

## 3. 如何新增渲染层功能

渲染层已拆分（`renderer/app.js` 曾是 1340 行单文件，现按职责分为多个模块，
全部挂在共享命名空间 `window.MM`，详见 `docs/ARCHITECTURE.md` §2.5）：

1. 新功能放进**对应职责的模块**（视图→`app-view.js`、详情框→`app-detail*.js`、
   媒体→`app-media.js`、操作与数据→`app-actions.js`）；`app.js` 只留 UI 接线与
   `window.MMApp` 导出。纯计算（如排序、检索）应下沉到 `src/` 并加单测 ——
   `src/palette-rank.js` 就是这么来的。
2. **业务逻辑不得在渲染层复制**：校验/转换/序列化走 `src/`（UMD，浏览器可直接用）。
3. **跨模块调用一律走 `window.MM` 的包装函数**（`const renderMind = (d) => MM.renderMind(d);`）。
   不要用解构赋值 —— 其他模块是后加载的，解构会在加载时捕获 `undefined`。
   拆分前同一闭包里的可变共享变量（整体重新赋值的那种）用同名全局槽位承载。
4. **注册全局监听 / 观察者必须放进带幂等守卫的 `bind*` 函数**
   （如 `bindContainerControls`、`bindViewportControls`、`bindFdGlobalDrag`、`bindAudit`、`bindPalette`），
   **禁止内联进 `renderMind()`** —— 该方法每次 undo/redo、切项目都会执行，
   内联注册会导致监听器无限累积（本项目曾因此出现"点一次触发 N 次"的泄漏）。
5. 在 `scripts/smoke/` 的**对应分域文件**追加断言（**新增渲染功能必须加**）。
   注意测**可观测的副作用**，不要依赖 jsMind 内部实现 —— 例如"折叠是否生效"不能用
   `jmnode` 数量判断（折叠时节点仍留在 DOM 里，靠样式隐藏，数量恒不变）。
6. 同步 `CHANGELOG.md` + `README.md`。

---

## 4. 如何新增数据字段

1. 改 `src/schema.js` 的校验（新增**可选**字段不必递增 `formatVersion`）。
2. 改 `docs/DATA-FORMAT.md`（契约文档，必须与实际一致）。
3. 若字段需要被 AI 读到：确认 `cli/commands/project.js` 的 `buildReadView` / `get` 输出它。
   **若新字段不在节点树里**（如 `assoc` 这类项目级集合）：它不会被 `serializeTree`、
   `export-md` 自动带上，必须逐条确认出口 —— 渲染层序列化（`state` 持有 + 写回）、
   `export-json`/`import-json`（`src/bundle.js` 的 `buildBundle` 与命令层复原）、
   主进程 `project:save` 的兜底，否则会在某条路径上**静默丢数据**。
4. 加测试：`tests/schema.test.js`（校验规则）+ 必要时 CLI 集成断言。

**注意**：字段加进 JSON 不等于**对 AI 可见**。AI 只读 `read` / `get` 的输出，
新增字段若没进这两个视图，等于白加。

---

## 5. 为什么不支持插件 / 主题 / 脚本扩展

本工程刻意不提供插件体系（**已决策，不再讨论**，原因记录在 `docs/ROADMAP.md` 的"已否决"）：

| 常规做法 | 本工程的选择 | 理由 |
|---------|------------|------|
| 插件市场 + 热加载 | ❌ 不做 | 需要沙箱、签名、审核、版本兼容矩阵；单机个人工具，收益远小于维护成本 |
| 主题/样式包 | ❌ 不做 | 样式集中在 `renderer/style.css`，需要时直接改文件即可 |
| 用户脚本钩子 | ❌ 不做 | 与"数据改动一律走 CLI 校验闸门"冲突，会引入未校验写入 |
| 外部 API 集成 | ✅ 用 MCP | **AI 就是扩展机制**：长尾需求由 AI 通过 CLI/MCP 组合现有原子能力动态完成，无需预置插件点 |

**这条设计的实际含义**：想加功能时不要设计"扩展点"，而是问
"现有原子命令能否组合出来" —— 例如"批量给某主题下所有节点打标签"不需要新插件，
用 `list --json` 筛出 id 再循环 `edit --tags` 即可；若这个组合被反复需要，
就把它固化成**一条新 CLI 命令**（§2），而不是一个插件 API。

---

## 6. 与其他 AI 工具协作

- **MCP 客户端**（Claude Desktop / Cursor / DeepSeek Harness 等）：配置
  `command: node`、`args: ["<工程绝对路径>/scripts/mcp-server.js"]` 即可。
- **无 MCP 的工具**：直接调 CLI（`node cli/mm-cli.js ...`）或读 JSON 文件。
- **接入前建议先读**：`SKILL.md`（触发与动作现场条目）→ `docs/RULES.md`（必须遵守什么）→
  `docs/AI-GUIDE.md`（操作规范）→
  `docs/DATA-FORMAT.md`（数据契约）。这三份足够写出正确的读写实现，无需读源码。
