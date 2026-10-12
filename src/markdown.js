/* ============================================================
 * src/markdown.js — Markdown ⇄ 节点树（UMD）
 * ------------------------------------------------------------
 * 职责：
 *   - markdownToTree(md, parentId, idGen)：md → 子树，追加到 parent 下
 *     （CLI import-md 使用）。支持两种形态，自动识别：
 *       · heading 形态：`# 标题` / `## 子标题`（# 数量 = 层级）
 *       · list 形态：`- 标题`（每级缩进 2 空格）
 *     正文处理：
 *       · `> ...` 引用块 → 还原为节点 detail（HTML），与导出成对
 *       · `![图：备注](assets/x.png)` → 节点 images；`[📎 备注 — attachments/x.md](…)` → 节点 files
 *         —— ⚠️ 这里只**登记引用字符串**（`parseResource` 的产物原样入树）；
 *         要把引用**落到项目里**（复制文件 + 改写成项目内相对路径）必须再走 `resolveImportRefs`
 *         （【W19】：不走的调用方就会留下悬空引用，见下面那一整段）
 *       · 其余非标题行 → 也转成 detail（HTML），保证 detail 始终是 HTML
 *   - treeToMarkdown(tree, {format, withDetail, withResources})：节点树 → 大纲
 *     （CLI export-md 使用）
 *   - resolveImportRefs(roots, opts)：把节点上挂的图片/附件引用**落到项目里**
 *     （复制 + 改写成项目内相对路径；【W19】，见下面那一整段）
 * 说明：导入是「追加为子树」，因此整份导出再导入会把顶层标题也变成一个节点
 *   （导出文档的第一行标题 = 文档标题，不是父节点本身）。
 * ⚠️ fs / path 只在 **Node 分支**注入（UMD 的浏览器分支传 null）：`markdownToTree` /
 *   `treeToMarkdown` 依旧是纯函数、双端可用；只有「资源落地」这一件事是 Node/CLI 侧的。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./convert.js'), require('fs'), require('path'));
  } else {
    root.MMMarkdown = factory(root.MMConvert, null, null);
  }
})(typeof self !== 'undefined' ? self : this, function (convert, fs, path) {
  'use strict';

  const H_RE = /^(#{1,6})\s+(.*)$/;
  const L_RE = /^(\s*)[-*]\s+(.*)$/;

  /**
   * 生成符合 id 规范的 id。
   *
   * `seq` 是**可选**的确定性序号（不传 = 老行为：时间戳 + 随机后缀，逐字节不变）——
   * `apply` 的一次事务里若有多个 `add`，产出的 id 必须**可复现**（同一份 ops 文件重跑得同一份数据），
   * 而"时间 + 随机"永远做不到。传了 `seq` 时 id 只由 `(标题, 序号)` 决定 ⇒ 重跑逐字节相同 ✓
   * （`add` 重试会造重复的另一半根因 —— 重试安全 —— 在 `cli/commands/edit.js` 的去重段与 `--idem`。）
   */
  function idGen(seed, seq) {
    const base = String(seed || 'n')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'n';
    if (seq !== undefined && seq !== null) {
      const n = Number(seq);
      if (Number.isInteger(n) && n > 0) return base + '-' + n;
    }
    return base + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** 首行形态判定：heading 优先，其次 list；引用块不参与判定 */
  function detectMode(lines) {
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || /^>/.test(t)) continue;
      if (/^#{1,6}\s+/.test(t)) return 'heading';
      if (/^[-*]\s+/.test(t)) return 'list';
      return 'heading';
    }
    return 'heading';
  }

  /** 资源行（图片/附件）识别 —— 与 treeToMarkdown 的 withResources 输出成对 */
  function parseResource(t) {
    const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(t);
    if (img) {
      const file = img[2].trim();
      const cap = img[1].replace(/^图：/, '').trim();
      return { kind: 'image', file, caption: cap || file };
    }
    const f = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(t);
    if (f && f[1].indexOf('📎') >= 0) {
      const file = f[2].trim();
      let cap = f[1].replace(/^📎\s*/, '').trim();
      const suffix = ' — ' + file;
      if (cap.slice(-suffix.length) === suffix) cap = cap.slice(0, -suffix.length).trim();
      return { kind: 'file', file, caption: cap || file };
    }
    return null;
  }

  /** 资源行的**写出**（唯一一处语法）：`treeToMarkdown` 与"把引用降级成正文"共用同一个函数，
   *  免得同一段语法在两地各写一遍（改一处忘一处 = 导出/导入不成对）。 */
  function resourceLine(kind, file, caption) {
    if (kind === 'file') return '[📎 ' + (caption || file) + ' — ' + file + '](' + file + ')';
    return '![图：' + (caption || file) + '](' + file + ')';
  }

  /* ================= 【W19】导入资源的引用解析与落地（**唯一实现**） =================
   * 要修的是什么：`import-md` / `import-project` 从前把 `parseResource` 的产物**直接落盘** ——
   * md 里的 `![图：备注](assets/x.png)` 被当作**原样字符串**写进 `images[].file`，而那个文件
   * **从没被复制进项目** ⇒ 悬空引用静默落盘。取证（临时沙箱实测，2026-10-12）：
   *   · `import-project w19a note.md` ⇒ exit 0、回显里一个字都没说、`projects/w19a/assets/` **不存在**、
   *     盘上 `images[].file = "assets/x.png"`（指向的文件不存在），而 `validate` **照样通过**
   *     （schema 只校验 file 是非空字符串 —— 所以"validate 绿"证明不了不留坏引用）；
   *   · 源文件真的不存在时同样 exit 0、同样静默（"这条引用坏了"没有任何可见痕迹）。
   * 正规通道的形状（`cli/commands/assets.js` 的 `addImage` / `addFile`）：
   *   ① 先判源文件在不在（不在 ⇒ **响亮报错**）→ ② 复制进 `projects/<name>/assets|attachments/`
   *   （名字 = 时间36进制 + 4 位随机 + 扩展名）→ ③ 引用写**项目内相对路径**（`assets/<新名>`）。
   * 本段把「这条引用指向哪、文件在不在、要不要复制」收成**一个函数** `resolveImportRefs`：
   * `import-md` 与 `import-project` 都调它，`import-dir` / W12（Obsidian 直进）将来也调同一个
   * —— 解析只有这一处，不许另起一套 ✗（两条路各写一套必然漂移）。
   * 与 `parseResource` 的分工：那边只管"这是不是一条资源行"（纯解析、不读盘），这边管"落到项目里"。
   *
   * 四种引用、四条口径（都在本函数里判；调用方只决定"坏引用要不要阻断"）：
   *   · **引用本来就是项目内的有效路径** ⇒ 原样保留（只把 `\` 规范成 `/`），**不复制**：
   *     最常见的场景是 export-md 导出的 md 又被 import-md 导回同一个项目 ——
   *     那时文件已经在 `assets/` 里了，再复制一份只会每次攒一个重复副本；
   *   · **能解析到源文件** ⇒ 按 assets.js 的既有规则复制进项目，引用改写成项目内相对路径 ✓；
   *   · **非本地引用**（`http(s):` / `data:` / 别的 scheme）⇒ **不挂进 images/files**：
   *     `file` 字段的规范是"相对 projects/<name>/ 的路径"，把 URL 写进去等于造一条**永远不可达**的
   *     引用（实测后果：GUI 去拼 `../projects/<项目>/https://…` ⇒ 裂图，export-html 把它当缺失资源）。
   *     这一行按**正文**并入该节点 detail（用 `convert.markdownToHtml`，与 detail 的其它来源同一处转换）
   *     ⇒ 内容不丢、也不落一条坏引用，并在回显里逐条点名 ✓；
   *   · **解析不到**（本地路径但盘上没有）⇒ 见 `opts.onMissing`：
   *     `'refuse'`（默认，两条 import 命令用）**拒绝整份导入**且**一个字节都不写**；
   *     `'detail'` ⇒ 与"非本地引用"同样按正文保留 + 逐条点名（给"整库导入不该为一条坏引用全灭"
   *     的场景预备；本次两条命令不用它，调用点写在 `cli/commands/project.js`）。
   *
   * 顺序上有一条硬约束：**先规划、后落地**（plan → apply）。判据不通过时**连复制都不做**，
   * 于是"拒绝了、却已经在 assets/ 里留了半份资源/半个项目"不会发生 ✓；`opts.dryRun` 就是
   * 只做规划、零副作用（不复制、不建目录、不改树）—— 预览与真导**同一份判据**，不会出现
   * "预览说能导、真导被拒"的落差。
   */
  const RESOURCE_DIR = { image: 'assets', file: 'attachments' };
  /** 图片扩展名白名单 —— **与 `cli/commands/assets.js` 的 copyAsset 逐字同一条**
   *  （`tests/import-refs.test.js` 有一条防漂移断言把两处钉在一起：改一处不改另一处必红）。 */
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/;
  /** 白名单的**人话版**（只用于报文）；由下面那条断言与正则钉在一起，不另立一套规则。 */
  const IMAGE_EXT_TEXT = 'png/jpg/jpeg/gif/webp/svg/bmp';
  /** 附件没有扩展名时的兜底（同 assets.js 的 copyAttachment） */
  const ATTACH_EXT_DEFAULT = '.bin';
  /** 资源文件的新名字 —— **与 assets.js 逐字同一条**（同上，有防漂移断言）：
   *  随机后缀防同毫秒重名覆盖；保留扩展名便于按类型预览/打开。 */
  function newResourceName(ext) {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext;
  }
  /** 非本地引用（URL scheme）。**≥2 个字符才算 scheme** —— Windows 的盘符只有一个字母，
   *  写成 `c:` 若也当协议，绝对路径 `C:\a\x.png` 会被误判成远程引用（那种误判会让文件永远不被复制）。
   *  反向误判（把真 scheme 当成本地路径）不会发生：盘上不会有叫 `https:` 的目录。 */
  const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;
  /** 两种资源的人话名（回显/报文共用一处，免得"图片/附件"各写一套） */
  const KIND_LABEL = { image: '图片', file: '附件' };

  function toPosix(p) { return String(p).split('\\').join('/'); }

  /** `abs` 是否**严格位于** `dir` 内部（`rel` 非空且不越出）—— 判"这条引用是不是已经指向项目内"时用。
   *  为什么必须判：引用字符串来自 md 文件（不受我们控制），`../..` 能把它指到项目根之外。 */
  function insideDir(dir, abs) {
    const rel = path.relative(dir, abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch (e) { return false; }   // 目录/不存在/没权限 ⇒ 一律"不是文件"
  }

  /** 收集一棵（或多棵）子树上的资源引用（**纯函数**，不读盘）。
   *  @returns {Array<{node,nodeId,nodeTopic,entry,kind,file,caption}>} —— `entry` 是那个
   *   挂在节点上的对象本身（落地时**就地改写** `entry.file`，保证改的就是要写盘的那份数据）。 */
  function collectResourceRefs(roots) {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      ['image', 'file'].forEach((kind) => {
        ((kind === 'image' ? n.images : n.files) || []).forEach((entry) => {
          if (!entry || typeof entry.file !== 'string' || !entry.file) return;
          out.push({ node: n, nodeId: n.id, nodeTopic: n.topic, entry: entry,
            kind: kind, file: entry.file, caption: entry.caption });
        });
      });
      (n.children || []).forEach(walk);
    };
    (Array.isArray(roots) ? roots : [roots]).forEach(walk);
    return out;
  }

  /** 单条引用的**规划**（只读盘判断：不复制、不改树、不建目录）。 */
  function planResourceRef(ref, baseDir, projectDir) {
    const rec = {
      node: ref.node, nodeId: ref.nodeId, nodeTopic: ref.nodeTopic, entry: ref.entry,
      kind: ref.kind, raw: ref.file, caption: ref.caption, file: ref.file,
      srcPath: null, dest: null, candidates: [], status: '', reason: ''
    };
    const target = String(ref.file).trim();
    if (URL_SCHEME_RE.test(target)) {
      rec.status = 'remote';
      rec.reason = '不是本地文件（协议 ' + target.slice(0, target.indexOf(':') + 1) + '）—— 本工程不复制外链'
        + KIND_LABEL[ref.kind];
      return rec;
    }
    // ① 引用字符串本身就是**项目内**的有效路径 ⇒ 原样保留（只规范化分隔符），不复制
    if (projectDir) {
      const abs = path.resolve(projectDir, target);
      if (insideDir(projectDir, abs) && isFile(abs)) {
        rec.status = 'in-project';
        rec.srcPath = abs;
        rec.file = toPosix(path.relative(projectDir, abs));
        rec.reason = '已经在项目内';
        return rec;
      }
    }
    /* ② 源文件候选（按序试；**全部记进 rec.candidates**，报文里要逐条说清"为什么没解析到"）。
     *    顺序 = 最可能的布局优先：md 同目录（export-md 的文件夹导出、Obsidian 的"附件在笔记旁"）
     *    → md 同目录下的同名文件 → 当前工作目录（`import-md 项目 assets/x.png` 这种写法）。 */
    const cands = path.isAbsolute(target)
      ? [target]
      : [path.join(baseDir, target), path.join(baseDir, path.basename(target)), path.resolve(target)];
    cands.forEach((c) => {
      const a = path.resolve(c);
      if (rec.candidates.indexOf(a) < 0) rec.candidates.push(a);
    });
    const hit = rec.candidates.filter(isFile)[0];
    if (!hit) {
      rec.status = 'missing';
      rec.reason = '源文件不存在';
      return rec;
    }
    rec.srcPath = hit;
    const ext = path.extname(hit).toLowerCase();
    // 图片的格式闸与 add-image **同一条**（那边是 `不支持的图片格式: .tiff` + 非 0 退出）
    if (ref.kind === 'image' && !IMAGE_EXT_RE.test(ext)) {
      rec.status = 'bad-ext';
      rec.reason = '不是受支持的图片格式: ' + (ext || '（无扩展名）') + '（与 add-image 同一条规则）';
      return rec;
    }
    rec.status = 'copy';
    rec.reason = '将复制进 ' + RESOURCE_DIR[ref.kind] + '/';
    return rec;
  }

  /**
   * 把节点上挂的图片/附件引用**落到项目里**（解析 → 规划 → 复制 → 改写引用）。
   *
   * @param {object|Array} roots 要处理的子树（成功落地时**就地改写** `images[].file` / `files[].file`）
   * @param {{baseDir:string, projectDir?:string, dryRun?:boolean, onMissing?:'refuse'|'detail',
   *          assetDir?:()=>string, attachmentDir?:()=>string}} opts
   *   · `baseDir`      —— 相对引用的基准目录（= md 文件所在目录）
   *   · `projectDir`   —— 目标项目目录（判"引用是否已在项目内"；没有就不判）
   *   · `assetDir` / `attachmentDir` —— **惰性**取项目内目录（`() => ctx.store.assetDir(名称)`）：
   *     它们内部会 `mkdirSync`，惰性调用 ⇒ 拒绝/预览时**不建任何目录** ✓；
   *     路径拼法不许在这里再写一份（目录布局的单源在 `src/data-store.js`）。
   *     （本函数只保证"真要复制时那个目录一定在"——`mkdirSync(recursive)` 兜一下底，
   *     免得调用方给了一个还不存在的目录时，报出来的是一个指不到真因的 ENOENT。）
   * @returns {{ok:boolean, applied:boolean, dryRun:boolean, onMissing:string, refs:Array,
   *            copied:Array, inProject:Array, remote:Array, dropped:Array, blocked:Array}}
   *   `ok:false` ⇒ **什么都没改**（没复制、没改写、没建目录），`blocked` 是逐条的坏引用。
   */
  function resolveImportRefs(roots, opts) {
    const o = opts || {};
    if (!fs || !path) {
      throw new Error('resolveImportRefs 只有 Node 侧可用（浏览器分支没有 fs/path）—— 资源落地是导入命令的事');
    }
    const onMissing = o.onMissing === 'detail' ? 'detail' : 'refuse';
    const baseDir = path.resolve(o.baseDir || process.cwd());
    const projectDir = o.projectDir ? path.resolve(o.projectDir) : null;
    const refs = collectResourceRefs(roots).map((r) => planResourceRef(r, baseDir, projectDir));
    const blocked = refs.filter((r) => r.status === 'missing' || r.status === 'bad-ext');
    const res = {
      ok: !(blocked.length && onMissing === 'refuse'),
      applied: false, dryRun: !!o.dryRun, onMissing: onMissing, baseDir: baseDir,
      refs: refs, blocked: blocked, copied: [], inProject: [], remote: [], dropped: []
    };
    // 判据不通过 ⇒ 规划就停在这里：**不复制、不改树、不建目录**（"拒绝"必须是干净的拒绝）
    if (!res.ok) return res;

    refs.forEach((r) => {
      if (r.status === 'in-project') {
        r.entry.file = r.file;                     // 规范化后的项目内相对路径（可能是 `./assets/x.png` → `assets/x.png`）
        res.inProject.push(r);
        return;
      }
      if (r.status === 'copy') {
        res.copied.push(r);
        if (o.dryRun) return;                      // 预览：不复制（新文件名真导时才生成）
        const dirFn = r.kind === 'image' ? o.assetDir : o.attachmentDir;
        if (typeof dirFn !== 'function') {
          throw new Error('缺少 ' + (r.kind === 'image' ? 'assetDir' : 'attachmentDir')
            + ' 参数：往哪复制由调用方给（项目内目录的单源是 ctx.store，别在这里再拼一份）');
        }
        const ext = r.kind === 'image'
          ? path.extname(r.srcPath).toLowerCase()
          : (path.extname(r.srcPath).toLowerCase() || ATTACH_EXT_DEFAULT);
        const dest = path.join(dirFn(), newResourceName(ext));
        fs.mkdirSync(path.dirname(dest), { recursive: true });   // 兜底：目录必须真在（见函数头）
        fs.copyFileSync(r.srcPath, dest);
        r.dest = RESOURCE_DIR[r.kind] + '/' + path.basename(dest);
        r.file = r.dest;
        r.entry.file = r.dest;
        return;
      }
      /* remote（非本地引用）与 missing + onMissing:'detail'（坏引用但不阻断）**同一处理**：
       * 从 images/files 里摘掉这一条，把那一行**按正文**并入该节点 detail（内容不丢、不留坏引用）。 */
      const list = r.kind === 'image' ? r.node.images : r.node.files;
      const bucket = r.status === 'remote' ? res.remote : res.dropped;
      if (o.dryRun) { bucket.push(r); return; }
      const at = list ? list.indexOf(r.entry) : -1;
      if (at >= 0) list.splice(at, 1);
      if (list && !list.length) delete r.node[r.kind === 'image' ? 'images' : 'files'];   // 不留空数组
      const html = convert.markdownToHtml(resourceLine(r.kind, r.raw, r.caption));
      if (html) r.node.detail = r.node.detail ? r.node.detail + '\n' + html : html;
      bucket.push(r);
    });
    res.applied = !o.dryRun;
    return res;
  }

  /**
   * Markdown 大纲 → 追加到 parent 下的节点树
   * @returns {{data, addedCount}} data 为新子树（根），addedCount 为新增节点数
   */
  function markdownToTree(md, parentId, genId) {
    const g = genId || idGen;
    const rawLines = String(md || '').split(/\r?\n/);
    const mode = detectMode(rawLines);
    // 栈：每层最近节点；栈底是 parent 占位
    const stack = [{ id: parentId, children: [] }];
    let addedCount = 0;
    let cur = null;
    let seg = null; // 期望写入 cur.detail 的连续片段 { kind, lines }
    /* 【W14】第一个标题**之前**的正文：原实现直接跳过（`if (!cur) continue`）⇒ **静默丢内容**。
     * 现在按"段"收集起来（与原 seg 同一套聚合规则），末尾转成 HTML 交回调用方，
     * 由调用方落到**本次导入的父/文件节点**的 detail 开头 —— 三条导入路同一条规则，落点在回显里说明。
     * 边界：前导区里的 `![图](…)` / `[附件](…)` **不当资源挂载**（那属导入资源的坏引用问题，W19），
     * 一律按正文处理 ⇒ 内容不丢，也不会凭空往 images/files 里塞一条指向不存在文件的引用。 */
    const preSegs = [];

    function flushSeg() {
      if (seg && seg.lines.length) {
        const text = seg.lines.join('\n');
        if (cur) {
          const html = convert.markdownToHtml(text);
          if (html) cur.detail = cur.detail ? cur.detail + '\n' + html : html;
        } else {
          preSegs.push(text);          // 前导段：先收原文，末尾统一转换（与上面同一个 convert）
        }
      }
      seg = null;
    }

    function openNode(topic, level) {
      flushSeg();
      // 展开状态的默认值：**只让前两层展开，更深的收起**。
      // 为什么：导入的笔记/目录树动辄上百节点，若一律写 expanded:true，打开项目就是一片全展开、
      // 要滚很久才找到东西；而"展开某个节点时，它的子节点应当是收起的"也是明确期望（用户反馈）。
      // 单源：渲染层不再兜底展开（app-core.js 的 renderMind 去掉了 expand_to_depth(3)），数据说啥就是啥。
      const node = { id: g(topic), topic, expanded: level <= 2, children: [] };
      // 调整栈深度：level-1 层为父
      while (stack.length > level) stack.pop();
      while (stack.length < level) {
        // 中间缺层：用占位节点兜底，避免结构损坏
        const holder = { id: g('层级' + (stack.length + 1)), topic: '（层级' + (stack.length + 1) + '）', expanded: true, children: [] };
        stack[stack.length - 1].children.push(holder);
        stack.push(holder);
        addedCount++;
      }
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      cur = node;
      addedCount++;
    }

    /* ⚠️ 围栏代码块必须**整段原样**收集，这里用 `inFence` 显式隔绝三件事：
     *   ① 空行不得触发 flushSeg（否则跨空行的围栏被切成多段、各段独立转 HTML ⇒ 代码碎成 <p>/<li>）；
     *   ② 围栏内的 `# 标题` / `- 列表` / 图片附件语法**一律不解读**（C 的 `#include`、shell 的 `# 注释`
     *      都是代码，不是结构）；
     *   ③ 缩进与 `>` 前缀不做任何加工（`kind:'text'` 不 strip）。
     * 实测代价（本次导入 day3/day4 案例程序时才发现）：Makefile 源 7 行 → detail 只剩 1 行；
     * netlink_user.c 143 行 → 6 行 —— 属"静默损坏"类，比报错危险得多。
     * 收尾标记也要收进段里，`markdownToHtml` 才能把它渲染成 `<pre><code>`。 */
    let inFence = false;
    for (const raw of rawLines) {
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      const isFence = /^```/.test(trimmed);
      if (inFence) {
        seg.lines.push(line);
        if (isFence) { inFence = false; flushSeg(); }   // 收尾 ⇒ 整段立刻定格
        continue;
      }
      if (isFence) {                                     // 开围栏
        flushSeg();
        seg = { kind: 'text', lines: [line] };
        inFence = true;
        continue;
      }
      if (mode === 'heading') {
        const m = H_RE.exec(line);
        if (m) {
          const topic = m[2].trim();
          if (!topic) continue;
          openNode(topic, m[1].length);
          continue;
        }
      } else {
        const m = L_RE.exec(line);
        if (m && m[2].trim()) {
          const indent = m[1].replace(/\t/g, '  ').length;
          openNode(m[2].trim(), Math.floor(indent / 2) + 1);
          continue;
        }
      }
      const t = line.trim();
      if (!t) { flushSeg(); continue; }
      if (!cur) {
        // 【W14】第一个标题之前的正文 —— **不丢**：收进前导段（见上面 preSegs 的说明）
        if (!seg || seg.kind !== 'text') { flushSeg(); seg = { kind: 'text', lines: [] }; }
        seg.lines.push(t);
        continue;
      }
      const res = parseResource(t);
      if (res) {
        flushSeg();
        if (res.kind === 'image') (cur.images = cur.images || []).push({ file: res.file, caption: res.caption });
        else (cur.files = cur.files || []).push({ file: res.file, caption: res.caption });
        continue;
      }
      const kind = /^>/.test(t) ? 'quote' : 'text';
      if (!seg || seg.kind !== kind) { flushSeg(); seg = { kind, lines: [] }; }
      seg.lines.push(kind === 'quote' ? t.replace(/^>\s?/, '') : t);
    }
    flushSeg();
    /* 【W14】前导正文 = 第一个标题之前的正文（整篇都没有标题时 = 全篇）。
     * 用**同一个** convert 转换（不另写解析）⇒ 与 detail 的其它来源同源。 */
    const preamble = preSegs.length ? convert.markdownToHtml(preSegs.join('\n\n')) : '';
    return { data: stack[0], addedCount, preamble: preamble };
  }

  /**
   * 节点树 → Markdown 大纲
   * @param {object} root 根节点
   * @param {object} opts { format: 'heading'|'list', withDetail, withResources }
   * @returns {string}
   */
  function treeToMarkdown(root, opts) {
    const o = opts || {};
    const fmt = o.format === 'list' ? 'list' : 'heading';
    const out = [];
    const walk = (node, level) => {
      if (fmt === 'heading') {
        // Markdown 只支持 1–6 级标题（H_RE 也只认 1–6）。
        // 超过 6 层若继续 `'#'.repeat(level)`，会生成 `#######` —— 导入时**认不出来**，
        // 该节点被降级成父节点 detail 里的一行字面井号，即**静默丢节点**
        // （实测 8 层树往返后只剩 L1..L6）。故这里夹取到 6，并以缩进保留深度信息，
        // 使深层节点至少在视觉上可区分、且仍能被导入成节点。
        const lv = Math.min(6, Math.max(1, level));
        const extra = level > 6 ? '　'.repeat(level - 6) : '';
        out.push('#'.repeat(lv) + ' ' + extra + node.topic);
      } else {
        out.push('  '.repeat(Math.max(0, level - 1)) + '- ' + node.topic);
      }
      if (o.withDetail && node.detail) {
        const quote = convert.detailToMarkdown(node.detail);
        if (quote) out.push(quote);
      }
      // withResources：把节点挂载的图片/附件写成相对路径链接
      // （配合 export-md 文件夹导出：md 与 assets/、attachments/ 同目录，链接可用）
      // ⚠️ 语法只有一处（`resourceLine`）：导入侧把"降级成正文"也复用它，导出/导入才成对
      if (o.withResources) {
        (node.images || []).forEach((img) => out.push(resourceLine('image', img.file, img.caption)));
        (node.files || []).forEach((f) => out.push(resourceLine('file', f.file, f.caption)));
      }
      (node.children || []).forEach((c) => walk(c, level + 1));
    };
    walk(root, 1);
    return out.join('\n');
  }

  return {
    markdownToTree, treeToMarkdown, idGen,
    // 【W19】导入资源的引用解析与落地（两条 import 命令 + 将来的 import-dir / W12 都调这里）
    resolveImportRefs, collectResourceRefs, resourceLine,
    RESOURCE_DIR, IMAGE_EXT_RE, IMAGE_EXT_TEXT, KIND_LABEL
  };
});
