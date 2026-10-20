/* ============================================================
 * src/dsh-ask.js —— 向内嵌 DSH 提一个一次性问题（功能 1 的**后端**）
 * ------------------------------------------------------------
 * 通道（2026-10-08 实测，运行包自带 help 的原文）：
 *     dsh headless "run the tests"   → answer one task, print the result, and exit
 *   · `headless` 是**内置 profile**（不落在 $DSH_HOME/profiles 里）⇒ 直接跑即可；
 *     实测：`dsh headless "用不超过 10 个字回答：1+1 等于几？"` ⇒ 退出码 0、**4.4 s**、
 *     stdout **只有一行答案**（没有 banner / 没有 token / 没有噪音）✓
 *   · 于是"内置 AI 的对话"可以先用**一次性子进程**实现：标准的 stdout 收答案，
 *     不需要 web 服务、不需要 ACP/SSE、不抢用户侧栏的会话锁（写锁冲突那套问题全绕开 ✓）。
 *   · 代价：**每次一问一个新会话**（没有上下文延续）。多轮要 `--resume <session>`，
 *     那是后续步（本文件先只做一次性，UI 的「解释」用它就够）。
 *
 * 本文件分两半：
 *   上半 **纯函数**（提示词/参数/环境构造）—— 有单测，是"AI 收到什么"的唯一定义处；
 *   下半 **运行器**（spawn 子进程）—— spawn 可注入 ⇒ 单测能验参数与环境，不真起进程 ✓
 * ============================================================ */
'use strict';

/* ---------- UMD 头（形态照 `docs/ARCHITECTURE.md` §2.3；对照模块 `src/palette-rank.js`）----------
 * 修复前（2026-10-20 实测）：`path` / `fs` / `os` / `{ spawnSync } = require('child_process')` 四条
 * 在模块顶层 ⇒ 浏览器端加载抛 `ReferenceError: require is not defined`。
 * 本模块要起 `dsh` 子进程、写临时 yml ⇒ 浏览器端本来就不该可用；合规做法是显式守卫。
 * `process` / `__dirname` 也由工厂注入：它们同样是 Node 全局，浏览器端直接取会抛
 * `process is not defined` / `__dirname is not defined`（比"需要 Node 环境"难读得多）。
 * ⚠️ `child_process` 在**加载时**就被解构 ⇒ 替身必须是"取属性得一个调用即抛的函数"。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('path'), require('fs'), require('os'), require('child_process'),
      require('./dsh-package.js'), process, __dirname);
  } else {
    root.MMDshAsk = factory(nodeTrap('path'), nodeTrap('fs'), nodeTrap('os'), nodeTrap('child_process'),
      root.MMDshPackage, nodeGlobal('process'), nodeGlobal('__dirname'));
  }
  function nodeTrap(name) {
    const no = (prop) => function () {
      throw new Error('src/dsh-ask.js 的 ' + name + '.' + prop + ' 需要 Node 环境（浏览器端没有 ' + name
        + '；问 AI 要起 dsh 子进程，请走 CLI / IPC）');
    };
    return new Proxy({}, { get: (_t, prop) => (typeof prop === 'symbol' ? undefined : no(String(prop))) });
  }
  function nodeGlobal(name) {
    return new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol') return undefined;
        throw new Error('src/dsh-ask.js 需要 Node 环境（浏览器端没有 ' + name + '.' + String(prop) + '；请走 CLI / IPC）');
      }
    });
  }
})(typeof self !== 'undefined' ? self : this, function (path, fs, os, childProcess, dshPackage, process, __dirname) {

const { spawnSync } = childProcess;

/** 一次性问答的超时上限（默认）。实测极小提示词 4.4 s；留足模型思考与吐字的时间 */
const DEFAULT_TIMEOUT_MS = 120000;

/* ---------------- 思考强度（用户反馈③：解释/问AI 太慢） ----------------
 * 证据（2026-10-08 实地取证）：
 *   · `dsh headless` **没有**任何思考强度参数（只有 --json / --session-id）✗ ⇒ 只能用 `--patch` 覆盖
 *     `agent-default-model` 这一行；
 *   · 现值来自 profile：实测 web profile 是 `reasoningEffort: high` —— 这就是"慢"的直接原因 ✓；
 *   · 允许取值**按模型声明**：`deepseek-flash` 声明的是 low/medium/high/xhigh（另一个模型是 high/max）
 *     ⇒ 本文件只做**取值的粗校验**，未知值一律拒绝（不猜 ✗）；
 *   · **patch 是整行替换**：实测只写 `reasoningEffort` 会把 `provider`/`model` 一起抹掉 ✗✗
 *     ⇒ 生成的 patch 必须把三项写全（provider/model 从 `--dump-config` 的现实值里取）。
 * 默认：解释用 low（用户原话"解释的时候自动降低思考强度增加速度"✓），问答用 medium（可手动改 ✓）。 */
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_EFFORT = { explain: 'low', ask: 'medium' };

/** 从 `--dump-config` 的文本里取 `agent-default-model` 的 provider/model（**不引 YAML 解析器**：
 *  本工程**零必需运行时依赖**（唯一例外：PDF 解析用的 `pdfjs-dist`）；只做一次极窄扫描 ✓，
 *  扫不到返回 null ⇒ 调用方**放弃 effort 覆盖**并如实说明 ✓） */
function parseAgentModel(dumpText) {
  const lines = String(dumpText || '').split(/\r?\n/);
  let i = lines.findIndex((l) => /^\s*-\s+id:\s*agent-default-model\s*$/.test(l));
  if (i < 0) return null;
  const out = {};
  for (let k = i + 1; k < lines.length && k < i + 12; k++) {
    if (/^\s*-\s+id:/.test(lines[k])) break;                 // 进入下一行了
    const m = lines[k].match(/^\s*(provider|model):\s*(\S+)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return (out.provider && out.model) ? out : null;
}

/** 生成"只改思考强度"的 patch 文本（**三项写全** —— 见上面的实测说明 ✓） */
function buildEffortPatch(effort, agentModel) {
  if (EFFORTS.indexOf(effort) < 0) throw new Error('未知的思考强度: ' + effort + '（可用：' + EFFORTS.join('/') + '）');
  if (!agentModel || !agentModel.provider || !agentModel.model) {
    throw new Error('拿不到 agent-default-model 的 provider/model（--dump-config 扫描失败）⇒ 不敢打 patch：'
      + 'patch 是整行替换，写不全会把模型配置抹掉');
  }
  return [
    '# 由 src/dsh-ask.js 生成（一次性）：只为了改思考强度。',
    '# ⚠️ 必须把 provider/model 一起写全：patch 是**整行替换**，只写 effort 会把它们抹掉（实测）✗',
    '- id: agent-default-model',
    '  config:',
    '    provider: ' + agentModel.provider,
    '    model: ' + agentModel.model,
    '    reasoningEffort: ' + effort,
    ''
  ].join('\n');
}

/** 问的"种类"：决定了开头那句指令怎么写（UI 上的两个按钮就映射到这里） */
const KINDS = {
  explain: '请**解释**这个节点在讲什么：先说它是什么，再说它与相邻概念的关系，最后给一个简短小结。',
  ask: '请回答用户的问题。'
};

/**
 * 情境块：**自动补充**"这个节点在哪个项目、路径是什么、正文说了什么"。
 * 为什么要它：不带情境的问题在导图场景里几乎没意义（同一句话在不同节点下答案完全不同），
 * 而让使用者每次手打情境是不现实的 ⇒ 由应用补齐（功能 5 的"自动补充情境信息"也复用这一块 ✓）。
 * @returns {string}
 */
function buildContextBlock(info) {
  const i = info || {};
  const lines = [];
  lines.push('【情境】（由 AI MindMap 自动补充，不要复述，直接用）');
  lines.push('· 项目：' + (i.project || '(未知)'));
  if (i.projectRoot) lines.push('· 工程根：' + i.projectRoot);
  // **多节点**（用户反馈④：框选/多选后"把所有被框选的都给 AI 看"）——
  // 逐个列出，每个都带路径与正文（正文按**总量**截断，避免 N 个节点把提示词撑爆 ✗）
  if (i.nodes && i.nodes.length) {
    lines.push('· 这是**多节点**提问：使用者在导图上选了 **' + i.nodes.length + ' 个节点**，'
      + '请把它们**放在一起**看（共同点 / 差异 / 彼此关系），不要只答第一个。');
    let budget = i.multiDetailBudget || 1200;   // 所有节点正文共享的预算（字符）
    i.nodes.forEach((n, k) => {
      lines.push('');
      lines.push('【节点 ' + (k + 1) + '】' + (n.topic || '(无标题)') + '（id=' + (n.id || '?') + '）');
      if (n.pathText) lines.push('  · 路径：' + n.pathText);
      if (n.tags && n.tags.length) lines.push('  · 标签：' + n.tags.join('、'));
      const d = String(n.detailText || '');
      if (!d) { lines.push('  · 正文：（这个节点还没有正文）'); return; }
      const take = Math.max(0, Math.min(budget, d.length));
      lines.push('  · 正文' + (take < d.length ? '（截断）' : '') + '：' + d.slice(0, take));
      budget -= take;
      if (budget <= 0 && k < i.nodes.length - 1) lines.push('  （其余节点正文因长度预算略去）');
    });
    return lines.join('\n');
  }
  if (i.nodeId) {
    lines.push('· 节点：' + (i.topic || '(无标题)') + '（id=' + i.nodeId + '）');
    if (i.pathText) lines.push('· 在树中的路径：' + i.pathText);
    if (i.tags && i.tags.length) lines.push('· 标签：' + i.tags.join('、'));
    if (i.relatedText) lines.push('· 相关节点：' + i.relatedText);
    if (i.detailText) {
      lines.push('· 节点正文（HTML 已转纯文本，过长会被截断）：');
      lines.push(String(i.detailText));
    } else {
      lines.push('· 节点正文：（这个节点还没有正文）');
    }
  } else if (i.projectLevel) {
    // 项目级提问（消息栏那条入口）：没有当前节点，但要告诉 AI **它在什么环境里、手上有哪些手段** ——
    // 否则它只会干聊，不会真去动数据（用户的原话是"描述要导入什么"，那需要它知道 import-project ✓）
    lines.push('· 这是**项目级**提问（用户没有选中具体节点）。');
    lines.push('· 你可以**动手**：本工程有 CLI（在工程根跑 `node cli/mm-cli.js --help` 看全部命令），'
      + '例如从一个大文件建新项目 `import-project <新项目名> <文件.md|.txt|.docx>`、'
      + '查询 `read/search/related/backlinks`、编辑 `add/edit/move/remove`。'
      + '用户让你"导入/整理某个文件"时，先看清文件存不存在、再动手，并把结果如实回报。');
  }
  return lines.join('\n');
}

/** 拼出完整提示词（纯函数：给定同样输入必然同样输出，便于单测锁住"AI 收到什么"） */
function buildAskPrompt(input) {
  const i = input || {};
  const kind = KINDS[i.kind] ? i.kind : 'ask';
  const parts = [];
  parts.push(i.projectLevel
    ? '你是「AI MindMap」里内置的助手，正在帮使用者处理他的思维导图应用（可以动手，不只是聊天）。'
    : (i.nodes && i.nodes.length > 1
      ? '你是「AI MindMap」里内置的助手，正在帮使用者理解他在导图上**一起选中的几个节点**。'
      : '你是「AI MindMap」里内置的助手，正在帮使用者理解他自己思维导图里的一个节点。'));
  parts.push('回答要贴住情境，直接给内容，不要寒暄、不要复述情境。');
  parts.push('');
  parts.push(buildContextBlock(i));
  parts.push('');
  parts.push('【要求】' + KINDS[kind]);
  if (i.question) {
    parts.push('');
    parts.push('【用户的问题】' + String(i.question).trim());
  }
  return parts.join('\n');
}

/** 运行包子命令参数：`dsh headless "<prompt>"`（多行提示词原样作为**一个** argv 传递 ✓ 不经 shell）
 *  给了 patchFile ⇒ 前面加 `--patch <文件>`（启动器的全局参数，在子命令之前 ✓） */
function buildAskArgs(prompt, opts) {
  const o = opts || {};
  const p = ['headless', String(prompt)];
  return o.patchFile ? ['--profile', 'headless', '--patch', String(o.patchFile)].concat(p) : p;
}

/** 子进程环境：DSH_HOME 指向应用自己的数据目录（**不覆盖**其它变量，只增） */
function buildAskEnv(baseEnv, home) {
  return Object.assign({}, baseEnv || process.env, { DSH_HOME: String(home) });
}

/** 解析运行包（复用 dsh-package 的单一真源，不自己拼路径） */
function resolveAskRuntime(opts) {
  const o = opts || {};
  const repoRoot = o.repoRoot || path.resolve(__dirname, '..');
  const userDataPath = o.userDataPath || path.join(process.env.APPDATA || '', 'AI MindMap');
  const r = dshPackage.resolveRuntime({
    bundledRoot: path.join(repoRoot, 'vendor', 'dsh'),
    userDataPath: userDataPath,
    verifyHashes: o.verifyHashes === true
  });
  return { node: r.node, dsh: r.dsh, home: path.join(userDataPath, 'dsh-home'), root: r.root, manifest: r.manifest };
}

/**
 * 跑一次一次性问答。
 * @param {{runtime:object, prompt:string, cwd?:string, timeoutMs?:number, spawn?:Function, env?:object}} opts
 * @returns {{ok:boolean, text:string, ms:number, code:number|null, error?:string, stdout?:string}}
 * 失败**绝不当成功**：非 0 退出 / 空输出 / 超时都要 ok:false 并带上原因（"采不到真值 = 红"）✓
 */
function askOnce(opts) {
  const o = opts || {};
  const rt = o.runtime;
  if (!rt || !rt.node || !rt.dsh) {
    return { ok: false, text: '', ms: 0, code: null, error: '运行包不可用（resolveAskRuntime 没给出 node/dsh）' };
  }
  const prompt = String(o.prompt || '');
  if (!prompt.trim()) return { ok: false, text: '', ms: 0, code: null, error: '提示词为空' };
  const spawn = o.spawn || spawnSync;
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  // 思考强度：给了就落一个临时 patch 文件（用完删 ✓）。拿不到模型配置 ⇒ **放弃覆盖并如实报**（不猜 ✗）
  let patchFile = null, effortNote = '';
  if (o.effort) {
    try {
      const dump = spawn(rt.node, [rt.dsh, '--profile', 'headless', '--dump-config'],
        { encoding: 'utf8', windowsHide: true, timeout: 20000, env: buildAskEnv(o.env, rt.home) });
      const agentModel = parseAgentModel(String((dump && dump.stdout) || ''));
      const text = buildEffortPatch(o.effort, agentModel);
      patchFile = path.join(os.tmpdir(), 'mm-ask-effort-' + process.pid + '-' + Date.now() + '.yml');
      fs.writeFileSync(patchFile, text, 'utf8');
      effortNote = o.effort;
    } catch (e) {
      effortNote = '（思考强度未生效：' + ((e && e.message) || e) + '）';
    }
  }
  let r;
  try {
    r = spawn(rt.node, [rt.dsh].concat(buildAskArgs(prompt, { patchFile: patchFile })), {
      cwd: o.cwd || process.cwd(),
      env: buildAskEnv(o.env, rt.home),
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
  } finally {
    if (patchFile) { try { fs.unlinkSync(patchFile); } catch (e) { /* 用完就删，失败不影响结果 */ } }
  }
  const ms = Date.now() - t0;
  const stdout = String((r && r.stdout) || '');
  const stderr = String((r && r.stderr) || '');
  const code = r && typeof r.status === 'number' ? r.status : null;
  // 超时：spawnSync 把 error.code/ETIMEDOUT 放在 error 上，status 为 null
  if (r && r.error) {
    const isTimeout = r.error.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(r.error.message || ''));
    return { ok: false, text: '', ms, code,
      error: (isTimeout ? '超时（' + Math.round(timeoutMs / 1000) + 's）' : '拉起子进程失败：' + (r.error.message || r.error)),
      stdout, stderr: stderr.slice(0, 500) };
  }
  if (code !== 0) {
    return { ok: false, text: '', ms, code,
      error: 'dsh headless 退出码 ' + code + (stderr.trim() ? '：' + stderr.trim().slice(0, 300) : ''), stdout };
  }
  const text = stdout.trim();
  if (!text) return { ok: false, text: '', ms, code, error: '退出码 0 但**没有任何输出**（不许当成空答案 ✓）', stdout };
  return { ok: true, text, ms, code, effort: effortNote, stdout };
}

/* ⚠️ **本文件不许出现异步 API**（Promise / async / 回调式 spawn）：
 * `tests/cli-sync-invariant.test.js` 会检查 CLI 每个命令的**依赖闭包**里没有异步 API
 * （`cli/main.js` 的 `invokeSync` 依赖命令同步完成）。界面那条路**不在这里** ——
 * 它由主进程**异步 spawn `cli ask`**（见 `main.js` 的 `app:ask` 与它上面的注释）：
 * 一次解释要 20+ 秒，主进程不能用 spawnSync 把界面卡住，但 CLI 侧保持同步 ✓。
 * 实测教训：第一版把 `askOnceAsync` 写进了本文件 ⇒ 直接被这条不变量判红 ✗（现在它不存在）。 */

return {
  DEFAULT_TIMEOUT_MS, KINDS,
  EFFORTS, DEFAULT_EFFORT, parseAgentModel, buildEffortPatch,
  buildContextBlock, buildAskPrompt, buildAskArgs, buildAskEnv, resolveAskRuntime, askOnce
};
});
