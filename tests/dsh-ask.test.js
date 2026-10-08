/* ============================================================
 * tests/dsh-ask.test.js — 功能 1 后端（向内嵌 DSH 提问）的契约
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 三件事值得锁：
 *   ① **AI 收到什么**（提示词）：情境必须被自动补齐（项目/路径/正文/相关节点），
 *      两种 kind 的措辞不同，问题原样带上 —— 这是"答得对不对"的**唯一**输入端；
 *   ② **子进程怎么拉**：参数是一个 argv（多行提示词不能变成多个参数 ✗）、
 *      DSH_HOME 必须指向应用自己的数据目录、**只增不覆盖**其它环境变量；
 *   ③ **失败绝不当成功**：非 0 退出 / 空输出 / 超时都要 ok:false 并带原因
 *      （"采不到真值 = 红"，这条是本工程的老规矩）。
 * 另有一条实测教训进测试：`--dry-run` 必须**真的不调模型**（第一版驼峰写错 ⇒ 静默失效 ✗）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dshAsk = require('../src/dsh-ask.js');
const askCmd = require('../cli/commands/dsh-ask.js');

const CTX_INFO = {
  project: 'comnet', projectRoot: 'D:\\proj', nodeId: 'tcp-handshake', topic: 'TCP 连接管理',
  pathText: '网络 / TCP / TCP 连接管理', tags: ['TCP', '握手'],
  detailText: '三次握手与四次挥手。', relatedText: '→ TCP 概述；← 可靠传输'
};

describe('提示词：AI 收到什么（情境自动补齐）', () => {
  it('情境块补齐项目/路径/正文/相关节点，并说明"不要复述"', () => {
    const p = dshAsk.buildAskPrompt(Object.assign({ kind: 'explain' }, CTX_INFO));
    expect(p).toContain('自动补充');
    expect(p).toContain('comnet');
    expect(p).toContain('网络 / TCP / TCP 连接管理');
    expect(p).toContain('三次握手与四次挥手。');
    expect(p).toContain('→ TCP 概述；← 可靠传输');
    expect(p).toContain('TCP、握手');           // 标签
    expect(p).toContain('不要寒暄');
  });

  it('没正文时**明说**"没有正文"，不留下一个空行让 AI 猜', () => {
    const p = dshAsk.buildAskPrompt({ kind: 'explain', project: 'p', nodeId: 'x', topic: 'X' });
    expect(p).toContain('还没有正文');
    expect(p).not.toContain('undefined');
  });

  it('kind=explain 与 kind=ask 的措辞不同；问题原样带上（ask 无问题也能构造，由命令层拦）', () => {
    const e = dshAsk.buildAskPrompt(Object.assign({ kind: 'explain' }, CTX_INFO));
    const a = dshAsk.buildAskPrompt(Object.assign({ kind: 'ask', question: '为什么要三次？' }, CTX_INFO));
    expect(e).toContain('请**解释**');
    expect(a).toContain('为什么要三次？');
    expect(a).not.toContain('请**解释**');
    // 未知 kind ⇒ 退回 ask（不抛，但也不假装是 explain）
    const u = dshAsk.buildAskPrompt(Object.assign({ kind: 'nonsense' }, CTX_INFO));
    expect(u).toContain('请回答用户的问题');
  });
});

describe('子进程参数与环境', () => {
  it('参数 = [headless, 整段提示词]：多行提示词必须是**一个** argv（不能拆成多个 ✗）', () => {
    const p = 'a\nb\nc';
    const args = dshAsk.buildAskArgs(p);
    expect(args).toEqual(['headless', 'a\nb\nc']);
    expect(args).toHaveLength(2);
  });

  it('环境：DSH_HOME 指向应用数据目录，其它变量**保留**（只增不覆盖）', () => {
    const env = dshAsk.buildAskEnv({ PATH: 'x', DSH_HOME: '旧的' }, 'D:\\home');
    expect(env.DSH_HOME).toBe('D:\\home');
    expect(env.PATH).toBe('x');
  });

  it('运行包不可用 ⇒ **响亮抛错**（不返回一个半成品路径让子进程"失败得莫名其妙"）', () => {
    expect(() => dshAsk.resolveAskRuntime({ repoRoot: 'X:\\nope', userDataPath: 'Y:\\nope', verifyHashes: false })).toThrow();
  });

  it('真仓库里解析到的就是 vendor/dsh 那一份（单一真源，不自己拼路径）', () => {
    const path = require('node:path');
    const repo = path.resolve(__dirname, '..');
    const rt = dshAsk.resolveAskRuntime({ repoRoot: repo, verifyHashes: false });
    expect(rt.dsh.replace(/\\/g, '/')).toContain('vendor/dsh/');
    expect(rt.dsh).toContain('bin.js');
    expect(rt.home).toContain('dsh-home');
  });
});

describe('失败绝不当成功（采不到真值 = 红）', () => {
  const rt = { node: 'NODE', dsh: 'DSH', home: 'H' };
  const fake = (ret) => () => ret;

  it('正常：stdout 去空白后返回，ok=true，带耗时', () => {
    const r = dshAsk.askOnce({ runtime: rt, prompt: '问', spawn: fake({ status: 0, stdout: '  答案\n', stderr: '' }) });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('答案');
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('非 0 退出 ⇒ ok=false，带退出码与 stderr 片段', () => {
    const r = dshAsk.askOnce({ runtime: rt, prompt: '问', spawn: fake({ status: 3, stdout: '', stderr: '炸了' }) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.error).toContain('炸了');
  });

  it('退出码 0 但**没有输出** ⇒ ok=false（空答案不是答案）', () => {
    const r = dshAsk.askOnce({ runtime: rt, prompt: '问', spawn: fake({ status: 0, stdout: '   \n', stderr: '' }) });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有任何输出');
  });

  it('超时 ⇒ ok=false 且说明"超时多少秒"（不是"未知错误"）', () => {
    const err = new Error('spawnSync ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    const r = dshAsk.askOnce({ runtime: rt, prompt: '问', timeoutMs: 5000, spawn: fake({ status: null, error: err }) });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
    expect(r.error).toContain('5s');
  });

  it('运行包不可用 / 提示词为空 ⇒ ok=false（不抛，也不假装成功）', () => {
    expect(dshAsk.askOnce({ runtime: null, prompt: '问' }).ok).toBe(false);
    expect(dshAsk.askOnce({ runtime: rt, prompt: '   ' }).ok).toBe(false);
  });
});

describe('CLI 命令：--dry-run 必须真的不调模型（实测教训）', () => {
  /** 最小 ctx 桩：够 ask() 走完 dry-run 分支 */
  const ctxStub = (args) => ({
    projectName: 'comnet',
    PROJECTS_DIR: 'D:\\proj\\projects',
    args: args,
    outs: [],
    read: () => ({ file: 'D:\\proj\\projects\\comnet\\comnet.json', data: { data: { id: 'root', topic: 'root', children: [] } } }),
    tree: {
      find: () => ({ id: 'tcp-handshake', topic: 'TCP 连接管理', detail: '<p>正文</p>' }),
      pathTo: () => [{ topic: '网络' }, { topic: 'TCP 连接管理' }]
    },
    out(s) { this.outs.push(String(s)); },
    outJson(o) { this.outs.push(JSON.stringify(o)); },
    error(m) { throw new Error('ctx.error: ' + m); }
  });

  it('--dry-run（驼峰 dryRun）⇒ 打印提示词，且**一次都不调用** askOnce', () => {
    const orig = dshAsk.askOnce;
    let called = 0;
    dshAsk.askOnce = () => { called++; throw new Error('dry-run 不该调用模型 ✗'); };
    try {
      const ctx = ctxStub({ _: ['ask', 'tcp-handshake'], kind: 'explain', dryRun: true });
      askCmd.ask(ctx);
      expect(called).toBe(0);
      const text = ctx.outs.join('\n');
      expect(text).toContain('没有调用模型');
      expect(text).toContain('【情境】');
      expect(text).toContain('DSH_HOME');
    } finally { dshAsk.askOnce = orig; }
  });

  it('不带 --dry-run ⇒ 确实会调用（对照组：证明上一条不是因为没接线才"没调用"）', () => {
    const orig = dshAsk.askOnce;
    let called = 0;
    dshAsk.askOnce = () => { called++; return { ok: true, text: '答案', ms: 1, code: 0 }; };
    try {
      const ctx = ctxStub({ _: ['ask', 'tcp-handshake'], kind: 'explain' });
      askCmd.ask(ctx);
      expect(called).toBe(1);
      expect(ctx.outs.join('\n')).toContain('答案');
    } finally { dshAsk.askOnce = orig; }
  });

  it('--kind ask 不给问题 ⇒ 报错（不许发一个没有问题的空问题）', () => {
    const ctx = ctxStub({ _: ['ask', 'tcp-handshake'], kind: 'ask', dryRun: true });
    expect(() => askCmd.ask(ctx)).toThrow(/需要 --question/);
  });

  it('取不到节点 ⇒ 报错（不是发个残缺提示词出去）', () => {
    const ctx = ctxStub({ _: ['ask', 'nope'], kind: 'explain', dryRun: true });
    ctx.tree.find = () => null;
    expect(() => askCmd.ask(ctx)).toThrow(/节点不存在/);
  });
});
