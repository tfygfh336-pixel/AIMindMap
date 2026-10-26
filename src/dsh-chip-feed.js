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
 *
 * ── 2026-10-42：投喂语义 = **追加**，幂等 = **`seq` 去重**（两者不是一回事）──────────────
 *   用户真机反馈（逐字）：「是块了，但是我先拉了两个过去，然后又选了两个过去，就会覆盖掉第一次的两个」
 *   ⇒ 上一版把 chip 路线写成 "`setDraft('')` → 逐条 insertReference"：清空整份草稿**是为了幂等**
 *     （"一次投喂恒等于一份"），但它把"追加"直接杀掉了 ⇒ 第二次投喂必然覆盖第一次。
 *   ⇒ 现在幂等**不再靠清空**：投喂通道带 `seq`（主进程分配 / 重试时沿用同一个），
 *     插件记住"已应用过的 seq 集合"（内存、FIFO 上限 `MAX_APPLIED`），同一个 seq 直接回
 *     `{ok:true, already:true}`（一个块都不插），新 seq 就**追加**。
 *   ⇒ 判据也跟着改（旧口径"块数恰好 N"在追加下必然假红）：见 `judgeInsertResult` 的三句话。
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
  /** 0.2.0（2026-10-42）：投喂语义从「清空重来」改成「**追加**」，幂等改由 `seq` 去重保证。
   *  ⇒ 载荷变了 ⇒ 必须重投（`install` 幂等，`verify` 会报 drift）。 */
  const PLUGIN_VERSION = '0.2.0';
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
  /** 「已应用过的 seq」集合的上界（FIFO 淘汰）。
   *  为什么是集合而不是「高水位 `seq > lastSeq`」——**二选一，这里选集合**：
   *    调用方给的 `seq` **不保证单调**（控制通道的 token、重放、将来的跨进程序号都可能更小），
   *    高水位会把一次**合法的**追加静默吞掉（= 用户的块丢了还不报错）；集合只吞**同一个** seq，
   *    永不吞别的 seq。代价是一点内存：一次投喂一个数字，64 个足够覆盖任何重试窗口。
   *  ⚠️ 这个数**同时**钉在载荷里（`var APPLIED_MAX = <这里>`），改这里就同时改载荷。 */
  const MAX_APPLIED = 64;

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

  /** 一个 occurrence 与一个期望单元是不是同一块（source / appearance / ref / label / clipboardText 全等）。 */
  function sameUnit(o, want) {
    const a = o || {}, w = want || {};
    return String(a.source) === SOURCE
      && String(a.appearance) === APPEARANCE
      && String(a.ref) === String(w.ref)
      && String(a.clipboardText) === String(w.clipboardText)
      && String(a.label == null ? '' : a.label) === String(w.label == null ? '' : w.label);
  }

  /**
   * 判"插件报回来的结果"算不算成功。**真值来自内核 store**（`InputState.occurrences`），
   * 插件只是转发；这里把"转发回来的东西对不对"钉死。
   *
   * ── 2026-10-42 改判据（**追加**语义；三条旧判据全部重写，不是删掉）────────────────
   *   旧口径（清空重来）：「occurrences 恰好 N 个」。
   *   ⇒ 追加语义下这句话**必然假红**（框里还有上一批），所以换成三句：
   *     ① **只许动自己那一类块**：先按 `source === 'reference'` **过滤**再比
   *        —— 将来 B（粘贴也成块）落地时，别人家的块不许把这条判据染红；
   *     ② **之前的不许被动**：`before` 那一份（插件在插入前读的）必须原样是 `after` 的**前缀**
   *        —— 谁把 `setDraft('')` 加回来，这一步立刻红（那是本批最容易做假的地方）；
   *     ③ **末尾恰好多了这一批**：`after` 的**末尾 N 个**逐条就是这一批（顺序即我给的顺序）。
   *   ⇒ 三句合起来才等于用户要的「拖两次 = 4 个块、同一次投喂只生效一次」。
   *
   * @param {object} result 插件 `insertRefs` 的返回值（JSON）
   * @param {Array<{ref:string,label:string,clipboardText:string}>} items 期望插入的单元（顺序即真值顺序）
   * @param {{minBefore?:number}} [opts] `minBefore` = 主进程台账里**已经投喂过**的块数。
   *   它是一条**单向**硬闸（只判"变少了"），而且**只在"页面说写前一个块都没有"时才用**：
   *   那正是"清空发生在读基线之前"的形状（页面自己看不出被清过 ⇒ 前缀判据抓不到）；
   *   若页面写前本来就有块，前缀判据已经够用，再比总量会因为"用户手动删过几个块"而假红。
   * @returns {{ok:boolean, already:boolean, added:number, reason:(string|null), occurrences:Array}}
   */
  function judgeInsertResult(result, items, opts) {
    const want = Array.isArray(items) ? items : [];
    const o = opts || {};
    const minBefore = Number(o.minBefore) > 0 ? Number(o.minBefore) : 0;
    const r = (result && typeof result === 'object') ? result : {};
    const rawAfter = Array.isArray(r.occurrences) ? r.occurrences : [];
    const rawBefore = Array.isArray(r.before) ? r.before : [];
    /* ★ 按 source 过滤（两处都过）：别人家的 chip 不参与本判据 —— §4.4 那条提前钉的坑 */
    const occ = rawAfter.filter((x) => x && String(x.source) === SOURCE);
    const before = rawBefore.filter((x) => x && String(x.source) === SOURCE);
    if (r.ok !== true) {
      return { ok: false, already: false, added: 0,
        reason: String(r.reason || '插件报失败但没给原因'), occurrences: occ };
    }
    if (r.already === true) {
      /* 同一个 seq 的第二次投喂：一个块都不许再插（这就是"同一次投喂只生效一次"）。 */
      const added = Number(r.added) || 0;
      if (added !== 0) {
        return { ok: false, already: true, added: added,
          reason: '回执说 already 但 added=' + added + '（说没插却又插了）', occurrences: occ };
      }
      return { ok: true, already: true, added: 0, reason: null, occurrences: occ };
    }
    if (occ.length !== before.length + want.length) {
      return { ok: false, already: false, added: occ.length - before.length,
        reason: '块数不对：写前 ' + before.length + ' 个 + 本批 ' + want.length + ' 个，实际 ' + occ.length
          + ' 个 —— 与期望不符（有过 0 次"清空"或部分插入？）', occurrences: occ };
    }
    if (before.length === 0 && minBefore > 0 && occ.length < minBefore + want.length) {
      /* 只在"页面说它写前一个块都没有、而台账说投过 minBefore 个"时才用这条闸：
       * 那正是"清空发生在**读基线之前**"的形状（页面自己看不出被清过 ⇒ 前缀判据抓不到）。
       * ⚠️ 不无条件比：用户手动删掉**几个**块后再拖，页面上本来就该少于台账 —— 那是正常操作，
       *    无条件比会把它判成"清掉了"（假红）。 */
      return { ok: false, already: false, added: occ.length - before.length,
        reason: '页面声称写前没有块，但主进程台账已投 ' + minBefore + ' 个（实际只有 ' + occ.length
          + ' 个，本批 ' + want.length + ' 个）—— 之前的块被清掉了（setDraft("") 回来了？）',
        occurrences: occ };
    }
    for (let i = 0; i < before.length; i++) {
      if (!sameUnit(occ[i], before[i])) {
        return { ok: false, already: false, added: occ.length - before.length,
          reason: '第 ' + (i + 1) + ' 个**原有**块的形状变了（ref=' + JSON.stringify(occ[i] && occ[i].ref)
            + '，写前是 ' + JSON.stringify(before[i] && before[i].ref) + '）—— 追加不许动已有的块',
          occurrences: occ };
      }
    }
    for (let k = 0; k < want.length; k++) {
      const got = occ[before.length + k] || {};
      if (!sameUnit(got, want[k])) {
        return { ok: false, already: false, added: occ.length - before.length,
          reason: '末尾第 ' + (k + 1) + ' 个新区块与期望不符（source=' + JSON.stringify(got.source)
            + ' ref=' + JSON.stringify(got.ref) + '，期望 ' + JSON.stringify(want[k].ref) + '）—— 与期望不符',
          occurrences: occ };
      }
    }
    return { ok: true, already: false, added: want.length, reason: null, occurrences: occ };
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
    '\t\t *  我们**不编数字**，只把它搬运给主进程。',
    '\t\t *  `offset`/`length` 是 clipboard 坐标（`Occurrence` 契约），`occurrenceId` 是壳内单调 id',
    '\t\t *  —— 三个读数都带上：判据要能说清"这一批是不是**接在末尾**"，而不是只数个数。 */',
    '\t\tfunction readOccurrences(input) {',
    '\t\t\ttry {',
    '\t\t\t\tvar st = input.state.getSnapshot() || {};',
    '\t\t\t\tvar occ = st.occurrences || [];',
    '\t\t\t\tvar out = [];',
    '\t\t\t\tfor (var i = 0; i < occ.length; i++) {',
    '\t\t\t\t\tvar o = occ[i] || {};',
    '\t\t\t\t\tout.push({ source: txt(o.source), ref: txt(o.ref), appearance: txt(o.appearance),',
    '\t\t\t\t\t\tclipboardText: txt(o.clipboardText), label: txt(o.label),',
    '\t\t\t\t\t\toffset: (typeof o.offset === "number" ? o.offset : null),',
    '\t\t\t\t\t\tlength: (typeof o.length === "number" ? o.length : null),',
    '\t\t\t\t\t\toccurrenceId: (typeof o.occurrenceId === "number" ? o.occurrenceId : null),',
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
    '\t\t/* ── 幂等层：已应用过的 `seq`（进程内、内存、FIFO 上限 APPLIED_MAX）────────────────',
    '\t\t * 2026-10-42 的核心改动：上一版靠 `setDraft("")`（清空整份草稿）保幂等 —— 那让',
    '\t\t * **第二次投喂把第一次的块全抹掉**（用户真机：「先拉了两个过去，然后又选了两个过去，',
    '\t\t * 就会覆盖掉第一次的两个」）。幂等的正确含义是"同一次投喂只生效一次"，不是"清空重来"。',
    '\t\t * ⇒ 现在：`seq` 在集合里就直接返回 `{ok:true, already:true}`（一个块都不插）；',
    '\t\t *    `seq` 是新的就**追加**，然后记进集合。 */',
    '\t\tvar APPLIED_MAX = ' + MAX_APPLIED + ';',
    '\t\tvar appliedOrder = [];',
    '\t\tvar appliedKeys = {};',
    '\t\tfunction appliedHas(seq) { return appliedKeys["s" + seq] === true; }',
    '\t\tfunction appliedAdd(seq) {',
    '\t\t\tvar k = "s" + seq;',
    '\t\t\tif (appliedKeys[k] === true) return;',
    '\t\t\tappliedKeys[k] = true;',
    '\t\t\tappliedOrder.push(seq);',
    '\t\t\t/* FIFO 淘汰：只留最近的 APPLIED_MAX 个（老的 seq 再来就当成新的一次投喂） */',
    '\t\t\twhile (appliedOrder.length > APPLIED_MAX) { delete appliedKeys["s" + appliedOrder.shift()]; }',
    '\t\t}',
    '\t\tfunction appliedView() { return { seqs: appliedOrder.slice(), total: appliedOrder.length, max: APPLIED_MAX }; }',
    '',
    '\t\t/** 等一帧：Lexical 的 DOM 选区 → 模型选区 的同步是异步的（vendor 第 5339 行 selectionchange）。',
    '\t\t *  两条腿（rAF + 定时器）取先到的 —— 窗口被遮挡时 rAF 可能不跑，定时器兜住。 */',
    '\t\tfunction frame() {',
    '\t\t\treturn new Promise(function (done) {',
    '\t\t\t\tvar fin = false;',
    '\t\t\t\tfunction go() { if (!fin) { fin = true; done(1); } }',
    '\t\t\t\ttry {',
    '\t\t\t\t\tif (typeof requestAnimationFrame === "function") { requestAnimationFrame(go); setTimeout(go, 32); }',
    '\t\t\t\t\telse setTimeout(go, 4);',
    '\t\t\t\t} catch (e) { setTimeout(go, 4); }',
    '\t\t\t});',
    '\t\t}',
    '',
    '\t\t/** 把光标折叠到**编辑器末尾**（返回走的是哪条腿：dom-range / live）。',
    '\t\t * 为什么必须先移末尾：`addFiles` 与 `insertReference` 都按**当前选区**落点',
    '\t\t *  （vendor 第 13336 行 `at = projection.selection?.end`）⇒ 光标停在半路会让新块',
    '\t\t *  插进旧块中间（不覆盖，但顺序错、用户看到"夹在中间"）。',
    '\t\t * 先用契约面的 `input.focus()`（"把键盘还给 composer"）⇒ 焦点元素就是 composer，',
    '\t\t * 再对它 `selectNodeContents + collapse(false)`；等价于 Lexical 内部的 `root.selectEnd()`，',
    '\t\t * 而那条是内核私有 API，页面侧只能这么达到同一效果。 */',
    '\t\tfunction caretToEnd() {',
    '\t\t\tvar mode = "live";',
    '\t\t\ttry {',
    '\t\t\t\tvar doc = document, sel = doc.getSelection ? doc.getSelection() : null;',
    '\t\t\t\tvar host = null, ae = doc.activeElement;',
    '\t\t\t\tif (ae && ae.isContentEditable === true) host = ae;',
    '\t\t\t\tif (!host) host = doc.querySelector("[data-lexical-editor=\'true\']");',
    '\t\t\t\tif (!host) {',
    '\t\t\t\t\tvar cands = doc.querySelectorAll("[contenteditable=\'true\'], [contenteditable=\'\'], [role=\'textbox\']");',
    '\t\t\t\t\tfor (var i = 0; i < cands.length; i++) {',
    '\t\t\t\t\t\tvar r = cands[i].getBoundingClientRect ? cands[i].getBoundingClientRect() : null;',
    '\t\t\t\t\t\tif (r && r.width > 60) { host = cands[i]; break; }',
    '\t\t\t\t\t}',
    '\t\t\t\t}',
    '\t\t\t\tif (host && sel && doc.createRange) {',
    '\t\t\t\t\tvar rg = doc.createRange();',
    '\t\t\t\t\ttry { host.focus(); } catch (e1) {}',
    '\t\t\t\t\trg.selectNodeContents(host);',
    '\t\t\t\t\trg.collapse(false);',
    '\t\t\t\t\tsel.removeAllRanges();',
    '\t\t\t\t\tsel.addRange(rg);',
    '\t\t\t\t\tmode = "dom-range";',
    '\t\t\t\t}',
    '\t\t\t} catch (e) { mode = "live"; }',
    '\t\t\treturn mode;',
    '\t\t}',
    '',
    '\t\t/**',
    '\t\t * 插入 N 个 chip：**追加**（不动草稿里已有的东西）→ 读 occurrences 判真值。',
    '\t\t * 任何一步不成立都返回 ok:false + reason（主进程据此**降级成纯文本**，绝不留"什么都没发生"）',
    '\t\t * —— 唯一的例外由主进程处理：**已经落了几个块**时它不再写文本（写了就是重复）。',
    '\t\t *',
    '\t\t * 路线优先级（都是内核**自己的**入口，不另造通道）：',
    '\t\t *   ① `addFiles(refs, [])` —— 真人拖文件进 composer 走的就是它（vendor 第 18281/18313 行',
    '\t\t *      → 13564 → 13331 `insertFileReferences`）：**在选区末尾批量追加** chip + 空格，',
    '\t\t *      不删选区、不做 span CAS ⇒ 天生的 append 语义；',
    '\t\t *   ② `insertReference(ref, span)` —— 契约面。⚠️ 锚点必须是**末尾**（`captureInsertion()`',
    '\t\t *      取到的是"移末尾之后"的选区），不再是上一版的 `{start:0,end:0}`（那是"清空后从 0 开始"）。',
    '\t\t *      CAS 只比 `draftRev`、不比起始位置（vendor 第 13747 行）⇒ 末尾 span 就是追加。',
    '\t\t */',
    '\t\tasync function insertRefs(scope, payload) {',
    '\t\t\tvar items = (payload && payload.items && payload.items.length) ? payload.items : [];',
    '\t\t\tvar isProbe = !!(payload && payload.probe === true);',
    '\t\t\tif (!isProbe && items.length === 0) return { ok: false, reason: "empty-payload" };',
    '\t\t\tvar seq = (payload && typeof payload.seq === "number") ? payload.seq : NaN;',
    '\t\t\tif (!isFinite(seq) || seq <= 0) return { ok: false, reason: "no-seq" };',
    '\t\t\t/* ⓪ 幂等：同一个 seq 只应用一次 —— **一个块都不插**（这正是"重试不变两遍"）。',
    '\t\t\t *  放在解析 session **之前**：重试那一次连内核都不该碰（碰了就可能多一次副作用）。 */',
    '\t\t\tif (!isProbe && appliedHas(seq)) {',
    '\t\t\t\treturn { ok: true, already: true, seq: seq, route: "none", added: 0, caret: "skipped",',
    '\t\t\t\t\toccurrences: [], before: [], applied: appliedView() };',
    '\t\t\t}',
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
    '\t\t\t/* 只读探针（`probe: true`）：只回答"这个 seq 应用过没有"，**一个字都不写**。',
    '\t\t\t * 主进程在 chip 通道超时 / 抛错之后用它判"到底落没落" —— 落过就绝不再写文本',
    '\t\t\t * （否则就是同一批投喂变成两遍，正是本批要治的东西）。 */',
    '\t\t\tif (isProbe) {',
    '\t\t\t\treturn { ok: true, probe: true, already: appliedHas(seq), seq: seq, added: 0,',
    '\t\t\t\t\toccurrences: readOccurrences(input), applied: appliedView() };',
    '\t\t\t}',
    '\t\t\tvar refs = [];',
    '\t\t\tfor (var i = 0; i < items.length; i++) {',
    '\t\t\t\trefs.push({ source: SOURCE, appearance: APPEARANCE, ref: txt(items[i].ref),',
    '\t\t\t\t\tlabel: txt(items[i].label), clipboardText: txt(items[i].clipboardText) });',
    '\t\t\t}',
    '\t\t\t/* ① 焦点 + 光标到末尾，然后等一帧让模型选区跟上。',
    '\t\t\t *  ⚠️ **不许**为了"看起来整齐"插换行（上一版试过：`\\n` 在 Lexical 里不成分段，',
    '\t\t\t *  vendor 第 7042-7089）；chip 之间内核自己补空格（第 13338 行），天然不用我们补。 */',
    '\t\t\ttry { if (typeof input.focus === "function") input.focus(); } catch (e0) {}',
    '\t\t\tvar caret = caretToEnd();',
    '\t\t\tawait frame();',
    '\t\t\t/* 插入前的真值：判"末尾恰好多了这一批"的基线（也用来算"实际落了几个"）。 */',
    '\t\t\tvar before = readOccurrences(input);',
    '\t\t\tvar route = "";',
    '\t\t\tif (typeof input.addFiles === "function") {',
    '\t\t\t\tif (input.addFiles(refs, []) === true) route = "addFiles";',
    '\t\t\t}',
    '\t\t\tif (route === "" && typeof input.insertReference === "function") {',
    '\t\t\t\troute = "insertReference";',
    '\t\t\t\tfor (var j = 0; j < refs.length; j++) {',
    '\t\t\t\t\tvar span = null;',
    '\t\t\t\t\ttry {',
    '\t\t\t\t\t\tspan = (input.actions && typeof input.actions.captureInsertion === "function")',
    '\t\t\t\t\t\t\t? input.actions.captureInsertion() : null;',
    '\t\t\t\t\t} catch (e2) { span = null; }',
    '\t\t\t\t\tif (!span || typeof span.start !== "number" || typeof span.end !== "number") { route = ""; break; }',
    '\t\t\t\t\tif (input.insertReference(refs[j],',
    '\t\t\t\t\t\t{ start: span.start, end: span.end, draftRev: span.draftRev }) !== true) { route = ""; break; }',
    '\t\t\t\t\tawait frame();',
    '\t\t\t\t}',
    '\t\t\t}',
    '\t\t\tvar after = readOccurrences(input);',
    '\t\t\tvar mineBefore = 0, mineAfter = 0, k;',
    '\t\t\tfor (k = 0; k < before.length; k++) if (before[k].source === SOURCE) mineBefore++;',
    '\t\t\tfor (k = 0; k < after.length; k++) if (after[k].source === SOURCE) mineAfter++;',
    '\t\t\t/* ② 页面侧只做**最小自检**（它必须能立刻说"这次到底成没成"）；完整判据在',
    '\t\t\t *    src/dsh-chip-feed.js 的 judgeInsertResult（唯一一份完整规则，主进程执行）。 */',
    '\t\t\tvar okShape = (route !== "") && (mineAfter === mineBefore + items.length);',
    '\t\t\tif (okShape) {',
    '\t\t\t\tvar tail = [];',
    '\t\t\t\tfor (k = 0; k < after.length; k++) if (after[k].source === SOURCE) tail.push(after[k]);',
    '\t\t\t\tfor (k = 0; okShape && k < items.length; k++) {',
    '\t\t\t\t\tvar got = tail[mineBefore + k] || {};',
    '\t\t\t\t\tif (got.source !== SOURCE) okShape = false;',
    '\t\t\t\t\tif (got.appearance !== APPEARANCE) okShape = false;',
    '\t\t\t\t\tif (got.ref !== txt(items[k].ref)) okShape = false;',
    '\t\t\t\t\tif (got.clipboardText !== txt(items[k].clipboardText)) okShape = false;',
    '\t\t\t\t}',
    '\t\t\t}',
    '\t\t\t/* 记 seq 的条件：**真的落了块**（哪怕形状不全也对）⇒ 免得重试把它变成两遍；',
    '\t\t\t * 一个都没落 ⇒ 不记（重试才有机会成功）。 */',
    '\t\t\tif (okShape || mineAfter > mineBefore) appliedAdd(seq);',
    '\t\t\tvar reason = okShape ? null',
    '\t\t\t\t: (route === ""',
    '\t\t\t\t\t? "两条插入路线都没被接受（phase 不是 plain/claimed，或内核签名变了）"',
    '\t\t\t\t\t: ("插入后块数/顺序与期望不符（写前 " + mineBefore + " 个，写后 " + mineAfter',
    '\t\t\t\t\t\t+ " 个，本批 " + items.length + " 个）"));',
    '\t\t\treturn { ok: okShape, already: false, seq: seq, route: route, caret: caret,',
    '\t\t\t\tbefore: before, occurrences: after, added: mineAfter - mineBefore,',
    '\t\t\t\tapplied: appliedView(), draft: draftOf(input), want: items.length, reason: reason };',
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
    PLUGIN_NAME, PLUGIN_VERSION, ROW_ID, SOURCE, APPEARANCE, HANDLE, READY, REF_MAX, MAX_ITEMS, MAX_APPLIED,
    chipUnitsFromText, isChipSafeUnit, judgeInsertResult, sameUnit,
    files, HOST_INDEX_JS, CLIENT_JS, PACKAGE_JSON, CORDIS_PATCH_YML,
    install, uninstall, verify, pluginDirOf
  };
});
