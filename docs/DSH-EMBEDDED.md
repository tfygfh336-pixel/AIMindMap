# 内置 DSH 台账（DSH-EMBEDDED）

<!-- registry
层: 设计
作用: 记录「应用内置的独立 DSH 实例」当前被改动成什么样、每项改动属于哪一侧、升级运行包后会不会丢、以及怎么重建/怎么核对
不该写: 不写内核私有常数本身（只写"来源文件+复核命令"，因为它们是易腐数字）；不写会话/消费等运行时状态；不复制 CHANGELOG 的变更叙事
更新方式: 每次动内置 DSH（迁移插件、改配置、加应用侧注入、换运行包）后同批更新本表；改完跑 `npm run docs:registry`
-->

## 0. 为什么需要这份台账

内置实例的现状**只存在于 `%APPDATA%\AI MindMap\dsh-home` 的现网状态里** ✗ ——
2026-09-30 那次插件/配置迁移（7553 文件 / 199.21 MB）**在仓库里零记录**：
`git grep` 无命中、CHANGELOG 无条目、commit 里没有它。后果：换机器或换人接手时，
"内置实例现在是什么配置"**只能靠现场反推** ✗。

这份台账就是那个缺失的单一真源。**判据**：每条改动都要能回答三件事 ——
① 属于哪一侧；② 运行包升级后会不会丢；③ 怎么重建、怎么核对（给命令，不给形容词）。

## 1. 三层结构与"升级会不会丢"

| 层 | 位置 | 升级运行包后 |
|---|---|---|
| **数据侧** | `%APPDATA%\AI MindMap\dsh-home\`（profiles/web、.agent-presets、skills、storages、sessions） | **保留** ✓（换包不碰 dsh-home） |
| **应用侧** | 本仓库代码（`main-dsh-sidebar.js`、`main.js`、`src/control.js`…）与**注入到内核页面的** CSS/JS | **保留** ✓（在 git 里），但**有效性**可能静默失效 ✗（依赖内核私有 DOM/文案） |
| **运行包侧** | `vendor\dsh\`（自带 node + DSH + pnpm，585 MB（快照，dsh 0.1.7-rc.2）） | **全丢** ✗ —— 整体替换。**规矩：一律不 patch** ✓（哈希清单 `npm run dsh:maint -- verify` 会判红） |

> ⚠️ `docs/ARCHITECTURE.md` 里"换包流程**永不触碰** dsh-home（用户数据）"这句话
> **只对换包流程成立** ✓。**插件/配置导入是另一条受控通道**，它就是往 dsh-home 写东西 ✓ ——
> 读那句话时别误以为 dsh-home 只读。

## 2. 台账

### A. 数据侧（dsh-home）

| # | 改动 | 现状证据 | 升级运行包 | 重跑导入 | 怎么重建 / 核对 |
|---|---|---|---|---|---|
| A1 | 人设 `liangshen`（5 文件）写入 `.agent-presets\` | 回执 `receipt-migrate-ed160722fe48.json`（deployed 5 项 created） | 保留 ✓ | **会被源侧覆盖** ✗ | `dsh-migrate-in` 配置层重放；核对：文件数 + 哈希。⚠️ **2026-10-08 更正（重要）**：这份目录是**遗留形态、内核已不再读它** —— 内核自带 skill `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md` 原文写着"**Nothing reads that directory any more**"；「梁神模式」真正生效靠的是**已安装的插件 `@linxin666/dsh-liangshen`**（它激活时把自带的 preset **声明**给 registry，"declare = enabled"，不往 dsh-home 写东西）。⇒ **"文件数 + 哈希"核对的是那份不影响生效的副本** ✗；要核"模式真的可用"请按 A5 的判据（列表里能选） |
| A2 | 插件载荷：`profiles\web\node_modules` **7543 文件 / 199.02 MB** + `config\rules.yaml` + `cordis.patch.yml` + `package.json`（8 bundle）+ pnpm lock/workspace；合计 **7553 文件 / 199.21 MB**（快照，dsh 0.1.7-rc.2） | 回执 `receipt-migrate-45242730bc15.json` + `packages\migrate-45242730bc15\manifest.json`（I1–I4 全 ✓） | 保留 ✓ | **会被源侧覆盖** ✗ | `dsh-migrate-in` 载荷层重放；核对：文件数/字节**容差 0** |
| A3 | **迁移后手工改过 `cordis.patch.yml`**（16:37:48，晚于 apply 15 分钟）：`defaultPreset` `full-access-review` → **`workspace-write`** + 4 行沙箱注释 | 改完当时与迁移包 payload 逐字节不同（差 9 行）；与全局 `~/.dsh` 差 15 行。**2026-09-30 晚复核（实测）：该键已又变回 `full-access-review`** ⇒ 那次手改**已经被后来的重跑冲掉** ✓ —— 这就是"手工态必丢"的直接证据（不是推测） | 保留 ✓ | **会丢** ✗✗ | 唯一不可复现的数据侧改动 ⇒ **现在只许**把值写进 `dsh-home\.embedded-overrides.json` 再 `render`（§3-② / B9）✓；核对 = 自检第 6 项（`overrides check`） |
| A4 | 内置实例**自建**物（非我们的改动，但要知道边界）：`profiles\web\cordis.yml`（空入口模板）、`hub.log`、根下 `storages/ sessions/ dsh-usage/ task-board/ skin-center/`、`skills\`（应用侧写入）、`node_modules\@deepseek-ai.stale-*`（升级残留） | `dsh-service.log` 有成功启动 | 保留 ✓ | 明确**不迁** ✓（含凭据 `.credentials.yaml`，有意不迁 ✓） | 无需动作；别把它们当"配置"迁移 ✗ |
| A5 | **「aimindmap 模式」的 agent preset 声明**（2026-10-08 新增）：`cordis.patch.yml` 末尾的**生成块** `- insert: - id: preset-aimindmap / name: @deepseek-ai/dsh-agent-preset`，其 `plugins` 清单（19 个顶层条目）**从运行包自带的 `presets/standard.patch.yml` 生成**、只替换 `persona.prefix` 为本工程的人设文本；**同块还有一条按 id 覆盖** `agent-preset-registry: {default: aimindmap}`（= 设成**默认模式**；按 id 覆盖会整份替换该行 config，而该行只有 `default` 一个键 ⇒ 是完整的）。⚠️ **用户选择优先**：若使用者在界面里选过模式（volatile `selectedDefault`），部署默认对它不生效 | `render` 回执 + `overrides check` 的 `✓ $presets.aimindmap`（**逐行比对**生成块与"现在重新生成的结果"）+ `✓ permission.defaultPreset`；声明在 `dsh-home\.embedded-overrides.json` 的 `"$presets"` | 保留 ✓（overrides 在 dsh-home；生成块在 patch 里） | **会丢** ✗（重跑导入按 A3 同路径覆盖） | **重建**：`node scripts/dsh-embedded-overrides.js render` → `check`（非 0 = 没生效）。**核对生效**（人工，5 秒）：内置侧栏 → 新建任务 → 模式选择器里应有「aimindmap 模式」，且**默认徽标**在它身上（若不在：你先在界面里选过一次模式 ⇒ 用户选择优先，再选一次 aimindmap 即可）。⚠️ 生效判据**不是**"文件里有那几行" —— 那是 A1 栽过的坑 |

### B. 应用侧（本仓库代码 / 注入）

| # | 改动 | 证据 | 升级后 | 怎么核对 |
|---|---|---|---|---|
| B1 | 侧栏上限 **720 → 900** + 内核右栏**自动加宽/关掉还原**（`ensureRightbarRoom` 幂等、只在自己仍是自动宽度时还原） | `b777bc2`；`main-dsh-sidebar.js` 常量区 | 代码保留 ✓；**900/756 是内核私有常数** ✗ 内核改预算即失效 | 自检第 8/9 项 + 重读内核 `computeColumns` |
| B2 | **注入内核页面的右栏观察器**：事实信号 `data-rightbar-collapsed`（MutationObserver）+ **意图信号**（点按钮双语正则 / Ctrl+Shift+B） | `main-dsh-sidebar.js`；`dsh-status.rightbarWatcher` | 代码保留 ✓；**有效性可能静默失效** ✗（内核改文案/DOM ⇒ 装上了但永不触发，**不报错** ✗） | `dsh-status --json` 的 `rightbarWatcher ∈ {on, already}` + 人工点一次看 `rightbarOpen` |
| B3 | 观察器**超时兜底**（3s，超时记状态、下一轮重试）+ 冒烟门禁"安装必须有终态" | `a1b056c`（真机 bug：注入撞页面加载时 `executeJavaScript` 永不返回 ⇒ 状态停在 null ⇒ 永久失效 ✗） | 保留 ✓ | 冒烟 `24-*`（`安装有终态=true`） |
| B4 | **窄宽适配**（应用侧注入）：`.dsh-narrow/-xs` 类（阈值 340/460）+ `overflow-x:hidden` / `min-width:0` / `max-width:100%` + CSS 变量 `--dsh-viewport-width`；并量出 overflow 写进 `status.narrow` | `a3f24f1` / `c7c7e5c` | 代码保留 ✓；**弱依赖内核类名** ✗ 不命中也不报错 | `dsh-status --json` 的 `narrow.mode` / `narrow.metrics.overflow` 非 null |
| B5 | 左侧**原生控制栏**（30px：拖宽热区 +「—」+「✕」合一）+ 对称命令 `sidebar-only` / `dsh-sidebar`（off 连服务一起停） | `a3f24f1` / `6931919` / `4794a1c` / `fbc3746`；`src/control.js`（**无回执即报错**） | 保留 ✓ | `node cli/mm-cli.js --help` 有这三条；冒烟 22/23/24 |
| B6 | **只读诊断 `dsh-status`**（可见性/总占宽/窄宽/溢出/`rightbarOpen`/`autoWide`/`rightbarWatcher`；**白名单输出，绝不含 url/token**） | `docs/CLI.md`；`AI-GUIDE.md` §4.0 | 保留 ✓ | **升级后自检的主要仪器** ✓ |
| B7 | **指针 skill 注入**：应用孵化时写 `dsh-home\skills\ai-mind-map\SKILL.md`（幂等） | `src/dsh-sidebar-skill.js` | 保留（启动按需重写） ✓ | 文件存在 + 内容里的真源路径正确 |
| B8 | **内核事实进文档**（本台账 + `AI-GUIDE.md` §4.0 + `ARCHITECTURE.md` 侧栏段 + CHANGELOG） | 上述文件 | 保留 ✓；**756/900 等数字易腐** ✗ | 升级后重读内核源码并更新本台账 |
| B9 | **本地覆盖"可重放"**（治理 A3 的那条机制，已落地）：`dsh-home\.embedded-overrides.json`（陈述式差异：现在有 `permission.defaultPreset` 与 `$presets.aimindmap`）+ 渲染器 `scripts\dsh-embedded-overrides.js`（`render [--dry-run]` / `check`；白名单 4 个条目，白名单外**报错退出**；写盘前备份 `.bak-<时间>`；幂等）。**2026-10-08 扩展**：新增 `$presets` —— 渲染器会**插入**一条 `@deepseek-ai/dsh-agent-preset` 声明，清单**从运行包自带的 `presets/<cloneFrom>.patch.yml` 生成**（不手抄进仓库，避免随升级漂移）、只替换 persona 文本；`check` 会把生成块与"现在重新生成的结果"**逐行比对**（手改/半截都判红）。**它同时是那份 patch 文件的唯一写者**（新增"要渲染进 patch 的东西"请扩它，别再开第二个写者 ✗） | §3-②；`tests/dsh-embedded-overrides.test.js`（22 条：锁"连跑两次 sha256 不变"、白名单边界、生成块与运行包逐行 id 对齐、check 抓手改、require 守卫） | 代码保留 ✓；overrides 在 dsh-home 里 ⇒ 按 A 类**保留** ✓ | **升级 / 重跑导入之后要跑它**：`node scripts/dsh-embedded-overrides.js render`（把手改态渲染回去）→ `node scripts/dsh-embedded-overrides.js check`（非 0 = 没生效）。自检第 6 项就是这次 `check` ✓ |
| B10 | **升级后自检**（只读、不起 Electron、10 项三态）：`scripts\dsh-embedded-check.js`（`--home` / `--json`）——§4 那张表就是它的 10 项 | `tests/dsh-embedded-check.test.js`（锁真实字段名 + `UNKNOWN ≠ PASS` + `--json` 必须是合法 JSON 数组） | 代码保留 ✓；判据依赖的字段名是**迁移侧**的（回执 + 投递包 `manifest.json`）⇒ 迁移侧改结构会让它退化 ✗ | **换运行包 / 重跑导入之后必跑**：`node scripts/dsh-embedded-check.js --json`。真值来源 = 回执 `receipt-migrate-*.json` **及其指向的** `packageDir\manifest.json`（第 3 项比 bundles、第 4 项比 `files{}` 的文件数/字节）。**UNKNOWN ≠ 通过** ✗ |

### C. 运行包侧（vendor\dsh）

| # | 事实 | 证据 |
|---|---|---|
| C1 | 现役 `dsh 0.1.7-rc.2`（id `dsh-0.1.7-rc.2-win32-x64-27566f-…`，27566 文件 / 585.1 MB）；两个备份：`vendor/dsh-0.2.0-rc.2-backup`、`vendor/dsh-0.1.5-rc.1-backup` | `vendor\dsh\manifest.json` |
| C2 | **升级通道**：`npm run dsh:vendor`（`--out` 必须是不存在的新目录，绝不覆盖）→ `npm run dsh:maint -- import <包目录>`（装到 `userData\dsh-runtimes\<id>` + `active.json` **原子切换**；`rollback` 回 bundled） | `scripts\vendor-dsh.js`、`scripts\dsh-maintenance.js`、`src\dsh-package.js` |
| C3 | 本次**对 vendor 零补丁** ✓（抽查 `app\lib\bin.js`、`app\package.json` 与全局安装 SHA256 完全一致） | 哈希比对 |

## 3. "升级不丢改动"的三条机制（含治理 A3）

**① 台账即真源**：本文件；改动同批更新，`npm run docs:registry` 重生成登记表。

**② 把手工态变成"可重放"**（治理 A3 ✗）：
- 新增陈述式 `dsh-home\.embedded-overrides.json`（**只写差异**：`defaultPreset` / `provider` / `model` / `reasoningEffort` / `rulesFile`）；
- 新增纯函数脚本 `scripts\dsh-embedded-overrides.js`，把 overrides **渲染进** `profiles\web\cordis.patch.yml`；
- 固定顺序：`migrate-in apply` → `overrides render` → 重启服务。**禁止**迁移后手工编辑该文件 ✗。
- 验证三条（报错必须含"对象 + 期望 + 实际"）：连跑两次 sha256 不变（幂等）✓；
  临时副本重放后与现网**逐字节**一致（重放证明）✓；解析 YAML 断言字段相等 ✓。

**③ 换包固定流程**（顺序即防线）：
停服务 → **备份配置层到 dsh-home 之外**（记前后 sha256）→ 制新包到 `vendor\dsh-<ver>`（新目录）→
旧包改名 `*-backup` → 新包改名 `vendor\dsh` → `npm run dsh:maint -- verify` → 重启 → 自检 → 更新本台账 + CHANGELOG。
**禁止**：编辑 `vendor\dsh\**` ✗、编辑 `userData\dsh-runtimes\**` ✗。

## 4. 升级后自检清单（10 项；一条命令 + 人工两项）

| # | 检查 | 判据 |
|---|---|---|
| 1 | 运行包版本 | `manifest.dshVersion` == 目标 |
| 2 | 运行包**零补丁** | `npm run dsh:maint -- verify` 通过 |
| 3 | profile 清单 | `package.json` 的 `dsh.profile.bundles` **逐字** == 期望 8 项 |
| 4 | 载荷完整 | `node_modules` 文件数/字节 == 回执值（**7543 / 199.02 MB**，容差 0） |
| 5 | **模式被声明**（2026-10-08 更正判据） | `overrides.$presets` 里每个模式都在 `cordis.patch.yml` 里有对应的 `- id: preset-<id>` 行。**旧判据**（`.agent-presets\<name>` 的文件数与哈希）**已废** —— 内核不再读那个目录（见 A1 更正），它核对的是**不影响生效的副本** ✗；遗留目录现在只作为**信息**附带报告。内容级核对（生成块逐行比对）在第 6 项，不在这里重复 |
| 6 | 本地覆盖生效 | `cordis.patch.yml` 的 `defaultPreset/model/rulesFile` == overrides 渲染结果；**且 `$presets` 的生成块与"现在重新生成的结果"逐行一致**（手改/半截都算没生效） |
| 7 | **独立性** | payload 内零 reparse 点；无"源机器绝对路径"引用（复用迁移的 I1/I2 判据） |
| 8 | 注入链完好 | `node cli/mm-cli.js dsh-status --json`：`narrow.mode` 与 `rightbarWatcher` **都非 null** |
| 9 | 内核事实仍成立 | 把侧栏拖到 900 ⇒ 点「打开侧边栏」⇒ 右栏真的出现（`rightbarOpen=true`、`autoWide` 有还原值）—— **人工确认**（判据不可机械判定，故不做硬门禁 ✗） |
| 10 | 状态未被污染 | 回执 `deployed[]` 里没有 `sessions/ storages/ dsh-usage/ task-board/ skills/` |

## 5. 已知风险与开放问题

| # | 风险 | 说明 |
|---|---|---|
| R1 | 目标机 DSH 版本不同 | 插件版本闭包不成立（现有 `dsh-closure` 阻断）；"只导配置层"的降级路径没人验证过 |
| R2 | 原生依赖跨机器 | payload 含 `sharp` / `node-pty` / `koffi` / `@img/*`；内置 pnpm 不认 allowBuilds ⇒ 原生构建会被**静默跳过** ⇒ 只能物理复制本机 ABI 的二进制；ARM64 可能不可用 |
| R3 | **插件侧没有许可证门禁** ✗ | Node 侧有"缺许可证直接失败"的硬约束 ✓，但 `@linxin666/*` 等插件能否随应用分发**未知** ⇒ 对外分发前需要一条门禁 |
| R4 | 体积与断网 | payload 199 MB、运行包 585 MB（快照，dsh 0.1.7-rc.2）；断网时只能走 zip 包 |
| R5 | 手工态（A3） | 不治理，别人的机器上会重演 |
| R6 | 内核私有依赖 ⇒ 静默失效 | 观察器/窄宽 CSS 都依赖内核 DOM 与文案；变了**不报错** ✗ ⇒ 靠 `dsh-status` + 自检第 9 项 |
| R7 | 配置与状态路径混放 | 迁移靠**路径白名单**而非内容分类 ⇒ 加新插件类型容易漏 |
| R8 | 快照漂移 | 本台账带清点时刻；并发编辑会让"改了什么"漂移 ⇒ 更新时一并改时刻 |
| R9 | **开放**：`profiles\node_modules` 真实目录之谜 | 实测真实目录与 reparse 点混存且实例能启动，而迁移铁律说"放真实目录会起不来" ⇒ 需一次隔离实验，它决定新插件该写 profile 级还是 web 级 |
| R10 | **开放**：两侧没有共同版本锚 | 建议 `dsh-home\.embedded-state.json`（上次 opId + 源指纹 + overrides 哈希）让下次迁移能**主动报出**"源变了 / 本地改过了" |
