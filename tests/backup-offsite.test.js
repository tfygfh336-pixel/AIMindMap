/* ============================================================
 * tests/backup-offsite.test.js — 异地备份工具的**纯函数契约**（W22）
 * 运行：npx vitest run
 * ------------------------------------------------------------
 * 为什么需要它：
 *   `W22` 要回答的是「**哪个项目哪个节点变了**」。这句话在真实数据上只能靠
 *   "正好两次备份之间有别的会话改了笔记"来撞（本批撞到了：`卖点讨论` 的 `bl-3-5`
 *   与 `bl-3-5-1` 改了标题）。**撞到一次不算有保证** —— 这个判据若是坏的，
 *   它会在"没撞到变化"时安静地说"没有节点变化"，而那份安静看起来和
 *   "确实没变化"一模一样 ✗。所以把差异判定抽成纯函数，用合成数据把
 *   **新增 / 删除 / 改标题 / 无变化** 四种情形各钉一条断言。
 *
 * 另守两处**踩过的坑**（都真发生过，写在注释里防回退）：
 *   ① 项目 JSON 的树根是 `meta` / `format` / `data` / `assoc` —— 树在 **`data`** 上。
 *      第一版按 `doc.nodes` 数，读数 0 而**不报错**（0 个节点看起来像个正常读数）。
 *   ② 运行时信号的排除正则必须锚定 `(^|[\\/])` —— 相对路径的顶层点目录写作
 *      `.visits/x`（**前面没有分隔符**），不锚定就一个都排除不掉，而读数只少几个数。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const SRC = path.resolve(__dirname, '..');
const mod = require(path.join(SRC, 'scripts', 'backup-offsite.js'));

describe('nodeIndexOfProject —— 树根是 data，不是 nodes', () => {
  it('从 data 树里数出全部节点，并记下父子关系', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bk-'));
    const p = path.join(dir, 'proj.json');
    fs.writeFileSync(p, JSON.stringify({
      meta: { name: 'proj' },
      format: 'jsmind',
      data: {
        id: 'root', topic: '根',
        children: [
          { id: 'a', topic: 'A', children: [{ id: 'a1', topic: 'A1' }] },
          { id: 'b', topic: 'B' },
        ],
      },
      assoc: [],
    }), 'utf8');
    const idx = mod.nodeIndexOfProject(p);
    expect(Object.keys(idx).sort()).toEqual(['a', 'a1', 'b', 'root']);
    expect(idx.a1.p).toBe('a');
    expect(idx.a.p).toBe('root');
    expect(idx.root.p).toBe(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('**负对照**：把树放在 nodes 上必须读不到（这正是第一版的错，读数 0 不报错）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bk-'));
    const p = path.join(dir, 'proj.json');
    fs.writeFileSync(p, JSON.stringify({ meta: {}, nodes: { id: 'x', topic: 'X' } }), 'utf8');
    expect(mod.nodeIndexOfProject(p)).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('nodePath —— 祖先路径（"哪个节点"要说得出位置）', () => {
  it('从根到该节点拼路径', () => {
    const idx = { r: { t: '网络笔记', p: null }, c: { t: '课程', p: 'r' }, x: { t: 'M3', p: 'c' } };
    expect(mod.nodePath(idx, 'x')).toBe('网络笔记 / 课程 / M3');
  });
});

describe('diffNodeIndexes —— 「哪个项目哪个节点变了」', () => {
  const before = {
    comnet: {
      root: { t: '根', p: null },
      keep: { t: '不变的', p: 'root' },
      gone: { t: '将被删', p: 'root' },
      ren: { t: '旧标题', p: 'root' },
    },
    other: { r2: { t: '别的项目', p: null } },
  };
  const after = {
    comnet: {
      root: { t: '根', p: null },
      keep: { t: '不变的', p: 'root' },
      ren: { t: '新标题', p: 'root' },
      added: { t: '新增的', p: 'root' },
    },
    other: { r2: { t: '别的项目', p: null } },
  };

  it('逐类报出 新增 / 删除 / 改标题，并点名节点 id', () => {
    const d = mod.diffNodeIndexes(before, after);
    expect(d).toHaveLength(1);                    // 只有 comnet 变了；other 未被列出
    expect(d[0].project).toBe('comnet');
    expect(d[0].added.map((n) => n.id)).toEqual(['added']);
    expect(d[0].removed.map((n) => n.id)).toEqual(['gone']);
    expect(d[0].renamed.map((n) => n.id)).toEqual(['ren']);
    expect(d[0].renamed[0]).toMatchObject({ from: '旧标题', to: '新标题' });
    // 路径可供人定位
    expect(d[0].added[0].path).toBe('根 / 新增的');
  });

  it('**没有变化时必须是空数组**（不是"安静地什么都不说"的分支）', () => {
    expect(mod.diffNodeIndexes(before, before)).toEqual([]);
  });

  it('新增整个项目 / 删掉整个项目也要报', () => {
    const d = mod.diffNodeIndexes({}, { p: { r: { t: 'R', p: null } } });
    expect(d).toHaveLength(1);
    expect(d[0].project).toBe('p');
    expect(d[0].added).toHaveLength(1);
    const d2 = mod.diffNodeIndexes({ p: { r: { t: 'R', p: null } } }, {});
    expect(d2[0].removed).toHaveLength(1);
  });
});

describe('verifyManifest —— 判据是字节，不是"文件存在"', () => {
  it('块内容被改一个字节 ⇒ 必须判坏', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bk-'));
    const L = { blobs: path.join(dir, 'blobs') };
    const good = Buffer.from('hello-offsite', 'utf8');
    const sha = require('node:crypto').createHash('sha256').update(good).digest('hex');
    const bd = path.join(L.blobs, sha.slice(0, 2));
    fs.mkdirSync(bd, { recursive: true });
    fs.writeFileSync(path.join(bd, sha), good);

    const files = { 'projects/x.json': { sha256: sha, size: good.length, tier: 'notes' } };
    expect(mod.verifyManifest(L, files).ok).toBe(true);

    // 篡改一个字节
    const bad = Buffer.from('hello-offsitf', 'utf8');
    fs.writeFileSync(path.join(bd, sha), bad);
    const r = mod.verifyManifest(L, files);
    expect(r.ok).toBe(false);
    expect(r.bad).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('块缺失也判坏（不是跳过）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bk-'));
    const L = { blobs: path.join(dir, 'blobs') };
    const files = { 'projects/gone.json': { sha256: 'f'.repeat(64), size: 1, tier: 'notes' } };
    const r = mod.verifyManifest(L, files);
    expect(r.ok).toBe(false);
    expect(r.bad).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('onlyShas 过滤：只验这批块，其余计 skipped（复用的块不在每次备份里重读）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-bk-'));
    const L = { blobs: path.join(dir, 'blobs') };
    const crypto = require('node:crypto');
    const mk = (s) => {
      const buf = Buffer.from(s, 'utf8');
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const bd = path.join(L.blobs, sha.slice(0, 2));
      fs.mkdirSync(bd, { recursive: true });
      fs.writeFileSync(path.join(bd, sha), buf);
      return { sha256: sha, size: buf.length, tier: 'notes' };
    };
    const a = mk('A');
    const b = mk('B');
    const files = { 'a.txt': a, 'b.txt': b };
    const r = mod.verifyManifest(L, files, new Set([a.sha256]));
    expect(r.checked).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('接线：写盘出口必须是 src/data-store.js 的唯一原子写（S2 踩过）', () => {
  it('源码里不许出现自造的 fs.renameSync / fs.writeFileSync / fs.copyFileSync', () => {
    const src = fs.readFileSync(path.join(SRC, 'scripts', 'backup-offsite.js'), 'utf8');
    expect(src).toMatch(/writeFileAtomic/);                 // 用的是出口
    expect(src).not.toMatch(/fs\.renameSync\s*\(/);         // 不许自造第二份原子写
    expect(src).not.toMatch(/fs\.writeFileSync\s*\(/);      // 不许裸写
    expect(src).not.toMatch(/fs\.copyFileSync\s*\(/);       // 复制也要过出口
  });
});
