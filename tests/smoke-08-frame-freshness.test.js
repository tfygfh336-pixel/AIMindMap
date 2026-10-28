/* ============================================================
 * tests/smoke-08-frame-freshness.test.js —— 「取证时刻」那条修复的**形状锁**
 * 运行：npx vitest run tests/smoke-08-frame-freshness.test.js
 * ------------------------------------------------------------
 * 锁的是 `scripts/smoke/08-audit-palette.js` 里那条断言
 * 「关系审计面板：可关闭（关闭后不再遮挡界面 · elementFromPoint 不再命中面板 + 真帧变亮）」。
 *
 * 为什么需要它（三个真实的失效方向，都不是假想）：
 *   ① **把判据改成永远绿**：这条断言 2026-10-30 全链红过一次，真因是"取证太早"（取到旧帧）。
 *      最诱人的误修法有三个 —— 放宽阈值、删掉"变亮"那一档、改成只判 `display`。
 *      前两个 `V1` 门禁抓得住（名字里有"遮挡"⇒ 必须有真判据），**第三个抓不住**
 *      （射`elementFromPoint` 还在，V1 照样绿）⇒ 只能在这里锁住"像素那一档必须还在，且仍吃单源阈值"。
 *   ② **重取变成"重取到判据通过为止"**：那样"面板真的不关"也可能被某次运气拍绿。
 *      正确口径是**只重取到帧变了**（取证），判据另算 —— 这条用一段结构切片锁死。
 *   ③ **上界被拿掉**：无限等会把"面板不关"从红变成挂死（守卫超时，读数全丢）。
 *
 * 边界（诚实标注）：这些是**源码级**判据 —— 它们证明"形状没被改坏"，
 * 证明不了"跑起来一定绿"。行为侧的判据在冒烟里（真跑）：
 *   · 正常关面板 ⇒ `第 N 次取帧` + 变亮 ≥20 ⇒ 绿（连跑 5 次全绿）；
 *   · `MM_SMOKE_INJECT=08-keep-open`（面板不关）⇒ 红，报文点名"命中测试 + 变亮"；
 *   · `MM_SMOKE_INJECT=08-stale-frame`（第一次取帧拿到旧帧）⇒ 第 2 次取帧才变 ⇒ 仍绿。
 * 读数见 `.review/20261030-取帧时序/README.md`。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'scripts', 'smoke', '08-audit-palette.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

/** 断言名（V1 的欠账册按名字对账，改名会让在册条目变成"悬挂欠账"⇒ 判红） */
const NAME = '关系审计面板：可关闭（关闭后不再遮挡界面 · elementFromPoint 不再命中面板 + 真帧变亮）';

/** 判据体：从这条断言的 `run:` 到它自己的 `};` 收尾（到下一个 `name:` 为止的前一段） */
function assertionBody(text) {
  const at = text.indexOf("name: '" + NAME + "'");
  if (at < 0) return '';
  const next = text.indexOf("name: '", at + NAME.length + 10);
  return text.slice(at, next < 0 ? text.length : next);
}
const body = assertionBody(src);

describe('域 08 · 关系审计面板可关闭：判据的形状没被放宽（三个误修法逐个锁住）', () => {
  it('断言还在、名字一字未改（V1 的账按名字对）', () => {
    expect(body.length).toBeGreaterThan(500);
    expect(src).toContain("name: '" + NAME + "'");
  });

  it('误修法①：阈值**只能**来自单源 thresholds（不许内联数字、不许放宽）', () => {
    expect(body).toContain('VTH.paint.minOverlayBrighten');
    expect(body).toContain('brighten >= minBrighten');
    // 内联一个更小的数字（`brighten >= 5` / `>= 0` 之类）会被这一条抓住
    expect(body).not.toMatch(/brighten\s*>=\s*\d/);
  });

  it('误修法②：改成"只判 display" ⇒ 必须红（命中测试与像素两档都得在，且都进 ok）', () => {
    expect(body).toContain('elementFromPoint');
    expect(body).toContain('frameStats.analyzeRegion');
    expect(body).toContain('const pixOk = brighten >= minBrighten;');
    expect(body).toContain('const hitOk =');
    expect(body).toContain('ok: hitOk && pixOk');
  });

  it('误修法③：重取**不是**"重取到判据通过为止"（停下来的条件是帧变了，不是变亮了）', () => {
    const from = src.indexOf('for (let i = 1; i <= MAX_FRAME_TRIES; i++) {');
    expect(from).toBeGreaterThan(0);
    const to = src.indexOf('const brighten = ', from);
    expect(to).toBeGreaterThan(from);
    const loop = src.slice(from, to);
    // 循环里只许出现"同一帧"判据（SAME_FRAME_EPS），不许掺进判定阈值
    expect(loop).toContain('SAME_FRAME_EPS');
    expect(loop).not.toContain('minBrighten');
    expect(loop).not.toContain('pixOk');
    // 变了就 break（而不是任其跑满）
    expect(loop).toMatch(/frameChanged = true; break;/);
  });

  it('误修法④：重取必须**有上界**（无限等会把"面板不关"从红变成挂死）', () => {
    expect(src).toMatch(/const MAX_FRAME_TRIES = (\d+);/);
    const n = Number(/const MAX_FRAME_TRIES = (\d+);/.exec(src)[1]);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(20);            // 上界是"有限次"，不是"很多次"
    expect(src).toContain('for (let i = 1; i <= MAX_FRAME_TRIES; i++)');
    // 每轮之间要"等重绘"（不是忙等）：走 `scripts/smoke/_wait.js` 的 frames（= 2 个真帧 + 一拍，与旧
    // `ctx.input.settle(FRAME_TICK)` **同语义**，只是把"等被节流的帧时钟"换成"截图逼帧"）。
    // 口径见 `_wait.js` 头部：227 处 settle 已全量替换，只剩 6 处"判据依赖真实墙钟"的名单，
    // 域 08 不属名单（它的 220ms 是"等重绘"而不是"等一个真实墙钟窗口"）。
    expect(src).toMatch(/const FRAME_TICK = \{ delayMs: \d+ \};/);
    expect(src).toMatch(/(?:wait|WAIT)\.frames\(ctx, FRAME_TICK\)/);
  });

  it('报文里必须出现「第 N 次取帧」并**点名是哪一项没过**（同帧到上界也要能看出来）', () => {
    expect(body).toContain("' ｜ 取证：第 ' + frameTry + ' 次取帧'");
    expect(body).toContain("' ｜ 判定：' + verdictText");
    expect(body).toContain("'命中测试'");
    expect(body).toContain("'变亮'");
    expect(body).toContain('**仍是关前那一帧**');   // 到上界仍同帧 ⇒ 报文如实说"拍到的还是旧帧"
  });

  it('判别力证明的两个注入口都还在（否则"这条判据会红"就没法重放）', () => {
    expect(body).toContain("MY_KEY('keep-open')");     // 面板真的不关 ⇒ 必红
    expect(body).toContain("MY_KEY('stale-frame')");   // 第一次取帧拿到旧帧 ⇒ 重取后仍绿
    expect(body).toContain('var doClose = ');          // 注入点：关闭变成一个空操作
  });
});
