/* ============================================================
 * tests/export-html.test.js — 静态站点导出纯逻辑单元测试（vitest）
 * ------------------------------------------------------------
 * export-html 生成的是**要交给别人打开的文件**，因此比内部代码更需要锁住：
 *   1) 注入：正文含 </script> 时不得提前闭合数据标签（否则整页破坏）
 *   2) 内嵌页面脚本必须语法可编译（否则导出的站点是白屏）
 *   3) detail 原样内联（这是**有意的**设计，测试把它固定下来，防止有人误加"消毒"）
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import exportHtml from '../src/export-html.js';

const { buildIndexHtml, buildModel, collectAssets, safeJson, esc, searchKeep } = exportHtml;

function proj(over) {
  const root = {
    id: 'root', topic: '根主题', detail: '<p>根的内容</p>', tags: ['总'],
    children: [
      {
        id: 'n1', topic: '子节点一', detail: '<p>提到 <b>孙节点</b></p>',
        tags: ['网络', '核心'],
        images: [{ file: 'assets/a.png', caption: '图A', source: 'RFC' }],
        files: [{ file: 'attachments/x.md', caption: '附件X' }],
        links: [{ project: 'p', id: 'n2', caption: 'n1→n2' }],
        children: [{ id: 'n1a', topic: '孙节点', children: [] }]
      },
      { id: 'n2', topic: '子节点二', children: [] }
    ]
  };
  return Object.assign({ meta: { name: '我的笔记', author: '作者', version: '0.15.0' }, format: 'node_tree', data: root }, over || {});
}

/** 从产物里取出内嵌 JSON（模拟浏览器读取 data 标签） */
function extractModel(html) {
  const m = /<script id="mm-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}
/** 取出最后一段内嵌脚本（页面逻辑） */
function extractAppJs(html) {
  const all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return all.length ? all[all.length - 1][1] : null;
}

describe('export-html.esc / safeJson', () => {
  it('esc 转义五个 HTML 敏感字符', () => {
    expect(esc('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('safeJson 把 < > & 与 U+2028/2029 转成 \\u 转义', () => {
    const s = safeJson({ a: '</script>', b: '&', c: '\u2028\u2029' });
    expect(s).not.toContain('</script>');
    expect(s).toContain('\\u003c');
    expect(s).toContain('\\u003e');
    expect(s).toContain('\\u0026');
    expect(s).toContain('\\u2028');
    expect(s).toContain('\\u2029');
    // 仍然是合法 JSON，且解回来与原文一致
    expect(JSON.parse(s)).toEqual({ a: '</script>', b: '&', c: '\u2028\u2029' });
  });

  it('safeJson 对无法序列化的输入不抛错（公开 API 的空值防御）', () => {
    // JSON.stringify(undefined) === undefined，旧实现随后 .replace 会抛 TypeError
    expect(() => safeJson(undefined)).not.toThrow();
    expect(safeJson(undefined)).toBe('null');
    expect(JSON.parse(safeJson(undefined))).toBeNull();
    expect(safeJson(() => {})).toBe('null');   // 函数同样无法序列化
  });

  it('buildIndexHtml 对 null/空对象不抛错（产出可打开的空页）', () => {
    expect(() => buildIndexHtml(null, { projectName: 'x' })).not.toThrow();
    expect(() => buildIndexHtml(undefined, { projectName: 'x' })).not.toThrow();
    const html = buildIndexHtml({}, { projectName: 'x' });
    expect(html).toContain('<!doctype html>');
    expect(extractModel(html).nodes.length).toBeGreaterThanOrEqual(1);
  });
});

describe('export-html.buildModel', () => {
  it('扁平化节点并补齐 parent / children', () => {
    const m = buildModel(proj(), { projectName: 'p' });
    expect(m.nodes.map((n) => n.id)).toEqual(['root', 'n1', 'n1a', 'n2']);
    const byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
    expect(byId.n1.parent).toBe('root');
    expect(byId.n1a.parent).toBe('n1');
    expect(byId.root.parent).toBeNull();
    expect(byId.n1.children).toEqual(['n1a']);
    expect(byId.n1.depth).toBe(1);
  });

  it('带上标题/作者/版本（供页头展示）', () => {
    const m = buildModel(proj(), { projectName: 'p' });
    expect(m.title).toBe('我的笔记');
    expect(m.author).toBe('作者');
    expect(m.version).toBe('0.15.0');
  });

  it('计算「相关知识点」（出边 + 入边），方向正确', () => {
    const m = buildModel(proj(), { projectName: 'p' });
    const byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
    // n2 被 n1 引用 → 入边
    const n2 = byId.n2.related.find((r) => r.id === 'n1');
    expect(n2).toMatchObject({ dir: 'in', caption: 'n1→n2' });
    // n1 的出边
    expect(byId.n1.related.find((r) => r.id === 'n2')).toMatchObject({ dir: 'out' });
  });

  it('保留图片/附件的 caption 与 source', () => {
    const m = buildModel(proj(), { projectName: 'p' });
    const n1 = m.nodes.find((n) => n.id === 'n1');
    expect(n1.images[0]).toEqual({ file: 'assets/a.png', caption: '图A', source: 'RFC' });
    expect(n1.files[0]).toEqual({ file: 'attachments/x.md', caption: '附件X', source: '' });
  });

  it('缺 meta 的极端输入不抛异常', () => {
    const m = buildModel({ data: { id: 'r', topic: 't' } }, { projectName: 'x' });
    expect(m.title).toBe('x');
    expect(m.nodes).toHaveLength(1);
  });
});

describe('export-html.collectAssets', () => {
  it('收集并去重图片与附件相对路径', () => {
    const d = proj();
    d.data.children[1].images = [{ file: 'assets/a.png' }];   // 与 n1 重复
    expect(collectAssets(d)).toEqual(['assets/a.png', 'attachments/x.md']);
  });

  it('无资源的项目返回空数组', () => {
    expect(collectAssets({ data: { id: 'r', topic: 't' } })).toEqual([]);
  });
});

describe('export-html.buildIndexHtml', () => {
  it('产出完整 HTML 文档（doctype / 标题 / 数据 / 脚本）', () => {
    const html = buildIndexHtml(proj(), { projectName: 'p' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>我的笔记</title>');
    expect(html).toContain('charset="utf-8"');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('内嵌的数据 JSON 可被解析回模型（浏览器就是这样读的）', () => {
    const html = buildIndexHtml(proj(), { projectName: 'p' });
    const m = extractModel(html);
    expect(m).not.toBeNull();
    expect(m.nodes.map((n) => n.id)).toEqual(['root', 'n1', 'n1a', 'n2']);
    expect(m.title).toBe('我的笔记');
  });

  it('注入防护：正文含 </script> 时不会提前闭合数据标签', () => {
    const d = proj();
    const evil = '</script><script>window.PWNED=1</script>';
    d.data.children[0].detail = '<p>' + evil + '</p>';
    const html = buildIndexHtml(d, { projectName: 'p' });
    // 整份文档只应有 3 个 </script>（数据 + 解析 + 页面脚本），注入未新增
    expect((html.match(/<\/script>/g) || []).length).toBe(3);
    // 关键不变量：**数据块内部不得出现任何裸的 script 标签**。
    // （注意：`window.PWNED` 这几个字仍会出现在 JSON 字符串里 —— 那是无害的文本，
    //   真正会出事的是未转义的 `<`，所以断言要针对标签、而不是针对那串字母。）
    const dataBlock = /<script id="mm-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
    expect(dataBlock).not.toContain('<script');
    expect(dataBlock).not.toContain('</script');
    // 而 detail 本身必须原样保留（不能因为转义而丢字）
    const m = extractModel(html);
    expect(m.nodes.find((n) => n.id === 'n1').detail).toBe('<p>' + evil + '</p>');
  });

  it('内嵌页面脚本语法可编译（否则导出的站点会白屏）', () => {
    const html = buildIndexHtml(proj(), { projectName: 'p' });
    const js = extractAppJs(html);
    expect(js).toBeTruthy();
    // 只编译、不执行 —— 用来抓语法错误
    expect(() => new Function(js)).not.toThrow();
  });

  it('解析脚本与数据标签配对（顺序正确）', () => {
    const html = buildIndexHtml(proj(), { projectName: 'p' });
    expect(html).toContain('window.__MM__=JSON.parse(document.getElementById("mm-data").textContent);');
    expect(html.indexOf('id="mm-data"')).toBeLessThan(html.indexOf('window.__MM__='));
  });

  it('detail 是**原样内联**（这是有意设计，不是漏了消毒）', () => {
    const d = proj();
    d.data.children[0].detail = '<p>带 <em>标签</em> 的正文</p>';
    const html = buildIndexHtml(d, { projectName: 'p' });
    const m = extractModel(html);
    expect(m.nodes.find((n) => n.id === 'n1').detail).toBe('<p>带 <em>标签</em> 的正文</p>');
  });

  it('页头与页脚含节点数（分享出去有基本信息）', () => {
    const html = buildIndexHtml(proj(), { projectName: 'p' });
    expect(html).toContain('4 个节点');
    expect(html).toContain('由 AI MindMap 静态导出');
  });

  it('空项目（仅根）也能生成，不抛异常', () => {
    const html = buildIndexHtml({ meta: { name: '空' }, data: { id: 'root', topic: '只有根' } }, { projectName: 'e' });
    expect(html).toContain('<title>空</title>');
    expect(extractModel(html).nodes).toHaveLength(1);
  });

  it('带 CSP：阻断远程加载与网络回传，但保留内联脚本/样式与本地图片', () => {
    const html = buildIndexHtml(proj(), { projectName: 'p' });
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    const csp = m[1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");     // 阻断回传
    expect(csp).toContain("img-src 'self' data:");   // 本地图片仍可显示（别写死了导致图挂掉）
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(exportHtml.CSP).toBe(csp);
  });
});

/* —— 站点搜索的保留集 ——
 * 这里锁住一个**曾经的真实缺陷**：原先只按"自身是否命中"隐藏条目，
 * 而条目是嵌套 <li>，祖先被 display:none 后整棵子树（含真正命中的深层节点）一起消失，
 * 于是搜索看起来"什么都搜不到"。comnet 上搜「交换机」的 6 个命中项全在非顶层，
 * 全部被各自的祖先藏掉。 */
describe('export-html.searchKeep（站点搜索保留集）', () => {
  /** 三层树：根 → 第6章 → 交换机/以太网；另有一条不相关的分支 */
  const model = () => ({
    nodes: [
      { id: 'root', topic: '网络笔记', parent: null, detail: '', tags: [] },
      { id: 'ch6', topic: '6. 链路层和局域网', parent: 'root', detail: '', tags: [] },
      { id: 'switch', topic: '交换机', parent: 'ch6', detail: '', tags: [] },
      { id: 'ether', topic: '以太网与 CSMA/CD', parent: 'ch6', detail: '<p>交换机组网</p>', tags: ['链路'] },
      { id: 'ch8', topic: '8. 网络安全', parent: 'root', detail: '', tags: [] },
      { id: 'fw', topic: '防火墙', parent: 'ch8', detail: '', tags: [] }
    ]
  });

  it('后代命中时**祖先必须一起保留**（否则子树被 display:none 藏掉）', () => {
    const keep = searchKeep(model(), '交换机');
    expect(keep.switch).toBe(true);
    expect(keep.ch6).toBe(true);      // 祖先自身不含关键词，但必须保留
    expect(keep.root).toBe(true);     // 更上层同理
  });

  it('命中项的完整祖先链都被保留（端到端可见性）', () => {
    const m = model();
    const keep = searchKeep(m, '交换机');
    const chainVisible = (id) => {
      let x = m.nodes.find((n) => n.id === id);
      while (x) { if (!keep[x.id]) return false; x = x.parent ? m.nodes.find((n) => n.id === x.parent) : null; }
      return true;
    };
    expect(chainVisible('switch')).toBe(true);   // 自身命中
    expect(chainVisible('ether')).toBe(true);    // 经 detail 命中
  });

  it('不相关的分支被隐藏', () => {
    const keep = searchKeep(model(), '交换机');
    expect(keep.fw).toBe(false);
    expect(keep.ch8).toBe(false);
  });

  it('匹配 detail 正文与标签', () => {
    expect(searchKeep(model(), 'CSMA').ether).toBe(true);
    expect(searchKeep(model(), '链路').ether).toBe(true);
  });

  it('空查询保留全部（清空搜索框就恢复完整树）', () => {
    const m = model();
    const keep = searchKeep(m, '');
    expect(m.nodes.every((n) => keep[n.id] === true)).toBe(true);
    expect(searchKeep(m, '   ').root).toBe(true);
  });

  it('无命中时全部隐藏', () => {
    const m = model();
    const keep = searchKeep(m, '绝不可能存在的词');
    expect(m.nodes.every((n) => keep[n.id] === false)).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(searchKeep(model(), 'csma').ether).toBe(true);
    expect(searchKeep(model(), 'CSMA').ether).toBe(true);
  });

  it('parent 指向缺失节点的孤儿也会被标记（否则会凭空消失）', () => {
    const m = { nodes: [{ id: 'x', topic: '孤立', parent: 'no-such-parent', detail: '', tags: [] }] };
    const keep = searchKeep(m, '孤立');
    expect(keep.x).toBe(true);
  });

  it('空模型安全', () => {
    expect(searchKeep({ nodes: [] }, 'abc')).toEqual({});
    expect(() => searchKeep({ nodes: [] }, null)).not.toThrow();
  });

  it('页面注入的是**同一份实现**（源码逐字一致，不存在两份漂移）', () => {
    const html = buildIndexHtml(proj(), { projectName: 'p' });
    expect(html).toContain('var searchKeep=' + searchKeep.toString() + ';');
  });
});

/* —— 导出站点的链接目标判定与 id 转义 —— */
describe('export-html 跨项目链接与 id 转义', () => {
  it('回归：跨项目链接目标 id 与本地 id 撞车时，不得误指向本地节点', () => {
    // 缺陷：页面判据只看 byId[r.id]（不看 r.project），于是"别的项目里叫 overview
    // 的节点"被渲染成指向**本站点** overview 的链接，还丢掉了 [project] 标注。
    const d = {
      meta: { name: '本站' },
      data: { id: 'root', topic: '根', children: [
        { id: 'overview', topic: '【本项目】总览', children: [] },
        { id: 'a', topic: '甲', links: [{ project: 'other', id: 'overview', caption: '外链' }], children: [] }
      ] }
    };
    const html = buildIndexHtml(d, { projectName: '本站' });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const app = scripts[scripts.length - 1];
    // 判据必须同时校验 project
    expect(app).toContain('r.project===M.project');
    expect(app).not.toMatch(/byId\[r\.id\]\?/);
    // 模型里外链项仍带 project，供页面判断
    const model = buildModel(d, { projectName: '本站' });
    const rel = model.nodes.find((n) => n.id === 'a').related;
    expect(rel[0]).toMatchObject({ id: 'overview', project: 'other' });
  });

  it('回归：恶意 node id 被转义（不注入、不破坏选择器）', () => {
    const evil = 'x"><img src=x onerror=alert(1)>';
    const d = { meta: { name: 't' }, data: { id: 'root', topic: '根', children: [{ id: evil, topic: '恶意', children: [] }] } };
    const html = buildIndexHtml(d, { projectName: 't' });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const app = scripts[scripts.length - 1];
    // 页面脚本仍可编译，且 id 一律走 esc()
    expect(() => new Function(app)).not.toThrow();
    expect(app).toContain('esc(n.id)');
    // 不再用插值 id 构造选择器（那会抛 DOMException，也是注入面）
    expect(app).not.toMatch(/querySelector\('a\[data-id="'\+n\.id/);
    // 数据块内无裸标签，且 id 往返保真（数据不因转义丢失）
    const dm = /<script id="mm-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    expect(dm[1]).not.toContain('<img');
    expect(JSON.parse(dm[1]).nodes.some((n) => n.id === evil)).toBe(true);
  });
});
