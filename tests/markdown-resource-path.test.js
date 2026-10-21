/* ============================================================
 * tests/markdown-resource-path.test.js —— `uniqueResourcePathBy` 的契约（G-15 下沉 · 2026-10-22）
 * ------------------------------------------------------------
 * 为什么这个文件存在：
 *   资源新名字的唯一性闸（撞名就重摇、连撞就响亮报错）**逻辑主体是纯计算**，但修前它和
 *   `fs.existsSync` 揉在同一个函数里 ⇒ 想测它就必须**先造文件系统**：
 *   `tests/import-refs.test.js` 的【批9】T1/T3 就是那个形状（造源目录 + 造 dest 目录 +
 *   写占位文件 + 钉 `Date.now`/`Math.random`）。
 *   下沉后：`uniqueResourcePathBy(taken, dir, ext, newName)` —— 喂**两个函数**就够：
 *   本文件 7 条里 **6 条一次盘都不碰**；只有最后那条"薄壳 == 纯核心 + fs.existsSync"的等价性
 *   证明用一次 `mkdtemp`（那一半本来就是盘，绕开它就是自欺）—— 条数可现场核。
 *
 * 三条纪律（照本工程既有测试的形状）：
 *   ① **既有断言一条没改**：`tests/import-refs.test.js` 的【批9】组原样保留、继续绿（那是端到端真值）；
 *      本文件只补"纯核心本身"的边界 —— 两者的判据**不是同一层**，不重复也不互相替代。
 *   ② **行为不变**：薄壳 `uniqueResourcePath` 的签名、返回值、报文、上界一个字都没动，
 *      本文件最后一条用"同一注入下薄壳 == 纯核心 + fs.existsSync"把它钉住。
 *   ③ **纯是可机械复查的**：最后一条读源码，断言纯核心的函数体里没有 `fs.`（`G-15` 的判据本身）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const markdown = require('../src/markdown.js');
const SRC = fileURLToPath(new URL('../src/markdown.js', import.meta.url));

/** 按顺序发名字的摇名器（撞名/重摇的次数在这一处可数） */
function seqNamer(names) {
  const queue = names.slice();
  let draws = 0;
  const fn = () => {
    draws += 1;
    return queue.length ? queue.shift() : names[names.length - 1];
  };
  fn.draws = () => draws;
  return fn;
}

describe('`uniqueResourcePathBy`：撞名重摇的纯核心（喂函数就够，不需要盘）', () => {
  it('不撞名 ⇒ **只摇一次**，返回值就是 `path.join(dir, 名字)`（命名形状一个字没动）', () => {
    const namer = seqNamer(['aa11.png']);
    const taken = () => false;
    const dest = markdown.uniqueResourcePathBy(taken, '/proj/assets', '.png', namer);
    expect(dest).toBe(path.join('/proj/assets', 'aa11.png'));
    expect(namer.draws(), '不撞名却多摇了 = 正常路径被改动').toBe(1);
  });

  it('★ 撞名 ⇒ 重摇：第一个被占的名字丢掉，收下第一个没被占的（撞几次就多摇几次）', () => {
    const P = (n) => path.join('/proj/assets', n);          // 与产品**同一个拼接口径**（Windows 上不是 '/'）
    const taken = new Set([P('a1.png'), P('a2.png')]);
    const namer = seqNamer(['a1.png', 'a2.png', 'a3.png']);
    const dest = markdown.uniqueResourcePathBy((p) => taken.has(p), '/proj/assets', '.png', namer);
    expect(dest).toBe(P('a3.png'));
    expect(namer.draws(), '两次撞名 ⇒ 共摇三次（不是"撞了就覆盖"）').toBe(3);
  });

  it('★ `taken` 看到的是**完整路径**（不是光名字）—— 判据在哪一层、入参就得是哪一层', () => {
    const seen = [];
    markdown.uniqueResourcePathBy((p) => { seen.push(p); return false; }, '/p/assets', '.png',
      seqNamer(['x.png']));
    expect(seen).toEqual([path.join('/p/assets', 'x.png')]);
    expect(path.isAbsolute(seen[0]), '交出去的是绝对/拼接后的路径（与产品侧同一条口径）').toBe(true);
  });

  it('★ 连撞到上界 ⇒ **响亮报错**（不是死循环、也不是"算了覆盖吧"），报文指回唯一的修法现场', () => {
    const namer = seqNamer(['stuck.png']);
    let err = null;
    try {
      markdown.uniqueResourcePathBy(() => true, '/p/assets', '.png', namer);
    } catch (e) { err = e; }
    expect(err, '名字永远撞不动 ⇒ 必须抛').toBeTruthy();
    expect(err.message).toContain('撞上盘上已存在的文件');
    expect(err.message, '报错要指回唯一的修法现场').toContain('newResourceName');
    // 上界 = RESOURCE_NAME_MAX_TRIES：初次 1 次 + 重摇 8 次 = 9 次摇名，然后抛（与修前逐次相同）
    expect(namer.draws()).toBe(markdown.RESOURCE_NAME_MAX_TRIES + 1);
  });

  it('不传 `newName` ⇒ 退回内置的 `newResourceName`（形状与生产同一个表达式）', () => {
    const dest = markdown.uniqueResourcePathBy(() => false, '/p/assets', '.png');
    expect(path.dirname(dest)).toBe(path.join('/p/assets'));
    expect(path.basename(dest)).toMatch(/^[0-9a-z]{5,}\.png$/);
  });

  it('★ 薄壳 == 纯核心 + `fs.existsSync`（同一注入条件下逐字节相同）—— 行为不变的机械证据', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-g15-res-'));
    const realNow = Date.now;
    const realRand = Math.random;
    /** 按序发随机数（第一次 = 撞上占位名，第二次 = 摇出一个新名）—— 两条路必须吃**同一串** */
    const pinSeq = (seq) => { let i = 0; return () => (i < seq.length ? seq[i++] : seq[seq.length - 1]); };
    try {
      Date.now = () => 1730000000000;
      const pinned = Date.now().toString(36) + (0.5).toString(36).slice(2, 6) + '.png';
      fs.writeFileSync(path.join(dir, pinned), 'occupied', 'utf8');
      Math.random = pinSeq([0.5, 0.7]);
      const shell = markdown.uniqueResourcePath(dir, '.png');
      Math.random = pinSeq([0.5, 0.7]);
      const core = markdown.uniqueResourcePathBy((p) => fs.existsSync(p), dir, '.png',
        markdown.newResourceName);
      expect(core, '薄壳必须只是"纯核心 + fs.existsSync"那一句').toBe(shell);
      expect(path.basename(shell)).not.toBe(pinned);
      expect(fs.readFileSync(path.join(dir, pinned), 'utf8'), '被占的文件一个字节都没改')
        .toBe('occupied');
    } finally {
      Date.now = realNow;
      Math.random = realRand;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('纯是可机械复查的：函数体里**没有 `fs.`**（G-15 的判据本身，不是"我觉得它纯"）', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const i = src.indexOf('function uniqueResourcePathBy(');
    expect(i, '纯核心不见了或被改名').toBeGreaterThan(0);
    // 取函数体（花括号配对；这条判据只扫这一小段，不扫全文）
    let depth = 0;
    let end = -1;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    expect(end).toBeGreaterThan(i);
    expect(src.slice(i, end)).not.toMatch(/\bfs\s*\./);
  });
});
