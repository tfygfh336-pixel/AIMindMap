/* ============================================================
 * src/assoc.js — 「关联笔记」实体（UMD 纯逻辑，无 IO）
 * ------------------------------------------------------------
 * 为什么要有这个实体（而不是把笔记挂在 links 上）：
 *   `links` 是**逐条声明的有向边**，图结构上完全能表达三角/两两互指；
 *   它表达不了的是「把若干节点的关联当成**一个对象**」。
 *   而"介绍二者/多者之间关联知识"的笔记需要的正是这个对象：
 *     · 可以有自己的标题（挂在某条边上时标题只能写成两端，第三个成员就消失了）
 *     · 有独立身份 —— 不会因为重跑 `link` 被替换、也不会因为 `unlink` 陪葬
 *       （实测：把 note 放在 links[] 上时，重跑 link 会整个替换掉该链接对象 → note 丢失）
 *     · 成员是 N 元的（≥2），可从**任一成员**的「相关知识点」区进入同一页
 *
 * 数据形状（项目级可选集合，与 `data` 平级）：
 *   "assoc": [
 *     { "id": "a-xxx", "title": "…", "members": [{"project":"p","id":"n"}, …], "note": "<p>HTML</p>" }
 *   ]
 * 约定：`note` 与节点 `detail` 同约定 —— 存储是 **HTML**，Markdown 只出现在
 * 导入/导出的边界（CLI 提供 --note-md）。这样渲染层可以直接 innerHTML，实现一致。
 *
 * 本模块只做纯计算（解析、校验、增删改内存对象）；读写盘由 CLI 命令层负责。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MMAssoc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** id 规范与 schema 的**节点 id 完全一致**（小写字母开头，后接小写字母/数字/连字符）。
   *  成员 id 就是节点 id，用同一套规则；关联自身的 id（`a-xxx`）也恰好符合。
   *  曾用更宽的正则（允许大写/下划线），后果是 `Bad_ID` 先通过校验、
   *  再被报成"悬挂成员不存在" —— 错误信息误导，故收紧。 */
  const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

  /** 最少成员数：关联至少要两方，否则不成为"关联" */
  const MIN_MEMBERS = 2;

  /** 生成关联 id（时间戳 + 随机，避免碰撞；带 a- 前缀便于与节点 id 区分） */
  function genId(existing) {
    const have = new Set((existing || []).map((a) => a && a.id));
    for (let i = 0; i < 100; i++) {
      const id = 'a-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      if (!have.has(id)) return id;
    }
    // 理论上到不了这里；真到了就用计数器兜底，绝不返回重复 id
    let n = 1;
    while (have.has('a-' + n)) n++;
    return 'a-' + n;
  }

  /**
   * 解析成员表达式为 [{project, id}]。
   * 支持两种写法（节点 id 与项目名都**不允许含 `/`**，见 schema.ID_RE 与 data-store 的
   * 非法字符校验，故 `/` 是安全的分隔符）：
   *   · `tcp-handshake`   → 本项目（selfProject）
   *   · `comnet/dns`      → 指定项目
   * 也接受已是 {project,id} 的项（幂等，便于 CLI 与别的调用方复用同一函数）。
   *
   * @returns { ok:true, members } | { ok:false, error }
   */
  function parseMembers(input, selfProject) {
    const list = Array.isArray(input)
      ? input
      : String(input === undefined || input === null ? '' : input).split(',');
    const out = [];
    const seen = new Set();
    list.forEach((raw) => {
      if (raw === undefined || raw === null) return;
      let project;
      let id;
      if (typeof raw === 'object') {
        project = raw.project;
        id = raw.id;
      } else {
        const token = String(raw).trim();
        if (!token) return;
        const slash = token.indexOf('/');
        if (slash >= 0) { project = token.slice(0, slash).trim(); id = token.slice(slash + 1).trim(); }
        else { project = selfProject; id = token; }
      }
      if (!id) { out.push({ project: project, id: id }); return; }   // 交由下方统一报错
      if (!ID_RE.test(String(id))) { out.push({ project: project, id: id, bad: true }); return; }
      if (!project) { out.push({ project: project, id: id, noProject: true }); return; }
      const key = project + '|' + id;
      if (seen.has(key)) return;        // 同一成员重复声明 → 去重（不是错误）
      seen.add(key);
      out.push({ project: project, id: id });
    });

    const bad = out.find((m) => m.bad);
    if (bad) return { ok: false, error: '成员 id 不合规范（小写字母/数字/连字符，如 tcp-basics）: ' + bad.id };
    const noProj = out.find((m) => m.noProject);
    if (noProj) return { ok: false, error: '成员缺少项目名（跨项目请写 项目/节点id）' };
    const missing = out.find((m) => !m.id);
    if (missing) return { ok: false, error: '成员缺少节点 id' };

    if (out.length < MIN_MEMBERS) {
      return { ok: false, error: '关联至少需要 ' + MIN_MEMBERS + ' 个**不同**成员（当前 ' + out.length + ' 个）' };
    }
    return { ok: true, members: out };
  }

  /** 关联是否包含某节点 */
  function includes(assoc, project, nodeId) {
    if (!assoc || !Array.isArray(assoc.members)) return false;
    return assoc.members.some((m) => m && m.project === project && m.id === nodeId);
  }

  /** 取某节点所属的全部关联（供「相关知识点」区展示入口） */
  function forNode(assocList, project, nodeId) {
    return (assocList || []).filter((a) => includes(a, project, nodeId));
  }

  /** 成员 → 可读标签（解析不到主题时回退成 项目/id） */
  function memberLabel(member, topicOf) {
    const t = topicOf ? topicOf(member.project, member.id) : null;
    return t || (member.project + '/' + member.id);
  }

  /** 标题兜底：作者没写标题时用成员主题拼一个，而不是留空 */
  function autoTitle(assoc, topicOf) {
    return (assoc.members || []).map((m) => memberLabel(m, topicOf)).join(' ↔ ');
  }

  /**
   * 校验单个关联的结构（**不含**"成员是否真实存在"——那需要读盘，
   * 由 schema.validateProject 的 projectsRoot 分支负责，与悬挂链接同一处）。
   * @returns { ok, errors:[string] }
   */
  function validateAssoc(assoc, index) {
    const errors = [];
    const at = 'assoc[' + index + ']';
    if (!assoc || typeof assoc !== 'object') return { ok: false, errors: [at + ' 不是对象'] };
    if (typeof assoc.id !== 'string' || !assoc.id) errors.push(at + ' 缺少 id');
    else if (!ID_RE.test(assoc.id)) errors.push(at + ' 的 id 不合规范: ' + assoc.id);
    if (assoc.title !== undefined && typeof assoc.title !== 'string') errors.push(at + ' 的 title 必须是字符串');
    if (assoc.note !== undefined && typeof assoc.note !== 'string') errors.push(at + ' 的 note 必须是字符串（HTML）');
    if (!Array.isArray(assoc.members)) {
      errors.push(at + ' 的 members 必须是数组');
    } else {
      if (assoc.members.length < MIN_MEMBERS) errors.push(at + ' 至少需要 ' + MIN_MEMBERS + ' 个成员');
      const seen = new Set();
      assoc.members.forEach((m, i) => {
        const mAt = at + '.members[' + i + ']';
        if (!m || typeof m !== 'object') { errors.push(mAt + ' 不是对象'); return; }
        if (typeof m.project !== 'string' || !m.project) errors.push(mAt + ' 缺少 project');
        if (typeof m.id !== 'string' || !m.id) errors.push(mAt + ' 缺少 id');
        if (typeof m.project === 'string' && typeof m.id === 'string') {
          const k = m.project + '|' + m.id;
          if (seen.has(k)) errors.push(mAt + ' 重复成员: ' + k);
          seen.add(k);
        }
      });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * 剪掉符合条件的成员，并清掉因此不足 MIN_MEMBERS 的关联（只剩一个成员 = 不再成为"关联"）。
   *
   * 为什么必须有它：删节点时若不同步处理 assoc，就会留下"悬挂成员"→ validate 判红；
   * 而 `project:save` 是**校验闸门**（main.js 写盘前必跑 CLI validate），于是保存被拒；
   * 界面又只有「编辑笔记」、没有改成员的入口 → 用户被彻底卡死（只能靠 CLI 救）。
   * 所以"删节点"这条路上必须能安全地剪掉引用。
   *
   * 纯函数：不修改入参，返回新数组（未受影响的关联按原引用带回）。
   * 判定用**谓词**而不是"项目 + id 列表"：跨项目时同一个 id 可能在一个项目里悬空、
   * 在另一个项目里合法，用扁平 id 集合会误删（如 p1/dns 悬空而 p2/dns 正常）。
   *
   * @param {Array} assocList 现有 assoc 集合
   * @param {(member:{project:string,id:string}) => boolean} shouldRemove 命中即剪掉该成员
   * @returns {{ list:Array, changed:boolean, empty:boolean,
   *            touched:Array<{id:string,removed:number}>, dropped:Array<string> }}
   */
  function pruneMembers(assocList, shouldRemove) {
    const list = Array.isArray(assocList) ? assocList : [];
    const hit = typeof shouldRemove === 'function' ? shouldRemove : function () { return false; };
    const touched = [];
    const dropped = [];
    const out = [];
    list.forEach((a) => {
      if (!a || !Array.isArray(a.members)) { out.push(a); return; }
      const gone = a.members.filter((m) => m && hit(m));
      if (!gone.length) { out.push(a); return; }
      const kept = a.members.filter((m) => !(m && hit(m)));
      if (kept.length < MIN_MEMBERS) { dropped.push(a.id); return; }
      touched.push({ id: a.id, removed: gone.length });
      out.push(Object.assign({}, a, { members: kept }));
    });
    return {
      list: out,
      changed: touched.length > 0 || dropped.length > 0,
      empty: out.length === 0,
      touched: touched,
      dropped: dropped
    };
  }

  /** 全集合校验：结构 + id 唯一。undefined/null 视为"没有关联"（合法）。 */
  function validateAll(assocList) {
    if (assocList === undefined || assocList === null) return { ok: true, errors: [] };
    if (!Array.isArray(assocList)) return { ok: false, errors: ['assoc 必须是数组'] };
    const errors = [];
    const seen = new Set();
    assocList.forEach((a, i) => {
      const r = validateAssoc(a, i);
      errors.push.apply(errors, r.errors);
      if (a && typeof a.id === 'string') {
        if (seen.has(a.id)) errors.push('assoc[' + i + '] 重复 id: ' + a.id);
        seen.add(a.id);
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  return {
    ID_RE, MIN_MEMBERS, genId, parseMembers, includes, forNode,
    memberLabel, autoTitle, pruneMembers, validateAssoc, validateAll
  };
});
