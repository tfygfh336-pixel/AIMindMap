/* ============================================================
 * src/dsh-chip-feed.js — 「拖节点进去 ⇒ 显示成一块（真 chip）」的内置 DSH 客户端插件载荷
 * ------------------------------------------------------------
 * 形态：CommonJS（main-dsh-sidebar.js 与 tests/ 与脚本侧 require；浏览器侧不用它）。
 * 它做三件事，**每一件都只有一处实现**：
 *   ① 纯逻辑：把"投喂那几行字"翻成 chip 的 `{ref,label,clipboardText}`（`chipUnitsFromText`）；
 *   ② 载荷：把客户端 cordis 插件的**四个文件**作为字符串产出（`files()`）；
 *   ③ 装卸：把载荷写进 / 撤出内置实例的 `dsh-home\profiles\web`（`install` / `uninstall` / `verify`）。
 *
 * ── 为什么插件必须存在（而不是页面侧注入就能干）─────────────────────────────────
 *   真 chip 是 Lexical 的 `ReferenceChipNode`（原子 decorator 节点），只能由**已注册的 inputTriggers
 *   source** 的插入通道创建；而 `insertReference` / `setDraft` 在 `SessionInput` 上，
 *   `SessionInput` 只能从 **session 作用域的 cordis ctx** 上取（`conversation.input.for(actx)`）。
 *   页面侧 `executeJavaScript` 拿不到那个 ctx ⇒ 只能投一个**客户端 cordis 插件**。
 *   （取证：.review/20261041-真chip/ 的报告 §一，逐行引 vendor/dsh 的源码。）
 *
 * ── ⚠️ 死 chip 红线：只许用内置 source 名 `reference` ────────────────────────────
 *   提交时每个 chip 走 `serializeReference(source, ref)`（…dsh-client-ui-input-trigger/lib/client.js:615-618）；
 *   若该 source 没注册或没有 codec ⇒ **reject**，而失败分支 = **整条发送被拒**
 *   （…dsh-client-ui-conversation/lib/client.js:13969-13972）⇒ **不会**悄悄退化成文本。
 *   ⇒ 编一个 source 名 = 用户按发送才炸的死 chip，比纯文字更糟。
 *   内置 `reference` 的 codec 是**恒等函数**（…dsh-client-ui-reference/lib/client.js:228-231：
 *   `serialize: (ref) => Promise.resolve(ref)`）⇒ 模型收到的文本**就是 ref 本身**。
 *   本文件与载荷里都**写死** `SOURCE = 'reference'`，并有单测钉住"载荷里出现任何别的 source 名即红"。
 *
 * ── 为什么模型输入与纯文本路径"逐行相同、但连接符不同"（如实）────────────────────
 *   纯文本路径：N 行用 `\n` 连（`src/sidebar-context.js` 的 buildSidebarText）。
 *   chip 路径：内核的 `insertFileReferences` 给每个 chip 后面补一个空格（…ui-conversation:13341）
 *   ⇒ 模型看到的是 `甲 乙 `（空格分隔，末尾一个空格）。**单行内容一字不差**，连接符从换行变空格。
 *   这不是我们的选择，是内核 chip 的既定形态（真人拖两个文件进 composer 也是这个形状）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fs'), require('path'), require('crypto'));
  } else {
    root.MMDshChipFeed = factory(null, null, null);
  }
})(typeof self !== 'undefined' ? self : this, function (fs, path, crypto) {
  'use strict';

  /** 插件包名。客户端 bundle 里 `__ModuleLoader__.load({id})` 的 id **必须**等于它
   *  （内核装配：`graphRow(packageName, …)` ⇒ 期望的注册 id 就是包名；注册不上会报
   *   `loaded without registering "<id>" via __ModuleLoader__.load`）。 */
  const PLUGIN_NAME = '@aimm/dsh-client-chip-feed';
  const PLUGIN_VERSION = '0.1.0';
  /** 装配行 id（我们自己的 patch 里那一行；台账与 --dump-config 用它对拍）。 */
  const ROW_ID = 'aimm-chip-feed';
  /** 内置 source 名 —— **写死，不许参数化**（见文件头"死 chip 红线"）。 */
  const SOURCE = 'reference';
  const APPEARANCE = 'file';
  /** 页面全局句柄（主进程 executeJavaScript 直接调它；句柄在不在 = 插件在不在）。 */
  const HANDLE = '__AIMM_CHIP_INSERT__';
  const READY = '__AIMM_CHIP_FEED__';
  /** 单行上限：与 `src/sidebar-context.js` 的 REF_MAX 同口径（那里已截断，这里是第二道闸）。 */
  const REF_MAX = 200;
  /** 一次最多几个 chip（防止误把超长文本整段变 chip）。 */
  const MAX_ITEMS = 50;

  /* ------------------------------------------------------------------ *
   * ① 纯逻辑：文本 ⇒ chip 单元
   * ------------------------------------------------------------------ */

  /** composer 的两个触发符（`@` 引用 / `/` 指令）：chip 的 ref 也不许站在行首触发位上。 */
  function isChipSafeUnit(line) {
    const t = String(line == null ? '' : line);
    if (!t) return false;
    if (t.indexOf('@') >= 0) return false;                  // `@` 一个字都不许有（它会被 composer 改写成引用实体）
    if ('@/'.indexOf(t.charAt(0)) >= 0) return false;        // 行首不许是触发符
    if (t.length > REF_MAX) return false;                    // 太长 ⇒ 不是"一个节点"该有的形状
    return true;
  }

  /**
   * 把一次投喂的**整段文案**翻成 chip 单元。**判据是"整段"而不是"单行"**：
   * 只有**每一行**都长得像 `<项目>/<标题>` 时才成立 ⇒ 否则返回 `null`（调用方走纯文本路径）。
   *
   * 为什么必须这么严（这条是"不做假"的关键）：
   *   · 拖节点那条路产出的文案**恒为** N 行 `项目/标题`（`src/sidebar-context.js` 的 buildSidebarText）；
   *   · 另一条同 IPC 的投喂路（「把对话送进侧栏」）产出的是 `【来自 AI MindMap 的对话】` + `我：…` +
   *     `AI：…` 这种**散文行**。若按单行判定，那些散文行会被做成一片垃圾 chip ✗。
   *   ⇒ 要求「**每一行**都含 `/` 且 `/` 前面至少一个非空白字符、且不带 `@`、且行首不是触发符」。
   *     散文行里那句 `【来自…】` 没有 `/` ⇒ 整段直接不成立 ⇒ 走纯文本 ✓（这一条有单测红侧）。
   *
   * @param {string} text 要投喂的整段文案
   * @returns {{items: Array<{ref:string,label:string,clipboardText:string}>, reason: string}|null}
   *   null = 这段文案不该走 chip（调用方照旧走纯文本）
   */
  function chipUnitsFromText(text) {
    const all = String(text == null ? '' : text);
    if (!all.trim()) return null;
    const lines = all.split('\n');
    if (lines.length === 0 || lines.length > MAX_ITEMS) return null;
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== line.trim()) return null;                  // 行首/行尾有空白 ⇒ 不是我们的形状
      if (!isChipSafeUnit(line)) return null;
      const slash = line.indexOf('/');
      /* `/` 必须在中间：`slash <= 0` 覆盖"没有 `/`"（散文行）与"`/` 在行首"（触发位）两种否决。
       * 标题自己带 `/` 是允许的（`buildSidebarText` 不禁止），那时只认**第一个** `/` 作为项目分隔符。 */
      if (slash <= 0) return null;
      const label = line.slice(slash + 1).trim() || line;      // chip 上显示标题（`项目/` 之后那段）
      items.push({ ref: line, label: label, clipboardText: line });
    }
    return { items: items, reason: null };
  }

  /**
   * 判"插件报回来的结果"算不算成功。**真值来自内核 store**（`InputState.occurrences`），
   * 插件只是转发；这里把"转发回来的东西对不对"钉死。
   * @param {object} result 插件 `insertRefs` 的返回值（JSON）
   * @param {Array<{ref:string,clipboardText:string}>} items 期望插入的单元（顺序即真值顺序）
   * @returns {{ok:boolean, reason:(string|null), occurrences:Array}}
   */
  function judgeInsertResult(result, items) {
    const want = Array.isArray(items) ? items : [];
    const r = (result && typeof result === 'object') ? result : {};
    const occ = Array.isArray(r.occurrences) ? r.occurrences : [];
    if (r.ok !== true) {
      return { ok: false, reason: String(r.reason || '插件报失败但没给原因'), occurrences: occ };
    }
    if (occ.length !== want.length) {
      return { ok: false, reason: 'occurrences 有 ' + occ.length + ' 个，应 ' + want.length + ' 个', occurrences: occ };
    }
    for (let i = 0; i < want.length; i++) {
      const o = occ[i] || {};
      if (o.source !== SOURCE) return { ok: false, reason: '第 ' + (i + 1) + ' 个 chip 的 source 是 ' + JSON.stringify(o.source) + '，应 ' + JSON.stringify(SOURCE), occurrences: occ };
      if (o.appearance !== APPEARANCE) return { ok: false, reason: '第 ' + (i + 1) + ' 个 chip 的 appearance 是 ' + JSON.stringify(o.appearance) + '，应 ' + JSON.stringify(APPEARANCE), occurrences: occ };
      if (String(o.ref) !== String(want[i].ref)) return { ok: false, reason: '第 ' + (i + 1) + ' 个 chip 的 ref 与期望不一致', occurrences: occ };
      if (String(o.clipboardText) !== String(want[i].clipboardText)) return { ok: false, reason: '第 ' + (i + 1) + ' 个 chip 的 clipboardText 与期望不一致', occurrences: occ };
    }
    return { ok: true, reason: null, occurrences: occ };
  }

  /* ------------------------------------------------------------------ *
   * ② 载荷：客户端 cordis 插件的四个文件
   * ------------------------------------------------------------------ */

  /** 主机半边。**故意的空 apply** —— 它存在的唯一理由是把这一行挂进 Host Loader，
   *  客户端半边才会被 `dsh.client` 扫描到（同 `@deepseek-ai/dsh-cordis-client-runner/lib/index.js`
   *  的 proven 形态："the empty apply exists so the row appears in the host cordis.yml / Loader"）。 */
  const HOST_INDEX_JS = [
    '/**',
    ' * ' + PLUGIN_NAME + ' — host half. Nothing happens here in the Host process.',
    ' *',
    ' * The row must exist in the Host Loader for the browser half to be discovered',
    ' * (client-modules scans Loader rows for package.json `dsh.client`), so this',
    ' * file exports an intentionally empty `apply`. Verified shape:',
    ' * @deepseek-ai/dsh-cordis-client-runner/lib/index.js (same reason).',
    ' */',
    'export function apply() {}',
    ''
  ].join('\n');

  /** 浏览器半边：`window.__ModuleLoader__.load({id, factory})` —— 内核每个 client.js 都是这个形态
   *  （例：@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js 第 1-3 行）。手写，不经构建。 */
  const CLIENT_JS = [
    'window.__ModuleLoader__.load({',
    "\tid: '" + PLUGIN_NAME + "',",
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    '',
    '\t\t/** 页面全局句柄：主进程 executeJavaScript 直接调它（本插件**唯一**的输入通道）。 */',
    "\t\tvar HANDLE = '" + HANDLE + "';",
    "\t\tvar READY = '" + READY + "';",
    '\t\t/** ⚠️ 死 chip 红线：**只许内置 source 名**。编造的 source 会在提交时被',
    '\t\t *  serializeReference 拒（ui-input-trigger:615-618），而失败分支 = 整条发送被拒',
    '\t\t * （ui-conversation:13969-13972）⇒ 不会退化成文本 ⇒ 死 chip 比纯文字更糟。 */',
    "\t\tvar SOURCE = '" + SOURCE + "';",
    "\t\tvar APPEARANCE = '" + APPEARANCE + "';",
    '\t\t/** 需要的客户端服务（缺任一个，cordis 会把本插件挂起，句柄就不会出现). */',
    "\t\tvar inject = ['sessions', 'conversation'];",
    '',
    '\t\tfunction txt(v) { return v == null ? "" : String(v); }',
    '\t\tfunction why(e) { return e instanceof Error ? e.message : String(e); }',
    '',
    '\t\t/** 主视图那个 session：内核十处同款写法（例 client-ui-workspace:259、client-ui-cordis:741）。 */',
    '\t\tfunction mainSessionId(sessions) {',
    '\t\t\tvar byId = {};',
    '\t\t\ttry { byId = (sessions.list.getSnapshot() || {}).byId || {}; } catch (e) { byId = {}; }',
    '\t\t\tvar ids = Object.keys(byId);',
    '\t\t\tfor (var i = 0; i < ids.length; i++) {',
    '\t\t\t\tvar row = byId[ids[i]];',
    '\t\t\t\tvar kept = (row && row.retainedBy) ? (row.retainedBy.mainView || 0) : 0;',
    '\t\t\t\tif (kept > 0) return row.id;',
    '\t\t\t}',
    '\t\t\treturn null;',
    '\t\t}',
    '',
    '\t\t/** 引用真值：内核公开 store 的 `InputState.occurrences`（契约 `contract/input.d.ts`）。',
    '\t\t *  我们**不编数字**，只把它搬运给主进程。 */',
    '\t\tfunction readOccurrences(input) {',
    '\t\t\ttry {',
    '\t\t\t\tvar st = input.state.getSnapshot() || {};',
    '\t\t\t\tvar occ = st.occurrences || [];',
    '\t\t\t\tvar out = [];',
    '\t\t\t\tfor (var i = 0; i < occ.length; i++) {',
    '\t\t\t\t\tvar o = occ[i] || {};',
    '\t\t\t\t\tout.push({ source: txt(o.source), ref: txt(o.ref), appearance: txt(o.appearance),',
    '\t\t\t\t\t\tclipboardText: txt(o.clipboardText), label: txt(o.label),',
    '\t\t\t\t\t\tsource_ok: o.source === SOURCE });',
    '\t\t\t\t}',
    '\t\t\t\treturn out;',
    '\t\t\t} catch (e) { return []; }',
    '\t\t}',
    '',
    '\t\tfunction draftOf(input) {',
    '\t\t\ttry { return txt((input.state.getSnapshot() || {}).draft); } catch (e) { return ""; }',
    '\t\t}',
    '',
    '\t\t/**',
    '\t\t * 插入 N 个 chip：清稿 → 插入 → 读 occurrences 判真值。任何一步不成立都返回 ok:false + reason',
    '\t\t * （主进程据此**降级成纯文本**，绝不留"什么都没发生"）。',
    '\t\t */',
    '\t\tasync function insertRefs(scope, payload) {',
    '\t\t\tvar items = (payload && payload.items && payload.items.length) ? payload.items : [];',
    '\t\t\tif (items.length === 0) return { ok: false, reason: "empty-payload" };',
    '\t\t\tvar sessions = scope.sessions;',
    '\t\t\tif (sessions === void 0) return { ok: false, reason: "no-sessions-service" };',
    '\t\t\tvar sessionId = mainSessionId(sessions);',
    '\t\t\tif (sessionId === null) return { ok: false, reason: "no-main-session" };',
    '\t\t\tvar actx = sessions.scope(sessionId);',
    '\t\t\tif (actx === void 0) return { ok: false, reason: "no-session-scope" };',
    '\t\t\tvar input;',
    '\t\t\ttry { input = scope.conversation.input.for(actx); }',
    '\t\t\tcatch (e) { return { ok: false, reason: "no-input-facade: " + why(e) }; }',
    '\t\t\tif (!input) return { ok: false, reason: "no-input-facade" };',
    '\t\t\t/* C：整稿清空走 setDraft —— 内核语义（ui-conversation:13236）：按 \\n 逐段 + 光标到末 +',
    '\t\t\t * 与当前草稿相同则直接 return（天然幂等）+ 一次历史步。比"全选+delete"可靠得多。 */',
    '\t\t\ttry { input.setDraft(""); } catch (e) { return { ok: false, reason: "set-draft-failed: " + why(e) }; }',
    '\t\t\tvar refs = [];',
    '\t\t\tfor (var i = 0; i < items.length; i++) {',
    '\t\t\t\trefs.push({ source: SOURCE, appearance: APPEARANCE, ref: txt(items[i].ref),',
    '\t\t\t\t\tlabel: txt(items[i].label), clipboardText: txt(items[i].clipboardText) });',
    '\t\t\t}',
    '\t\t\tvar route = "";',
    '\t\t\t/* 路线 1（契约面）：`SessionInput.insertReference(ref, span)`。span 先取 `actions.captureInsertion()`',
    '\t\t\t * （那是内核给 slot 组件的公开动作面）；取不到就按"空稿 + 当前位置为 0"构造（清稿之后成立）。 */',
    '\t\t\tif (typeof input.insertReference === "function") {',
    '\t\t\t\troute = "insertReference";',
    '\t\t\t\tfor (var j = 0; j < refs.length; j++) {',
    '\t\t\t\t\tvar span = null;',
    '\t\t\t\t\ttry {',
    '\t\t\t\t\t\tspan = (input.actions && typeof input.actions.captureInsertion === "function")',
    '\t\t\t\t\t\t\t? input.actions.captureInsertion() : null;',
    '\t\t\t\t\t} catch (e2) { span = null; }',
    '\t\t\t\t\tif (!span) {',
    '\t\t\t\t\t\tvar rev = 0;',
    '\t\t\t\t\t\ttry { rev = (input.state.getSnapshot() || {}).draftRev || 0; } catch (e3) { rev = 0; }',
    '\t\t\t\t\t\tspan = { start: 0, end: 0, draftRev: rev };',
    '\t\t\t\t\t}',
    '\t\t\t\t\tvar applied = input.insertReference(refs[j],',
    '\t\t\t\t\t\t{ start: span.start, end: span.end, draftRev: span.draftRev });',
    '\t\t\t\t\tif (applied !== true) { route = ""; break; }',
    '\t\t\t\t}',
    '\t\t\t}',
    '\t\t\t/* 路线 2（内核拖拽入件的同一入口）：`addFiles(refs, [])` —— 不带 span，在选区末尾批量追加',
    '\t\t\t * chip+空格（ui-conversation:13567 → 13334 insertFileReferences）。这是真人拖文件进 composer 走的路。 */',
    '\t\t\tif (route === "" && typeof input.addFiles === "function") {',
    '\t\t\t\tif (input.addFiles(refs, []) === true) route = "addFiles";',
    '\t\t\t}',
    '\t\t\tvar occurrences = readOccurrences(input);',
    '\t\t\tvar okShape = occurrences.length === items.length;',
    '\t\t\tfor (var k = 0; okShape && k < items.length; k++) {',
    '\t\t\t\tif (occurrences[k].source !== SOURCE) okShape = false;',
    '\t\t\t\tif (occurrences[k].appearance !== APPEARANCE) okShape = false;',
    '\t\t\t\tif (occurrences[k].ref !== txt(items[k].ref)) okShape = false;',
    '\t\t\t}',
    '\t\t\treturn { ok: okShape, route: route, source: SOURCE, appearance: APPEARANCE,',
    '\t\t\t\twant: items.length, occurrences: occurrences, draft: draftOf(input),',
    '\t\t\t\treason: okShape ? null : (route === ""',
    '\t\t\t\t\t? "两条插入路线都没被接受（phase 不是 plain/claimed，或内核签名变了）"',
    '\t\t\t\t\t: "插入后 occurrences 与期望不符（有 " + occurrences.length + " 个）") };',
    '\t\t}',
    '',
    '\t\t/** 客户端插件体：等服务到齐 ⇒ 装全局句柄（句柄在不在 = 插件在不在）。 */',
    '\t\tfunction apply(ctx) {',
    '\t\t\tctx.inject(inject, function (scope) {',
    '\t\t\t\tvar handle = function (payload) { return insertRefs(scope, payload); };',
    '\t\t\t\tglobalThis[HANDLE] = handle;',
    '\t\t\t\tglobalThis[READY] = { v: 1, plugin: "' + PLUGIN_NAME + '" };',
    '\t\t\t\tctx.effect(function () {',
    '\t\t\t\t\treturn function () {',
    '\t\t\t\t\t\tif (globalThis[HANDLE] === handle) delete globalThis[HANDLE];',
    '\t\t\t\t\t\tdelete globalThis[READY];',
    '\t\t\t\t\t};',
    '\t\t\t\t}, "aimm chip feed: page handle");',
    '\t\t\t});',
    '\t\t}',
    '',
    '\t\texports.apply = apply;',
    '\t\texports.inject = inject;',
    '\t\treturn module.exports;',
    '\t}',
    '});',
    ''
  ].join('\n');

  const PACKAGE_JSON = JSON.stringify({
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    private: true,
    description: 'AI MindMap 侧栏投喂：把"拖进去的节点"插成真 chip（借内置 reference source，不新建 source）',
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json'
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: ['@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-conversation']
      }
    }
  }, null, 2) + '\n';

  const CORDIS_PATCH_YML = [
    '# ' + PLUGIN_NAME + ' bundle patch：把本插件的一行插进 web profile 的装配表。',
    '# 生效开关是 profiles/web/package.json 的 dsh.profile.bundles（与 dsh-browser-plus 同一机制）；',
    '# ⚠️ 不要把这行手抄进 profiles/web/cordis.patch.yml —— 那是生成物（唯一写者 scripts/dsh-embedded-overrides.js）。',
    '- insert:',
    '    - id: ' + ROW_ID,
    "      name: '" + PLUGIN_NAME + "'",
    ''
  ].join('\n');

  /** 载荷成品：相对插件目录的路径 ⇒ 文件内容。**唯一的载荷真源。** */
  function files() {
    return {
      'package.json': PACKAGE_JSON,
      'cordis.patch.yml': CORDIS_PATCH_YML,
      'lib/index.js': HOST_INDEX_JS,
      'lib/client.js': CLIENT_JS
    };
  }

  /* ------------------------------------------------------------------ *
   * ③ 装卸（dsh-home\profiles\web）
   * ------------------------------------------------------------------ */

  function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  }

  function pluginDirOf(home) {
    return path.join(home, 'profiles', 'web', 'node_modules', '@aimm', 'dsh-client-chip-feed');
  }

  function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function bundleListOf(profileJson) {
    const b = profileJson && profileJson.dsh && profileJson.dsh.profile && profileJson.dsh.profile.bundles;
    return Array.isArray(b) ? b.slice() : [];
  }

  /**
   * 装上（幂等）：写四个文件 + 把包名追加进 `dsh.profile.bundles`。
   * **写 `package.json` 之前先备份**（同目录 `.bak-aimm-chip-<时间戳>`），并回报前后 sha256。
   * @param {string} home dsh-home 绝对路径
   * @param {{now?:Date}} [opts]
   * @returns {{ok:boolean, pluginDir:string, written:string[], unchanged:string[], bundlesBefore:string[],
   *            bundlesAfter:string[], backup:(string|null), sha256:object}}
   */
  function install(home, opts) {
    const o = opts || {};
    const profileDir = path.join(home, 'profiles', 'web');
    const pkgFile = path.join(profileDir, 'package.json');
    const pluginDir = pluginDirOf(home);
    const payload = files();
    const written = [];
    const unchanged = [];
    for (const rel of Object.keys(payload)) {
      const target = path.join(pluginDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const exists = fs.existsSync(target);
      if (exists && fs.readFileSync(target, 'utf8') === payload[rel]) { unchanged.push(rel); continue; }
      fs.writeFileSync(target, payload[rel], 'utf8');
      written.push(rel);
    }
    const before = readJson(pkgFile);
    const bundlesBefore = bundleListOf(before);
    let backup = null;
    let bundlesAfter = bundlesBefore;
    if (bundlesBefore.indexOf(PLUGIN_NAME) < 0) {
      const stamp = (o.now instanceof Date ? o.now : new Date()).toISOString().replace(/[:.]/g, '-');
      backup = pkgFile + '.bak-aimm-chip-' + stamp;
      fs.copyFileSync(pkgFile, backup);
      bundlesAfter = bundlesBefore.concat([PLUGIN_NAME]);
      const next = JSON.parse(JSON.stringify(before));
      next.dsh = next.dsh || {};
      next.dsh.profile = next.dsh.profile || {};
      next.dsh.profile.bundles = bundlesAfter;
      fs.writeFileSync(pkgFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }
    return {
      ok: true, pluginDir: pluginDir, written: written, unchanged: unchanged,
      bundlesBefore: bundlesBefore, bundlesAfter: bundlesAfter, backup: backup,
      sha256: {
        packageJson: sha256(JSON.stringify(readJson(pkgFile), null, 2) + '\n'),
        libClientJs: sha256(payload['lib/client.js']),
        libIndexJs: sha256(payload['lib/index.js']),
        cordisPatchYml: sha256(payload['cordis.patch.yml'])
      }
    };
  }

  /**
   * 撤回：删掉插件目录（含空的 `@aimm` 容器）+ 把包名从 bundles 里摘掉。
   * **不**自动恢复备份（备份路径由 install 回报；要不要回滚由人决定 —— 撤回到"没有这个包"是幂等的）。
   * @param {string} home
   * @returns {{ok:boolean, removed:(string|null), bundlesBefore:string[], bundlesAfter:string[]}}
   */
  function uninstall(home) {
    const profileDir = path.join(home, 'profiles', 'web');
    const pkgFile = path.join(profileDir, 'package.json');
    const pluginDir = pluginDirOf(home);
    let removed = null;
    if (fs.existsSync(pluginDir)) { fs.rmSync(pluginDir, { recursive: true, force: true }); removed = pluginDir; }
    const scopeDir = path.dirname(pluginDir);
    try { if (fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir); } catch (e) { /* 非空就留着 */ }
    const before = readJson(pkgFile);
    const bundlesBefore = bundleListOf(before);
    const bundlesAfter = bundlesBefore.filter((n) => n !== PLUGIN_NAME);
    if (bundlesAfter.length !== bundlesBefore.length) {
      const next = JSON.parse(JSON.stringify(before));
      next.dsh.profile.bundles = bundlesAfter;
      fs.writeFileSync(pkgFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }
    return { ok: true, removed: removed, bundlesBefore: bundlesBefore, bundlesAfter: bundlesAfter };
  }

  /**
   * 只读核对（**不写任何文件**）：载荷在不在、内容与 `files()` 是否逐字节相同、装配清单里有不有它。
   * 供 `dsh-status` 与自检用 —— 判据是"内容级"，不是"目录存在"（后者会让旧载荷冒充新载荷）。
   * @param {string} home
   * @returns {{installed:boolean, payloadOk:boolean, bundlesEntry:boolean, rowId:string,
   *            drift:string[], missing:string[], pluginDir:string}}
   */
  function verify(home) {
    const pluginDir = pluginDirOf(home);
    const payload = files();
    const drift = [];
    const missing = [];
    for (const rel of Object.keys(payload)) {
      const target = path.join(pluginDir, rel);
      if (!fs.existsSync(target)) { missing.push(rel); continue; }
      if (fs.readFileSync(target, 'utf8') !== payload[rel]) drift.push(rel);
    }
    let bundlesEntry = false;
    try { bundlesEntry = bundleListOf(readJson(path.join(home, 'profiles', 'web', 'package.json'))).indexOf(PLUGIN_NAME) >= 0; }
    catch (e) { bundlesEntry = false; }
    return {
      installed: missing.length === 0,
      payloadOk: missing.length === 0 && drift.length === 0,
      bundlesEntry: bundlesEntry,
      rowId: ROW_ID,
      drift: drift, missing: missing, pluginDir: pluginDir
    };
  }

  return {
    PLUGIN_NAME, PLUGIN_VERSION, ROW_ID, SOURCE, APPEARANCE, HANDLE, READY, REF_MAX, MAX_ITEMS,
    chipUnitsFromText, isChipSafeUnit, judgeInsertResult,
    files, HOST_INDEX_JS, CLIENT_JS, PACKAGE_JSON, CORDIS_PATCH_YML,
    install, uninstall, verify, pluginDirOf
  };
});
