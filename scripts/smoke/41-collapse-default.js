/* ============================================================
 * scripts/smoke/41-collapse-default.js —— 折叠默认（用户 2026-10-13 反馈）
 * ------------------------------------------------------------
 * 用户原话："展开一棵新开的树或者新编辑的子树，应该是**默认折叠**"。
 * 四条判据的全文与裁决见 `.review/20261010-卖点与功能-常驻讨论/折叠默认-实施规格.md` §四；
 * 本域钉住其中三条，第四条（打开项目只展开根、用 elementFromPoint 判可见性）落在 17 域。
 *
 *   甲 新建节点是**折叠**的：`add` / `add-root` 不给 `--expanded` ⇒ 盘上 `expanded` **键存在且为 false**
 *      ——"缺键即 true"是本工程的判据地基（`src/schema.js`），靠省略永远折不起来；
 *   乙 import（md / project / dir）产生的**新子树**一律折叠，且 **`import-md` 后父结点逐字节未变**
 *      （前导正文那条路会把父节点写进 detail ⇒ 本域刻意用"第一行就是 `#`"的样本避开它，
 *       把"父节点没被动过"变成一条真的判据）；
 *   丙 手动展开过的节点在**别处**被增量编辑 + 重开项目之后**仍然展开**（数据 + 视图两侧都查）
 *      —— 这条守的是"把'新建即折叠'实现成'每次写盘都整树 normalize'"，那会把用户的折叠/展开全抹平。
 *
 * 真值口径：一律读**沙箱里的项目 JSON 原文**（`AI_MINDMAP_PROJECTS_DIR` 由 main.js 在 `--smoke` 下
 * 指向临时副本 ⇒ 读到的就是本次跑动的真实盘上形态，且**零真实数据风险** ✓）。
 * 为什么不用命令回显当判据：回显是**第二份表述**，而这里要钉的恰好是"盘上到底写了什么"。
 * ⚠️ 本文件里的注释不要写成行内标记形态（G9 会把那种形态当判定条数去数）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const settle = 'new Promise(function (r) { setTimeout(r, 260); })';

/** 沙箱项目 JSON 的绝对路径。取不到就**抛**（"采不到真值 ⇒ 红"，不许静默跳过 —— A5 口径） */
function projectFile(name) {
  const dir = process.env.AI_MINDMAP_PROJECTS_DIR;
  if (!dir) throw new Error('没有 AI_MINDMAP_PROJECTS_DIR（不是 --smoke 路径？）⇒ 取不到盘上真值');
  return path.join(dir, name, name + '.json');
}
function readRaw(name) { return fs.readFileSync(projectFile(name), 'utf8'); }
function readProject(name) { return JSON.parse(readRaw(name)); }
function findNode(proj, id) {
  let hit = null;
  (function walk(n) {
    if (!n || hit) return;
    if (n.id === id) { hit = n; return; }
    (n.children || []).forEach(walk);
  })(proj && proj.data);
  return hit;
}
function hasExpandedKey(n) { return !!n && Object.prototype.hasOwnProperty.call(n, 'expanded'); }
/** 盘上某个节点的展开态（**连键一起查**：缺键 = 展开，只查值会把缺键读成"折叠" ✗） */
function expansionOf(name, id) {
  const n = findNode(readProject(name), id);
  if (!n) return { found: false };
  return { found: true, hasKey: hasExpandedKey(n), value: n.expanded };
}
/** 整棵树里"不是折叠"的节点（根除外）—— 用来判"新子树一律折叠" */
function notCollapsed(proj) {
  const out = [];
  (function walk(n, d) {
    if (!n) return;
    if (n.id !== 'root' && (!hasExpandedKey(n) || n.expanded !== false)) {
      out.push(n.id + '(层' + d + ' 键=' + hasExpandedKey(n) + ' 值=' + n.expanded + ')');
    }
    (n.children || []).forEach((c) => walk(c, d + 1));
  })(proj.data, 0);
  return out;
}
function descendantsOf(proj, id) {
  const n = findNode(proj, id);
  return n ? (n.children || []) : null;
}
const tmpPath = (name) => path.join(os.tmpdir(), name);
/** 每次跑动都换一份唯一的样本文本与文件名，而且**三条导入路各用一份不同的内容**：
 *  导入器的幂等闸门认"来源指纹"（文件路径 + 规范化正文），
 *  ① 固定样本会让第二次跑动撞上"这份文档已经导入过"；
 *  ② `import-project` / `import-dir` 的闸门**扫全库**（不是只看本项目）⇒ 同一份内容先经 `import-md`
 *     进了别的项目，再来建新项目同样会被拒 ✗（实测踩到）。分开就都不撞。 */
const STAMP = String(Date.now());
const SAMPLE_MD = '# 甲书' + STAMP + '\n正文甲\n\n## 甲章\n正文甲章\n\n### 甲节\n正文甲节\n\n# 乙书\n正文乙\n';
const SAMPLE_MD_PJ = '# 丙书' + STAMP + '\n正文丙\n\n## 丙章\n正文丙章\n';
const SAMPLE_MD_DIR_A = '# 丁书' + STAMP + '\n正文丁\n';
const SAMPLE_MD_DIR_B = '# 戊书' + STAMP + '\n正文戊\n';

const assertions = [
  {
    name: '甲 新建节点默认折叠：add / add-root 不给 --expanded ⇒ 盘上 `expanded` 键存在且为 false（--expanded true 逃生门照旧）',
    run: async (ctx) => {
      const P = 'zz-collapse-add';
      ctx.runCli(['init', P]);
      ctx.runCli(['add', P, 'root', '--topic', '甲', '--id', 'n1']);
      ctx.runCli(['add', P, 'n1', '--topic', '甲一', '--id', 'n11']);
      ctx.runCli(['add-root', P, '--topic', '主题乙', '--id', 't2']);
      // 逃生门：显式给 true 必须仍然写 true（证明"默认折叠"没把接口改成"只能折叠"）
      ctx.runCli(['add', P, 'root', '--topic', '丙（显式展开）', '--id', 'n3', '--expanded', 'true']);

      const n1 = expansionOf(P, 'n1');
      const n11 = expansionOf(P, 'n11');
      const t2 = expansionOf(P, 't2');
      const n3 = expansionOf(P, 'n3');
      const root = expansionOf(P, 'root');
      // 命令面与盘上必须**同一口径**（不是两套）：`get --json` 的 expanded 与盘上值一致
      const viaCli = JSON.parse(ctx.runCli(['get', P, 'n1', '--json'])).expanded;

      const def = [['n1', n1], ['n11', n11], ['t2', t2]];
      const bad = def.filter((p) => !(p[1].found && p[1].hasKey && p[1].value === false));
      return {
        ok: bad.length === 0 && n3.value === true && n3.hasKey === true
          && root.value === true && viaCli === false,
        text: '默认三处=' + def.map((p) => p[0] + ':' + (p[1].hasKey ? p[1].value : '缺键')
          + (p[1].hasKey ? '' : '(键不存在 ✗)')).join(' ')
          + ' · 逃生门 n3=' + (n3.hasKey ? n3.value : '缺键') + '（须 true）'
          + ' · 根=' + root.value + '（根照旧展开）'
          + ' · get --json 与盘上一致=' + (viaCli === false)
          + (bad.length ? ' ✗ 不是"键存在且为 false"：' + JSON.stringify(bad) : '')
      };
    }
  },

  {
    name: '乙 import 的新子树一律折叠（md / project / dir），且 import-md 后**父节点逐字节未变**、三种导入的根仍展开',
    run: async (ctx) => {
      const P = 'zz-collapse-import';
      const P2 = 'zz-collapse-import-project';
      const dir = tmpPath('zz-collapse-dir-src-' + STAMP);
      const mdFile = tmpPath('zz-collapse-sample-' + STAMP + '.md');
      const mdFilePj = tmpPath('zz-collapse-sample-pj-' + STAMP + '.md');
      let out;
      try {
        fs.writeFileSync(mdFile, SAMPLE_MD, 'utf8');            // node 写盘：无 BOM ✓
        fs.writeFileSync(mdFilePj, SAMPLE_MD_PJ, 'utf8');
        fs.mkdirSync(path.join(dir, '子目录'), { recursive: true });
        fs.writeFileSync(path.join(dir, '一号.md'), SAMPLE_MD_DIR_A, 'utf8');
        fs.writeFileSync(path.join(dir, '子目录', '二号.md'), SAMPLE_MD_DIR_B, 'utf8');

        // —— import-md：追到已有父节点下，父节点**除 children 之外**一个字节都不许动 ——
        // （`children` 当然会多出这次导入的顶层主题 —— 那不是"被动过"，是本来的目的；
        //   判据要的是"父节点自己的字段（尤其 `expanded`）没被顺带改/顺带展开" ✓）
        ctx.runCli(['init', P]);
        ctx.runCli(['add', P, 'root', '--topic', '父', '--id', 'par']);
        const selfOf = (node) => JSON.stringify(Object.assign({}, node, { children: null }));
        const parBefore = selfOf(findNode(readProject(P), 'par'));
        ctx.runCli(['import-md', P, mdFile, '--parent', 'par']);
        const proj = readProject(P);
        const parAfter = selfOf(findNode(proj, 'par'));
        const books = descendantsOf(proj, 'par') || [];
        const firstBook = books[0] || null;
        const chap = firstBook ? (firstBook.children || [])[0] : null;
        const sect = chap ? (chap.children || [])[0] : null;
        const mdBad = notCollapsed(proj);
        const level0 = firstBook ? expansionOf(P, firstBook.id) : { found: false };
        const level1 = chap ? expansionOf(P, chap.id) : { found: false };
        const level2 = sect ? expansionOf(P, sect.id) : { found: false };

        // —— import-project：从零建项目（根 = 该文档；1 级标题成为顶层主题）——
        ctx.runCli(['import-project', P2, mdFilePj]);
        const proj2 = readProject(P2);
        const pjBad = notCollapsed(proj2);

        // —— import-dir：一个目录 → 一棵与文件夹同构的树 ——
        ctx.runCli(['import-dir', P2 + '-dir', dir]);
        const proj3 = readProject(P2 + '-dir');
        const dirBad = notCollapsed(proj3);

        out = {
          ok: parAfter === parBefore
            && mdBad.length === 0 && level0.value === false && level0.hasKey === true
            && level1.value === false && level2.value === false
            && books.length === 2
            && expansionOf(P2, 'root').value === true && pjBad.length === 0
            && expansionOf(P2 + '-dir', 'root').value === true && dirBad.length === 0,
          text: 'import-md：父节点（除 children 外）逐字节未变=' + (parAfter === parBefore)
            + ' · 顶层主题=' + books.length + ' 个 · 层0/1/2 折叠=' + [level0, level1, level2]
              .map((x) => (x.hasKey ? x.value : '缺键')).join('/')
            + ' · 非折叠节点=' + mdBad.length + (mdBad.length ? ' ✗' + mdBad.slice(0, 4).join('、') : '')
            + ' · import-project：根展开=' + expansionOf(P2, 'root').value + ' 非折叠=' + pjBad.length
              + (pjBad.length ? ' ✗' + pjBad.slice(0, 4).join('、') : '')
            + ' · import-dir：根展开=' + expansionOf(P2 + '-dir', 'root').value + ' 非折叠=' + dirBad.length
              + (dirBad.length ? ' ✗' + dirBad.slice(0, 4).join('、') : '')
        };
      } finally {
        // 收尾：临时样本只在跑动期间存在（E2：长流程的副产物必须收干净；异常照旧上抛 ✓）
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清不掉不掩盖主判据 */ }
        try { fs.rmSync(mdFile, { force: true }); } catch (e) { /* 同上 */ }
        try { fs.rmSync(mdFilePj, { force: true }); } catch (e) { /* 同上 */ }
      }
      return out;
    }
  },

  {
    name: '丙 手动展开在**别处**被增量编辑 + 重开项目之后仍在（数据 + 视图两侧；打开只展开根不许抹掉它）',
    run: async (ctx) => {
      const P = 'zz-collapse-manual';
      ctx.runCli(['init', P]);
      ctx.runCli(['add', P, 'root', '--topic', '主题甲', '--id', 't1']);
      ctx.runCli(['add', P, 't1', '--topic', '甲', '--id', 'na']);
      ctx.runCli(['add', P, 'na', '--topic', '甲一', '--id', 'na1']);
      // ⚠️ 手动展开的那一个必须**比"前两层"更深**（这里是第 4 层：root → t1 → 甲 → 甲一 → 甲二）：
      //    本判据要抓的反面实现是"每次写盘顺手 `expand-depth --depth 2`"那一类整树归一 ——
      //    若手动展开点落在被归一覆盖的浅层，注入照样绿（实测踩到：depth≤2 时注入**抓不住** ✗）。
      ctx.runCli(['add', P, 'na1', '--topic', '甲二', '--id', 'na2']);
      ctx.runCli(['add', P, 'na2', '--topic', '甲三', '--id', 'na3']);
      ctx.runCli(['add-root', P, '--topic', '主题乙', '--id', 't2']);
      ctx.runCli(['add', P, 't2', '--topic', '乙', '--id', 'nb']);

      await ctx.exec('window.MMApp.openProject("' + P + '")');
      await ctx.exec(settle);
      // 手动展开 甲二 —— 就是用户点圆钮做的事（jsMind 的 expand_node，见 renderer/app-view.js 的圆钮绑定）
      await ctx.exec('(function () { window.MMApp.getState().jm.expand_node("na2"); return true; })()');
      await ctx.exec(settle);
      // 保存：展开态是**数据**（裁决三 —— 手动展开仍持久化在数据层）
      await ctx.exec('(async function () { await window.MMApp.save(); return true; })()');
      await ctx.exec(settle);
      const afterSave = expansionOf(P, 'na2');
      // 别处增量编辑：**另一个子树**（t2 → 乙）下加一个节点
      ctx.runCli(['add', P, 'nb', '--topic', '乙一', '--id', 'nb1']);
      const afterEdit = expansionOf(P, 'na2');
      // 重开项目（同一份盘上数据再渲染一次 = renderMind ⇒ 会做"只展开根"的视图归一）
      await ctx.exec('window.MMApp.openProject("' + P + '")');
      await ctx.exec(settle);
      const view = await ctx.exec(`(function () {
        var jm = window.MMApp.getState().jm;
        var val = function (id) { var n = jm.get_node(id); return n ? n.expanded !== false : null; };
        return { a: val('na2'), t1: val('t1'), b1: !!jm.get_node('nb1'), t2: val('t2') };
      })()`);
      const final = expansionOf(P, 'na2');
      return {
        ok: afterSave.hasKey === true && afterSave.value === true
          && afterEdit.hasKey === true && afterEdit.value === true          // 别处的增量编辑不许把它抹平
          && final.hasKey === true && final.value === true                  // 重开项目后盘上仍在
          && view.a === true                                               // 视图节点标志也没被打开动作抹掉
          && view.t1 === false                                             // 打开 ⇒ 只展开根（顶层主题被收起）
          && view.b1 === true,                                             // 别处那次编辑确实生效了
        text: '保存后 甲=' + (afterSave.hasKey ? afterSave.value : '缺键')
          + ' · 别处增量编辑后 甲=' + (afterEdit.hasKey ? afterEdit.value : '缺键')
          + ' · 重开项目后：盘上 甲=' + (final.hasKey ? final.value : '缺键')
          + ' · 视图 甲=' + view.a + '（须 true）· 顶层主题 t1=' + view.t1 + '（须 false = 只展开根）'
          + ' · 别处编辑落盘=' + view.b1
      };
    }
  }
];

module.exports = assertions;
