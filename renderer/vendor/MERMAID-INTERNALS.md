# mermaid（vendored）—— 升级回归清单 / 内部符号边界

> 体例照 `renderer/vendor/JSMIND-INTERNALS.md`（先例）：把"这个第三方 bundle 与本工程的接触面"
> 写在一处，升级时**先读它、再动代码**。本文件是**受管文档之外**的应用资产说明
> （`renderer/vendor/` 被 G8 的文档扫描跳过，见 `scripts/docs-registry-check.js`）。

## 1. 入库形态（一句话）

| 项 | 值 |
|---|---|
| 包 / 版本 | `mermaid@12.2.0`（npm 官方包） |
| 入库文件 | `renderer/vendor/mermaid/mermaid.min.js` —— `dist/mermaid.min.js`（**逐字节拷贝**） |
| 字节数 / sha256 | **5,494,801 B** · `a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f` |
| 体积上限 | **≤6 MB**（用户 2026-10-16 拍板；当前 5.24 MiB，余量 ≈14%） |
| 形态 | **UMD / IIFE 单文件**，末尾 `globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;` ⇒ **经典 `<script>` 可用，全局名 `mermaid`** |
| 许可证 | MIT（`renderer/vendor/mermaid/LICENSE`，随包拷入） |
| 与 `jsmind.js` 的**有意差异** | `jsmind.js` / `jsmind.css` 被 `.gitignore` 忽略（不入库）；**mermaid.min.js 入库** —— 它的价值就是"离线可用"，不入库等于新克隆的工程**功能消失**（判决记录见本批 `.review/20261016-R7实现/README.md`） |

## 2. 加载链（**唯一实现**：`renderer/app-md.js` 的 `loadMermaid()`）

```
探测（```mermaid 围栏 / language-mermaid 类）
  ⇒ 动态注入 <script src="vendor/mermaid/mermaid.min.js">（经典脚本；CSP `script-src 'self' file:` 放行）
  ⇒ 等 onload ⇒ 检查全局 `mermaid`（没有就**响亮失败**，不静默当成功）
  ⇒ mermaid.initialize({ startOnLoad:false, securityLevel:'strict' })
  ⇒ mermaid.render(id, src, host) ⇒ 成功落 svg ／ 失败出**可见降级条**（原因 + 图源仍以代码块显示）
```

- **为什么不是 `import()`**：本页由 `win.loadFile()` 载入（`file://`，源是 opaque），模块脚本取回要走 CORS
  ⇒ 被拦。实测读数（含两种写法的对照）见 `.review/20261016-R7实现/README.md` 与冒烟域 52。
- **首屏代价 = 0**：没有 mermaid 图源的节点，一个字节的库文件都不会被请求（判据：域 52 断言 mermaid 请求计数）。
- ⚠️ 这条"库文件在本地"的口径**与"能否联网"无关**：本工程禁止的是**从 CDN 取渲染库**（供应商依赖面），
  不是"页面不许发外部请求"—— 用户 2026-10-16 裁决 `img` 允许 `https:`（`renderer/index.html:5` 的 `img-src` 已放宽）。
- **失败必须响亮**：三档失败（取不到文件 / 脚本报错 / 全局没有 mermaid）都带非空原因进降级条。

## 3. ⚠️ 一条**消毒管不到**的路（已知边界，不是漏做）

mermaid **一定会往文档里插 `<style>`**（主题 CSS），而本工程的 CSP 是
`style-src 'self' 'unsafe-inline'` ⇒ **放行**。时序上 **消毒在前、mermaid 渲染在后**
（`renderer/sanitize.js` 只处理"注入之前的那串字节"）⇒ 白名单**管不到 mermaid 自己产出的 DOM**。

兜底只有两条，升级时**必须逐条复验**：

1. **`securityLevel:'strict'`**（`renderer/app-md.js` 的 `initialize` 里写死，不许改成 `loose`/`antiscript`）——
   图源里的 HTML 标签与点击回调由它禁掉；
2. mermaid 的产物只落在**它自己的容器**里（`.fd-mermaid[data-mm-mermaid]`），不进正文的其它位置。

## 4. 升级回归清单（改版本时逐条做，缺一条都不算升完）

1. `npm pack mermaid@<新版本>` → 解包 → 用 `dist/mermaid.min.js` **逐字节**替换本目录的文件；
2. 复核 **sha256 / 字节数**进本文件，并确认 **≤6 MB**（超了要用户重新拍板体积上限）；
3. 复核末尾仍是 `globalThis["mermaid"] = …`（若改成纯 ESM 入口 ⇒ `renderer/app-md.js` 的加载链**要重写**，
   不是"改个路径"）；
4. 确认 `LICENSE` 随包拷回（MIT 文本变化也要一起更新）；
5. 跑 `SMOKE_ONLY=52 node node_modules/electron/cli.js . --smoke`（或 `npm run smoke`）：域 52 的
   mermaid 两条（真渲染 / 非法图源必降级）都要绿；
6. 新增/变化的**不渲染语法**记到下面第 5 节（本工程只承诺"能渲染的渲染、渲染不了的要看得见"）。

## 5. 已知不渲染 / 受限的语法（诚实清单，随版本更新）

- 本工程**不做**公式族（KaTeX/MathJax 是独立条目）与 mermaid 的点击回调（`strict` 档禁掉）；
- 单次最多渲染 **5** 张图、单张图源 **>20 KB 拒渲**（常量在 `renderer/app-md.js` 的 `LIMITS`）；
- 图源里的内嵌 HTML 标签在 `strict` 档下被转义（这是**有意**的安全档位，不是显示缺陷）。
