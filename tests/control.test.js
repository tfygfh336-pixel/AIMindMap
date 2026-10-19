/* ============================================================
 * tests/control.test.js —— 界面控制通道（src/control.js）协议单测
 * ------------------------------------------------------------
 * 这个通道是"外部 AI / 内置 DSH 能不能指挥界面"的唯一途径，它的失效方式很不显眼：
 *   · 命令文件半截 / 坏 JSON ⇒ 必须当作"没有命令"，**不能**抛异常把轮询打断；
 *   · 回执丢了 ⇒ 调用方必须能判出"没生效"（CLI 靠 `readResult(dir, token)` 决定报不报错）；
 *   · **并发两条命令互相覆盖** ⇒ 至少一方永远等不到回执（旧单槽协议的实测缺陷，见下）。
 *
 * 协议 v2（多槽 + 序号 + 取走即认领）：`pending/<token>.json` → `consuming/<token>.json`(rename)
 *   → `done/<token>.json`。本文件钉住三件事：
 *   ① 写入互不覆盖；② 认领只有一个赢家（同一条命令不会被派发两次）；③ 回执按 token 认。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);
const control = require(path.resolve(__dirname, '..', 'src', 'control.js'));

/* ---------------- 临时目录：**每次创建都登记**，收尾只此一处 ----------------
 * 病（2026-10-19 实测）：`tmp()` 在本文件里被 **9 个用例各调一次**（每个用例一个独立目录），
 * 旧实现是一个裸 `mkdtempSync` ⇒ 建出来的目录**一个都没人删**。
 * 读数：一次 `vitest run tests/control.test.js tests/link-caption.test.js` ⇒
 *       `%TEMP%` 里 `mm-control-test-*` **+9**。
 * 清理形态（`recursive + force`、失败响亮但不判红、三态读数）统一收在 `tests/_tmp-cleanup.js`
 * —— 别在本文件里再写一份 `fs.rmSync`（那份删不到"建了却没被引用"的目录，正是这个病的来源）。 */
const tmp = () => makeTmp('mm-control-test-');
afterAll(cleanupAll);

describe('控制通道：多槽 + 序号（修「两个 CLI 同时下命令互相覆盖」）', () => {
  it('两条并发命令各有各的槽：后写的不覆盖先写的，两条都在 pending 里', () => {
    const dir = tmp();
    const a = control.writeCommand(dir, { cmd: 'dsh-prefill', text: 'A 的文本' });
    const b = control.writeCommand(dir, { cmd: 'dsh-prefill', text: 'B 的文本' });
    expect(a.token).not.toBe(b.token);
    const list = control.listPending(dir);
    expect(list.length).toBe(2);
    expect(list.map((c) => c.text).sort()).toEqual(['A 的文本', 'B 的文本']);
    // 各自读自己的槽：**A 那条没被 B 覆盖**（旧协议在这里必红：只有一个 mm-control.json）
    expect(control.readPending(dir, a.token).text).toBe('A 的文本');
    expect(control.readPending(dir, b.token).text).toBe('B 的文本');
  });

  it('★ 认领（rename）只有一个赢家：同一条命令被 claim 两次，第二次拿到 null', () => {
    const dir = tmp();
    const { token } = control.writeCommand(dir, { cmd: 'dsh-prefill', text: '只该跑一次' });
    expect(control.claim(dir, token)).toBeTruthy();
    expect(control.claim(dir, token)).toBeNull();          // 已被认领 ⇒ 不许再执行
    expect(control.listPending(dir).length).toBe(0);       // 认领后不在 pending 里（轮询看不到它）
  });

  it('回执按 token 认：别人的回执不算自己的（并发同名命令不会串）', () => {
    const dir = tmp();
    const a = control.writeCommand(dir, { cmd: 'dsh-prefill' });
    const b = control.writeCommand(dir, { cmd: 'dsh-prefill' });
    control.writeResult(dir, b.token, { ok: true, result: { textLen: 2 } });
    expect(control.readResult(dir, a.token)).toBeNull();
    expect(control.readResult(dir, b.token).result.textLen).toBe(2);
  });

  it('坏 JSON / 半截文件一律当作"没有命令"（不能打断轮询），且**如实报出丢了什么**', () => {
    const dir = tmp();
    const p = control.paths(dir);
    const { token } = control.writeCommand(dir, { cmd: 'dsh-status' });   // 先建目录 + 一条好命令
    fs.writeFileSync(path.join(p.pending, 'broken.json'), '{ "cmd": "dsh-o', 'utf8');
    fs.writeFileSync(path.join(p.pending, 'garbage.json'), 'not json at all', 'utf8');
    // 判据：好命令照旧读得到（坏文件不打断轮询），坏文件被丢在一边、**不冒充成命令**
    // （第一版这里写的是 `expect(listPending(dir)).toEqual([])` —— 它其实是"好命令也没了"才通过 ✗，
    //  等于用一条错误的判据去守"坏文件不能打断轮询"，被测的行为根本没被验到）
    const dropped = [];
    expect(control.listPending(dir, (d) => dropped.push(...d))).toEqual([
      { cmd: 'dsh-status', token: token }
    ]);
    expect(dropped.sort()).toEqual(['broken.json', 'garbage.json']);   // 丢弃**可见**（静默丢最难排查）
  });

  it('listPending：排序发生在丢弃**之前**（坏文件排前面时不许把好命令的先后颠倒）', () => {
    const dir = tmp();
    const p = control.paths(dir);
    control.writeCommand(dir, { cmd: 'dsh-status' });       // 建目录
    // 把上一步那条真命令清掉，只留下面三条写死文件名的命令（断言才只对着它们）
    fs.rmSync(p.pending, { recursive: true, force: true });
    // 三条命令用**写死的 token**（文件名序 = 执行序），其中中间那条是坏的：
    //   cmd-0001（好）→ cmd-0002（坏）→ cmd-0003（好）
    // 若实现是 `sort().map().filter()`：坏文件被丢掉后下标前移，两条好命令的顺序取决于
    // 过滤发生在排序之前还是之后 ⇒ 这条断言就能把两者分开
    fs.mkdirSync(p.pending, { recursive: true });
    fs.writeFileSync(path.join(p.pending, 'cmd-0001.json'),
      JSON.stringify({ cmd: 'dsh-only', on: true, token: 'cmd-0001' }), 'utf8');
    fs.writeFileSync(path.join(p.pending, 'cmd-0002.json'), 'not json at all', 'utf8');
    fs.writeFileSync(path.join(p.pending, 'cmd-0003.json'),
      JSON.stringify({ cmd: 'dsh-sidebar', on: false, token: 'cmd-0003' }), 'utf8');
    const list = control.listPending(dir);
    expect(list.map((c) => c.cmd)).toEqual(['dsh-only', 'dsh-sidebar']);   // 先来先做，顺序不许翻
    expect(list.map((c) => c.token)).toEqual(['cmd-0001', 'cmd-0003']);
  });

  it('缺 token 的命令不许被派发（回执按 token 认 ⇒ 派发它等于让调用方永远等）', () => {
    const dir = tmp();
    const p = control.paths(dir);
    const { token } = control.writeCommand(dir, { cmd: 'dsh-status' });   // 建目录 + 一条好命令
    // 手工写一条**看着合法**但没有 token 的命令（旧协议形态 / 手写脚本）
    fs.writeFileSync(path.join(p.pending, 'no-token.json'),
      JSON.stringify({ cmd: 'dsh-prefill', text: '没有 token' }), 'utf8');
    const dropped = [];
    expect(control.listPending(dir, (d) => dropped.push(...d))).toEqual([{ cmd: 'dsh-status', token: token }]);
    expect(dropped).toEqual(['no-token.json']);   // 只有它被丢，**好命令照旧读得到**
  });

  it('原子写：写完不留临时文件，且命令文件始终是完整 JSON', () => {
    const dir = tmp();
    const { token } = control.writeCommand(dir, { cmd: 'dsh-only', on: false });
    const p = control.paths(dir);
    expect(fs.readdirSync(p.pending).filter((f) => f.indexOf('.tmp') >= 0)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(p.pending, token + '.json'), 'utf8')).on).toBe(false);
  });

  it('clear：调用方读走回执后不留下痕迹（三种状态的文件都清）', () => {
    const dir = tmp();
    const { token } = control.writeCommand(dir, { cmd: 'dsh-prefill' });
    control.claim(dir, token);
    control.writeResult(dir, token, { ok: true });
    expect(control.readResult(dir, token)).toBeTruthy();
    control.clear(dir, token);
    const p = control.paths(dir);
    expect(fs.existsSync(path.join(p.pending, token + '.json'))).toBe(false);
    expect(fs.existsSync(path.join(p.done, token + '.json'))).toBe(false);
    expect(fs.existsSync(path.join(p.consuming, token + '.json'))).toBe(false);
  });

  it('sweep：清掉孤儿认领位与超量 pending，并**如实报出清掉了什么**（不静默丢）', () => {
    const dir = tmp();
    const { token } = control.writeCommand(dir, { cmd: 'dsh-prefill' });
    control.claim(dir, token);
    // 把认领文件的时间戳推到很久以前（模拟"认领后进程被杀"）
    const p = control.paths(dir);
    const cf = path.join(p.consuming, token + '.json');
    const old = Date.now() - control.ORPHAN_MS - 1000;
    fs.utimesSync(cf, old / 1000, old / 1000);
    const r = control.sweep(dir, { now: Date.now() });
    expect(r.orphans.length).toBe(1);
    expect(fs.existsSync(cf)).toBe(false);
  });

  it('newToken：并发/同毫秒也唯一（两个 CLI 进程各自的 token 不会撞）', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(control.newToken('x'));
    expect(seen.size).toBe(500);
  });
});
