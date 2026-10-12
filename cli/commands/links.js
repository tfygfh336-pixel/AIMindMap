/* ============================================================
 * cli/commands/links.js — 跨项目链接命令
 * ------------------------------------------------------------
 * 链接约定：
 *   - 节点 links: [{ project, id, item?, caption? }]
 *   - project 是另一个项目的目录名（projects/<project>/）
 *   - 悬挂链接（目标不存在）由 validate 检测
 *   - `item`（条目层 v3，契约 docs/ITEM-MODEL.md §7）= 目标节点里的**某一条条目**；
 *     省略 = 节点级链接（v2 语义**完全不变**）
 *
 * 重复 `link` **同一条边**的语义（K8 修复；改前是真机复现过的**静默丢字段**）：
 *   · 省略 --caption        ⇒ **保留**原有 caption（"重复添加"退化成幂等，绝不静默清掉）；
 *   · 显式给 --caption      ⇒ 覆盖（**空串 = 清空**，见下面 hasCaption 处的说明）；
 *   · 三种结局的回显**必须可分辨**：`已添加链接` / `已更新链接` / `无变化`。
 * 改前的实现把"要写下去的那条链接"从零重建（`{project, id, caption?}` 再 concat），于是
 * "没给 --caption"与"没有 caption"不可区分 —— 第二次 link 把盘上已有的 caption 抹掉，
 * 而回显与第一次**逐字相同**（`已添加链接: …`）：**成功与覆盖不可分辨** ✗。
 *
 * ---- 条目层升层（S6）：边的同一性 =（项目, 节点, **条目**）三元组 ----
 * `--item <itemId>` 与 `--caption` 走**同一条三态语义**（这是 K8 定下的词，S6 只把它扩到第二层）：
 *   · 省略 --item        ⇒ 条目为空那一档，也就是**节点级那条边**（与条目级边是**两条不同的边**）；
 *   · 显式 --item <id>   ⇒ 指向目标节点里的那一条条目（又是另一条边）；
 *   · 显式 `--item ""`   ⇒ **清空条目层**（边退回节点级；回显点明"item 清空"）；
 *   回显仍然是那三种结局：`已添加链接` / `已更新链接`（清空时写明清的是哪个字段）/ `无变化`。
 * ⚠️ 三态词（"重复同一条边 ⇒ 无变化"）只对**同一条边**成立：省略 `--item` 命中的是**节点级**
 *    那一条，**不是**"同 (源,目标) 上的任意一条边"（改前那样做 ⇒ 同 (源,目标) 上永远建不出
 *    节点级边，与 `--item` 的意义自相矛盾）。
 * ⚠️ 明确**不造** `--clear-item` / `--clear-caption`，也不另起"幂等命中"那套话术：
 *    "清空"这件事在本命令里只有一个拼法 —— **显式空串**。
 *
 * **判据只有一处**：目标"还在不在"（含条目级）一律问 `src/relations.js` 的 `refState()`
 *   —— `link` 的前置检查与 `links-prune` 的自动清理**调的是同一个函数**，
 *   所以"写入口拒绝的"与"清理口能修的"永远是同一件事（契约 §7/§12）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const links = require('../../src/links.js');
const relations = require('../../src/relations.js');

/** 链接的可读目标（出边/报告都用这一处拼法）：`项目/节点id[#条目id]` */
function refLabel(project, id, item) {
  return project + '/' + id + (relations.itemKey(item) ? '#' + relations.itemKey(item) : '');
}

/**
 * 找出这条命令**要动的那条边**（没有则 null）。
 *
 * 判定键由"这次给了哪一层"决定 —— 这正是"不许把两种意图混成一条边"的落点：
 *   · 给了 `--item X`：键 = (项目, 节点, **条目 X**) ⇒ 同 (源,目标) 上不同条目是**不同的边**
 *     （契约 §7：`item` 让边精确指到"某节点里的某一条条目"）⇒ "节点级一条 + 条目级两条"
 *     能并存，各自独立添加/更新/去掉。
 *     **唯一的例外是"把节点级那条升级成条目级"**：没有完全同条目的边时，若存在一条
 *     **指向同一目标、且还没有条目层**的边，就改它（`link --to T --id X --item IA` 两次
 *     仍是「无变化」——重放安全是硬要求）。
 *   · 省略 `--item`：键 = (项目, 节点, **条目为空**) ⇒ **只认节点级那条边**（条目级边是别的边，
 *     不参与命中）。同 (源,目标) 上"节点级一条 + 条目级两条"因此是**三条不同的边**，可以并存、
 *     互不吞掉；重复 `link` **同一条边**仍是「无变化」（保留原有的 caption / item，绝不静默清掉）。
 *     ⚠️ 改前这一档是 `if (!hasItem) return toTarget;`（把"同一条边"当成 (源,目标) 两元组）⇒
 *     省略 `--item` 会命中一条**条目级**边并回显「无变化」，于是**节点级那条边永远建不出来**，
 *     与 `--item` 的意义自相矛盾（契约要求两者并存，见 `cli-integration.js` §S6 之四与
 *     `tests/link-item.test.js` 的 B2/C1）。
 * 这个"看意图选键"与 K8 的 `hasCaption` 是**同一条思路的第二层**（问"给没给"，不看值）。
 *
 * ⚠️ `--item ""`（显式清空条目层）的**清空规则**（写下来免得后来者猜）：
 *   · 该 (源,目标) 下有"**本来就没有条目层**"的边 ⇒ 清它（无变化、最保守）；
 *   · 否则若**只有一条**边 ⇒ 清它的 `item`（"把这条边退回节点级"是唯一合理解读）；
 *   · 否则（**多条条目级边**）⇒ **不猜**，按"该层为空"**新起一条节点级边**。
 *     猜一条来降级 = 静默改错对象；宁可多一条节点级边，也不许凭空删掉别人的 `item`。
 */
function edgeCandidates(node, project, id, hasItem, item) {
  const list = node && Array.isArray(node.links) ? node.links : [];
  const toTarget = list.filter((l) => l && l.project === project && l.id === id);
  // 省略 `--item` ⇒ 键 = (项目, 节点, **条目为空**) ⇒ 命中的**只有节点级那条边**。
  // ⚠️ 不许写成 `if (!hasItem) return toTarget;`：那是把"同一条边"当成 (源,目标) 两元组，
  //    省略 `--item` 会命中一条条目级边并回显「无变化」⇒ 节点级边永远建不出来（见文件头）。
  if (!hasItem) return toTarget.filter((l) => relations.itemKey(l.item) === '');
  const want = relations.itemKey(item);
  if (!want) {
    const bare = toTarget.filter((l) => relations.itemKey(l.item) === '');
    if (bare.length) return bare;                   // 有"无条目层"的边 ⇒ 清它
    return toTarget.length === 1 ? toTarget : [];   // 只有一条 ⇒ 退它回节点级；多条 ⇒ 不猜
  }
  const exact = toTarget.filter((l) => relations.itemKey(l.item) === want);
  if (exact.length) return exact;
  // 精确档空 ⇒ **仅当这一对上还没有条目级边**时，允许把节点级那条**升级**成条目级：
  // 那是把"v2 的那一条边"升层（`link --to T --id X --item IA` 两次仍是「无变化」= 重放安全）。
  // ⚠️ 一旦这一对上**已经有**条目级边 ⇒ 三元组口径生效：节点级那条是**独立的一条边**，不许被
  // 吞掉（契约为"同 (源,目标) 上节点级一条 + 条目级两条**并存、互不吞掉**"；吞掉它的后果是
  // 用户/AI 想"再加一条指向这条条目的边"时，静静地把原有的节点级链接换掉了）。
  const bareEdges = toTarget.filter((l) => relations.itemKey(l.item) === '');
  const itemEdges = toTarget.filter((l) => relations.itemKey(l.item) !== '');
  return itemEdges.length ? [] : bareEdges;
}

/**
 * 重复 `link` 同一条边的**语义判定**（纯函数、无 I/O ⇒ 可单测，见 `tests/link-caption.test.js`）。
 *
 * 判定的关键输入是 `hasCaption`（命令行**给没给** `--caption`），**不是** caption 的值 ——
 * 拿值的真假来判，`''`（显式清空）与 `undefined`（省略）就分不开，那正是这个缺陷的根因。
 * `hasItem` / `item` 是**同一套规矩**的第二层（条目层）：同一条边可以精确指到条目，
 * 也可以退回节点级；清空同样只认显式空串。
 *
 * @param {object|null} prev 盘上已有的那条边（没有 = null）
 * @param {boolean} hasCaption 是否给了 `--caption`
 * @param {string} [caption] 给了时的新说明（空串 = 显式清空）
 * @param {boolean} [hasItem] 是否给了 `--item`
 * @param {string} [item] 给了时的新条目 id（空串 = 显式清空条目层）
 * @returns {{action:'add'|'update'|'clear'|'nochange', caption?:string, item?:string,
 *            from?:string, fromItem?:string}}
 *          `from` / `fromItem` = 改动前那一份的值（空串表示原本就没有）
 */
function planLink(prev, hasCaption, caption, hasItem, item) {
  const nextCaption = hasCaption ? String(caption == null ? '' : caption) : null;   // null = 保留
  const nextItem = hasItem ? relations.itemKey(item) : null;                        // null = 保留
  if (!prev) {
    return {
      action: 'add',
      caption: nextCaption === null ? '' : nextCaption,
      item: nextItem === null ? undefined : nextItem
    };
  }
  const from = typeof prev.caption === 'string' ? prev.caption : '';
  const fromItem = relations.itemKey(prev.item);
  // 省略 ⇒ 两层都保留（重复添加退化成幂等）
  if (!hasCaption && !hasItem) return { action: 'nochange', from: from, fromItem: fromItem };
  // 给了但两级都同值 ⇒ 真·无变化（**不许**重建对象：边上别的字段与数组顺序都不该动）
  const capSame = !hasCaption || nextCaption === from;
  const itemSame = !hasItem || nextItem === fromItem;
  if (capSame && itemSame) return { action: 'nochange', from: from, fromItem: fromItem };
  // "清空"= 两件可清的事里**至少有一件被清掉**（清哪一层由 report() 按 from/fromItem 点明）。
  // 注意"待动的 item 与盘上相同"时不该报清空（那是"只清 caption"那一档），故此处按**是否真的变成空**判。
  const clearsItem = hasItem && nextItem === '' && fromItem !== '';
  const clearsCaption = hasCaption && nextCaption === '';
  if (clearsItem || clearsCaption) {
    return {
      action: 'clear',
      from: from,
      fromItem: fromItem,
      clearsItem: clearsItem,
      clearsCaption: clearsCaption,
      caption: nextCaption === null ? from : nextCaption,
      item: nextItem === null ? undefined : nextItem
    };
  }
  return {
    action: 'update',
    from: from,
    fromItem: fromItem,
    clearsItem: false,
    clearsCaption: false,
    caption: nextCaption === null ? from : nextCaption,
    item: nextItem === null ? undefined : nextItem
  };
}

/**
 * 某项目的数据根（`项目.json` 的 `data`）。三种结局**必须分开**（不许都退化成 null）：
 *   · `{ ok:true, root }`               —— 读到了
 *   · `{ ok:false, reason:'no-project' }` —— 目录/文件不存在（= 确认"项目没了"，可清理）
 *   · `{ ok:false, reason:'unreadable' }` —— 文件在、但解析不了（**不确定**，不许当成"没了"）
 */
function readTargetRoot(PROJECTS_DIR, project) {
  const file = path.join(PROJECTS_DIR, project, project + '.json');
  if (!fs.existsSync(file)) return { ok: false, reason: 'no-project' };
  try { return { ok: true, root: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).data }; }
  catch (e) { return { ok: false, reason: 'unreadable' }; }
}

/**
 * `link` 的目标前置检查 —— **唯一判据**是 `relations.refState`（节点级与条目级同一处）。
 * 目标节点在、但它没有那一条条目 ⇒ **响亮拒绝并点名**（这是本流最要紧的一条：
 * 写入口不许造出"节点在、条目不在"的悬挂引用 —— 那种引用会把该项目**所有**写命令锁死）。
 */
function assertTarget(ctx, to, toId, toItem) {
  const got = readTargetRoot(ctx.PROJECTS_DIR, to);
  if (!got.ok && got.reason === 'no-project') ctx.error('目标项目不存在: ' + to);
  if (!got.ok) ctx.error('目标项目读不出来: ' + to + '（损坏或权限问题，先修好它再链接）');
  const st = relations.refState({ project: to, id: toId, item: toItem }, got.root, to);
  if (st.state === 'ok') return st;
  if (st.state === 'no-node') ctx.error('目标节点不存在: ' + to + '/' + toId);
  if (st.state === 'no-item') {
    ctx.error('目标条目不存在: ' + to + '/' + toId + '#' + relations.itemKey(toItem)
      + '\n' + st.hint
      + '\n（--item 指向的是**目标节点里的一条条目**；省略 --item 就是节点级链接）');
  }
  return ctx.error('链接目标不完整: 缺少 --to / --id');
}

module.exports = {
  link(ctx) {
    const id = ctx.args._[1];
    const to = ctx.args.to;
    const toId = ctx.args.id;
    if (!id || !to || !toId) ctx.error('用法: link <项目> <id> --to 目标项目 --id 目标id [--item 目标条目id] [--caption 说明]');
    // 校验顺序与报错文本**保持与从前一致**（B1：人按原有习惯操作得到的仍是设计意图）。
    // 目标项目那几项检查与"要写下去的数据"无关，放在 mutate 之外 —— 免得读盘代价被重放乘一遍。
    const pre = ctx.read();
    const preNode = ctx.tree.find(pre.data.data, id);
    if (!preNode) ctx.error('节点不存在: ' + id);

    // ⚠️ **必须问"给没给 --caption"，不能看它的值**：省略时 `args.caption` 是 undefined、
    // 显式空串时是 ''，两者的真假完全一样 —— 拿值判就等于把"保留"和"清空"混成一句。
    const hasCaption = Object.prototype.hasOwnProperty.call(ctx.args, 'caption');
    if (hasCaption && typeof ctx.args.caption !== 'string') {
      // 只写 `--caption` 不给值（parseArgs 给 `true`）：旧实现会把 true 原样写进链接
      // （盘上出现 `"caption": true`，而 validate 不查 caption 类型 ⇒ 一路静默）。
      // 这里响亮拒绝并给出两条正路。⚠️ 这条**排在既有全部检查之后**：老调用方的报错顺序不变。
      ctx.error('--caption 需要一个说明文本（省略 --caption = 保留原说明；要清空请显式写 --caption ""）');
    }
    // `--item` 与 `--caption` **同一套规矩**（S6 沿用 K8 的三态词，见文件头）：
    // 省略 = 保留；给了字符串 = 覆盖；`--item ""` = 清空条目层（边退回节点级）。
    const hasItem = Object.prototype.hasOwnProperty.call(ctx.args, 'item');
    if (hasItem && typeof ctx.args.item !== 'string') {
      ctx.error('--item 需要一个条目 id（省略 --item = 保留原条目层；要清空请显式写 --item ""）');
    }
    const toItem = hasItem && ctx.args.item !== '' ? ctx.args.item : '';
    const caption = hasCaption ? ctx.args.caption : '';

    // ⚠️ 自链接判定**排在目标检查之前**：与 K8 的检查顺序逐条一致（老调用方看到的报错顺序不变）
    if (to === ctx.projectName && toId === id) ctx.error('不能链接到自身');
    // 目标检查（节点级 + 条目级同一处判据）
    assertTarget(ctx, to, toId, toItem);

    const target = refLabel(to, toId, toItem);
    const report = (p) => {
      if (p.action === 'add') { ctx.out('已添加链接: ' + id + ' → ' + target); return; }
      if (p.action === 'nochange') {
        ctx.out('无变化: ' + id + ' → ' + target + '（链接已存在，未改动；'
          + (p.from ? 'caption: ' + p.from : '无 caption')
          + (p.fromItem ? '；item: ' + p.fromItem : '') + '）');
        return;
      }
      if (p.action === 'clear') {
        // 清空**必须点明清的是哪一层**（caption / item 各自一段，同一句式）：
        // 免得"清掉了一条边的条目层"与"清掉了它的说明"在同一句话里混过去
        const segs = [];
        if (p.clearsItem) segs.push('item 清空（原 item: ' + p.fromItem + '）');
        if (p.clearsCaption) segs.push('caption 清空（原 caption: ' + (p.from || '（无）') + '）');
        ctx.out('已更新链接: ' + id + ' → ' + target + '（' + segs.join('；') + '）');
        return;
      }
      // update：把真的变了的字段写出来（caption 与 item 各一段，没变的那段不写）——
      // "成功与覆盖不可分辨"是 K8 修掉的老病，条目层不许把它重新引进来
      const segs = [];
      if (hasCaption && p.caption !== p.from) {
        segs.push('caption: ' + (p.from || '（无）') + ' → ' + (p.caption || '（无）'));
      }
      if (hasItem && relations.itemKey(p.item) !== p.fromItem) {
        segs.push('item: ' + (p.fromItem || '（无）') + ' → ' + (relations.itemKey(p.item) || '（无）'));
      }
      ctx.out('已更新链接: ' + id + ' → ' + target
        + '（' + (segs.length ? segs.join('；') : '字段已更新') + '）');
    };

    /** 用"这次这一版数据"算出要动的边与计划（探一次与 mutate 内各调一次，口径完全一致） */
    const planAt = (node) => {
      const cands = edgeCandidates(node, to, toId, hasItem, toItem);
      return { cands: cands, plan: planLink(cands.length ? cands[0] : null, hasCaption, caption, hasItem, toItem) };
    };

    // 先探一次（用刚读到的这一版）：盘上已是目标状态就**不产生空写入** ——
    // 与 `links-prune` 的先探后写同一口径。不只是省一次写：`store.write` 还会追加一条
    // `.changes.jsonl`，空写入会让别的会话在 `changes` 里看到"有人动过这里"的假信号。
    const prePlan = planAt(preNode);
    if (prePlan.plan.action === 'nochange') { report(prePlan.plan); return; }

    let plan = prePlan.plan;
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);          // 重放时可能已被别人删掉 ⇒ 报同一句话
      const cur = planAt(node);
      plan = cur.plan;
      if (plan.action === 'nochange') return data;        // 并发期间别人已改成同一状态 ⇒ 一个字节都不动
      if (plan.action === 'add') {
        const link = { project: to, id: toId };
        if (toItem) link.item = toItem;                   // 空串 = 不落 item 键（= 这条边没有条目层）
        if (caption) link.caption = caption;              // 空串 = 不落 caption 键（= 这条边没有说明）
        node.links = (node.links || []).concat(link);
        return data;
      }
      // update / clear：**在原对象上改 caption/item**，不重建对象 —— 边上的其它字段（实测会被旧写法
      // 顺手抹掉的 `note`）与数组顺序都保持不动。
      // （同一条边在数据里若有多条历史副本，一起改 —— 不让它们各说各话；条数不变。）
      cur.cands.forEach((l) => {
        if (plan.clearsCaption) delete l.caption;
        else if (hasCaption) { if (plan.caption === '') delete l.caption; else l.caption = plan.caption; }
        if (plan.clearsItem) delete l.item;               // 清条目层 ⇒ 这条边退回节点级
        else if (hasItem) { if (relations.itemKey(plan.item) === '') delete l.item; else l.item = plan.item; }
      });
      return data;
    });
    report(plan);
  },

  unlink(ctx) {
    const id = ctx.args._[1];
    const to = ctx.args.to;
    const toId = ctx.args.id;
    if (!id || !to || !toId) ctx.error('用法: unlink <项目> <id> --to 目标项目 --id 目标id');
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      const before = (node.links || []).length;
      node.links = (node.links || []).filter((l) => !(l.project === to && l.id === toId));
      if (node.links.length === before) ctx.error('链接不存在: ' + id + ' → ' + to + '/' + toId);
      return data;
    });
    ctx.out('已移除链接');
  },

  /**
   * 列出本项目全部出边。**条目层只增字段**（契约 §7）：带 `item` 的边多一个 `item`
   * 与可读标注 `itemLabel`，v2 的边**逐字节不变**（一个字段都不多）——
   * 于是老消费者（渲染层、doc-facts 的静态真值）照常可用。
   */
  links(ctx) {
    const { data } = ctx.read();
    const out = [];
    ctx.tree.walk(data.data, (n) => {
      (n.links || []).forEach((l) => out.push(relations.withItem(
        { node: n.id, topic: n.topic, project: l.project, id: l.id, caption: l.caption }, l.item)));
    });
    const itemEdges = out.filter((l) => l.item);
    if (ctx.args.json) {
      ctx.outJson({
        project: ctx.projectName,
        links: out,
        // 预算是"能问得出条目层有多少条"，不是在正文里塞一份清单
        itemEdges: { count: itemEdges.length, ids: itemEdges.map((l) => l.node + '#' + l.item) }
      });
      return;
    }
    out.forEach((l) => ctx.out(l.node + ' → ' + l.project + '/' + l.id
      + (l.item ? '#' + l.item : '') + (l.caption ? '  ' + l.caption : '')));
    if (itemEdges.length) ctx.out('（其中 ' + itemEdges.length + ' 条指向**条目**：'
      + itemEdges.map((l) => l.node + '#' + l.item).join(', ') + '）');
  },

  /**
   * 清理悬空链接（修好"悬挂链接"导致的校验红）。
   *   links-prune <项目>                    → 自动找出**确认不存在**的目标并删掉这些链接（默认）
   *   links-prune <项目> --nodes a,b        → 只删指向本项目 a/b 的链接（删节点时用，含指向它们的条目级链接）
   *   links-prune <项目> --items a#i-1,b#i-2 → 只删指向本项目这几个**条目**的链接
   *   links-prune <项目> --dry-run          → 只报告，不写盘
   *
   * 存在意义：链接可以指向**别的项目**，那个项目把节点删掉后，本项目的链接就悬空，
   * validate 判红 → 本项目**所有**写操作都被闸门挡住，而界面上没有"删链接"的入口。
   * 有没有它，决定了"别人删了个节点"能不能自己修好 —— 这与 assoc-prune 是同一类修法。
   *
   * **条目层（S6）**：`links[].item` 指的那一条被删掉（**节点还在**）时，同样是悬挂
   * —— 自动模式按 `relations.refState` 判，把它与"节点整个不在"一起收进清理名单，
   * 但报告里**分开点名**（"节点整个不在了" vs "节点还在、条目已删"，
   * 修法是剪掉这条边，而恢复数据得另说）。`--items` 是等价的精确档（给人点名用）。
   */
  linksPrune(ctx) {
    const { data: pre } = ctx.read();
    const all = links.allLinks(pre.data);
    if (!all.length) { ctx.out('本项目暂无链接，无需清理'); return; }
    // ⚠️ **不要拿 `l.project` 跟任何项目名比较**（实测踩过，两处都会错）：
    //   · `ctx.projectName` 是**源项目**（本次要清理的那个）；`l.project` 是**目标**项目
    //     ⇒ 两者恒不等 ⇒ 谓词永远不命中，而回显照样说"按 --items 清理…没有需要清理的链接"
    //     （**一次静默空转**，比报错坏得多）；
    //   · 换成本次项目名去比同样错：`SRC → DST/T#i-1` 这种边，`l.id` 在 **DST** 里，
    //     跟"本项目"没有必然关系。何况这两档本来就是**给人点名用的强力档**，
    //     `--nodes x` / `--items y#z` 的语义是"**凡是**指向 x / y#z 的边都剪"。
    let should;
    if (ctx.args.nodes !== undefined) {
      const raw = String(ctx.args.nodes).split(',').map((s) => s.trim()).filter(Boolean);
      if (!raw.length) ctx.error('--nodes 内容为空（如 --nodes a,b,c）');
      const set = new Set(raw);
      // 指向该节点 id 的边**一律**剪（含精确指到它某一条目的边）
      should = (l) => set.has(String(l.id));
      ctx.out('按 --nodes 清理指向这些节点的链接（含指向其条目的）: ' + raw.join(', '));
    } else if (ctx.args.items !== undefined) {
      const raw = String(ctx.args.items).split(',').map((s) => s.trim()).filter(Boolean);
      if (!raw.length) ctx.error('--items 内容为空（如 --items a#i-1,b#i-2）');
      const bad = raw.find((s) => s.indexOf('#') < 1 || s.indexOf('#') === s.length - 1);
      if (bad) ctx.error('--items 每项要写成 `节点id#条目id`（收到 ' + JSON.stringify(bad) + '）');
      const set = new Set(raw);
      should = (l) => set.has(String(l.id) + '#' + relations.itemKey(l.item));
      ctx.out('按 --items 清理指向这些**条目**的链接: ' + raw.join(', '));
    } else {
      // 自动模式：只删**能确认不存在**的目标。项目读不出来（损坏/权限）不算"不存在"——
      // 按"采不到真值 = 红"的规矩，不确定就不猜，单独列出来警告。
      //
      // 条目级与节点级**同一处判据**（`relations.refState`）：节点不存在 ⇒ no-node；
      // 节点在、条目不在 ⇒ no-item。两种都进 `gone`（都要剪），但**分开记**
      // 是为了报告能点名"是哪一种坏"（修法不同，含混报出来等于没报）。
      const gone = new Map();            // `项目|节点id[#条目id]` → state
      const unknown = new Set();
      const roots = {};                  // 项目名 → 读盘结局（同一个目标项目只读一次盘）
      all.forEach((x) => {
        const l = x.link;
        if (!l || typeof l.project !== 'string' || typeof l.id !== 'string') return;
        if (!(l.project in roots)) roots[l.project] = readTargetRoot(ctx.PROJECTS_DIR, l.project);
        const got = roots[l.project];
        if (!got.ok && got.reason === 'no-project') { gone.set(l.project + '|' + l.id, 'no-project'); return; }
        if (!got.ok) { unknown.add(l.project + '/' + l.id); return; }   // 读不出来 ⇒ 不猜
        const st = relations.refState(l, got.root, l.project);
        if (st.state === 'ok') return;
        gone.set(st.label.replace('/', '|'), st.state);                // 保持历史键形 `项目|id`
      });
      if (unknown.size) {
        ctx.out('⚠ 以下目标所在项目读不出来，**不**当作悬空处理（请先修好项目再清理）:');
        unknown.forEach((k) => ctx.out('    · ' + k));
      }
      if (!gone.size) {
        ctx.out('没有悬挂链接，无需清理' + (unknown.size ? '（上面读不出来的除外）' : ''));
        return;
      }
      const keys = Array.from(gone.keys());
      ctx.out('发现悬挂链接: ' + keys.map((k) => k.replace('|', '/')).join(', '));
      // 条目级的坏**单独点明**：这一条改了"节点在、条目不在"报告含糊的老毛病
      const itemGone = keys.filter((k) => gone.get(k) === 'no-item');
      if (itemGone.length) {
        ctx.out('其中 ' + itemGone.length + ' 条是**节点还在、条目已被删**（剪掉这些边即可修好；'
          + '要恢复内容请另说）：');
        itemGone.forEach((k) => ctx.out('    · ' + k.replace('|', '/')));
      }
      // ⚠️ 键必须**带上条目层**：`项目|节点` 若不带条目，同节点上"一条条目坏了、另一条好好的"
      // 就会被判成同一条。更坏的是**反例**：一条指向 A 的条目级边与一条指向 B 的节点级边
      // 若共用 `项目|A` 这个键，`gone` 的 Map 会让后写的一方覆盖前者 ⇒ **漏剪**（静默少剪是
      // 最难查的一类）。(undefined) 与 '' 走**同一个键**（both = 无条目层）。
      const goneKey = (project, id, item) => String(project) + '|' + String(id)
        + (relations.itemKey(item) ? '#' + relations.itemKey(item) : '');
      should = (l) => gone.has(goneKey(l.project, l.id, l.item));
    }

    // 先探一次：没有可清理的就不写盘（保持"不产生空写入"）
    const probe = links.pruneLinks(pre.data, should);
    if (!probe.changed) { ctx.out('没有需要清理的链接'); return; }

    let r = probe;
    let alreadyClean = false;
    if (!ctx.args.dryRun) {
      // **并发安全**：判据 `should` 在 fn **外**固定 —— 它依赖**别的项目**的读盘（目标是否还在），
      // 而 fn 里禁止 I/O（并发重放会再调用它一次）。重放只按"我核实过的那份名单"剪，不猜新的。
      // 收益：两个会话同时修、或修的同时别人在改**别的节点**时，不再整体失败。
      ctx.mutate((cur) => {
        const out = links.pruneLinks(cur.data, should);
        r = out;
        if (!out.changed) { alreadyClean = true; return cur; }
        return cur;
      });
    }
    if (alreadyClean) { ctx.out('并发期间这些链接已被其他写入者清掉，本次无需改动'); return; }
    const tag = ctx.args.dryRun ? '[dry-run] 将要' : '已';
    // 条目级的被剪边**逐条标出 `#条目`** —— 那正是"节点还在、条目已被删"这一档。
    // ⚠️ `removed[]` 的元素形状是 `{node, target, caption?, item?}`（`src/links.js` 给的那一份，
    // 与它已有的 `caption` 同一策略：**可选字段**），故这里直接读 `x.item`，**不反查预读数据**
    // （反查要靠标签文本去配对，同源同目标多条边时会配错，看起来却像"标签没写"）。
    r.removed.forEach((x) => ctx.out(tag + '删除链接: ' + x.node + ' → ' + x.target
      + (relations.itemKey(x.item) ? '#' + relations.itemKey(x.item) : '')));
    if (ctx.args.dryRun) ctx.out('（--dry-run：未写盘）');
    else ctx.out('共清理 ' + r.removed.length + ' 条链接，涉及 ' + r.nodes.length + ' 个节点');
  }
};
