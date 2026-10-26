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
const core = require('../cli/core.js');

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
  it('**项目级**（消息栏那条入口）：不说"理解一个节点"，而要说清"你能动手 + 有哪些命令"', () => {
    const p = dshAsk.buildAskPrompt({ kind: 'ask', projectLevel: true, project: 'comnet',
      projectRoot: 'D:\\proj', question: '把 E:\\书\\计算机网络.md 导入成新项目' });
    expect(p).toContain('项目级');
    expect(p).toContain('可以动手');
    expect(p).toContain('import-project');          // 关键：告诉它怎么真的导入 ✓
    expect(p).toContain('把 E:\\书\\计算机网络.md 导入成新项目');
    expect(p).not.toContain('理解他自己思维导图里的一个节点');   // 开场白也要换 ✓
    expect(p).not.toContain('还没有正文');           // 项目级不谈节点正文 ✓
  });

  it('节点级不受影响（项目级的改动没有把原来的情境挤掉）', () => {
    const p = dshAsk.buildAskPrompt(Object.assign({ kind: 'explain' }, CTX_INFO));
    expect(p).toContain('理解他自己思维导图里的一个节点');
    expect(p).toContain('网络 / TCP / TCP 连接管理');
    expect(p).not.toContain('可以动手');            // 节点级不塞"你能动手"那段（免得解释跑偏）
  });
});

describe('思考强度（用户反馈③：解释/问AI 太慢）', () => {
  const DUMP = [
    '# composed profile',
    '- id: other-row',
    '  config:',
    '    x: 1',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-flash',
    '    reasoningEffort: high',
    '- id: next-row',
    '  config:',
    '    provider: 不该被扫到'
  ].join('\n');

  it('parseAgentModel：只认 agent-default-model 那一段里的 provider/model（不会串到下一行去）', () => {
    const m = dshAsk.parseAgentModel(DUMP);
    expect(m).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' });
  });

  it('parseAgentModel：扫不到就返回 null（**不猜** —— 调用方据此放弃覆盖并如实说明 ✓）', () => {
    expect(dshAsk.parseAgentModel('没有那一行')).toBe(null);
    expect(dshAsk.parseAgentModel('- id: agent-default-model\n  config:\n    model: x')).toBe(null);  // 缺 provider
    expect(dshAsk.parseAgentModel('')).toBe(null);
  });

  it('buildEffortPatch：**三项写全**（校验实测教训：patch 是整行替换，少写会把模型配置抹掉 ✗）', () => {
    const t = dshAsk.buildEffortPatch('low', { provider: 'p', model: 'm' });
    expect(t).toMatch(/- id: agent-default-model/);
    expect(t).toMatch(/provider: p/);
    expect(t).toMatch(/model: m/);
    expect(t).toMatch(/reasoningEffort: low/);
  });

  it('buildEffortPatch：拿不到模型配置 / 未知取值 ⇒ **抛错**（不静默打一个半截 patch ✗）', () => {
    expect(() => dshAsk.buildEffortPatch('low', null)).toThrow(/provider\/model/);
    expect(() => dshAsk.buildEffortPatch('turbo', { provider: 'p', model: 'm' })).toThrow(/未知的思考强度/);
    for (const e of dshAsk.EFFORTS) expect(() => dshAsk.buildEffortPatch(e, { provider: 'p', model: 'm' })).not.toThrow();
  });

  it('默认强度：解释 low（提速 ✓）、问答 medium（可手动改 ✓）', () => {
    expect(dshAsk.DEFAULT_EFFORT.explain).toBe('low');
    expect(dshAsk.DEFAULT_EFFORT.ask).toBe('medium');
  });

  it('buildAskArgs：给了 patch 就带 `--profile headless --patch <文件>`（启动器全局参数在子命令之前 ✓）', () => {
    expect(dshAsk.buildAskArgs('问', {})).toEqual(['headless', '问']);
    const withPatch = dshAsk.buildAskArgs('问', { patchFile: 'C:\\t\\p.yml' });
    expect(withPatch).toEqual(['--profile', 'headless', '--patch', 'C:\\t\\p.yml', 'headless', '问']);
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
    // 夹具纪律：别用映射网络盘做"不可用"夹具 —— 盘不可达时 fs.existsSync 一次要 9s+（X: 实测 9303ms、复测 21067ms，2026-10-15，对照本地路径 <1ms）⇒ resolveRuntime 的多次存在性探测被放大成链内超时；一律用快速失败的本地不存在路径（Z: 已被映射也不许用，见 docs/INCIDENTS.md 事故三）。
    expect(() => dshAsk.resolveAskRuntime({ repoRoot: 'C:\\__definitely_not_exist_dsh_ask_fixture__\\nope', userDataPath: 'C:\\__definitely_not_exist_dsh_ask_fixture__\\nope2', verifyHashes: false })).toThrow();
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
    /* 【W8】`--dry-run` 的判定统一走 `ctx.dryRun`（真 ctx 上是个 getter，唯一读取点见 cli/core.js）——
     * 桩里照同一语义给一份（**别让桩比真实现更宽松**：桩少了它，命令会读成 undefined ⇒ dry-run 静默失效）。 */
    get dryRun() { return !!args.dryRun; },
    outs: [],
    read: () => ({ file: 'D:\\proj\\projects\\comnet\\comnet.json', data: { data: { id: 'root', topic: 'root', children: [] } } }),
    tree: {
      find: () => ({ id: 'tcp-handshake', topic: 'TCP 连接管理', detail: '<p>正文</p>' }),
      pathTo: () => [{ topic: '网络' }, { topic: 'TCP 连接管理' }]
    },
    out(s) { this.outs.push(String(s)); },
    outJson(o) { this.outs.push(JSON.stringify(o)); },
    error(m) { throw new Error('ctx.error: ' + m); },
    /* 热度埋点（第三件 · C）：`ask` **答出来之后**会调它记一次 `ai-ask`。
     * 桩里必须给出它 —— 少了它，命令会在"模型已经答完"之后抛 `recordVisit is not a function`，
     * 报错指向的地方（成功路径的尾巴）和真因（桩缺一个方法）完全不是一回事（实测踩到）。
     * 这里只记下调用供断言、返回一个"记上了"的读数，**不触碰任何盘**（桩就是桩）。 */
    visits: [],
    recordVisit(ch, ids) {
      this.visits.push({ ch: ch, ids: (ids || []).slice() });
      return { ok: true, reason: 'stub', channel: ch, recorded: (ids || []).length, dropped: 0, errors: [] };
    },
    // 与真实 ctx 同一套语义（**委托给真实现**，别在桩里另写一份判定逻辑）：
    // 整数选项非法 ⇒ 报错；没给 ⇒ 默认值。`ask --timeout` 现在走它。
    intOption(key, opts) {
      const p = core.parseIntOption(this.args[key], opts);
      if (!p.ok) this.error('--' + key + ' ' + p.reason);
      return p.value;
    }
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
      // 顺便钉住热度埋点那一刻的口径：**答出来了**才记，且记的是被问的那个节点（通道 ai-ask）
      expect(ctx.visits.length).toBe(1);
      expect(ctx.visits[0].ch).toBe('ai-ask');
      expect(ctx.visits[0].ids).toEqual(['tcp-handshake']);
    } finally { dshAsk.askOnce = orig; }
  });

  it('--dry-run 那条路**不记**访问（没调模型、没有内容被消耗）', () => {
    const ctx = ctxStub({ _: ['ask', 'tcp-handshake'], kind: 'explain', dryRun: true });
    askCmd.ask(ctx);
    expect(ctx.visits.length).toBe(0);
  });

  it('模型答失败（ok:false）⇒ **也不记**（"叫了模型但没读到东西"不算一次访问）', () => {
    const orig = dshAsk.askOnce;
    dshAsk.askOnce = () => ({ ok: false, text: '', ms: 1, code: 2, error: '超时' });
    try {
      const ctx = ctxStub({ _: ['ask', 'tcp-handshake'], kind: 'explain' });
      expect(() => askCmd.ask(ctx)).toThrow(/提问失败/);
      expect(ctx.visits.length).toBe(0);
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
