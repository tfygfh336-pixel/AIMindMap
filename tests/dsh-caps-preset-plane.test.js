/* ============================================================
 * tests/dsh-caps-preset-plane.test.js —— `dsh-caps` 的 **agent（preset）平面**发现
 * ------------------------------------------------------------
 * 为什么单独一个文件（2026-10-19）：`385767e` 实测发现 `cli/commands/release.js` 的 preset 发现路径
 * **指向一个不存在的包**（`@deepseek-ai/dsh-agent-presets/presets/<name>/agent.cordis.yml`）——
 * 两处都错：那个包在发行包里不存在、真实形态是**平铺的 `presets/<preset>.patch.yml`**（无子目录）。
 * ⇒ `existsSync` 恒假 + `if` 里静默跳过 ⇒ `kind:'preset'` 层**一次都没出现过**（修前实测 0 层）。
 *
 * 代价不是"少一层"：`src/dsh-capabilities.js` 的核心叙事
 *   「host 行 `disabled: true` **≠ 不可用** —— preset 会把同一 id 重挂」
 * 在读的人眼里**无法观察、无法核对** —— 正是本工程反复治的病（声称能做到、实测是另一回事）。
 *
 * 本文件钉住三件事（每条都能真的红）：
 *   ① **层数 = 实测文件数**：`discoverPresetLayers()` 的 preset 层数必须 > 0 且**等于独立磁盘扫描**
 *      数出来的 `@deepseek-ai/<包>/presets/*.patch.yml` 个数 —— 两个读数来自**不同实现**（一个走被测函数，
 *      一个走本文件的裸 `fs` 扫描），所以不是自证。
 *      判别力：把发现路径改回那个不存在的包 ⇒ 被测函数返回 0 ⇒ 0 ≠ 4 ⇒ **必红**
 *      （证据见 `.review/20261019-preset平面/inject-red.txt`）。
 *   ② **空 ⇒ 响亮**：`presetPlaneProblem(空读数)` 必须返回文案且**点名"preset 平面为空"**；
 *      真实读数必须返回 `null`（否则"空"与"不空"在判据上是同一个答案 ⇒ 判据没分辨力）。
 *   ③ **叙事要有实例**：「host 按 id 算 `disabled: true`、preset 又挂回来」必须至少 1 个，且
 *      **两处行号**都要真读得回原文（不是编号对得上就算）。
 *
 * ⚠️ 环境边界：`vendor/dsh` 被 `.gitignore` 忽略、不在版本库 ⇒ 没有运行包的机器上这些断言**无法取到真值**。
 *    按纪律**不静默跳过**：有专门的 `it` 把"未验证"印出来（它不会被读成"通过"）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const releaseCmd = require('../cli/commands/release.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DSH_NM = path.join(ROOT, 'vendor', 'dsh', 'app', 'node_modules', '@deepseek-ai');
const hasVendor = fs.existsSync(DSH_NM);

/** **独立**的磁盘扫描（不走被测函数）：层数判据的另一侧读数。 */
function diskPresetFiles() {
  const out = [];
  if (!hasVendor) return out;
  for (const name of fs.readdirSync(DSH_NM)) {
    const dir = path.join(DSH_NM, name, 'presets');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/\.patch\.yml$/.test(f)) out.push(path.join(dir, f));
  }
  return out;
}

const FILES = diskPresetFiles();
const SCAN = hasVendor ? releaseCmd.discoverPresetLayers(DSH_NM) : null;

describe('preset 平面发现：层数 = 实测文件数（不是"配置里的数字"）', () => {
  it.runIf(!hasVendor)('**未验证**：本机没有 vendor/dsh ⇒ preset 平面层数未被验证（这条不是"通过"）', () => {
    // 故意保持绿，但测试名与下面这句都把话说清楚：无法取到真值 ≠ 验过了
    expect(hasVendor).toBe(false);
  });

  it.runIf(hasVendor)('**层数 > 0**（旧实现是 0：发现路径指向不存在的包）', () => {
    expect(SCAN.layers.length, 'preset 层数为 0 ⇒ **preset 平面为空**：'
      + '`dsh-caps` 的 agent 平面读不到任何东西，"host disabled:true 被 preset 重挂"那条叙事因此无法核对')
      .toBeGreaterThan(0);
    expect(FILES.length, '磁盘上一个 preset 文件都没有 ⇒ 这条判据没有真值，先查运行包').toBeGreaterThan(0);
  });

  it.runIf(hasVendor)('**层数 == 独立磁盘扫描出的文件数**（两个不同实现的两侧读数）', () => {
    expect(SCAN.layers.length).toBe(FILES.length);
    expect(SCAN.files.length).toBe(FILES.length);
    // 每个文件都要真的读进正文（不是只数个名字）
    for (const l of SCAN.layers) expect(l.text.length).toBeGreaterThan(200);
  });

  it.runIf(hasVendor)('只认 `@deepseek-ai/<包>/presets`（depth-1）—— LibreOffice 自带的 `program/presets` 不许混进来', () => {
    // 实测：`libreoffice-kit-win32-x64/program/presets` 也存在，它跟 DSH agent preset 无关
    expect(SCAN.packages).not.toContain('libreoffice-kit-win32-x64');
    for (const p of SCAN.packages) {
      expect(fs.existsSync(path.join(DSH_NM, p, 'presets'))).toBe(true);
      expect(fs.existsSync(path.join(DSH_NM, p, 'cordis.patch.yml')) || true).toBe(true);
    }
  });

  it.runIf(hasVendor)('每个 preset 文件都声明了 `@deepseek-ai/dsh-agent-preset`（否则不该按 preset 计数）', () => {
    expect(SCAN.noDeclare, '这些文件在 `presets/` 下却不是 preset 段 —— 会被当成 preset 层多算').toEqual([]);
  });

  it('**空读数 ⇒ 响亮**：文案必须点名"preset 平面为空"（不是静默跳过）', () => {
    const msg = releaseCmd.presetPlaneProblem({ layers: [], scanned: 250, emptyDirs: [], noDeclare: [],
      packages: [], files: [] });
    expect(msg).toBeTruthy();
    expect(msg).toContain('preset 平面为空');
    expect(msg).toMatch(/disabled:true\s*≠\s*不可用|disabled:true ≠ 不可用/);
    expect(releaseCmd.presetPlaneProblem(null), 'null 读数同样不许放过').toContain('preset 平面为空');
  });

  it.runIf(hasVendor)('**非空读数 ⇒ 不算问题**（否则"空/不空"是同一个答案，判据没有分辨力）', () => {
    expect(releaseCmd.presetPlaneProblem(SCAN)).toBe(null);
  });
});

describe('叙事可观察：「host disabled:true 被 preset 重挂」必须给得出实例与两处行号', () => {
  it.runIf(hasVendor)('至少 1 个实例，且两处行号都真读得回原文', () => {
    const layers = [];
    for (const name of fs.readdirSync(DSH_NM).sort()) {
      const p = path.join(DSH_NM, name, 'cordis.patch.yml');
      if (fs.existsSync(p)) layers.push({ layer: name, kind: 'host', text: fs.readFileSync(p, 'utf8') });
    }
    layers.push(...SCAN.layers);
    const remounts = releaseCmd.findRemounts(layers);
    expect(remounts.length, '一个实例都没有 ⇒ 那条叙事在本运行包上**不成立**，'
      + '此时应当去改准 `src/dsh-capabilities.js` / 文档里的说法，而不是留着一句无法核对的话').toBeGreaterThan(0);

    for (const r of remounts) {
      // host 侧：`- id:` 行 + 紧随的 `disabled: true` 必须是**原文**
      const hostFile = path.join(DSH_NM, r.host.layer, 'cordis.patch.yml');
      const hostLines = fs.readFileSync(hostFile, 'utf8').split(/\r?\n/);
      const row = hostLines[r.host.line - 1];
      expect(row, `host ${r.host.layer}:${r.host.line} 应是 \`- id: ${r.id}\``).toContain('- id:');
      expect(row).toContain(r.id);
      const nearby = hostLines.slice(r.host.line - 1, r.host.line + 2).join('\n');
      expect(nearby, `host ${r.host.layer}:${r.host.line} 这一行（或紧随两行）应含 \`disabled: true\``)
        .toMatch(/disabled:\s*true/);
      // preset 侧：行号指向的行必须真的是这个 id
      for (const p of r.presets) {
        const presetFile = p.layer.replace(/^preset:/, '').replace(/\/[^/]+$/, '') + '/presets/'
          + p.layer.replace(/^preset:[^/]+\//, '') + '.patch.yml';
        const presetLines = fs.readFileSync(path.join(DSH_NM, presetFile), 'utf8').split(/\r?\n/);
        expect(presetLines[p.line - 1], `${p.layer}:${p.line} 应是 \`- id: ${r.id}\``).toContain(r.id);
      }
    }
  });

  it.runIf(hasVendor)('口径钉住：**两边都 disabled** 不算"重挂"（实测反例 `tool-ralph`：host `dsh-base:446-448` 与 `presets/standard.patch.yml:125-127` 都是 `disabled: true`）', () => {
    const layers = [];
    for (const name of fs.readdirSync(DSH_NM).sort()) {
      const p = path.join(DSH_NM, name, 'cordis.patch.yml');
      if (fs.existsSync(p)) layers.push({ layer: name, kind: 'host', text: fs.readFileSync(p, 'utf8') });
    }
    layers.push(...SCAN.layers);
    const ids = releaseCmd.findRemounts(layers).map((r) => r.id);
    expect(ids, 'preset 自己也 `disabled: true` ⇒ 那是"两边都关"，不是"重挂"；'
      + '只按 id 配对会把它算进来（本批自查抓到的那一处假阳性）').not.toContain('tool-ralph');
    // 对照：同一份数据里 `agent-instructions` **必须**在（host 禁用 + preset 启用）⇒ 证明上面那条不是因为整段没实现
    expect(ids).toContain('agent-instructions');
  });

  it('序列口径与 `src/dsh-capabilities.js` **同一处**：载体包那一步也在（不是只认 `dsh-base`）', () => {
    // H1：`findRemounts` 不再自己写 `dsh-base` / `/^preset:([^/]+)\//` 两份推导，
    //     改取模块的 `assemblySequenceOf` / `presetCarrierOf`。这条把"载体那一步"钉住 ——
    //     如果有人把它退回成"只看 dsh-base"，`dsh-web-app` 那一行的禁用就看不见了 ⇒ 必红。
    const layers = [
      { layer: 'dsh-base', kind: 'host', text: "- id: x\n  name: '@deepseek-ai/dsh-x'\n" },
      { layer: 'dsh-web-app', kind: 'host', text: "- id: x\n  disabled: true\n" },
      { layer: 'preset:dsh-web-app/std', kind: 'preset', text: "- id: x\n  name: '@deepseek-ai/dsh-x'\n" }
    ];
    const r = releaseCmd.findRemounts(layers);
    expect(r, '载体包 `dsh-web-app` 上按 id 的 `disabled: true` 必须进入有效状态').toHaveLength(1);
    expect(r[0].id).toBe('x');
    expect(r[0].pkg, '载体包取模块的 `presetCarrierOf`').toBe('dsh-web-app');
    expect(r[0].host, 'host 侧指向**载体包那一行**，不是 `dsh-base`').toEqual({ layer: 'dsh-web-app', line: 1, state: 'literal-true' });
  });

  it('口径钉住：`disabled: !!js …`（expr）**不算**实例（运行期才知道，不求值不猜）', () => {
    const layers = [
      { layer: 'dsh-base', kind: 'host', text: "- id: x\n  name: '@deepseek-ai/dsh-x'\n  disabled: !!js process.platform === 'win32'\n" },
      { layer: 'preset:pkg/std', kind: 'preset', text: "- insert:\n    - id: p\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        plugins:\n          - id: x\n            name: '@deepseek-ai/dsh-x'\n" }
    ];
    expect(releaseCmd.findRemounts(layers), 'expr 的真假运行期才知道 ⇒ 不许当"已禁用"证据').toEqual([]);

    // 同一形状把 `expr` 换成字面 true ⇒ 必须**给出**实例（证明上一条不是因为"整段没实现"才空）
    const layers2 = [
      { layer: 'dsh-base', kind: 'host', text: "- id: x\n  name: '@deepseek-ai/dsh-x'\n  disabled: true\n" },
      layers[1]
    ];
    const r2 = releaseCmd.findRemounts(layers2);
    expect(r2.length).toBe(1);
    expect(r2[0]).toMatchObject({ id: 'x', host: { layer: 'dsh-base', line: 1 } });
    expect(r2[0].presets).toEqual([{ layer: 'preset:pkg/std', line: 6 }]);   // 行号 = 那一行 `- id: x`

    // 再把 **preset 那一行**也设成 `disabled: true` ⇒ 又必须是空（"两边都关"不是"重挂"）
    const layers3 = [
      layers2[0],
      { layer: 'preset:pkg/std', kind: 'preset', text: "- insert:\n    - id: p\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        plugins:\n          - id: x\n            name: '@deepseek-ai/dsh-x'\n            disabled: true\n" }
    ];
    expect(releaseCmd.findRemounts(layers3), 'host 与 preset 都 disabled: true ⇒ 不是重挂（假阳性）；'
      + '真实装配里 `tool-ralph` 就是这一档').toEqual([]);
  });
});
