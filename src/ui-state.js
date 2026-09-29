/* ============================================================
 * src/ui-state.js — 「界面有未保存编辑」的跨进程协调信号（纯逻辑 + 文件契约）
 * ------------------------------------------------------------
 * 为什么需要它（v0.16.6）：
 *   「边聊边编辑」原有的写前协调走的是 Electron IPC `dsh-sidebar:ui-dirty`，
 *   但那条通道**根本到不了侧栏 AI** —— 侧栏是独立 WebContentsView，建的
 *   时候就没有宿主 preload（main-dsh-sidebar.js 顶部安全边界写明），
 *   preload.js 也没把它暴露给主 renderer。于是它是一个"有 handler、零调用方"
 *   的死通道：skill 里写着"批量编辑前先查 dirty"，AI 却无从查起（文档承诺 ≠
 *   可执行能力）。这正是 RULES R5 点名的那类脱钩。
 *
 * 为什么用**文件**而不是 IPC/HTTP：
 *   侧栏 AI 唯一的能力面是 shell（跑 CLI）。所以信号必须落在双方都能直接读到
 *   的地方。IPC 需要渲染层桥、HTTP 需要常驻端口与鉴权 —— 都是新攻击面。
 *   文件放在**项目目录内**（`projects/<项目>/.ui-state.json`）而不是 userData：
 *   CLI 已经用 `ctx.PROJECTS_DIR` 解析项目根，不需要另外复制一份"Electron userData
 *   路径怎么算"的知识（两处推导必然漂移）。
 *
 * 语义（谁写谁读）：
 *   · 写：主进程（app:ui-state IPC ← 渲染层在脏标记**变化时**推送）；退出时写 false。
 *   · 读：`node cli/mm-cli.js ui-state [<项目>] [--json]`（侧栏 AI / 外部 AI）。
 *   · `uiPid` 是**界面进程**的 pid：读方据此判定"界面是否真的在跑"——
 *     界面已退出（pid 不在）时，盘上的 dirty 只是残影，一律按 false 处理，
 *     否则 AI 会被一个崩溃残留的 true 永久吓得不敢写。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MMUiState = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 文件名固定带前导点：项目目录列举（store.list / 资源扫描）只认常规文件，点文件天然被忽略 */
  const FILE_NAME = '.ui-state.json';
  const SCHEMA_VERSION = 1;

  /** pid 是否活着。EPERM = 进程存在但无权限（仍然算活着）。 */
  function pidAlive(pid) {
    if (!pid || typeof pid !== 'number' || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) {
      return !!(e && e.code === 'EPERM');
    }
  }

  /** 状态文件的绝对路径（需要 path 模块；纯函数便于单测） */
  function statePath(pathMod, projectsDir, project) {
    return pathMod.join(projectsDir, project, FILE_NAME);
  }

  /** 构造要落盘的状态对象（单一真源：字段名只有这里定义） */
  function buildState(opts) {
    const o = opts || {};
    return {
      schemaVersion: SCHEMA_VERSION,
      project: String(o.project || ''),
      dirty: !!o.dirty,
      uiPid: typeof o.uiPid === 'number' ? o.uiPid : 0,
      updatedAt: o.updatedAt || new Date().toISOString()
    };
  }

  function serializeState(state) {
    return JSON.stringify(buildState(state));
  }

  /** 解析盘上的内容；坏 JSON / 形状不对 → { ok:false, error }（不抛，调用方决定口径） */
  function parseState(text) {
    if (!text || typeof text !== 'string') return { ok: false, error: '内容为空' };
    let raw;
    try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { return { ok: false, error: 'JSON 解析失败: ' + e.message }; }
    if (!raw || typeof raw !== 'object') return { ok: false, error: '不是对象' };
    return { ok: true, state: buildState(raw) };
  }

  /**
   * 把「盘上状态 + 界面进程活性」解释成读方要的结论。
   * @param {object|null} state  parseState 的结果（null = 文件不存在）
   * @param {function} isAlive    pid → boolean（注入以便单测）
   * @returns {{project:string, uiRunning:boolean, dirty:boolean, uiPid:number,
   *            updatedAt:string|null, exists:boolean, stale:boolean, corrupt:boolean, note:string}}
   */
  function interpret(project, state, isAlive) {
    const alive = isAlive || pidAlive;
    const base = {
      project: project, uiRunning: false, dirty: false, uiPid: 0,
      updatedAt: null, exists: false, stale: false, corrupt: false, note: ''
    };
    if (!state) {
      base.note = '界面未运行或未上报（无状态文件）—— 可以安全写入';
      return base;
    }
    base.exists = true;
    base.uiPid = state.uiPid;
    base.updatedAt = state.updatedAt || null;
    if (!state.uiPid || !alive(state.uiPid)) {
      // 界面进程不在：dirty 是残影。崩溃/强杀后没人会来清它，读方必须自己判死。
      base.stale = true;
      base.note = '界面进程（pid=' + (state.uiPid || '?') + '）已不在 —— 旧状态按「无未保存编辑」处理';
      return base;
    }
    base.uiRunning = true;
    base.dirty = !!state.dirty;
    base.note = base.dirty
      ? '界面有未保存编辑 —— 先请用户保存（或确认丢弃），再动笔'
      : '界面无未保存编辑 —— 可以安全写入（并发版本闸门保证你的写入不会被界面的整树覆盖；'
        + '但界面若随后有改动要保存，那次保存会因版本不符被拒并要求重开项目 —— 介意就先让用户重开）';
    return base;
  }

  /** 便捷入口：读一个项目的状态文件并解释（需要 fs/path；文件缺失不算错误） */
  function readProjectState(fsMod, pathMod, projectsDir, project, isAlive) {
    const file = statePath(pathMod, projectsDir, project);
    let text = null;
    let corrupt = false;
    try {
      text = fsMod.readFileSync(file, 'utf8');
    } catch (e) {
      return interpret(project, null, isAlive);
    }
    const parsed = parseState(text);
    if (!parsed.ok) { corrupt = true; return Object.assign(interpret(project, null, isAlive), { exists: true, corrupt: true }); }
    return interpret(project, parsed.state, isAlive);
  }

  return {
    FILE_NAME, SCHEMA_VERSION,
    pidAlive, statePath, buildState, serializeState, parseState, interpret, readProjectState
  };
});
