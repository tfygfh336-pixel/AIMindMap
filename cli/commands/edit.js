/* ============================================================
 * cli/commands/edit.js — 节点编辑命令
 * ============================================================ */
'use strict';

const fs = require('fs');
const markdown = require('../../src/markdown.js');
const convert = require('../../src/convert.js');
const assoc = require('../../src/assoc.js');
const links = require('../../src/links.js');

/**
 * 取本次命令要写入的 detail。
 * 存储格式是 **HTML**（渲染层以 innerHTML 注入，见 docs/DATA-FORMAT.md §2.4），
 * 但 AI 天然写 Markdown —— 故提供 `--detail-md`：显式声明"我给的是 Markdown"，
 * 由命令转换为 HTML 落盘。两个选项互斥，避免"我以为是 Markdown 其实是 HTML"的静默歧义。
 */
function detailFromArgs(ctx) {
  const html = ctx.args.detail;
  const md = ctx.args.detailMd;
  if (html !== undefined && md !== undefined) {
    ctx.error('--detail 与 --detail-md 不能同时使用（前者按 HTML 原样存，后者按 Markdown 转换）');
  }
  if (md !== undefined) {
    if (typeof md !== 'string' || !md.trim()) ctx.error('--detail-md 内容为空');
    return convert.markdownToHtml(md);
  }
  return html;
}

/**
 * 取本次命令要写入的**本机文件夹路径**（`localPath`，见 docs/DATA-FORMAT.md §2.5）。
 *
 * 它是什么：节点对应的目录在本机的绝对路径，界面上点击即用系统文件管理器打开
 * （从文件夹结构建树时，每个结构节点都挂一条，于是"导图 ↔ 真目录"随时互跳）。
 * `--local-path <绝对路径>` 设置；`--clear-local-path` 清除；两者互斥。
 *
 * 为什么必须**绝对**：相对路径会随"当前工作目录"漂移，而点击打开的是操作系统，
 * 它没有"项目根"这个概念 —— 放行相对路径只会得到一个看似合法、点了打不开的值。
 * 为什么**不校验存在**：目标盘可能没挂载、目录可能还没建；存在性在**点击时**判（主进程 shell.openPath
 * 会返回明确错误），而数据校验只管形状（否则换台机器连 validate 都红）。
 */
function localPathFromArgs(ctx) {
  const p = ctx.args.localPath;
  const clear = ctx.args.clearLocalPath;
  if (p !== undefined && clear) ctx.error('--local-path 与 --clear-local-path 不能同时使用');
  if (clear) return { set: true, value: undefined };
  if (p === undefined) return { set: false };
  const s = String(p).trim();
  if (!s) ctx.error('--local-path 内容为空（要清除请用 --clear-local-path）');
  if (!/^[A-Za-z]:[\\/]/.test(s) && !/^\\\\/.test(s)) {
    ctx.error('--local-path 必须是**绝对路径**（如 E:\\markdown\\M1 或 \\\\服务器\\共享\\目录）：' + s);
  }
  return { set: true, value: s };
}

/** 通用：在指定父节点下新增一个子节点 */
function addUnder(ctx, parent) {
  const topic = ctx.args.topic;
  if (!topic) ctx.error('缺少 --topic 标题');
  const detail = detailFromArgs(ctx);
  const lp = localPathFromArgs(ctx);                    // 形状校验在写盘之前（错了就别动数据）
  if (lp.set && lp.value && !fs.existsSync(lp.value)) {
    // 只是**警告**：目标可能还没建 / 盘没挂。数据照写，让用户自己看到风险（不静默、也不武断拒绝）
    ctx.out('⚠ 这个路径当前不存在（仍已记录，点击时会报错）：' + lp.value);
  }
  let addedId = null;                                   // 闭包变量：报出**实际落盘**的 id（重放时可能是新生成的）
  ctx.mutate((data) => {                                // 多路同时编辑：冲突时自动重放到最新版
    const parentNode = ctx.tree.find(data.data, parent);
    if (!parentNode) ctx.error('父节点不存在: ' + parent);
    const id = ctx.args.id || markdown.idGen(topic);
    if (ctx.tree.find(data.data, id)) ctx.error('id 已存在: ' + id);
    const node = { id, topic, expanded: ctx.args.expanded !== 'false' && ctx.args.expanded !== false, children: [] };
    if (detail) node.detail = detail;
    if (lp.set && lp.value) node.localPath = lp.value;
    parentNode.children = (parentNode.children || []).concat(node);
    addedId = id;
    return data;
  });
  ctx.out('已添加: ' + addedId + '（父 ' + parent + '）');
}

module.exports = {
  add(ctx) {
    const parent = ctx.args._[1];
    if (!parent) ctx.error('缺少父节点 id');
    addUnder(ctx, parent);
  },

  /** 新增顶层主题：不选父节点，直接挂在根节点下，并开启「主题模式」
   *  —— 主题模式下渲染层会隐藏容器根、跳过它的连线，于是各顶层主题互相独立。
   *  这样同一个项目里可以放多个不同方面的笔记。 */
  addRoot(ctx) {
    const topic = ctx.args.topic;
    if (!topic) ctx.error('缺少 --topic 标题');
    const detail = detailFromArgs(ctx);
    let addedId = null, alreadyThemed = false;
    ctx.mutate((data) => {
      const rootNode = ctx.tree.find(data.data, 'root');
      if (!rootNode) ctx.error('找不到根节点 root');
      const id = ctx.args.id || markdown.idGen(topic);
      if (ctx.tree.find(data.data, id)) ctx.error('id 已存在: ' + id);
      const node = { id, topic, expanded: true, children: [] };
      if (detail) node.detail = detail;
      rootNode.children = (rootNode.children || []).concat(node);
      data.meta = data.meta || {};
      alreadyThemed = data.meta.rootMode === 'themes';
      data.meta.rootMode = 'themes';
      addedId = id;
      return data;
    });
    ctx.out('已添加顶层主题: ' + addedId + '（父 root）' + (alreadyThemed ? '' : '，并已开启主题模式'));
  },

  edit(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('缺少节点 id');
    const detailGiven = ctx.args.detail !== undefined || ctx.args.detailMd !== undefined;
    const detail = detailGiven ? detailFromArgs(ctx) : undefined;
    const lp = localPathFromArgs(ctx);
    if (lp.set && lp.value && !fs.existsSync(lp.value)) {
      ctx.out('⚠ 这个路径当前不存在（仍已记录，点击时会报错）：' + lp.value);
    }
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      if (ctx.args.topic) node.topic = ctx.args.topic;
      if (detailGiven) node.detail = detail;
      if (ctx.args.clearDetail) delete node.detail;
      // 标签：--tags "a,b" 覆盖设置；--clear-tags 清空
      if (ctx.args.tags !== undefined) {
        const tags = String(ctx.args.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (tags.length) node.tags = tags; else delete node.tags;
      }
      if (ctx.args.clearTags) delete node.tags;
      // 本机文件夹路径：--local-path 设置；--clear-local-path 清除
      if (lp.set) { if (lp.value) node.localPath = lp.value; else delete node.localPath; }
      if (ctx.args.expanded !== undefined) node.expanded = ctx.args.expanded !== 'false' && ctx.args.expanded !== false;
      return data;
    });
    ctx.out('已更新: ' + id);
  },

  move(ctx) {
    const id = ctx.args._[1];
    const parent = ctx.args._[2];
    if (!id || !parent) ctx.error('用法: move <项目> <id> <新父id> [--index n]');
    ctx.mutate((data) => {
      const ok = ctx.tree.moveNode(data.data, id, parent, ctx.args.index !== undefined ? Number(ctx.args.index) : undefined);
      if (!ok) ctx.error('移动失败（节点不存在 / 目标非法 / 移动到自身子树）');
      return data;
    });
    ctx.out('已移动: ' + id + ' → ' + parent);
  },

  remove(ctx) {
    const id = ctx.args._[1];
    if (!id) ctx.error('缺少节点 id');
    if (id === 'root') ctx.error('根节点不可删除');
    // 清理结果是"给人看的输出"，必须带出 fn 之外 —— fn 可能被并发重放，在里面 out() 会打印两次
    let removedKids = 0, assocMsg = null, linkMsg = null;
    ctx.mutate((data) => {
      const target = ctx.tree.find(data.data, id);
      if (!target) ctx.error('节点不存在: ' + id);

      // 关联笔记：被删（子）树可能是某些关联的成员。删掉而不处理 = 造出"悬挂成员"，
      // 而写盘闸门会拿**这份待写数据**判同项目成员 → 不处理的删除会被判红。
      // 不用"先 prune 再删"来回避：prune 只能清已经悬空的成员，删之前它还悬不了，
      // 所以这里必须自己提供清理路径（--clean-assoc），否则用户无路可走。
      const ids = new Set();
      (function collect(n) { if (!n) return; ids.add(n.id); (n.children || []).forEach(collect); })(target);
      const list = Array.isArray(data.assoc) ? data.assoc : [];
      const hit = list.filter((a) => (a.members || []).some((m) => m && m.project === ctx.projectName && ids.has(m.id)));

      // 链接：**同项目**里指向被删（子）树的有向边同样会悬空 → 同样的锁死问题。
      // （跨项目引用者没法在这里便宜地发现：要扫全部项目。那个方向由引用者自己跑
      //   `links-prune` 修好 —— 提示里会说明。）
      const inbound = [];
      ids.forEach((nid) => links.inbound(data.data, ctx.projectName, nid).forEach((x) => inbound.push(x)));

      const removed = ctx.tree.removeNode(data.data, id);
      if (!removed) ctx.error('节点不存在: ' + id);
      removedKids = ctx.tree.count(removed) - 1;

      if (hit.length || inbound.length) {
        const need = [];
        if (hit.length) need.push('--clean-assoc');
        if (inbound.length) need.push('--clean-links');
        const flagsOk = (!hit.length || ctx.args.cleanAssoc) && (!inbound.length || ctx.args.cleanLinks);
        if (!flagsOk) {
          const lines = ['删除 ' + id + ' 会影响已被引用的关系，若原样删除，本项目**所有**写命令都会被闸门挡住:'];
          if (hit.length) {
            lines.push('  · ' + hit.length + ' 篇关联笔记引用了它（' + hit.map((a) => a.id).join(', ') + '）');
          }
          if (inbound.length) {
            lines.push('  · ' + inbound.length + ' 条链接指向它（'
              + inbound.map((x) => x.node + ' → ' + x.link.project + '/' + x.link.id).join(', ') + '）');
          }
          lines.push('二选一：');
          lines.push('  · remove ' + ctx.projectName + ' ' + id + ' ' + need.join(' ') + '    （删节点并同步清理）');
          lines.push('  · 先摘引用再单独删：assoc-prune / links-prune ' + ctx.projectName + ' --nodes ' + id);
          lines.push('  注：若**别的项目**里有链接指向它，那些项目请各自跑 links-prune 修好。');
          ctx.error(lines.join('\n'));
        }
        if (hit.length) {
          const pruned = assoc.pruneMembers(list, (m) => m.project === ctx.projectName && ids.has(m.id));
          if (pruned.empty) delete data.assoc; else data.assoc = pruned.list;
          assocMsg = '已同步清理关联：' + pruned.touched.map((t) => t.id + '（- ' + t.removed + ' 成员）').join(', ')
            + (pruned.dropped.length ? '；整篇删除（只剩一个成员）: ' + pruned.dropped.join(', ') : '');
        }
        if (inbound.length) {
          const lr = links.pruneLinks(data.data, (l) => l.project === ctx.projectName && ids.has(String(l.id)));
          linkMsg = '已同步清理链接：' + lr.removed.map((x) => x.node + ' → ' + x.target).join(', ');
        }
      }
      return data;
    });
    if (assocMsg) ctx.out(assocMsg);
    if (linkMsg) ctx.out(linkMsg);
    ctx.out('已删除: ' + id + '（含 ' + removedKids + ' 个子节点）');
  },

  clone(ctx) {
    const id = ctx.args._[1];
    const parent = ctx.args._[2];
    if (!id || !parent) ctx.error('用法: clone <项目> <源id> <新父id> [--deep]');
    let copyId = null;
    ctx.mutate((data) => {
      const src = ctx.tree.find(data.data, id);
      if (!src) ctx.error('源节点不存在: ' + id);
      const parentNode = ctx.tree.find(data.data, parent);
      if (!parentNode) ctx.error('父节点不存在: ' + parent);

      // 新 id 生成：时间戳 + 序号，并对照全树现有 id 去重。
      // （原实现只用 Date.now().toString(36).slice(-3)，--deep 复制同层多个节点时
      //   极易撞号 → validate 报「重复 id」直接失败。）
      const used = new Set(ctx.tree.flatten(data.data).map((n) => n.id));
      const stamp = Date.now().toString(36).slice(-4);
      let seq = 0;
      const mintId = (base) => {
        let candidate;
        do { candidate = base + '-c' + stamp + (seq++ ? '-' + seq : ''); } while (used.has(candidate));
        used.add(candidate);
        return candidate;
      };

      // 深拷贝必须覆盖全部节点字段：曾漏掉 tags 与 files，
      // 导致复制带标签/附件的节点后两者无声消失（附件物理文件变孤儿）。
      const deepCopy = (n) => {
        const node = { id: mintId(n.id), topic: n.topic, expanded: n.expanded !== false, children: [] };
        if (n.detail !== undefined) node.detail = n.detail;
        if (n.background !== undefined) node.background = n.background;
        if (Array.isArray(n.tags) && n.tags.length) node.tags = n.tags.slice();
        if (Array.isArray(n.images) && n.images.length) node.images = JSON.parse(JSON.stringify(n.images));
        if (Array.isArray(n.files) && n.files.length) node.files = JSON.parse(JSON.stringify(n.files));
        if (Array.isArray(n.links) && n.links.length) node.links = JSON.parse(JSON.stringify(n.links));
        if (ctx.args.deep) node.children = (n.children || []).map(deepCopy);
        return node;
      };

      const copy = deepCopy(src);
      parentNode.children = (parentNode.children || []).concat(copy);
      copyId = copy.id;
      return data;
    });
    ctx.out('已复制: ' + id + ' → ' + parent + '（新 id ' + copyId + '）');
  }
};
