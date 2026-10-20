/* ============================================================
 * tests/control-point.test.js —— `point`（指给你看 · `AP` · 台账 `W21`）与**控制通道白名单**
 * 运行：node node_modules/vitest/vitest.mjs run --pool=threads tests/control-point.test.js
 * ------------------------------------------------------------
 * 本文件钉四件事，一件比一件难：
 *
 *   ① **白名单有判别力**：`src/control.js` 的 `KNOWN_CMDS` / `isKnownCmd` / `unknownCmdReceipt`
 *      —— 已知 6 条为真、假 cmd 为假，且拒绝报文**逐字**里既有那个名字、也列出这个版本认哪些。
 *      （为什么单独测它：`main.js` 要 Electron 才能加载 ⇒ 那条判定以前**没有任何自动判据**。）
 *
 *   ② **规划出来的 JS 真的这么干**：`planPointAction` 是纯函数，生成的是一段要在渲染层跑的 JS。
 *      本文件拿一个**假渲染层**在 `vm` 里**真跑它**（不是比对字符串）：
 *      note 档必须调 `MM.jumpToNode`、related 档必须调 `MM.showRelated`、项目不符必须拒绝并点名
 *      两个项目名、导图页被卸载（`window.MM` 不在）必须说清"用 sidebar-only off 恢复"。
 *
 *   ③ **注入面**：节点 id / 项目名是**调用方给的字符串**，会被嵌进那段 JS 的源码。
 *      喂 `");global.pwned=1;//` 这样的 id，断言假渲染层收到的**逐字**是那个 id、且 `global.pwned`
 *      没有被创建 —— 这是"字符串进代码"这类缺陷唯一能机械判的形态。
 *
 *   ④ **端到端（CLI 半边）+ 零写盘**：真起一个"假界面"子进程（扫 pending → 认领 → 写回执），
 *      然后**进程内** `invokeSync(['point', …])` 走完 `cli/commands/ui.js` 全程，断言：
 *        · 写进通道的命令文件**逐键**是 `{cmd:'point', mode, project, node, token, at, by}`；
 *        · 回执拿得到 ⇒ exit 0、`--json` 字段齐；界面**拒绝**时 ⇒ exit 1 且 app 的原因**原样转述**；
 *        · 界面**认领了却不回执** ⇒ exit 1 且报文说"主界面没有响应"（**没有回执 = 没生效**）；
 *        · 跑前跑后**项目根逐字节不变**（含 `.changes.jsonl`）—— 这条才是"零写盘"的判据。
 *
 * ## 为什么用"假界面子进程"而不是同进程里的定时器
 *   `cli/commands/ui.js` 的等回执是**忙等**（同步自旋，为了满足 `cli-sync-invariant` 的"命令体
 *   不得出现 await"）。同进程里的 `setInterval` 在忙等期间**一次都跑不到** ⇒ 收不到回执。
 *   把"界面"放到**另一个进程**是唯一能在单测里复现存活界面的办法（也不碰 Electron）。
 *   子进程用 `stdio:'ignore'`（受限环境下管道 stdio 会 EPERM 假失败，见 `tests/w8-dry-run.test.js`
 *   的环境要点）—— 本文件不读它的输出，只读它写下的文件。
 *
 * ## 如实登记的边界（别把本文件当"界面真的这么做了"）
 *   `--smoke` 下控制通道**不启动**（`main.js`：`if (!isSmoke …)`）⇒ "界面真的选中了/真画了关联线"
 *   这一半**没有自动判据**，只能人看（步骤见 `.review/20261020-W21-ask-apply/00-定题.md` §5.3）。
 *   本文件覆盖的是：白名单、规划语义、注入面、通道协议（CLI 侧全程）、零写盘。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');

/** 沙箱（创建即登记，收尾只此一处） */
const SANDBOX = makeTmp('mm-w21-point-');
/** 项目根（**必须在 require `cli/main.js` 之前设好** —— `cli/core.js` 在模块加载时读它） */
const PROJECTS = path.join(SANDBOX, 'projects');
process.env.AI_MINDMAP_PROJECTS_DIR = PROJECTS;
/** 应用 userData 根（`src/control.js` 的通道目录在它下面；CLI 侧靠 `APPDATA` 推导） */
const APPDATA = path.join(SANDBOX, 'appdata');
/** 界面（假的那个）的 userData：**通道函数的 `baseDir` 是这个**（`control/` 由 `paths()` 自己拼） */
const USERDATA = path.join(APPDATA, 'AI MindMap');

const control = require('../src/control.js');
/** 规划器在**另一个模块**里（故意不在 control.js：那个文件在 CLI 的 require 闭包里，
 *  而规划出来的 JS 含 `.then(` ⇒ 会把 `cli-sync-invariant` 判红。理由见那个文件的文件头）。 */
const controlPlan = require('../src/control-plan.js');

afterAll(cleanupAll);

/* ---------------- 小工具 ---------------- */
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 整棵目录树的 {相对路径 → sha256:字节数}（目录也记一条 ⇒ "少了一个目录"同样看得出来） */
function snapTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (e.isDirectory()) { out[rel + '/'] = 'dir'; walk(abs); }
      else out[rel] = sha256(abs) + ':' + fs.statSync(abs).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** 一个像样的项目（`point` 不该动它，一个字节都不该动；`.changes.jsonl` 一并放进去当第二个证据面） */
function seedProject(name) {
  const dir = path.join(PROJECTS, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({
    meta: { name: name, author: '', version: '0.19.0', formatVersion: 2 },
    format: 'node_tree',
    data: {
      id: 'root', topic: 'root', expanded: true,
      children: [{ id: 'n-a', topic: '节点甲', children: [] },
        { id: 'n-b', topic: '节点乙', children: [] }]
    }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, '.changes.jsonl'),
    JSON.stringify({ at: '2026-10-19T00:00:00.000Z', by: 'seed', rev: 1, changed: ['node:n-a'] }) + '\n', 'utf8');
}

/** 项目目录的字节快照（`point` 的"零写盘"判据就是它前后相等） */
const snapProject = (name) => snapTree(path.join(PROJECTS, name));

/**
 * `.visits/` 里有没有**访问事件**（真值：目录里有没有文件）。
 *
 * ⚠️ 这条为什么要单列（实测 2026-10-20）：**项目根上的 `.visits/` 空目录不是本命令建的** ——
 *   它是 store 层对**任何带项目位置参数的命令**的既有副作用。实测四条只读命令都会把它建出来
 *   （项目都不存在也一样建）：
 *     `read nope --json` / `list nope --json` / `stats nope --json` / `search nope x --json`
 *   每条跑完 `projects/.visits/` 存在、且**里面是空的**。所以"零写盘"的判据不是"项目根多没多一个
 *   目录"，而是**项目自己的字节**（`snapProject`）+ **有没有真的记下一次访问**（这里）。
 */
const visitEvents = () => {
  const dir = path.join(PROJECTS, '.visits');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

/* ============================================================================
 * 一、白名单（判据：已知为真 / 假的为假 / 拒绝报文逐字点名）
 * ========================================================================== */
describe('W21-A 控制通道 cmd 白名单（`KNOWN_CMDS` 是"认得出什么"的唯一一处）', () => {
  it('A1 已知 6 条全为真，假的为假（含空串 / null / 前后空格 / 大小写）', () => {
    expect(control.KNOWN_CMDS).toEqual([
      'dsh-prefill', 'dsh-status', 'dsh-only', 'dsh-sidebar', 'draft-map', 'point'
    ]);
    control.KNOWN_CMDS.forEach((n) => expect(control.isKnownCmd(n), n).toBe(true));
    ['', 'nope', 'point-bogus', ' open-related', 'point ', 'POINT', null, undefined].forEach((n) => {
      expect(control.isKnownCmd(n), '必须判假：' + String(n)).toBe(false);
    });
  });

  it('A2 未知 cmd 的拒绝报文**逐字**点名那个名字 + 列出这个版本认哪些（响亮，不是一句"失败"）', () => {
    const r = control.unknownCmdReceipt('dsh-bogus');
    expect(r.ok).toBe(false);
    expect(r.cmd).toBe('dsh-bogus');
    expect(r.err).toContain('界面不认识这条命令: dsh-bogus');
    control.KNOWN_CMDS.forEach((n) => expect(r.err, '报文里要列出 ' + n).toContain(n));
    // 空名字也要能答（坏命令文件里 cmd 可能是空的）
    expect(control.unknownCmdReceipt(undefined).err).toContain('界面不认识这条命令: ');
  });

  it('A3 白名单是**冻结**的（运行时改不动 ⇒ 没有"临时放行一条"的暗道）', () => {
    expect(Object.isFrozen(control.KNOWN_CMDS)).toBe(true);
    expect(Object.isFrozen(control.POINT_MODES)).toBe(true);
    expect(control.POINT_MODES).toEqual(['note', 'related']);
  });
});

/* ============================================================================
 * 二、planPointAction：生成的 JS 在**假渲染层**上真跑
 * ========================================================================== */
/** 假渲染层：只实现那段 JS 用到的东西，并记账（调了谁、用什么参数） */
function fakeWindow(opts) {
  const o = opts || {};
  const calls = { jump: [], related: [] };
  const nodes = o.nodes || { 'n-a': '节点甲' };
  const w = {};
  if (!o.noMM) {
    w.MM = {
      getState: () => ({
        project: o.project === null ? null : { name: o.project === undefined ? 'proj' : o.project },
        jm: { tag: 'jm' }
      }),
      adapter: {
        getNode: (jm, id) => (Object.prototype.hasOwnProperty.call(nodes, id) ? { id: id, topic: nodes[id] } : null),
        getSelected: () => ({ id: o.selected === undefined ? 'n-a' : o.selected })
      },
      jumpToNode: (id) => { calls.jump.push(id); },
      showRelated: (id) => {
        calls.related.push(id);
        return Promise.resolve(o.relatedResult
          || { members: [{ id: 'n-b' }, { id: 'n-c' }], drawn: 3, crossProject: 1, unrendered: 0, assocCount: 2 });
      }
    };
  }
  return { w, calls };
}

/** 在 vm 里真跑规划出来的那段 JS（`window` 是假的；返回值可能是 Promise） */
async function runPlan(plan, win) {
  const ctx = vm.createContext({ window: win, global: {} });
  expect(plan.ok, '规划失败：' + plan.reason).toBe(true);
  const result = await vm.runInContext(plan.js, ctx);
  return { result, ctx };
}

describe('W21-B `planPointAction`：规划期就拒绝掉的那几种（不进渲染层）', () => {
  it('B1 未知 mode ⇒ 拒绝并列出支持的两个（**不许**静默退化成 note）', () => {
    const p = controlPlan.planPointAction({ project: 'proj', node: 'n-a', mode: 'highlight' });
    expect(p.ok).toBe(false);
    expect(p.reason).toContain('highlight');
    expect(p.reason).toContain('note');
    expect(p.reason).toContain('related');
  });

  it('B2 缺 project / 缺 node ⇒ 各自点名（不是一句"参数不对"）', () => {
    const a = controlPlan.planPointAction({ node: 'n-a' });
    expect(a.ok).toBe(false);
    expect(a.reason).toContain('project');
    const b = controlPlan.planPointAction({ project: 'proj' });
    expect(b.ok).toBe(false);
    expect(b.reason).toContain('node');
  });

  it('B3 默认档是 note；给的 mode 原样带进规划结果', () => {
    const p = controlPlan.planPointAction({ project: 'proj', node: 'n-a' });
    expect(p).toMatchObject({ ok: true, mode: 'note', project: 'proj', node: 'n-a' });
    expect(typeof p.js).toBe('string');
    const q = controlPlan.planPointAction({ project: 'proj', node: 'n-a', mode: 'related' });
    expect(q.mode).toBe('related');
  });
});

describe('W21-C 规划出来的 JS 在假渲染层上**真跑**（note 档）', () => {
  it('C1 正常档：调 `MM.jumpToNode(id)`，回执 ok + 选中态确认', async () => {
    const { w, calls } = fakeWindow();
    const { result } = await runPlan(controlPlan.planPointAction({ project: 'proj', node: 'n-a' }), w);
    expect(calls.jump).toEqual(['n-a']);            // **真的调了那个既有唯一实现**
    expect(calls.related).toEqual([]);              // 没走错分支
    expect(result).toMatchObject({ ok: true, mode: 'note', project: 'proj', node: 'n-a', topic: '节点甲', selected: true });
  });

  it('C2 界面当前打开的是**别的项目** ⇒ 拒绝，且报文里**两个项目名都在**（不静默切项目）', async () => {
    const { w, calls } = fakeWindow({ project: 'proj-actual' });
    const { result } = await runPlan(controlPlan.planPointAction({ project: 'proj-wanted', node: 'n-a' }), w);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('proj-actual');
    expect(result.reason).toContain('proj-wanted');
    expect(result.reason).toContain('未保存');      // 说清"为什么不替你切"
    expect(calls.jump).toEqual([]);                 // 拒绝 ⇒ 一次都没调
    expect(calls.related).toEqual([]);
  });

  it('C3 节点不在当前视图 ⇒ 拒绝并点名那个 id（不是"失败了"）', async () => {
    const { w } = fakeWindow();
    const { result } = await runPlan(controlPlan.planPointAction({ project: 'proj', node: 'n-不存在' }), w);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('n-不存在');
  });

  it('C4 导图页被卸载（`window.MM` 不在）⇒ 说清怎么恢复（`sidebar-only off`），别只说"没响应"', async () => {
    const { w } = fakeWindow({ noMM: true });
    const { result } = await runPlan(controlPlan.planPointAction({ project: 'proj', node: 'n-a' }), w);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('sidebar-only off');
  });

  it('C5 界面还没打开任何项目 ⇒ 拒绝（不是拿 null 当项目名去比）', async () => {
    const { w } = fakeWindow({ project: null });
    const { result } = await runPlan(controlPlan.planPointAction({ project: 'proj', node: 'n-a' }), w);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('还没有打开任何项目');
  });
});

describe('W21-D 同上（related 档：异步 + 回执带读数）', () => {
  it('D1 调 `MM.showRelated(id)`，把视图读数搬进回执（members / drawn / crossProject）', async () => {
    const { w, calls } = fakeWindow();
    const { result } = await runPlan(controlPlan.planPointAction({ project: 'proj', node: 'n-a', mode: 'related' }), w);
    expect(calls.related).toEqual(['n-a']);
    expect(calls.jump).toEqual([]);
    expect(result).toMatchObject({ ok: true, mode: 'related', members: 2, drawn: 3, crossProject: 1, empty: false });
  });

  it('D2 没有关联节点（`empty:true`）⇒ 仍是 ok（视图照进）+ `empty` 标记（调用方要能分辨"空视图"）', async () => {
    const { w } = fakeWindow({ relatedResult: { members: [], drawn: 0, empty: true, crossProject: 0, unrendered: 0, assocCount: 0 } });
    const { result } = await runPlan(controlPlan.planPointAction({ project: 'proj', node: 'n-a', mode: 'related' }), w);
    expect(result).toMatchObject({ ok: true, mode: 'related', members: 0, empty: true });
  });

  it('D3 渲染层的 promise reject（`showRelated` 返回 null 也算）⇒ 回执 ok:false + 原因，**不许挂死**', async () => {
    const { w } = fakeWindow();
    w.MM.showRelated = () => Promise.resolve(null);      // 真实现里"没接上窗口桥"就是这个
    const a = await runPlan(controlPlan.planPointAction({ project: 'proj', node: 'n-a', mode: 'related' }), w);
    expect(a.result.ok).toBe(false);
    expect(a.result.reason).toContain('没有打开');
    const { w: w2 } = fakeWindow();
    w2.MM.showRelated = () => Promise.reject(new Error('桥断了'));
    const b = await runPlan(controlPlan.planPointAction({ project: 'proj', node: 'n-a', mode: 'related' }), w2);
    expect(b.result.ok).toBe(false);
    expect(b.result.reason).toContain('桥断了');
  });
});

describe('W21-E 注入面：调用方给的字符串进 JS 源码后**仍然是字符串**', () => {
  it('E1 note 档：id 里带引号/分号/注释符 ⇒ 假渲染层收到的 id **逐字相同**，且没有副作用', async () => {
    const evil = '"); global.pwned = 1; //';
    const { w, calls } = fakeWindow({ nodes: { [evil]: '危险节点' } });
    const { result, ctx } = await runPlan(controlPlan.planPointAction({ project: 'proj', node: evil }), w);
    expect(calls.jump).toEqual([evil]);            // 逐字：没被截断、没被转义走样
    expect(result.node).toBe(evil);
    expect(ctx.global.pwned).toBeUndefined();       // 没被执行
  });

  it('E2 related 档：同上（两档共用一段模板 ⇒ 都得测）', async () => {
    const evil = "'+global.pwned=2+'";
    const { w, calls } = fakeWindow({ nodes: { [evil]: '危险节点' } });
    const { ctx } = await runPlan(controlPlan.planPointAction({ project: 'proj', node: evil, mode: 'related' }), w);
    expect(calls.related).toEqual([evil]);
    expect(ctx.global.pwned).toBeUndefined();
  });

  it('E3 项目名也带引号 ⇒ 比较仍然成立（不是拼进字符串比较）', async () => {
    const evil = 'a"b\'c';
    const { w } = fakeWindow({ project: evil });
    const { result } = await runPlan(controlPlan.planPointAction({ project: evil, node: 'n-a' }), w);
    expect(result.ok).toBe(true);
    expect(result.project).toBe(evil);
  });
});

/* ============================================================================
 * 三、防漂移：三处（表 / main.js 分支 / CLI 发命令处）必须对得上
 * ========================================================================== */
describe('W21-F 三处防漂移（静态扫描；表是单源，另两处不许各写一份）', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'cli', 'commands', 'ui.js'), 'utf8');

  it('F1 `main.js` 里所有 `cmd.cmd === / !== \'X\'` 的字面量 == `KNOWN_CMDS`（双向：多一个、少一个都红）', () => {
    const got = new Set();
    const re = /cmd\.cmd\s*(?:===|!==)\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(mainSrc))) got.add(m[1]);
    expect([...got].sort()).toEqual([...control.KNOWN_CMDS].sort());
  });

  it('F2 `cli/commands/ui.js` 发出去的 cmd 名 ⊆ `KNOWN_CMDS`（CLI 不许发出界面不认的 cmd）', () => {
    const got = new Set();
    const re = /\bcmd:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(uiSrc))) got.add(m[1]);
    expect(got.size).toBeGreaterThan(0);                       // 扫不到东西 = 这条判据在空转
    [...got].forEach((n) => expect(control.isKnownCmd(n), 'CLI 会发 ' + n + '，但白名单里没有').toBe(true));
    expect(got.has('point')).toBe(true);                        // 本批新加的那条必须在里面
  });

  it('F3 `main.js` 的白名单闸在**所有分支之前**，且 `point` 分支的执行内容由纯函数决定', () => {
    const iGate = mainSrc.indexOf('control.isKnownCmd(cmd.cmd)');
    expect(iGate, 'main.js 里必须有这道闸').toBeGreaterThan(0);
    const iFirstBranch = mainSrc.indexOf("if (cmd.cmd === 'dsh-prefill')");
    expect(iFirstBranch).toBeGreaterThan(0);
    expect(iGate).toBeLessThan(iFirstBranch);
    const iPoint = mainSrc.indexOf("if (cmd.cmd === 'point')");
    expect(iPoint).toBeGreaterThan(iFirstBranch);
    expect(mainSrc.slice(iPoint, iPoint + 600)).toContain('controlPlan.planPointAction');   // 执行什么由纯函数决定
    // 未知 cmd 的回执**就是** `unknownCmdReceipt` 那一份（不是另拼一句）：报文文本只有一处
    expect(mainSrc).toContain('reply(control.unknownCmdReceipt(cmd.cmd))');
  });

  it('F4 `src/control-plan.js` **不在** CLI 的命令闭包里（它是给主进程的；进闭包就撞 cli-sync-invariant）', () => {
    /* 这条边界是**实测打出来的**（2026-10-20）：规划出来的 JS 必须含 `.then(`（related 档是异步的），
     * 而 `cli/commands/ui.js` 的 require 闭包被 `tests/cli-sync-invariant.test.js` 禁止出现 `.then(`
     * ⇒ 规划器只能待在"CLI 闭包之外 + 主进程 require 得到"的位置。三条判据： */
    expect(uiSrc.indexOf('control-plan'), 'ui.js 不许 require 规划器').toBe(-1);
    expect(mainSrc.indexOf("require('./src/control-plan.js')"), 'main.js 必须 require 它').toBeGreaterThan(0);
    // 两份 POINT_MODES 是为"零依赖"各存一份（规划器不 require control.js）⇒ 值必须逐字相同
    expect(controlPlan.POINT_MODES).toEqual(control.POINT_MODES);
  });
});

/* ============================================================================
 * 四、端到端（CLI 半边 + 零写盘）：真起一个"假界面"子进程
 * ========================================================================== */
/**
 * 假界面（另一个进程）：扫 pending → 认领 → 记下命令文件 → 写回执 → 退出。
 * 为什么另起进程：CLI 那边是**忙等**（同步自旋），同进程的定时器在忙等期间跑不到（见文件头）。
 * 三种行为：`answer`（照做并回执）/ `refuse`（拒绝并回执原因）/ `silent`（认领了但不回执）。
 */
const APP_JS = [
  "'use strict';",
  "const fs = require('fs');",
  'const control = require(' + JSON.stringify(path.join(ROOT, 'src', 'control.js')) + ');',
  'const dir = process.argv[2];',
  "const behavior = process.argv[3] || 'answer';",
  'const capture = process.argv[4];',
  'const until = Date.now() + 6000;',
  '(function tick() {',
  '  let list = [];',
  '  try { list = control.listPending(dir); } catch (e) { list = []; }',
  '  if (list.length) {',
  '    const claimed = control.claim(dir, list[0].token);',
  '    if (!claimed) return setTimeout(tick, 5);',
  '    fs.writeFileSync(capture, JSON.stringify(claimed, null, 2), "utf8");',
  "    if (behavior === 'answer') {",
  '      control.writeResult(dir, claimed.token, Object.assign({ at: new Date().toISOString() }, {',
  "        cmd: 'point', ok: true,",
  "        result: { ok: true, mode: claimed.mode, project: claimed.project, node: claimed.node,",
  "          topic: '节点甲', selected: true, members: 2, drawn: 3, empty: false,",
  '          crossProject: 0, unrendered: 0, assocCount: 0 } }));',
  "    } else if (behavior === 'refuse') {",
  // ⚠️ 回执**必须带 `at`**：`waitForResult` 的新鲜度判据看的就是它（没 `at` = 当成陈旧回执 ⇒ 判"没生效"）。
  //    真界面那边由 `control-poll.js` 的 `reply()` 统一补 `at`，假界面照同一条协议来。
  '      control.writeResult(dir, claimed.token, Object.assign({ at: new Date().toISOString() }, { cmd: "point", ok: false,',
  '        err: "界面当前打开的是「proj-other」，不是「" + claimed.project + "」" }));',
  '    }',
  '    return process.exit(0);',   // silent：认领了、不回执（模拟"界面在跑但不理"）
  '  }',
  '  if (Date.now() > until) return process.exit(3);',
  '  setTimeout(tick, 10);',
  '})();'
].join('\n');

/** 起假界面进程（返回 Promise：子进程退出时 resolve 它的退出码） */
function startFakeApp(behavior, captureFile) {
  const scriptFile = path.join(SANDBOX, 'fake-app-' + behavior + '.js');
  fs.writeFileSync(scriptFile, APP_JS, 'utf8');
  const child = spawn(process.execPath, [scriptFile, USERDATA, behavior, captureFile],
    { cwd: SANDBOX, stdio: 'ignore' });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

/** 跑一次命令：把 APPDATA 指到沙箱（通道目录就落在沙箱里），跑完恢复 */
function withAppData(fn) {
  const prev = process.env.APPDATA;
  process.env.APPDATA = APPDATA;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev;
  }
}

describe('W21-G 端到端：CLI 侧全程走完（假界面在另一个进程）', () => {
  const { invokeSync } = require('../cli/main.js');

  it('G1 命令文件**逐键**是 {cmd,mode,project,node,token,at,by}；回执拿得到 ⇒ exit 0；项目根逐字节不变', async () => {
    seedProject('demo');
    const capture = path.join(SANDBOX, 'captured-note.json');
    const appDone = startFakeApp('answer', capture);
    const before = snapProject('demo');
    const r = withAppData(() => invokeSync(['point', 'demo', 'n-a', '--json']));
    await appDone;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const cmd = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(cmd.cmd).toBe('point');
    expect(cmd.mode).toBe('note');
    expect(cmd.project).toBe('demo');
    expect(cmd.node).toBe('n-a');
    expect(cmd.by).toBe('cli');
    expect(typeof cmd.token).toBe('string');
    expect(cmd.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(cmd).sort()).toEqual(['at', 'by', 'cmd', 'mode', 'node', 'project', 'token']);
    // `--json` 的形状（字段集稳定；token/at 天然每次不同，见定题 §6.4 的口径）
    const j = JSON.parse(String(r.stdout).trim());
    expect(j).toMatchObject({ ok: true, cmd: 'point', mode: 'note', project: 'demo', node: 'n-a' });
    expect(j.token).toBe(cmd.token);
    expect(j.result.topic).toBe('节点甲');
    // ★ 零写盘：项目根**逐字节**不变（含 .changes.jsonl）
    expect(snapProject('demo')).toEqual(before);
    expect(visitEvents()).toEqual([]);   // 没记下任何一次访问（.visits/ 里没有事件文件）
  });

  it('G2 related 档：mode 真的传到界面（不是被 CLI 悄悄改回 note），且同样零写盘', async () => {
    seedProject('demo');
    const capture = path.join(SANDBOX, 'captured-related.json');
    const appDone = startFakeApp('answer', capture);
    const before = snapProject('demo');
    const r = withAppData(() => invokeSync(['point', 'demo', 'n-a', '--mode', 'related', '--json']));
    await appDone;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(capture, 'utf8')).mode).toBe('related');
    const j = JSON.parse(String(r.stdout).trim());
    expect(j.mode).toBe('related');
    expect(j.result.members).toBe(2);
    expect(snapProject('demo')).toEqual(before);
    expect(visitEvents()).toEqual([]);   // 没记下任何一次访问（.visits/ 里没有事件文件）
  });

  it('G3 界面**拒绝**（项目不符）⇒ exit 1，且界面的原因**原样转述**（不是"失败"两个字）', async () => {
    seedProject('demo');
    const capture = path.join(SANDBOX, 'captured-refuse.json');
    const appDone = startFakeApp('refuse', capture);
    const before = snapProject('demo');
    const r = withAppData(() => invokeSync(['point', 'demo', 'n-a']));
    await appDone;
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('error:');
    expect(r.stdout).toContain('proj-other');            // app 给的那句被原样带回来
    expect(r.stdout).toContain('界面没有照做');
    expect(snapProject('demo')).toEqual(before);
    expect(visitEvents()).toEqual([]);   // 没记下任何一次访问（.visits/ 里没有事件文件）
  });

  it('G4 界面认领了却**不回执** ⇒ exit 1 + "主界面没有响应"（没有回执 = 没生效，且不早退）', async () => {
    seedProject('demo');
    const capture = path.join(SANDBOX, 'captured-silent.json');
    const appDone = startFakeApp('silent', capture);
    const t0 = Date.now();
    const r = withAppData(() => invokeSync(['point', 'demo', 'n-a']));
    const ms = Date.now() - t0;
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('主界面没有响应');
    expect(r.stdout).toContain('AI MindMap');
    // 该等满窗口才判失败（早退 = 把"还没干完"说成"没响应"，那是假原因）
    expect(ms).toBeGreaterThan(2000);
    expect(await appDone).toBe(0);                          // 收尾：假界面已退出（认领过、没回执）
    expect(fs.existsSync(capture)).toBe(true);              // 它**确实认领到了**那条命令（不是没看见）
  });
});
