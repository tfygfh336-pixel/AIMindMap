# 事故与恢复记录（INCIDENTS）

<!-- registry（本块是 §5 登记表的**数据源**；改完跑 `npm run docs:registry` 重新生成表）
层: 记录
作用: 事故与操作禁令
不该写: 功能变更
更新方式: 仅事故后追加
-->

> 作用：记录本工程发生过的**文件系统级事故**及其派生的操作禁令。
> 边界：只记事故本身与教训，**不记功能变更**（那属于 `CHANGELOG.md`）。
> 读者：任何接手本工程的 AI / 开发者 —— 这些禁令不是流程洁癖，而是两次真实全损换来的。
> 更新方式：仅在下一次同类事故后追加。

---

## 事故一（2026-09-15）：目录级重命名导致工程整体丢失

**经过**：改名 `network-mind-map` → `ai-mind-map` 时，执行 robocopy 移动后
`.user_skills` 目录整体被清空（疑似文件系统层 / 企业安全软件层问题），
工程全部文件（源码 + 文档 + 笔记数据）一次性丢失。

**恢复方式**：从本会话运行轨迹（`trajectory.jsonl`）提取 Write/Edit 调用重放重建代码；
缺失的 `editor.js`、`cli/commands/{assets,links}.js`、`src/convert.js` 等按架构约定重写；
`network.json` 知识体系按教材结构重建。

**遗留缺口**：
1. 原 `projects/network/network.json` 44 节点中，部分节点的**详情文字与图片无法恢复**
   （重建版为 36 节点，覆盖 TCP/IP 四层核心知识点，但保真度有限）。
2. `renderer/vendor/jsmind.js` 从 npm 包恢复（0.9.1 es6 版）。
3. 冒烟截图、`build/` 安装包为可再生产物，可重新生成。
4. 该 `network` 项目现已不在 `projects/` 中，仅存于 `backups/`。

## 事故二（2026-09-15）：用 PowerShell 读写 UTF-8 文档导致文件损坏

**经过**：修改 README 时误用 PowerShell `Get-Content -Raw` + `Set-Content`
（PS 5.1 默认按 GBK 解码）把 UTF-8 文档写坏。已从会话轨迹提取权威版本重建。

---

## 派生禁令（**必须遵守**）

1. **不移动目录**。改名只改 `SKILL.md` frontmatter 与 `package.json` 的 `name` 字段，
   禁止 `robocopy /MOVE`、禁止移动 `.user_skills` 内的任何目录。
2. **不用 PowerShell 读写 UTF-8 文档**。`Get-Content` / `Set-Content` / `Out-File`
   在 PS 5.1 下默认 GBK，会损坏中文文件；一律用编辑器 / Write / Edit 工具。
   文档必须是 **UTF-8 无 BOM**。
3. **不做批量写盘**。禁止批量 `writeFileSync` 脚本、禁止一次性重写大量文件
   （企业安全软件会把这类行为判定为可疑操作并清理目录）。
4. **大改前先导出备份**。涉及大量节点增删前先 `export-json` 一份到**工程外**目录
   （单文件含全部图片，可整体回滚）。
5. **写盘必须原子**。`src/data-store.js` 的 `writeFileAtomic`（临时文件 + fsync + rename）
   是唯一写盘出口；新增写盘路径必须复用它，避免中断产生半截文件。

---

## 相关背景

- **本地 Git 至今无任何提交**：`git init` 成功，但写 `.git/objects` 被 EDR 拦截。
  需企业侧为该目录加排除规则后才能获得版本回滚能力。
  在此之前，`export-json` 到工程外目录是**唯一**的兜底手段。
- 上述禁令第 3 条正是本项目"避免脚本大批量修改文件"的由来。
