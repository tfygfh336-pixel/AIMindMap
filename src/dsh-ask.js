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

const path = require('path');
const { spawnSync } = require('child_process');
const dshPackage = require('./dsh-package.js');

/** 一次性问答的超时上限（默认）。实测极小提示词 4.4 s；留足模型思考与吐字的时间 */
const DEFAULT_TIMEOUT_MS = 120000;

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
  lines.push('· 节点：' + (i.topic || '(无标题)') + '（id=' + (i.nodeId || '?') + '）');
  if (i.pathText) lines.push('· 在树中的路径：' + i.pathText);
  if (i.tags && i.tags.length) lines.push('· 标签：' + i.tags.join('、'));
  if (i.relatedText) lines.push('· 相关节点：' + i.relatedText);
  if (i.detailText) {
    lines.push('· 节点正文（HTML 已转纯文本，过长会被截断）：');
    lines.push(String(i.detailText));
  } else {
    lines.push('· 节点正文：（这个节点还没有正文）');
  }
  return lines.join('\n');
}

/** 拼出完整提示词（纯函数：给定同样输入必然同样输出，便于单测锁住"AI 收到什么"） */
function buildAskPrompt(input) {
  const i = input || {};
  const kind = KINDS[i.kind] ? i.kind : 'ask';
  const parts = [];
  parts.push('你是「AI MindMap」里内置的助手，正在帮使用者理解他自己思维导图里的一个节点。');
  parts.push('回答要贴住这个节点的语境，直接给内容，不要寒暄、不要复述情境。');
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

/** 运行包子命令参数：`dsh headless "<prompt>"`（多行提示词原样作为**一个** argv 传递 ✓ 不经 shell） */
function buildAskArgs(prompt) {
  return ['headless', String(prompt)];
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
  const r = spawn(rt.node, [rt.dsh].concat(buildAskArgs(prompt)), {
    cwd: o.cwd || process.cwd(),
    env: buildAskEnv(o.env, rt.home),
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
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
  return { ok: true, text, ms, code, stdout };
}

module.exports = {
  DEFAULT_TIMEOUT_MS, KINDS,
  buildContextBlock, buildAskPrompt, buildAskArgs, buildAskEnv, resolveAskRuntime, askOnce
};
