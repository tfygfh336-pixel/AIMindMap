/* ============================================================
 * vitest.config.mjs — 测试发现范围 + 超时口径（**唯一真源**）
 * ------------------------------------------------------------
 * 理由一 —— 测试发现范围：**`.review/` 会被 vitest 默认收集**。
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
 * 理由二 —— 超时口径：**默认 5000ms 撑不住"子进程密集"的用例**。
 *
 * 实测（2026-10-12）：`tests/doc-import.test.js` 的 PDF 书签切片、`tests/dsh-ask.test.js` 的 `--dry-run`、
 * `tests/mcp-protocol.test.js` 的 isError 一拍、`tests/verify-budget.test.js` 的 `gitCommitCount`
 * 这 4 条会**偶发**报 `Test timed out in 5000ms` —— 是超时，**不是断言失败**（报文里没有"期望/实际"）。
 * 同一份代码的三条读数：① 这 4 个文件**单独跑全绿**（4 files / 110 tests / 6.13s / exit 0）；
 * ② 默认并行池下 `npm test` 连红 3/3，红的永远是这同一组用例，而其中 `gitCommitCount` **只 spawn 一个 `git`**、
 * 与任何业务改动无关；当时本机另有 **7 个 electron + 13 个 node** 进程在跑；③ 限池
 * （`--pool=threads --maxWorkers=4`）下 **62 files / 1206 tests 全绿**（28.0s）。
 * ⇒ 结论：**环境/负载脆弱性**（默认池 + 机器负载下，spawn 到出结果超过 5s），**不是逻辑失败**。
 *   本批新增 4 个测试文件把用例从 ~1100 顶到 1206，只是把这条**既有**的脆弱性顶过了可见阈值。
 *
 * 修法取舍：抬**测试超时**到 15s，**不动 pool 配置** —— 限池虽然能全绿，但那是另一套并发口径，
 * 不能拿它当"链的默认口径已绿"的依据；要守的是"默认口径下不该有随机红灯"。
 * ⚠️ 超时不是放宽断言的借口：它只用来区分"慢"与"错"；15s 仍不出结果 = 真的卡住 ⇒ 照样红。
 * ⚠️ 本工程先例：`tests/dsh-embedded-overrides.test.js` 里也有一条 `vi.setConfig({ testTimeout: 30000 })`。
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
    ],
    // 理由二：默认 5s 在"子进程密集 + 机器另有负载"时会随机红（文件头有三条实测读数）。
    // 15s 只用来区分"慢"与"错"，**不动 pool 配置**（并发口径保持默认）。
    testTimeout: 15000,
    hookTimeout: 15000
  }
});
