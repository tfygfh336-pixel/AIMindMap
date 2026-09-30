/* ============================================================
 * tests/control.test.js —— 界面控制通道（src/control.js）单测
 * ------------------------------------------------------------
 * 这个通道是"外部 AI / 内置 DSH 能不能指挥界面"的唯一途径，它的失效方式很不显眼：
 *   · 命令文件半截 / 坏 JSON ⇒ 必须当作"没有命令"，**不能**抛异常把轮询打断；
 *   · 回执丢了 ⇒ 调用方必须能判出"没生效"（CLI 靠 `readResult` 决定报不报错）。
 * 所以这两条是重点，其余是协议往返。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const control = require(path.resolve(__dirname, '..', 'src', 'control.js'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mm-control-test-'));

describe('界面控制通道', () => {
  it('往返：写命令 → 界面读得到 → 清掉后读不到', () => {
    const dir = tmp();
    expect(control.readCommand(dir)).toBe(null);
    control.writeCommand(dir, { cmd: 'dsh-only', on: true });
    expect(control.readCommand(dir)).toEqual({ cmd: 'dsh-only', on: true });
    control.clearCommand(dir);
    expect(control.readCommand(dir)).toBe(null);
  });

  it('坏 JSON / 半截文件一律当作"没有命令"（不能打断轮询）', () => {
    const dir = tmp();
    const p = control.paths(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p.cmd, '{ "cmd": "dsh-o', 'utf8');
    expect(control.readCommand(dir)).toBe(null);
    fs.writeFileSync(p.cmd, 'not json at all', 'utf8');
    expect(control.readCommand(dir)).toBe(null);
  });

  it('回执：写得出、读得回；没有回执时读到 null（调用方据此判"没生效"）', () => {
    const dir = tmp();
    expect(control.readResult(dir)).toBe(null);
    control.writeResult(dir, { cmd: 'dsh-only', ok: true, state: true });
    expect(control.readResult(dir).ok).toBe(true);
    expect(control.readResult(dir).state).toBe(true);
  });

  it('原子写：写完不留临时文件，且命令文件始终是完整 JSON', () => {
    const dir = tmp();
    control.writeCommand(dir, { cmd: 'dsh-only', on: false });
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.indexOf('.tmp') >= 0)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(control.paths(dir).cmd, 'utf8')).on).toBe(false);
  });
});
