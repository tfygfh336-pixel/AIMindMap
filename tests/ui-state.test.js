/* ============================================================
 * tests/ui-state.test.js — 「界面未保存编辑」状态契约单元测试
 * ------------------------------------------------------------
 * 这是侧栏 AI 的**写前协调**信号（v0.16.6）：IA 读到 dirty=true 就该先请用户
 * 保存再动笔，否则用户一保存就把 AI 的改动覆盖掉（白做工）。
 * 因此它的失效方向必须是想清楚过的：
 *   · 界面**活着**且脏 → dirty=true（保守：宁可让 AI 多问一句）
 *   · 界面**已退出**（pid 不在）→ dirty=false + stale=true
 *     （否则崩溃残留的 true 会永久吓住 AI，写前协调变成永久阻塞）
 *   · 文件**损坏** → dirty=false + corrupt=true（同上：不阻塞）
 * 用注入的 isAlive 覆盖"进程已死"分支 —— 不真去杀进程。
 * ============================================================ */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ui = require('../src/ui-state.js');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-uistate-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

const alive = () => true;
const dead = () => false;
const projectsDir = () => tmp;
const write = (project, obj) => {
  const p = ui.statePath(path, projectsDir(), project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  return p;
};

describe('ui-state 文件契约', () => {
  it('文件名是点文件（项目目录列举只认 <项目>.json，点文件不会被当成项目内容）', () => {
    expect(ui.FILE_NAME).toBe('.ui-state.json');
    expect(ui.FILE_NAME.startsWith('.')).toBe(true);
  });

  it('statePath 落在项目目录内部', () => {
    const p = ui.statePath(path, 'C:\\root\\projects', 'comnet');
    expect(p).toBe(path.join('C:\\root\\projects', 'comnet', '.ui-state.json'));
  });

  it('buildState/serializeState 只产出约定字段（schemaVersion 锁格式）', () => {
    const s = ui.buildState({ project: 'comnet', dirty: true, uiPid: 1234 });
    expect(Object.keys(s).sort()).toEqual(
      ['baseVersion', 'dirty', 'project', 'schemaVersion', 'seenVersion', 'uiPid', 'updatedAt']);
    expect(s.schemaVersion).toBe(1);
    expect(JSON.parse(ui.serializeState(s)).dirty).toBe(true);
  });

  /* 两个版本字段（v0.20）：**盘上版本指纹**，不是"界面自己算的一份哈希"。
   * 判据按"读方能不能答'界面所见落后盘上多少'"来写 —— 见 interpret 那一组。 */
  it('seenVersion / baseVersion 是字符串且缺值一律空串（**不编版本**）', () => {
    const s = ui.buildState({ project: 'comnet', dirty: false, uiPid: 1 });
    expect(s.seenVersion).toBe('');
    expect(s.baseVersion).toBe('');
    const s2 = ui.buildState({ project: 'comnet', dirty: true, uiPid: 1, seenVersion: 'abc123', baseVersion: 7 });
    expect(s2.seenVersion).toBe('abc123');
    expect(s2.baseVersion).toBe('7');            // 非字符串一律 String()（契约是字符串，不写对象/数字）
    expect(ui.parseState(ui.serializeState(s2)).state.seenVersion).toBe('abc123');
  });

  it('parseState：坏 JSON / 非对象 / 空 → { ok:false }，不抛', () => {
    expect(ui.parseState('{broken').ok).toBe(false);
    expect(ui.parseState('"str"').ok).toBe(false);
    expect(ui.parseState('').ok).toBe(false);
    expect(ui.parseState(null).ok).toBe(false);
    expect(ui.parseState('﻿{"project":"a","dirty":true,"uiPid":1}').ok).toBe(true); // BOM 容错
  });
});

describe('interpret（盘上状态 + 进程活性 → 结论）', () => {
  it('界面活着且 dirty=true → dirty=true、uiRunning=true', () => {
    const r = ui.interpret('comnet', ui.buildState({ project: 'comnet', dirty: true, uiPid: process.pid }), alive);
    expect(r.dirty).toBe(true);
    expect(r.uiRunning).toBe(true);
    expect(r.stale).toBe(false);
    expect(r.note).toContain('先请用户保存');
  });

  it('界面活着且 dirty=false → dirty=false（可以安全写入）', () => {
    const r = ui.interpret('comnet', ui.buildState({ project: 'comnet', dirty: false, uiPid: process.pid }), alive);
    expect(r.dirty).toBe(false);
    expect(r.uiRunning).toBe(true);
    expect(r.note).toContain('可以安全写入');
  });

  /* 文案与实现必须一致（用户 2026-10-13 报的正是这一条：界面提示/文档说"要重开项目"，
   * 而实现早就是三方合并）。判据按"那句话在不在"写，**不去锁整段措辞**（措辞会改，改措辞不该红）。 */
  it('note 不再宣称"重开项目"，并如实说三方合并（文案与实现一致）', () => {
    const clean = ui.interpret('comnet', ui.buildState({ project: 'comnet', dirty: false, uiPid: process.pid }), alive);
    expect(clean.note).not.toContain('重开');
    expect(clean.note).toContain('三方合并');
    expect(clean.note).toContain('最新代码');   // "界面看不到外部改动"时的第一条自查（主进程改动要重启）
    const dirty = ui.interpret('comnet', ui.buildState({ project: 'comnet', dirty: true, uiPid: process.pid }), alive);
    expect(dirty.note).not.toContain('重开');
  });

  /* 「界面所见落后盘上多少」可判：两个字面值都进 interpret（CLI `ui-state --json` 原样转发
   * 这个对象的全部字段 —— 判据见 cli/commands/project.js 的 uiState）。 */
  it('两版版本指纹进结论；seenVersion 与 baseVersion 不同 ⇒ 可读出"界面所见落后于基线"', () => {
    const behind = ui.interpret('comnet', ui.buildState({
      project: 'comnet', dirty: true, uiPid: process.pid, seenVersion: 'aaaa1111', baseVersion: 'bbbb2222'
    }), alive);
    expect(behind.seenVersion).toBe('aaaa1111');
    expect(behind.baseVersion).toBe('bbbb2222');
    expect(behind.note).toContain('aaaa1111'.slice(0, 8));
    expect(behind.note).toContain('bbbb2222'.slice(0, 8));
    // 同版 ⇒ 提示里两个前缀相同（"界面所见 == 基线"，没有落后）
    const same = ui.interpret('comnet', ui.buildState({
      project: 'comnet', dirty: false, uiPid: process.pid, seenVersion: 'cccc3333', baseVersion: 'cccc3333'
    }), alive);
    expect(same.seenVersion).toBe(same.baseVersion);
    // 老状态文件（没这两个键）⇒ 空串，**不许**回填一个假版本
    const legacy = ui.interpret('comnet', ui.buildState({ project: 'comnet', dirty: false, uiPid: process.pid }), alive);
    expect(legacy.seenVersion).toBe('');
    expect(legacy.baseVersion).toBe('');
    expect(legacy.note).not.toContain('未上报）；');   // 没有值就不给这半句提示（不无中生有）
  });

  it('界面已退出（pid 不在）→ dirty 归零 + stale=true，**不**永久阻塞 AI', () => {
    const r = ui.interpret('comnet', ui.buildState({ project: 'comnet', dirty: true, uiPid: 4242 }), dead);
    expect(r.dirty).toBe(false);
    expect(r.uiRunning).toBe(false);
    expect(r.stale).toBe(true);
    expect(r.note).toContain('已不在');
  });

  it('uiPid=0（从未上报过界面 pid）→ 视同界面不在', () => {
    const r = ui.interpret('comnet', ui.buildState({ project: 'comnet', dirty: true, uiPid: 0 }), alive);
    expect(r.dirty).toBe(false);
    expect(r.stale).toBe(true);
  });

  it('没有状态文件 → exists=false、dirty=false', () => {
    const r = ui.interpret('comnet', null, alive);
    expect(r.exists).toBe(false);
    expect(r.dirty).toBe(false);
    expect(r.note).toContain('未运行或未上报');
  });
});

describe('readProjectState（读盘 + 解释）', () => {
  it('界面进程活着 + dirty=true → DIRTY（真机 pid 用本测试进程）', () => {
    write('comnet', ui.buildState({ project: 'comnet', dirty: true, uiPid: process.pid }));
    const r = ui.readProjectState(fs, path, projectsDir(), 'comnet');
    expect(r.dirty).toBe(true);
    expect(r.uiRunning).toBe(true);
    expect(r.exists).toBe(true);
  });

  it('文件缺失不算错误（界面没跑过）', () => {
    const r = ui.readProjectState(fs, path, projectsDir(), 'nope');
    expect(r.exists).toBe(false);
    expect(r.dirty).toBe(false);
    expect(r.corrupt).toBe(false);
  });

  it('文件损坏 → corrupt=true 且 dirty=false（不阻塞写入）', () => {
    write('comnet', '{ 这不是合法 JSON');
    const r = ui.readProjectState(fs, path, projectsDir(), 'comnet');
    expect(r.corrupt).toBe(true);
    expect(r.dirty).toBe(false);
  });

  it('pidAlive：本进程 true / 不存在的 pid false / 非法值 false', () => {
    expect(ui.pidAlive(process.pid)).toBe(true);
    expect(ui.pidAlive(999999999)).toBe(false);
    expect(ui.pidAlive(0)).toBe(false);
    expect(ui.pidAlive(null)).toBe(false);
    expect(ui.pidAlive('123')).toBe(false);
  });
});
