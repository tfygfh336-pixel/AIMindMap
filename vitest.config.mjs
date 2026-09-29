/* ============================================================
 * vitest.config.mjs — 测试发现范围（**唯一真源**）
 * ------------------------------------------------------------
 * 存在的唯一理由：**`.review/` 会被 vitest 默认收集**。
 *
 * 实测：往 `.review/` 放一个 `*.test.js`（本工程把它当"工作产物区"，见 SKILL.md 顶部落盘规矩），
 * `npm test` 会**直接变红** —— 因为 vitest 默认的 include 是 `**\/*.test.js`，
 * 而默认 exclude 只有 `**\/node_modules/**` 与 `**\/.git/**`。
 *
 * 为什么这件事值得一个配置文件：
 *   `.review/` 是**允许随时删、允许放临时脚本与备份**的地方。一个"把备份放进去就红"的测试套件，
 *   会让人得出错误结论（"我改坏了什么"），而真实原因只是**一个不该被收集的目录**。
 *   本工程已有过同型的坑：`.review/` 在工作产物口径之外、却在 vitest 的 collect 之内 ——
 *   **两个口径不一致**，而它只在踩到时才可见。
 *
 * 为什么用 `.mjs`：本工程的测试层本来就是 ESM（`tests/*.test.js` 用 `import`），
 * 与它保持一致；且 ESM 的 `import { configDefaults }` 是 vitest 官方推荐的写法。
 *
 * ⚠️ 改这里要连带：`scripts/docs-registry-check.js` 的 `ROOT_FILES` 白名单（G8 管工程根文件），
 * 否则新对话跑门禁会红。该白名单的作用正是"工程根只允收入口文档与工程配置文件"。
 * ============================================================ */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 保留 vitest 的默认排除项（显式列出，避免"以为它会自动带"），再补上工作产物区。
    exclude: [
      ...configDefaults.exclude,
      '**/.review/**'
    ]
  }
});
