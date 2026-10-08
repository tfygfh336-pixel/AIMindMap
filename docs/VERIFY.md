# 验证基线（VERIFY）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 契约
作用: 验证基线（各类计数 + 验证链）
不该写: 被测功能说明
更新方式: `doc-facts --write` 生成
-->

> 本文件由 `node scripts/doc-facts.js --write` **自动生成**，请勿手改。
> 作用：本工程「易腐事实」的唯一权威副本（命令数 / 工具数 / 用例数 / 断言数 / 版本号）。
> 其他文档**不要**再抄写这些数字，改为引用本文件，或直接运行 `node scripts/doc-facts.js`。

## 权威值

| 事实 | 值 | 来源 |
|------|----|------|
| CLI 命令数 | 51 | `cli/registry.js`（`registry.list().length`） |
| MCP 工具数 | 35 | `scripts/mcp-server.js`（导出的 `TOOLS.length`） |
| 单元测试 | 775 用例 / 44 文件 | `tests/*.test.js`（vitest） |
| CLI 集成断言 | 197 | `scripts/cli-integration.js` |
| 冒烟断言 | 146 | `scripts/smoke-assertions.js` |
| 视觉断言（L2 关键区域） | 2 | `scripts/vision/roi-assertions.js`（`ROIS.length`） |
| 版本号 | 0.16.1 | `package.json` / `src/config.js` / `package-lock.json`（须一致） |

## 验证链

> **执行顺序、每步命令与耗时预算的唯一定义在 `scripts/verify.js`**；本表由它渲染，勿手改。

```bash
npm run verify    # 编码完整性 → 文档登记与家门 → 规则文件自洽 → 单元测试 → 文档数字与版本一致 → CLI 集成断言 → 数据校验 → 冒烟（Electron 无头）（合计预算 180s）
```

每步可单独运行；下表即 `docs/RULES.md` 的**门禁 G1–G9**，顺序与 verify 链一致：

| 步 | 门禁 | 命令 | 耗时预算 | 覆盖 |
|----|------|------|---------|------|
| 1 | G1 | `npm run check:encoding` | 10s | 文件编码完整性：UTF-8 BOM / U+FFFD / 经典乱码特征 |
| 2 | G8 | `npm run check:docs` | 10s | 文档登记与家门：表外文档 / 散落文档 / 工程根与顶层目录乱放 / 悬挂登记（登记表 = `docs/ARCHITECTURE.md` §5；工作产物区 = `.review/`） |
| 3 | G9 | `npm run check:rules` | 10s | 规则文件自洽：声明条数 == 表格行数 / 表格未被引用块或空行打断 / 编号引用闭合 / 实现列点名的脚本存在 |
| 4 | G3 | `npm test`（附加 JSON reporter 把用例数交给 G6，省一次 vitest 重跑） | 60s | 共享核心 `src/` 各模块（含 data-store 原子写、BOM 容错与并发版本闸门） |
| 5 | G6 | `node scripts/doc-facts.js --check` | 20s | 文档数字与真值一致、版本号四处一致 |
| 6 | G7 | 同上（重算比对） | （与 G6 同一次调用） | 生成物是否过期（`docs/CLI.md` 与 registry 一致） |
| 7 | G4 | `node scripts/cli-integration.js` | 30s | 全部 CLI 命令端到端（**进程内调用**，临时项目，自动清理） |
| 8 | G2 | `node cli/mm-cli.js validate-all` | 15s | 全部项目结构 + 悬挂链接 + 环 |
| 9 | G5 | `npm run smoke` | 150s | 渲染层（Electron 无头，含监听器泄漏回归）+ **真实数据隔离** |

> **只改了某一条冒烟断言时不必跑全链**：`SMOKE_ONLY=<文件前缀> npm run smoke`
> （等价写法 `electron . --smoke-only=<文件前缀>`）只跑选中的那几个断言文件，
> **永远并入 `01-*`**（预热：它负责加载渲染层并打开 comnet，后面的断言都假设这个前提）。
> 过滤运行**不产截图/取景记录/视觉断言**，其计数也**不代表本文件的冒烟真值** ——
> 真值只由全量运行代表（`npm run verify` 或 `npm run smoke` 不带选择串时）。
> 选择规则、以及"筛错名字必须响亮失败（采不到真值 = 红）"见 `scripts/smoke-select.js`。

> 耗时预算是**止涨线**（取实测的 2–3 倍），不是性能目标 —— 它防的是「每次只涨一点点、没人注意到」。
> 本链曾从 176 s 压到约 77 s（集成断言由"每条起一个进程"改为进程内调用），预算是让这个成果守得住。
> 超预算时 `npm run verify` 会红，并提示"若增长合理就改 `scripts/verify.js` 的预算**并说明理由**"。

> 门禁的分级、强制方式与"为什么这些不需要记住"，见 **`docs/RULES.md`**。

## 本机受限环境注意

- `npm test` 已固定 `--pool=threads`：默认 `forks` 池会 fork 子进程并用**管道 stdio** 收集结果，
  在禁止管道 stdio 的环境（企业 EDR / 沙箱）下报 `spawn EPERM` 与 "no tests" —— 那是**假失败**。
- `scripts/cli-integration.js` 已改为**进程内调用**（`cli/main.js` 的 `invokeSync`），不再依赖管道 stdio，
  上面那条历史假失败已消除；文件末尾保留 4 条**真子进程**对照断言（那 4 条仍需能 spawn 子进程）。
- ⚠️ **跑 `scripts/cli-integration.js` 时，别用会"提前关闭管道"的方式取输出**
  （PowerShell 的 `Select-Object -First N`、`head`、`| more` 都是这一类）。
  管道被提前关闭会**杀掉脚本** ⇒ 它**文件末尾的收尾清理不执行** ⇒ 留下一批 `it-probe-*` 探针项目
  （其中 `…-assoc` 是**故意注入过悬挂成员**的 fixture）⇒ 下一步 **G2 `validate-all` 把这些探针当项目验，报假红**。
  `[实测]` 2026-09-29：一次这样的运行留下 5 个探针，全链在 G2 报 `it-probe-…-assoc 悬挂关联成员`。
  处置：删掉 `projects/it-probe-*` 后重跑；**要看部分输出就先把结果存进变量或文件，再截取**。
  （脚本自己也防了一手：开工前清扫**超过 10 分钟**没动过的探针 —— 但刚被中断的那批太新，扫不掉。）
- **`npm run smoke`（G5）要求 Electron 能真正启动**：在部分受限路径 / 环境下 Chromium 进程
  会**立即死亡**（实测 `node_modules\.bin\electron.cmd --version` 也零输出、退出码
  `-2147483645` = `0x80000003` STATUS_BREAKPOINT），此时 G5 **假失败且没有任何断言输出**。
  判据：**先单独跑 `electron --version`** —— 它都出不来就是环境问题，与工程内容无关；
  实测同一份工程内容换一个能启动的 Electron 二进制即得 **112/112**。
- ⚠️ **验证期间不要在工程内并发写文件**（例如另一个 AI 子代理正在改文件、或编辑器正在保存）。
  `[实测]` 2026-09-26：同一份内容，**有并发写入的 3 次全链里 2 次失败**（一次 G2「数据校验」报红 —— 它正在读那些被改的文件；
  一次 G3 `npm test` 以退出码 `3221225477` = `0xC0000005` 访问违例**原生崩溃** —— 测试进程脚下的文件被改），
  而**停止并发写入后连跑 6 次全部通过**（可用内存 6.5–7.1 GB 几乎不变，故**不是内存压力**）。
  这类红是**假失败**，属本文档第一类失败模式（"把测量环境的限制当成被测对象的缺陷"）的新实例。
  判据：**先看那次失败发生在哪一步** —— G2/G3 这类"读或跑工程文件"的步骤，最可能被并发写入污染；
  处置：**让它单独重跑一次**（`npm run verify`），不要直接当成"我改坏了"。

## 文档体系快照

> 由本生成器**现场计算**（不是抄写）：接手者想一眼看清"文档体系现在长什么样"，看这一节即可。
> 规则与判定见 `docs/ARCHITECTURE.md` §5，判定实现见 `scripts/docs-registry-check.js`（G8）。

| 事实 | 值 | 来源 |
|------|----|------|
| 受管文档（登记表登记数） | 13 份 | `docs/ARCHITECTURE.md` §5 表 |
| 登记表分层的条目分布 | 入口 2 · 治理 1 · 契约 4 · 设计 3 · 记录 3 · 归档 2 | 同上（含归档族的前缀行） |
| 归档族 | `docs/archive/` 6 份 · `docs/changelog/` 14 份 | 磁盘现场统计（只增不改，不逐份登记） |
| 工作产物区（`.review/`） | `20260925-scripts草稿清理` → 已收口 · `20260925-集成断言进程内化` → 已收口 · `20260926-文档架构图` → 已收口 · `20260926-静默闭环2-5` → 在飞 · `20260929-多路并发编辑` → 在飞 · `20261008-DSH深度集成调研` → 在飞 | 各目录的 `README.md` |
| 上次全链结果 | 见 `.review/last-verify.json`（`npm run verify` 与 `npm run check:docs` 都会打印当前值） | 每次 `npm run verify` 写入 |

> 交接面：「什么没做完」看 `docs/ROADMAP.md` 的「在飞 / 未收口」；
> 「最近改了什么」看 `CHANGELOG.md` 的 `[Unreleased]`；接手顺序见 `SKILL.md` 顶部「接手 5 步」。

---

*本文件由 `scripts/doc-facts.js` 生成（勿手改）；对应版本 v0.16.1。*
