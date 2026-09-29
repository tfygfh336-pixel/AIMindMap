/* ============================================================
 * cli/commands/project.js — 项目与数据命令
 * ------------------------------------------------------------
 * 本文件只做三件事：读参数、调 src/ 的纯逻辑、输出。
 * 视图构造 / 搜索 / 统计 / 打包格式解析都已下沉：
 *   src/query.js   —— read 视图、list、get、search、stats（AI 看到什么）
 *   src/bundle.js  —— aimap v1 打包格式的组装、解析与路径安全校验
 * 这样命令层不再藏"只有端到端才能测到"的逻辑（见 tests/query.test.js、tests/bundle.test.js）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const markdown = require('../../src/markdown.js');
const tree = require('../../src/tree-utils.js');    // 树遍历单源（本文件不再自写 walk）
const query = require('../../src/query.js');       // 视图/搜索/统计纯逻辑
const bundle = require('../../src/bundle.js');     // aimap 打包格式纯逻辑
const exportHtml = require('../../src/export-html.js');   // 静态站点 HTML 生成纯逻辑
const MMConfig = require('../../src/config.js');   // 版本号单源（APP_VERSION）

/** 树形打印（缩进由 src/query.js 的 treeLines 生成） */
function printTree(ctx, root) {
  query.treeLines(root).forEach((line) => ctx.out(line));
}

/** 可读视图：实现已下沉到 src/query.js（buildReadView） */
function buildReadView(data, opts) {
  return query.buildReadView(data, opts);
}

module.exports = {
  projects(ctx) {
    const list = ctx.store.list();
    if (ctx.args.json) { ctx.outJson(list); return; }
    list.forEach((p) => ctx.out(p.name + (p.meta && p.meta.name ? '  （' + p.meta.name + '）' : '')));
  },

  read(ctx) {
    const { data } = ctx.read();
    const js = !!ctx.args.json;

    // ---- 文本模式的静默陷阱：以前 --detail / --images 被**无声丢弃** ----
    // 文本模式只输出结构树，它给不出详情与资源清单。静默忽略的后果不是"少给了点东西"，
    // 而是让人得出**错误的结论**：「这个项目没有详情」。所以这里明确报错并给出替代路径。
    // （`--brief` 不在此列：文本模式本来就是结构视图，它没有做出任何给不出的承诺。）
    if (!js) {
      const phantom = [];
      if (ctx.args.detail !== undefined) phantom.push('--detail');
      if (ctx.args.images !== undefined) phantom.push('--images');
      if (phantom.length) {
        ctx.error(phantom.join(' / ') + ' 只在 --json 视图里有效；文本模式只输出结构树。'
          + '要详情：read ' + ctx.projectName + ' --json（--json 默认就含详情，无需 --detail）｜'
          + '要结构：read ' + ctx.projectName + ' --json --brief｜'
          + '要最省：read ' + ctx.projectName + ' --json --brief --compact');
      }
    }

    // ---- --subtree <id>：只读某一棵子树（定位到分支后的定点作业）----
    // 实测收益：全项目 --json 149 KB，而某棵大子树只要 24 KB（--brief --compact）⇒ 约 −84%。
    if (ctx.args.subtree === true) {
      ctx.error('--subtree 需要一个节点 id：read <项目> --subtree <id>');
    }
    const subId = ctx.args.subtree === undefined ? null : String(ctx.args.subtree);
    let view = data;
    if (subId !== null) {
      const node = tree.find(data.data, subId);
      if (!node) ctx.error('--subtree 指向的节点不存在: ' + subId);
      // 子树当成根来建视图：buildReadView 的 depth 从 0 起，于是子树内部层级自洽
      view = { meta: data.meta, data: node };
    }

    if (js) {
      ctx.outJson(buildReadView(view, ctx.args));
      return;
    }
    ctx.out('# ' + (data.meta.name || ctx.projectName) + (subId !== null ? '  ▸ ' + subId : ''));
    printTree(ctx, view.data);
  },

  list(ctx) {
    const { data } = ctx.read();
    if (ctx.args.json) {
      ctx.outJson({ project: ctx.projectName, nodes: query.buildNodeList(data.data) });
      return;
    }
    printTree(ctx, data.data);
  },

  get(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('缺少节点 id');
    const { data } = ctx.read();               // 只读一次，保证 path 与 node 同一快照
    // path 由 tree-utils.pathTo 计算（曾内联手写 DFS 且缺回溯 pop，
    // 导致返回「DFS 访问过的全部节点」——查 s-3-1 会得到 27 项而非 4 项）
    const out = query.getNodeView(data.data, id, ctx.args);
    if (!out) ctx.error('节点不存在: ' + id);
    if (ctx.args.json) ctx.outJson(out);
    else ctx.out(JSON.stringify(out, null, 2));
  },

  search(ctx) {
    const kw = ctx.args._[1];
    const tag = ctx.args.tag;
    if (!kw && !tag) ctx.error('缺少关键词（或用 --tag 按标签搜索）');
    const { hits } = query.searchNodes(ctx.root, { keyword: kw, tag, full: !!ctx.args.full });
    if (ctx.args.json) ctx.outJson({ keyword: kw, tag, hits });
    else hits.forEach((h) => ctx.out(h.id + '  ' + h.topic + (h.matchIn && h.matchIn !== 'topic' ? '  [' + h.matchIn + ']' : '') + (h.snippet ? '  …' + h.snippet + '…' : '')));
  },

  stats(ctx) {
    const { data } = ctx.read();
    // files / tags 此前缺失，导致 AI 用 stats 判断"该项目有没有附件/标签"时永远得到 0。
    const s = Object.assign({ project: ctx.projectName }, query.computeStats(data.data));
    if (ctx.args.json) ctx.outJson(s);
    else Object.keys(s).forEach((k) => ctx.out(k + ': ' + s[k]));
  },

  init(ctx) {
    const name = ctx.projectName;
    if (!name) ctx.error('缺少项目名');
    if (fs.existsSync(path.join(ctx.PROJECTS_DIR, name, name + '.json'))) ctx.error('项目已存在: ' + name);
    const title = ctx.args.title || name;
    const data = {
      // 版本号单源：src/config.js 的 APP_VERSION（历史上此处硬编码 '0.13.0'）
      meta: { name: title, author: '', version: MMConfig.APP_VERSION, formatVersion: 2 },
      format: 'node_tree',
      data: { id: 'root', topic: title, expanded: true, children: [] }
    };
    ctx.write(data);
    ctx.out('已创建项目: ' + name);
  },

  importMd(ctx) {
    const file = ctx.args._[1];
    if (!file) ctx.error('缺少 Markdown 文件路径');
    if (!fs.existsSync(file)) ctx.error('文件不存在: ' + file);
    const md = fs.readFileSync(file, 'utf8');
    const parent = ctx.args.parent || 'root';
    // 预读一次：让"父节点不存在"这条错误**先于**转换与写入报出来（保持原有报错顺序）
    const pre = ctx.read();
    if (!ctx.tree.find(pre.data.data, parent)) ctx.error('父节点不存在: ' + parent);
    // **转换只做一次**并捕获进闭包：fn 里禁止 I/O，且并发重放不该重新生成一遍节点 id。
    // 这使本命令的并发语义与 `add`（同一种"往某父节点下加内容"）完全一致：
    // 别人改的是**别的对象**时自动叠到最新版，撞同一个父节点时才拒绝。
    const r = markdown.markdownToTree(md, parent);
    const added = r.data.children || [];
    ctx.mutate((cur) => {
      const parentNode = ctx.tree.find(cur.data, parent);
      // 读之后父节点被别人删了（罕见）⇒ 报错而不是凭空造一个父节点出来
      if (!parentNode) throw new Error('父节点在并发改动后已不存在: ' + parent);
      parentNode.children = (parentNode.children || []).concat(added);
      return cur;
    });
    ctx.out('导入完成，新增 ' + r.addedCount + ' 个节点（父节点 ' + parent + '）');
  },

  exportMd(ctx) {
    const dir = ctx.args._[1];
    if (!dir) ctx.error('缺少输出目录路径（导出为文件夹：md + 图片 + 附件）');
    const { data } = ctx.read();
    const outDir = path.resolve(dir);
    fs.mkdirSync(outDir, { recursive: true });
    // 1) 复制项目资源（assets/ 图片 + attachments/ 附件）→ 输出目录
    const copyTree = (src, dst) => {
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(dst, { recursive: true });
      fs.readdirSync(src, { withFileTypes: true }).forEach((e) => {
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        if (e.isDirectory()) copyTree(s, d);
        else fs.copyFileSync(s, d);
      });
    };
    copyTree(path.join(ctx.PROJECTS_DIR, ctx.projectName, 'assets'), path.join(outDir, 'assets'));
    copyTree(path.join(ctx.PROJECTS_DIR, ctx.projectName, 'attachments'), path.join(outDir, 'attachments'));
    // 2) 生成 Markdown（相对路径链接图片与附件）
    const md = markdown.treeToMarkdown(data.data, {
      format: ctx.args.format === 'list' ? 'list' : 'heading',
      withDetail: !!ctx.args.withDetail,
      withResources: true
    });
    const mdFile = path.join(outDir, ctx.projectName + '.md');
    fs.writeFileSync(mdFile, md, 'utf8');
    const nodes = tree.count(data.data);
    ctx.out('已导出文件夹: ' + outDir + '（' + ctx.projectName + '.md，' + nodes + ' 节点，含 assets/ 与 attachments/）');
  },

  /**
   * 静态导出：项目 → 可分享/可部署的静态站点（index.html + assets/ + attachments/）。
   *
   * 与 export-md / export-json 的分工：
   *   export-md    → 给编辑器/AI 读的 Markdown
   *   export-json  → 单文件无损备份与跨机迁移（aimap v1）
   *   export-html  → 给**人看**的只读站点（本命令）
   * HTML 生成是纯逻辑（src/export-html.js，有单测）；本命令只负责复制资源与落盘。
   */
  exportHtml(ctx) {
    const dir = ctx.args._[1];
    if (!dir) ctx.error('缺少输出目录路径（生成 index.html + assets/ 的静态站点）');
    const { data } = ctx.read();
    const outDir = path.resolve(dir);
    fs.mkdirSync(outDir, { recursive: true });

    const html = exportHtml.buildIndexHtml(data, { projectName: ctx.projectName });
    fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

    // 复制图片与附件（保持相对路径结构；index.html 里的链接即这些相对路径）
    const refs = exportHtml.collectAssets(data);
    const missing = [];
    let copied = 0;
    refs.forEach((rel) => {
      const src = path.join(ctx.PROJECTS_DIR, ctx.projectName, rel);
      if (!fs.existsSync(src)) { missing.push(rel); return; }
      const dst = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied++;
    });

    const nodes = tree.count(data.data);
    ctx.out('已导出静态站点: ' + outDir + '（index.html，' + nodes + ' 节点，'
      + copied + ' 个资源'
      + (missing.length ? '；缺失资源 ' + missing.length + ' 个: ' + missing.slice(0, 5).join(', ') : '')
      + '）');
  },

  /* ================= JSON 打包（aimap v1：单文件，图片+附件 base64 内嵌） ================= */
  exportJson(ctx) {
    const file = ctx.args._[1];
    if (!file) ctx.error('缺少输出文件路径');
    const { data } = ctx.read();
    // 收集节点引用的图片与附件 → base64 内嵌；键为相对路径（assets/x.png / attachments/x.md）
    const assets = {};
    const missing = [];
    bundle.collectResourceRefs(data.data).forEach((ref) => {
      const p = path.join(ctx.PROJECTS_DIR, ctx.projectName, ref.file);
      if (fs.existsSync(p)) assets[ref.file] = fs.readFileSync(p).toString('base64');
      else missing.push(ref.file);
    });
    const pack = bundle.buildBundle(data, assets);
    fs.writeFileSync(file, JSON.stringify(pack, null, 2), 'utf8');
    const nodes = tree.count(data.data);
    ctx.out('已导出 ' + ctx.projectName + ' → ' + file + '（' + nodes + ' 节点，' + Object.keys(assets).length + ' 个资源内嵌（图片+附件）'
      + (missing.length ? '；缺失资源: ' + missing.join(', ') : '') + '）');
  },

  importJson(ctx) {
    const file = ctx.args._[0];
    if (!file) ctx.error('缺少 aimap JSON 文件路径');
    if (!fs.existsSync(file)) ctx.error('文件不存在: ' + file);
    // 结构解析（含 BOM 剥离）已下沉到 src/bundle.js，规则可被单测锁住
    const parsed = bundle.parseBundle(fs.readFileSync(file, 'utf8'));
    if (!parsed.ok) ctx.error(parsed.error);
    const pack = parsed.bundle;
    const name = String(ctx.args.name || pack.meta.name).trim();
    if (!name || /[\\/:*?"<>|]/.test(name)) ctx.error('非法项目名: ' + name);
    // 数据校验闸门（与保存同源）。
    // selfProject = name 是**恢复备份的关键**：备份里的链接/关联成员多半指向这个项目自己
    // （同项目链接也带显式 project 字段），而恢复时它在磁盘上恰恰**不存在** ——
    // 不告诉校验器"这份数据就是 name 项目"，就会把整个备份判成悬挂链接而拒绝导入。
    // 实测：删除项目后导入它自己的备份 → "悬挂链接: 项目不存在 p1"，备份形同废纸。
    const v = ctx.schema.validateProject(
      { meta: pack.meta, format: pack.format || 'node_tree', data: pack.data, assoc: pack.assoc },
      ctx.PROJECTS_DIR, name);
    if (!v.ok) ctx.error('数据校验失败: ' + v.errors.join('; '));
    const targetDir = path.join(ctx.PROJECTS_DIR, name);
    if (fs.existsSync(path.join(targetDir, name + '.json'))) {
      ctx.error('项目已存在: ' + name + '（可用 --name 指定新项目名）');
    }
    // 解包资源（防路径穿越：资源路径必须解析在项目目录**内部**）
    if (pack.assets && typeof pack.assets === 'object') {
      const keys = Object.keys(pack.assets);
      keys.forEach((k) => {
        if (!bundle.isSafeRelPath(targetDir, k)) ctx.error('非法资源路径: ' + k);
      });
      keys.forEach((k) => {
        const p = path.resolve(targetDir, k);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        // 资源同样原子落盘（避免半截文件被后续引用）
        ctx.store.writeFileAtomic(p, Buffer.from(pack.assets[k], 'base64'));
      });
    }
    // 项目 JSON 是「提交点」，最后写：走 store.write（校验闸门 + 原子写）
    const outData = { meta: pack.meta, format: pack.format || 'node_tree', data: pack.data };
    // 关联笔记是项目级集合，不属于节点树 —— 漏掉它会让"无损备份"静默丢数据
    if (Array.isArray(pack.assoc) && pack.assoc.length) outData.assoc = pack.assoc;
    // 走 store.write（不经 ctx.write）：这是"用这个文件新建一个项目"，与既有数据没有
    // "读→改→写"关系，所以**不该**参与并发合并（也没有 expectVersion 可声明）。
    // 但**要把"谁在写"传下去** —— 否则变更日志里这条会显示成 `unknown`（实测发现的漏洞）。
    ctx.store.write(name, outData, { writer: ctx.writer });
    let nodes = 0, imgs = 0, files = 0;
    tree.walk(pack.data, (n) => {
      nodes++;
      imgs += (n.images || []).length;
      files += (n.files || []).length;
    });
    ctx.out('已导入: ' + name + '（' + nodes + ' 节点，' + imgs + ' 个图片引用，' + files + ' 个附件引用，'
      + (pack.assets ? Object.keys(pack.assets).length : 0) + ' 个资源解包）');
  },

  /** 主题布局：meta.layout = { left: [主题id], right: [主题id] }，决定顶层主题在导图中的左右分侧。
   *  不写侧 = 该主题保持 jsMind 默认（右侧）。渲染层据此刻画 direction。 */
  themeLayout(ctx) {
    const left = ctx.args.left;
    const right = ctx.args.right;
    if (!left && !right && !ctx.args.clear) ctx.error('缺少 --left 或 --right（--clear 清除布局）');
    const { data } = ctx.read();
    const kidSet = new Set((data.data.children || []).map((c) => c.id));
    const parse = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
    const layout = {};
    if (left) {
      const ids = parse(left);
      ids.forEach((id) => { if (!kidSet.has(id)) ctx.error('不是顶层主题: ' + id); });
      layout.left = ids;
    }
    if (right) {
      const ids = parse(right);
      ids.forEach((id) => { if (!kidSet.has(id)) ctx.error('不是顶层主题: ' + id); });
      layout.right = ids;
    }
    if (layout.left && layout.right) {
      const dup = layout.left.filter((id) => layout.right.includes(id));
      if (dup.length) ctx.error('同一主题不能同时出现在左右两侧: ' + dup.join(','));
    }
    // 布局对象在 fn 外算好（校验也用预读的顶层主题列表 ⇒ 报错顺序不变）；
    // 写入走 `ctx.mutate`：别人改的是**节点**（与 meta 不相交）时不再整体失败。
    let written = null;
    ctx.mutate((cur) => {
      if (ctx.args.clear) {
        if (cur.meta) delete cur.meta.layout;
      } else {
        cur.meta = cur.meta || { name: ctx.projectName, version: MMConfig.APP_VERSION, formatVersion: 2 };
        cur.meta.layout = layout;
      }
      written = JSON.parse(JSON.stringify((cur.meta && cur.meta.layout) || {}));
      return cur;
    });
    ctx.out('已设置主题布局: ' + JSON.stringify(written || {}));
  },

  validate(ctx) {
    const target = ctx.projectName;
    if (!target) ctx.error('缺少项目名或 JSON 文件路径');
    // 项目名 或 文件路径（含 .tmp 等任意扩展名——主进程保存前校验临时文件依赖此）
    const file = fs.existsSync(target)
      ? target
      : path.join(ctx.PROJECTS_DIR, target, target + '.json');
    if (!fs.existsSync(file)) ctx.error('找不到项目: ' + target);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 自项目推断：主进程保存前校验的是 `projects/<项目>/<项目>.json.<pid>.validate`
    // 这类**同目录临时文件**（见 main.js），父目录名就是项目名。据此让"同项目成员"
    // 以这份待写数据为准 —— 否则界面删掉被引用的节点后，第一次保存会因为闸门看的是
    // 磁盘旧态而放行，第二次保存才突然被拒（实测），用户完全看不懂。
    // 不在项目根内的文件（如 import 的临时包）推断不出项目名，退回纯读盘校验。
    const absFile = path.resolve(file);
    const absRoot = path.resolve(ctx.PROJECTS_DIR);
    const selfProject = absFile.indexOf(absRoot + path.sep) === 0
      ? path.basename(path.dirname(absFile)) : null;
    const v = ctx.schema.validateProject(data, ctx.PROJECTS_DIR, selfProject);
    if (ctx.args.json) ctx.outJson({ ok: v.ok, errors: v.errors });
    else if (v.ok) ctx.out('校验通过: ' + target);
    else ctx.out('error: 校验失败: ' + v.errors.join('; '));
    // --json 分支此前**不设退出码** —— 于是 validate --json 遇到坏数据也返回 0，
    // 与文本分支行为不一致。退出码必须由"校验结果"决定，与输出格式无关。
    if (!v.ok) process.exitCode = 1;
  },

  validateAll(ctx) {
    const list = ctx.store.list();
    let bad = 0;
    list.forEach((p) => {
      const data = JSON.parse(fs.readFileSync(p.file, 'utf8'));
      const v = ctx.schema.validateProject(data, ctx.PROJECTS_DIR, p.name);
      if (!v.ok) { bad++; ctx.out('FAIL ' + p.name + ': ' + v.errors.join('; ')); }
      else ctx.out('OK   ' + p.name);
    });
    ctx.out(bad ? bad + ' 个项目校验失败' : '全部 ' + list.length + ' 个项目校验通过');
    if (bad) process.exitCode = 1;
  },

  /**
   * 界面未保存编辑查询（写前协调信号）。
   *
   * 与 `validate` 的关系：这是**事前**协调（"现在动笔会不会和人的未保存编辑打架"），
   * validate 是**事后**闸门（"我写的数据合法吗"）。两者都要，缺事前协调就会出现
   * "AI 写完、人一保存把 AI 的改动覆盖掉"的白做工（L3 冲突规则见 README）。
   *
   * 不带项目名 → 汇总所有有状态文件的（AI 在不确定当前是哪个项目时先跑这个）。
   */
  uiState(ctx) {
    const uiState = require('../../src/ui-state.js');
    const read = (name) => uiState.readProjectState(fs, path, ctx.PROJECTS_DIR, name);
    if (ctx.projectName) {
      const s = read(ctx.projectName);
      if (ctx.args.json) { ctx.outJson(s); return; }
      ctx.out(ctx.projectName + ': ' + (s.dirty ? 'DIRTY（有未保存编辑）' : 'clean')
        + ' · ' + s.note);
      return;
    }
    const names = ctx.store.list().map((p) => p.name);
    const all = names.map(read);
    if (ctx.args.json) { ctx.outJson({ projects: all }); return; }
    if (!all.length) { ctx.out('（没有项目）'); return; }
    all.forEach((s) => ctx.out((s.dirty ? 'DIRTY ' : 'clean ') + s.project + ' · ' + s.note));
    const dirty = all.filter((s) => s.dirty).map((s) => s.project);
    ctx.out(dirty.length
      ? '⚠ 有未保存编辑的项目: ' + dirty.join(', ') + ' —— 先请用户在界面里保存（或确认丢弃）再写入'
      : '全部项目界面均无未保存编辑 —— 可以安全写入');
  }
};
