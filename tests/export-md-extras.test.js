/* ============================================================
 * tests/export-md-extras.test.js — `export-md` 的**读向**补全（v3 条目层 + 两个标注字段）
 * 运行：npx vitest run tests/export-md-extras.test.js
 * ------------------------------------------------------------
 * ## 修的是什么（改前实测，不是推测）
 * `cli/commands/project.js` 的 `exportMd` 原先只把 `format` / `withDetail` / `withResources`
 * 三把开关交给 `markdown.treeToMarkdown`，而在它那 260 行函数体里 **`items` / `tags` /
 * `verified` / `localPath` 的出现次数都是 0** ⇒ 导出物丢掉的是"v3 之后加上的**一切**"：
 * 条目层正文、条目级出处与核验状态、节点级标签、本机目录。那不是"少两个字段"，
 * 是**它导出的 Markdown 已经不能代表现在的数据模型**。
 *
 * ## 定位（口径与 `cli/registry.js` 的 `export-md` desc 是同一段话，不在这里发明第二份）
 * `export-md` = **读向**（给编辑器 / 人 / AI 读）；**不保证** `export-md` → `import-md`
 * 往返等价（那是 `export-json` 的职责），也**不**为往返发明标记语法。
 *
 * ## 本文件钉住的判据（每条都能红；括号里是判据编号，与交付说明一致）
 *   A. **不误伤**（权重最高）：四样都没有的树 ⇒ 与改动前**逐字节相同**（`toBe` 整串比，
 *      不是 `toContain`）；`items: []` 的节点同样不多一个字节。
 *   B. **items[]**：展开成该节点下的 `1.` 有序子列表；顺序 = 数组顺序；`text` / `rich` /
 *      `qa` 三种条目各自可读；`<li>` 外壳不重复写列表标记（不出现 `1. - `）。
 *   C. **tags**：节点级 `#标签` 在**节点行**内联（heading 与 list 两种格式都是），
 *      条目级 `#标签` 在条目行尾括注里；空数组不产生标注。
 *   D. **verified**：`未核` **恒显**（缺失 = 未核）；`已核：<怎么核的>`；只有 `verified`
 *      没有 `how` 时是 `已核`（不编一个"怎么核的"）。
 *   E. **localPath**：路径**原文**出现 + 一句失效说明（它按契约是本机绝对路径 ⇒ 恒不在
 *      导出目录内）—— 断言的是"读者知道为什么打不开"，不是"有个字符串"。
 *   F. **可分辨**（本批最容易做假的地方）：同一个句子的两种来历 —— 走 `items` 与走 `detail`
 *      —— 在导出物里**必须结构不同**（`1.` vs `>`），且两种产物不相等。
 *      把 items 拼进 detail 后面就算"补上了"的话，这条断言必红。
 *   G. **`--with-detail` 的边界**：它只管 `detail`；四样**不受它控制**。有 `items` 的节点
 *      即使给了 `--with-detail` 也**不导** `detail`（它是 `renderDetail(items)` 的派生缓存）。
 *   H. **说明行**：有四样之一时出现在**第一行**且是 HTML 注释；四样都没有时**一个字节都不加**。
 *   I. **端到端**（命令层真的接上了）：在临时项目根上 `init` → `add` → `item-add` →
 *      `item-edit --verified` → `edit --tags --local-path` → `export-md` ⇒ 落盘的 md 里有
 *      B/C/D/E 四样的可见形态；且**真实 `projects/` 一个字节都不碰**（下面当场自证项目根）。
 *
 * ## 判别力证明（"去掉某一样 ⇒ 本文件必红"的四次注入）
 * 单测证明不了"注入后必红"（它测的是当前实现），所以四次注入放在
 * `.review/20261036-export-md/proof/inject-mutants.js`：它**逐条**把 `src/markdown.js` 里
 * items / tags / verified / localPath 的写出各改坏一次、跑本文件、再用原始字节还原。
 * 本文件里每一组都至少有一条**只对那一样敏感**的断言（例如 E 组断言里含"不在导出目录内"），
 * 注入脚本按组名报出哪一组红了 —— 四条各自单独一次，不做"同理"。
 * ============================================================ */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTmp, cleanupAll } from './_tmp-cleanup.js';

const require = createRequire(import.meta.url);

/* ---- ① 临时项目根（必须在 require cli/main.js **之前**设好）----
 * `cli/core.js` 的 `PROJECTS_DIR` 在模块加载时定型；设晚了夹具就会建进真实 `projects/`。 */
const SANDBOX = makeTmp('mm-em-extras-');
const OUTDIR = makeTmp('mm-em-extras-out-');
process.env.AI_MINDMAP_PROJECTS_DIR = SANDBOX;

const markdown = require('../src/markdown.js');
const { invokeSync } = require('../cli/main.js');
const core = require('../cli/core.js');

const { treeToMarkdown, EXPORT_LEGEND } = markdown;

/* 重定向必须**当场**生效，否则本文件后面所有断言都会在真仓上跑。宁可在这里响亮地红。 */
if (path.resolve(core.PROJECTS_DIR) !== path.resolve(SANDBOX)) {
  throw new Error('项目根重定向未生效：PROJECTS_DIR=' + core.PROJECTS_DIR + ' 期望=' + SANDBOX
    + ' —— 本测试拒绝运行，以免写进真实 projects/');
}

afterAll(() => { cleanupAll(); });

/* ============================================================================
 * A 组 · 不误伤：四样都没有 ⇒ 与改动前逐字节相同
 * 期望串是**改动前**的行为（`#`.repeat + 空格 + topic / `- ` / `>` 引用块 / 资源行），
 * 手写在下面、用 `toBe` 整串比对 —— 有人给普通节点多加一个空格都会红。
 * ========================================================================== */
const PLAIN = {
  id: 'root', topic: '根', children: [
    {
      id: 'a', topic: '甲', detail: '<p>甲详情</p>',
      images: [{ file: 'assets/x.png', caption: '示意图' }],
      children: [{ id: 'b', topic: '乙', children: [] }]
    }
  ]
};

describe('A · 四样都没有的树：与改动前逐字节相同', () => {
  it('heading + withDetail + withResources（整串逐字节）', () => {
    expect(treeToMarkdown(PLAIN, { format: 'heading', withDetail: true, withResources: true }))
      .toBe([
        '# 根',
        '## 甲',
        '> 甲详情',
        '![图：示意图](assets/x.png)',
        '### 乙'
      ].join('\n'));
  });

  it('list 格式（整串逐字节）', () => {
    expect(treeToMarkdown(PLAIN, { format: 'list' }))
      .toBe(['- 根', '  - 甲', '    - 乙'].join('\n'));
  });

  it('`items: []` 的节点不多一个字节（空数组不是"有内容"）', () => {
    const withEmpty = { id: 'root', topic: '根', children: [{ id: 'a', topic: '甲', items: [], children: [] }] };
    const without = { id: 'root', topic: '根', children: [{ id: 'a', topic: '甲', children: [] }] };
    expect(treeToMarkdown(withEmpty, { format: 'heading' }))
      .toBe(treeToMarkdown(without, { format: 'heading' }));
    expect(treeToMarkdown(withEmpty, { format: 'heading' })).not.toContain(EXPORT_LEGEND);
  });

  it('`tags: []` / 空串 localPath / 非对象 items 都不产生标注', () => {
    const t = {
      id: 'root', topic: '根', children: [
        { id: 'a', topic: '甲', tags: [], localPath: '', children: [] },
        { id: 'b', topic: '乙', items: '不是数组', tags: ['', '  '], children: [] }
      ]
    };
    expect(treeToMarkdown(t, { format: 'heading' })).toBe(['# 根', '## 甲', '## 乙'].join('\n'));
  });
});

/* ============================================================================
 * B 组 · items[] → 该节点下的 `1.` 有序子列表
 * ========================================================================== */
describe('B · items[] 展开成有序子列表', () => {
  const tree = {
    id: 'root', topic: '根', children: [
      {
        id: 'a', topic: '甲',
        items: [
          { id: 'i-1', type: 'text', html: '<li>第一件事</li>' },
          { id: 'i-2', type: 'text', html: '<li>第二件事</li>' }
        ],
        children: []
      }
    ]
  };

  it('条目行以 `1.` / `2.` 起头，且顺序 = 数组顺序', () => {
    const lines = treeToMarkdown(tree, { format: 'heading' }).split('\n');
    const itemLines = lines.filter((l) => /^\s*\d+\.\s/.test(l));
    expect(itemLines).toHaveLength(2);
    expect(itemLines[0]).toContain('1. 第一件事');
    expect(itemLines[1]).toContain('2. 第二件事');
  });

  it('`<li>` 外壳不重复写列表标记（不出现 `1. - `）', () => {
    const md = treeToMarkdown(tree, { format: 'heading' });
    expect(md).not.toContain('1. - ');
    expect(md).not.toContain('1. * ');
  });

  it('list 格式里条目比节点深一级，且用 `1.` 与子节点的 `-` 区分', () => {
    const t2 = {
      id: 'root', topic: '根', children: [
        { id: 'a', topic: '甲', items: [{ id: 'i-1', type: 'text', html: '<li>一条</li>' }], children: [
          { id: 'b', topic: '乙', children: [] }
        ] }
      ]
    };
    const lines = treeToMarkdown(t2, { format: 'list' }).split('\n');
    const item = lines.find((l) => l.indexOf('1. 一条') >= 0);
    const child = lines.find((l) => l.trim() === '- 乙');
    expect(item).toBe('    1. 一条（未核）');       // 节点 `- 甲` 缩进 2 ⇒ 条目 4
    expect(child).toBe('    - 乙');                 // 子节点与条目**同缩进**，靠标记区分
  });

  it('rich 条目（表格）：序号独占一行，表格原样缩进（不当成一行文本）', () => {
    const t = {
      id: 'root', topic: '根', children: [{
        id: 'a', topic: '甲', items: [{
          id: 'i-1', type: 'rich',
          html: '<table><tr><th>维度</th><th>电路</th></tr><tr><td>资源</td><td>独占</td></tr></table>'
        }], children: []
      }]
    };
    const lines = treeToMarkdown(t, { format: 'heading' }).split('\n');
    expect(lines).toContain('  1. （未核）');            // 序号 + 核验状态独占一行
    expect(lines).toContain('    | 维度 | 电路 |');
    expect(lines[lines.length - 1]).toContain('| 资源 | 独占 |');
  });

  it('qa 条目：问 / 答都看得见（正文由 `qa` 子对象承载，不是 `html`）', () => {
    const t = {
      id: 'root', topic: '根', children: [{
        id: 'a', topic: '甲',
        items: [{ id: 'i-1', type: 'qa', qa: { q: '为什么慢', a: '因为等锁', at: '2026-10-11T00:00:00.000Z' } }],
        children: []
      }]
    };
    const md = treeToMarkdown(t, { format: 'heading' });
    expect(md).toContain('1. 问：为什么慢 ｜ 答：因为等锁');
  });
});

/* ============================================================================
 * C 组 · tags → 行内标注（节点级在节点行、条目级在条目括注里）
 * ========================================================================== */
describe('C · tags 行内标注', () => {
  const tree = {
    id: 'root', topic: '根', tags: ['总览'], children: [
      {
        id: 'a', topic: '甲', tags: ['门禁', '检索'],
        items: [{ id: 'i-1', type: 'text', html: '<li>一条</li>', tags: ['要点'] }],
        children: []
      }
    ]
  };

  it('节点级 tags 挂在**节点行**（heading 格式）', () => {
    const lines = treeToMarkdown(tree, { format: 'heading' }).split('\n');
    expect(lines).toContain('# 根 ｜ `#总览`');
    expect(lines.find((l) => l.indexOf('## 甲') === 0)).toContain('`#门禁` `#检索`');
  });

  it('节点级 tags 挂在**节点行**（list 格式）', () => {
    expect(treeToMarkdown(tree, { format: 'list' })).toContain('- 根 ｜ `#总览`');
  });

  it('条目级 tags 在条目行的括注里（不另起一节）', () => {
    const lines = treeToMarkdown(tree, { format: 'heading' }).split('\n');
    const item = lines.find((l) => l.indexOf('1. 一条') >= 0);
    expect(item).toContain('（未核 · `#要点`）');
  });

  it('标签里的空白被压成一行（标签含空格时仍靠反引号界定）', () => {
    const md = treeToMarkdown({ id: 'r', topic: '根', tags: ['两个 词'], children: [] }, { format: 'heading' });
    expect(md).toContain('`#两个 词`');
  });
});

/* ============================================================================
 * D 组 · verified → 已核 / 未核（**未核也显示**）
 * ========================================================================== */
describe('D · verified 恒显（缺失 = 未核）', () => {
  const mk = (item) => ({
    id: 'root', topic: '根',
    children: [{ id: 'a', topic: '甲', items: [item], children: [] }]
  });

  it('没有 verified ⇒ 显式写「未核」（不是什么都不写）', () => {
    const md = treeToMarkdown(mk({ id: 'i-1', type: 'text', html: '<li>一条</li>' }), { format: 'heading' });
    expect(md).toContain('1. 一条（未核）');
  });

  it('有 verified ⇒ 「已核：<怎么核的>」', () => {
    const md = treeToMarkdown(mk({
      id: 'i-1', type: 'text', html: '<li>一条</li>',
      verified: { at: '2026-10-11T00:00:00.000Z', by: 'cli:item-edit', how: '读了源码行' }
    }), { format: 'heading' });
    expect(md).toContain('1. 一条（已核：读了源码行）');
  });

  it('有 verified 但没有 how ⇒ 只写「已核」，不编一个"怎么核的"', () => {
    const md = treeToMarkdown(mk({
      id: 'i-1', type: 'text', html: '<li>一条</li>',
      verified: { at: '2026-10-11T00:00:00.000Z', by: 'cli:item-edit' }
    }), { format: 'heading' });
    expect(md).toContain('（已核）');
    expect(md).not.toContain('已核：');
  });

  it('出处（`src`）在同一行括注里，数组用「、」连接', () => {
    const md = treeToMarkdown(mk({
      id: 'i-1', type: 'text', html: '<li>一条</li>', src: ['a.md:1-3', 'b.md:9']
    }), { format: 'heading' });
    expect(md).toContain('（未核 · 出处：a.md:1-3、b.md:9）');
  });
});

/* ============================================================================
 * E 组 · localPath → 路径原文 + **为什么打不开**
 * ========================================================================== */
describe('E · localPath 的失效说明', () => {
  it('路径原文出现，且明说它不在导出目录内', () => {
    const md = treeToMarkdown({
      id: 'root', topic: '根', localPath: 'E:\\markdown\\M1', children: []
    }, { format: 'heading' });
    expect(md).toContain('`E:\\markdown\\M1`');            // 原文可复制（没被改写成 URL）
    expect(md).toContain('本机绝对路径');
    expect(md).toContain('不在导出目录内');
    expect(md).not.toContain('file://');                   // 不假装可点（那会"点了没反应"却说不出为什么）
  });

  it('tags 与 localPath 同时存在 ⇒ 两段都在、用 `｜` 分隔', () => {
    const md = treeToMarkdown({
      id: 'root', topic: '根', tags: ['总览'], localPath: 'D:\\notes', children: []
    }, { format: 'heading' });
    const line = md.split('\n').find((l) => l.indexOf('# 根') === 0);
    expect(line).toBe('# 根 ｜ `#总览` ｜ 本机目录 `D:\\notes`（本机绝对路径，不在导出目录内 —— 换机器/换盘即失效，别人打不开）');
  });
});

/* ============================================================================
 * F 组 · 可分辨（本批最容易做假的地方）
 * 同一句话的两种来历：走 items 与走 detail。若实现把 items 拼进 detail 后面，
 * 两者在导出物里就会长得一样 —— 那一版必须在这一组红。
 * ========================================================================== */
describe('F · 条目与正文在导出物里可分辨', () => {
  const SENT = '闸门在写盘之前拦一次';
  const AS_ITEM = {
    id: 'root', topic: '根', children: [{
      id: 'a', topic: '甲',
      items: [{ id: 'i-1', type: 'text', html: '<li>' + SENT + '</li>', src: ['x.md:1'] }],
      children: []
    }]
  };
  const AS_DETAIL = {
    id: 'root', topic: '根', children: [{
      id: 'a', topic: '甲', detail: '<ul><li>' + SENT + '</li></ul>',
      children: []
    }]
  };

  it('条目是 `1.`（无引用块标记），正文是 `>`（无序号）', () => {
    const a = treeToMarkdown(AS_ITEM, { format: 'heading' });
    const b = treeToMarkdown(AS_DETAIL, { format: 'heading', withDetail: true });
    expect(a).toContain('1. ' + SENT);
    expect(a.split('\n').some((l) => l.trim().startsWith('> '))).toBe(false);
    expect(b).toContain('> - ' + SENT);
    expect(b.split('\n').some((l) => /^\s*\d+\.\s/.test(l))).toBe(false);
  });

  it('两种产物不相等；且条目那侧必有核验状态、正文那侧必没有', () => {
    const a = treeToMarkdown(AS_ITEM, { format: 'heading', withDetail: true });
    const b = treeToMarkdown(AS_DETAIL, { format: 'heading', withDetail: true });
    expect(a).not.toBe(b);
    expect(a).toContain('未核');
    expect(b).not.toContain('未核');
  });
});

/* ============================================================================
 * G 组 · `--with-detail` 的边界（四样不受它控制；有 items 时不导 detail）
 * ========================================================================== */
describe('G · `--with-detail` 只管 detail', () => {
  const tree = {
    id: 'root', topic: '根', tags: ['总览'], children: [{
      id: 'a', topic: '甲',
      detail: '<ul><li>条目一</li></ul>',
      items: [{ id: 'i-1', type: 'text', html: '<li>条目一</li>' }],
      children: []
    }]
  };

  it('不给 `--with-detail`：四样照旧全部导出（items / tags 一个都不少）', () => {
    const md = treeToMarkdown(tree, { format: 'heading' });
    expect(md).toContain('1. 条目一（未核）');
    expect(md).toContain('`#总览`');
  });

  it('给了 `--with-detail`：有 items 的节点**仍然**不导 detail（它是派生缓存）', () => {
    const md = treeToMarkdown(tree, { format: 'heading', withDetail: true });
    expect(md).not.toContain('> - 条目一');       // detail 没被写第二遍
    expect(md).toContain('1. 条目一（未核）');     // 内容仍在（来自 items）
  });

  it('没有 items 的节点：`--with-detail` 行为与改动前完全一致', () => {
    const t = { id: 'root', topic: '根', children: [{ id: 'a', topic: '甲', detail: '<p>甲详情</p>', children: [] }] };
    expect(treeToMarkdown(t, { format: 'heading' })).toBe(['# 根', '## 甲'].join('\n'));
    expect(treeToMarkdown(t, { format: 'heading', withDetail: true }))
      .toBe(['# 根', '## 甲', '> 甲详情'].join('\n'));
  });
});

/* ============================================================================
 * H 组 · 说明行（只在真有东西要解释时出现）
 * ========================================================================== */
describe('H · 说明行', () => {
  it('有四样之一 ⇒ 第一行就是它，且是 HTML 注释（渲染视图不占版面）', () => {
    const md = treeToMarkdown({ id: 'r', topic: '根', tags: ['总览'], children: [] }, { format: 'heading' });
    const first = md.split('\n')[0];
    expect(first).toBe(EXPORT_LEGEND);
    expect(first.startsWith('<!--')).toBe(true);
    expect(first.trim().endsWith('-->')).toBe(true);
  });

  it('四样都没有 ⇒ 一个字节都不加（同一棵树两种写法逐字节相等）', () => {
    const plain = { id: 'r', topic: '根', children: [] };
    expect(treeToMarkdown(plain, { format: 'heading' })).toBe('# 根');
    expect(treeToMarkdown(plain, { format: 'heading' })).not.toContain('export-md');
  });

  it('说明行里点明"不可回灌"（读者不该把它当备份）', () => {
    expect(EXPORT_LEGEND).toContain('不可回灌');
    expect(EXPORT_LEGEND).toContain('export-json');
  });
});

/* ============================================================================
 * I 组 · 端到端：命令层真的接上了（临时项目根，绝不碰真 projects/）
 * ========================================================================== */
describe('I · export-md 端到端（临时项目根）', () => {
  const PROJ = 'em-extras-probe';

  it('init → add → item-add → item-edit --verified → edit --tags/--local-path → export-md', () => {
    expect(invokeSync(['init', PROJ]).code).toBe(0);
    const add = invokeSync(['add', PROJ, 'root', '--topic', '甲节点', '--id', 'a1']);
    expect(add.code).toBe(0);

    const ia = invokeSync(['item-add', PROJ, 'a1', '--md', '条目一号', '--src', 'src/a.js:1-9']);
    expect(ia.code).toBe(0);
    const m = /(i-[a-z0-9-]+)/.exec(ia.stdout);
    expect(m).not.toBeNull();
    const itemId = m[1];

    expect(invokeSync(['item-edit', PROJ, 'a1', itemId, '--verified', '--how', '对着源码行核过']).code).toBe(0);
    expect(invokeSync(['edit', PROJ, 'a1', '--tags', '门禁,检索', '--local-path', 'E:\\notes\\M1']).code).toBe(0);

    const out = path.join(OUTDIR, PROJ);
    const r = invokeSync(['export-md', PROJ, out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('已导出文件夹');

    const md = fs.readFileSync(path.join(out, PROJ + '.md'), 'utf8');
    expect(md).toContain('`#门禁` `#检索`');                       // C
    expect(md).toContain('条目一号');                                // B
    expect(md).toContain('已核：对着源码行核过');                     // D
    expect(md).toContain('出处：src/a.js:1-9');                      // D（出处）
    expect(md).toContain('`E:\\notes\\M1`');                        // E
    expect(md).toContain('不在导出目录内');                           // E
    expect(md).toContain(EXPORT_LEGEND);                            // H
  });

  it('回显说清"这一档导了什么、没导什么"（不静默丢）', () => {
    const r = invokeSync(['export-md', PROJ, path.join(OUTDIR, PROJ + '-echo')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('读向口径');
    expect(r.stdout).toContain('本档**未导** detail');
  });

  it('`--format list` 也带四样（不是只有 heading 才有）', () => {
    const out = path.join(OUTDIR, PROJ + '-list');
    expect(invokeSync(['export-md', PROJ, out, '--format', 'list']).code).toBe(0);
    const md = fs.readFileSync(path.join(out, PROJ + '.md'), 'utf8');
    expect(md).toContain('1. 条目一号');
    expect(md).toContain('`#门禁`');
  });
});
