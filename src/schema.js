/* ============================================================
 * src/schema.js — 数据格式校验（UMD）
 * ------------------------------------------------------------
 * 校验 projects/<name>/<name>.json（formatVersion 2）：
 *   - 整体结构（meta/format/data）
 *   - 节点字段（id/topic/children/detail/images/links）
 *   - id 规范（小写字母/数字/连字符，禁止空白与中文）
 *   - 图片必填字段（file/caption）
 *   - 跨项目链接悬挂检测（links 指向的 project+id 必须存在）
 *   - 关联笔记（data.assoc）：结构与成员悬挂检测
 * 供 CLI validate / 主进程保存闸门 / 测试三方共用。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fs'), require('path'), require('./assoc.js'));
  } else {
    root.MMSchema = factory(null, null, root.MMAssoc);   // 浏览器不校验；assoc 可能未加载，下方有守卫
  }
})(typeof self !== 'undefined' ? self : this, function (fs, path, assoc) {
  'use strict';

  const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

  /**
   * 每次校验用**自己的**数组，最后随结果一起返回。
   *
   * 曾经用模块级共享 `errors` 数组（调用时 `errors.length = 0` 复用）——
   * 那会让**先前返回的结果对象被后续调用改写**：
   *   v1 = validateProject(好数据)   // {ok:true, errors:[]}
   *   validateProject(坏数据)         // 同一个数组被清空后重新填充
   *   v1.errors  =>  ['…']           // ok 仍为 true，却带着错误 → 自相矛盾
   * 任何"先收集多份结果、再统一报告"的调用方都会读到被污染的数组。
   * 现改为局部数组；`err` 的作用域随之收进 validateProject。
   * @param {object} data 待校验的项目数据（**即将落盘的那一份**）
   * @param {string} [projectsRoot] 给出则做悬挂检测（需跨项目读盘）
   * @param {string} [selfProject] 入参 data 对应的项目名。给了它，**同项目**的
   *   链接/关联成员就以 `data` 自身为准，而不是去读磁盘上的旧文件。
   *   不给的后果（实测）：写盘闸门永远慢一步 —— 删掉被关联引用的节点能写进去
   *   （闸门看磁盘，那时节点还在），此后该项目**所有**写命令都被这条悬挂成员挡住，
   *   直到 assoc-prune 才解开。跨项目成员只能读盘（磁盘是唯一真值），保持不变。
   */
  function validateProject(data, projectsRoot, selfProject) {
    const errors = [];
    const err = (msg, nodeId) => {
      errors.push(nodeId ? '[' + nodeId + '] ' + msg : msg);
    };
    if (!data || typeof data !== 'object') { err('顶层必须是对象'); return { ok: false, errors }; }
    if (!data.meta || typeof data.meta !== 'object') err('缺少 meta');
    else {
      if (typeof data.meta.name !== 'string' || !data.meta.name.trim()) err('meta.name 必填');
      if (data.meta.formatVersion !== undefined && data.meta.formatVersion !== 2) err('meta.formatVersion 必须为 2');
      // 主题布局（可选）：meta.layout = { left: [主题id], right: [主题id] }，决定顶层主题的左右分侧
      if (data.meta.layout !== undefined) {
        if (typeof data.meta.layout !== 'object' || Array.isArray(data.meta.layout)) err('meta.layout 必须是对象');
        else ['left', 'right'].forEach((side) => {
          const ids = data.meta.layout[side];
          if (ids !== undefined) {
            if (!Array.isArray(ids)) err('meta.layout.' + side + ' 必须是数组');
            else ids.forEach((id) => {
              if (typeof id !== 'string' || !ID_RE.test(id)) err('meta.layout.' + side + ' 含非法 id（小写字母/数字/连字符）: ' + id);
            });
          }
        });
      }
      // 树偏移（可选，2026-10-08 新增）：meta.themeOffsets = { "<顶层主题id>": { x, y } }
      // 语义：界面把顶层主题拖到别处后的**相对偏移**（逻辑画布像素，相对该主题的自动布局位置）；
      // 缺省 = 全部按自动布局。只影响呈现，不改变树结构 —— 所以它是可选字段、formatVersion 不升。
      // 上下界（±20000）不是随手写的：它是"明显异常数据"的护栏（自动布局量级是千像素级），
      // 防止坏数据把内容推到视口之外、用户再也找不回来。
      if (data.meta.themeOffsets !== undefined) {
        const TO = data.meta.themeOffsets;
        const LIMIT = 20000;
        if (typeof TO !== 'object' || TO === null || Array.isArray(TO)) err('meta.themeOffsets 必须是对象');
        else Object.keys(TO).forEach((tid) => {
          if (!ID_RE.test(tid)) err('meta.themeOffsets 含非法 id（小写字母/数字/连字符）: ' + tid);
          const p = TO[tid];
          if (typeof p !== 'object' || p === null || Array.isArray(p)) { err('meta.themeOffsets.' + tid + ' 必须是 {x,y} 对象'); return; }
          ['x', 'y'].forEach((k) => {
            const v = p[k];
            if (typeof v !== 'number' || !Number.isFinite(v)) err('meta.themeOffsets.' + tid + '.' + k + ' 必须是有限数字');
            else if (Math.abs(v) > LIMIT) err('meta.themeOffsets.' + tid + '.' + k + ' 超出允许范围（±' + LIMIT + '）: ' + v);
          });
        });
      }
    }
    if (data.format !== 'node_tree') err('format 必须为 "node_tree"');
    if (!data.data) err('缺少 data（根节点）');
    else {
      // 先迭代检测环：递归 validateNode 遇环会栈溢出，必须先拦截
      const seen = new Set();
      const stack = [data.data];
      let cyclic = false;
      while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        if (seen.has(n)) { err('树存在环（节点被重复访问）', n.id); cyclic = true; break; }
        seen.add(n);
        (n.children || []).forEach((c) => stack.push(c));
      }
      if (!cyclic) {
        // 形状校验（逐节点字段）与「重复 id / 环」分开：
        // 后者必须是**整棵树的一次遍历**。原先把它写在 validateNode 里，
        // 而 validateNode 对每个子节点递归 + 又对本子树做一次迭代扫描 →
        // 同一处重复 id 按祖先层数被**重复报多次**（3 层嵌套报 3 次，实测）。
        validateNode(data.data, err);
        checkIdsAndCycles(data.data, err);
      }
    }

    // 关联笔记的结构校验（不需要读盘）。
    // 浏览器侧可能没加载 assoc.js（渲染层不校验），故加守卫而不是直接调用。
    if (assoc && assoc.validateAll) {
      const assocCheck = assoc.validateAll(data.assoc);
      if (!assocCheck.ok) assocCheck.errors.forEach((e) => err(e));
    }

    // 悬挂检测（需跨项目文件系统）：链接目标 + 关联成员，同一处逻辑
    if (projectsRoot && fs && path) {
      // 同项目成员的节点集合（惰性构建：绝大多数项目没有悬挂问题，不必先遍历）
      let selfIds = null;
      /** 某项目的 JSON 里是否存在该节点；不可读时返回异常标记（调用方报"无法读取"） */
      const nodeExists = (proj, nodeId) => {
        // 同项目：以入参 `data` 为准 —— 那才是即将写下去的真值。
        // 读盘会把"我刚删掉的那个节点"算成还在（磁盘尚未覆盖），闸门因此漏判。
        if (selfProject && proj === selfProject) {
          if (selfIds === null) {
            selfIds = new Set();
            flatten(data && data.data).forEach((n) => { if (n && n.id !== undefined) selfIds.add(n.id); });
          }
          return selfIds.has(nodeId) ? 'yes' : 'no';
        }
        const p = path.join(projectsRoot, proj, proj + '.json');
        if (!fs.existsSync(p)) return 'no-project';
        try {
          const pd = JSON.parse(fs.readFileSync(p, 'utf8'));
          const found = (function findNode(r) {
            if (!r) return false;
            if (r.id === nodeId) return true;
            return (r.children || []).some(findNode);
          })(pd.data);
          return found ? 'yes' : 'no';
        } catch (e) {
          return 'unreadable:' + (e.message || e);
        }
      };

      flatten(data.data).forEach((n) => {
        (n.links || []).forEach((l, i) => {
          if (!l || typeof l !== 'object') { err('links[' + i + '] 不是对象', n.id); return; }
          if (!l.project || !l.id) { err('links[' + i + '] 缺少 project/id', n.id); return; }
          const r = nodeExists(l.project, l.id);
          if (r === 'no-project') err('悬挂链接: 项目不存在 ' + l.project, n.id);
          else if (r === 'no') err('悬挂链接: ' + l.project + '/' + l.id + ' 不存在', n.id);
          else if (r !== 'yes') err('悬挂链接: 无法读取 ' + l.project + '（' + r.slice(11) + '）', n.id);
        });
      });

      // 关联成员悬挂：成员指向的节点若已不存在，该关联就是坏的。
      // 与悬挂链接同样按项目名读盘（不是 meta.name）——成员里的 project 就是项目目录名。
      (Array.isArray(data.assoc) ? data.assoc : []).forEach((a, ai) => {
        if (!a || !Array.isArray(a.members)) return;
        a.members.forEach((m, mi) => {
          if (!m || typeof m !== 'object' || !m.project || !m.id) return;  // 结构问题已由 validateAll 报过
          const r = nodeExists(m.project, m.id);
          const at = 'assoc[' + ai + '].members[' + mi + ']';
          if (r === 'no-project') err('悬挂关联成员: 项目不存在 ' + m.project, at);
          else if (r === 'no') err('悬挂关联成员: ' + m.project + '/' + m.id + ' 不存在', at);
          else if (r !== 'yes') err('悬挂关联成员: 无法读取 ' + m.project + '（' + r.slice(11) + '）', at);
        });
      });
    }
    return { ok: errors.length === 0, errors };
  }

  /** 形状校验：只校验节点**自身字段**并递归子节点；不做 id 去重/环检测（见 checkIdsAndCycles） */
  function validateNode(node, err) {
    if (!node || typeof node !== 'object') { err('节点必须是对象'); return; }
    if (typeof node.id !== 'string' || !node.id) err('缺少 id');
    else if (!ID_RE.test(node.id)) err('id 不合规范（小写字母/数字/连字符，如 my-node）: ' + node.id);
    if (typeof node.topic !== 'string' || !node.topic.trim()) err('缺少 topic（节点标题）', node.id);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) err('children 必须是数组', node.id);
      else node.children.forEach((c) => validateNode(c, err));
    }
    if (node.detail !== undefined && typeof node.detail !== 'string') err('detail 必须是字符串', node.id);
    if (node.tags !== undefined) {
      if (!Array.isArray(node.tags)) err('tags 必须是数组', node.id);
      else node.tags.forEach((t, i) => {
        if (typeof t !== 'string' || !t.trim()) err('tags[' + i + '] 必须是非空字符串', node.id);
      });
    }
    // 本机文件夹路径（可选）：节点对应的目录在**本机**的绝对路径，界面点击后用系统文件管理器打开。
    // 它是 `docs/DATA-FORMAT.md`「禁止绝对路径」的**明文例外**（见该文 §2.5）：
    // 目录快捷方式天然是机器本地的（不像 assets/ 的相对引用要保证可移植）。
    // ⚠️ **只校验形状，不校验存在性** —— 存在性依赖运行环境（盘可能没挂、目录可能还没建），
    // 把它做成校验条件会让"换台机器打开就连 validate 都红"，那是把环境问题伪装成数据问题。
    if (node.localPath !== undefined) {
      if (typeof node.localPath !== 'string' || !node.localPath.trim()) err('localPath 必须是非空字符串', node.id);
      else if (/[\r\n]/.test(node.localPath)) err('localPath 不能含换行', node.id);
      else if (node.localPath.length > 500) err('localPath 过长（超过 500 字符）', node.id);
    }
    if (node.images !== undefined) {
      if (!Array.isArray(node.images)) err('images 必须是数组', node.id);
      else node.images.forEach((img, i) => {
        if (!img || typeof img !== 'object') { err('images[' + i + '] 不是对象', node.id); return; }
        if (typeof img.file !== 'string' || !img.file) err('images[' + i + '] 缺少 file', node.id);
        if (typeof img.caption !== 'string' || !img.caption.trim()) err('images[' + i + '] 缺少 caption（AI 理解图片的备注）', node.id);
      });
    }
    if (node.files !== undefined) {
      if (!Array.isArray(node.files)) err('files 必须是数组', node.id);
      else node.files.forEach((f, i) => {
        if (!f || typeof f !== 'object') { err('files[' + i + '] 不是对象', node.id); return; }
        if (typeof f.file !== 'string' || !f.file) err('files[' + i + '] 缺少 file', node.id);
        if (typeof f.caption !== 'string' || !f.caption.trim()) err('files[' + i + '] 缺少 caption（AI 理解附件的备注）', node.id);
      });
    }
    if (node.links !== undefined && !Array.isArray(node.links)) err('links 必须是数组', node.id);
  }

  /** 重复 id 与环检测：对整棵树做**一次**迭代遍历（不递归，避免环导致栈溢出） */
  function checkIdsAndCycles(root, err) {
    const seenNodes = new Set();
    const seenIds = new Set();
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if (seenNodes.has(n)) { err('树存在环（节点被重复访问）', n.id); continue; }
      seenNodes.add(n);
      if (seenIds.has(n.id)) err('重复 id: ' + n.id, n.id);
      seenIds.add(n.id);
      (n.children || []).forEach((c) => stack.push(c));
    }
  }

  function flatten(root) {
    const out = [];
    (function w(n) { if (!n) return; out.push(n); (n.children || []).forEach(w); })(root);
    return out;
  }

  return { validateProject, validateNode, checkIdsAndCycles, flatten, ID_RE };
});
