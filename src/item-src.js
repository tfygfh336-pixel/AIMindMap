/* ============================================================
 * src/item-src.js — 条目「出处」（`src`）这一维的唯一实现处
 * ------------------------------------------------------------
 * 契约：`docs/ITEM-MODEL.md` §1（`src` 形状）、§12（S4 那一句：**`verified` 是"怎么核的"
 * 的记录，不是布尔**）。本模块回答一个问题：**这条出处在今天还成不成立**。
 *
 * ## 为什么必须有这个文件（而不是把判定写在命令里）
 * 出处这一维有三个用法：`recheck` 逐条点名、`health` 报读数、`search --src` 过滤。
 * 三处各写一份「什么算同一个出处 / 什么算过期」⇒ 必然漂移，而漂移的后果是
 * "同一条数据在体检里是过期的、在检索里是命中的" —— 那种自相矛盾比不判还坏。
 * ⇒ **解析 / 判定 / 子串匹配只在这里**；**归一化**（`string|string[]` → 只留非空字符串的数组）
 *   的唯一实现在 `src/item-index.js` 的 `srcList()`，本文件那一份是**薄适配**
 *   （第四批收口：改前是两份同口径实现，靠交叉断言兜着；现在只剩一处，方向与理由见 `normalizeSrc`）。
 *
 * ## 判定口径（三条，都可执行）
 *   1. **文件在不在**：`file:line` 里的 file（相对**工程根**；绝对路径也认，但会标 `outside`/绝对
 *      路径的注意点）必须能读到 —— 读不到 ⇒ `src-gone`。
 *   2. **引文在不在**（本流新增的**扩展**形式 `file:line::引文`，老形状一个字节都不变）：
 *      给了引文就在文件里**逐字搜**（`indexOf`，不分词、不折叠大小写）——
 *      找不到 ⇒ `src-gone`（出处所引的内容已不在那份文件里 = 出处失效）。
 *   3. **过期没有**：文件的 `mtime` **晚于** `verified.at` ⇒ `needs-recheck`
 *      （"核过之后源文件又改过"）。`line` **只作导航**、允许腐坏（行号越界 ⇒ `needs-recheck`，
 *      不是 `src-gone`：文件还在，只是短了/行号漂了）。
 *   没给引文、也没有 `verified` ⇒ 只能判"文件在不在"（没有可对照的时刻）—— 如实说，不假装判过。
 *
 * ## `verified` 缺不代表出处没问题
 * 契约 §1：`verified` **缺失 = 未核**。所以"未核"是**条目**级的事，不是出处级的事：
 * 条目的最终判定由 `inspect()` 汇总（见那里的裁决表），本模块只把两件事分开报，不混。
 *
 * ## 已知边界（如实登记，别当它万能）
 *   · `mtime` 是**近似**：本工程没有在条目里存"核验时的文件指纹"的位置（`verified` 只有
 *     at/by/how）⇒ "文件改过"只能靠时间戳。**克隆/还原一份仓库会把全部文件 mtime 刷新**
 *     ⇒ 那一次复校会把已核条目大面积报成 `needs-recheck`（宁可多报，不可漏报）。
 *   · URL / 命令型出处**不可机核**（离线、且复校不该产生网络与副作用）⇒ 一律
 *     `needs-recheck` + 专用 reason，交给人和模型。
 *   · 本模块**只读**：除 `loadFile` 的读盘外无任何副作用；同一次运行里**同一个文件只读一次**
 *     （`createCache()` 里按绝对路径 memo），这是"文件级指纹做廉价前置"的落地形态。
 *   · 本模块是 **Node-only**（要读盘），与 `src/item-index.js` 那种 UMD 双端模块不同
 *     （同 `src/doc-import.js` 的先例）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/* 归一化的**唯一实现**在条目索引那一份（本文件只做薄适配）—— 方向与理由见 `normalizeSrc`：
 * 同层（`scripts/dep-direction-check.js` 的 LAYERS 里两文件都是 rank 1、同 rank 互不判方向），
 * 且 `src/item-index.js` **零依赖本文件** ⇒ 这条边不成环（S1 门禁实跑证明）。 */
const itemIndex = require('./item-index.js');

/* ============================================================================
 * 一、取值表（封闭；判定与报错文案共用一处 ⇒ 不许在命令里另写一份）
 * ========================================================================== */

/** 条目级判定：只有这三个（S4 派发词冻结的形状）。 */
const VERDICTS = Object.freeze(['ok', 'needs-recheck', 'src-gone']);

/** 单条出处（ref）的形态：file / url / command / unknown —— 封闭取值表。 */
const KINDS = Object.freeze(['file', 'url', 'command', 'unknown']);

/**
 * 条目级 reason 的**封闭取值表**（体检要按它出"原因分布"，所以顺序也被当成契约：
 * 分布表按这个顺序打印 ⇒ 同状态两次运行逐字节相同）。
 */
const REASONS = Object.freeze([
  'no-src',                 // 条目没有 src：机器无从复校
  'src-gone',               // 出处文件不存在 / 读不了
  'quote-missing',          // 引文在那份文件里找不到了
  'line-out-of-range',      // 行号越界（文件短了；line 只作导航）
  'file-changed',           // 出处文件在 verified.at 之后改过（src 过期）
  'unverifiable-url',       // URL 出处：离线不可机核
  'unverifiable-command',   // 命令型出处：复校不该代跑
  'unrecognized-src',       // 出处形状无法识别
  'unverified',             // 没有 verified 记录（缺失 = 未核，契约 §1）
  'superseded-unknown'      // supersededBy 指向一个不存在的条目
]);

/** 引文分隔符：`file:line::引文`。为什么用 `::` 而不是 `#`：`#` 在 URL 锚点/文件名里都合法
 *  （`CHANGELOG.md#713` 会被误读成"文件 + 引文 713"），`::` 不在任何路径语法里。 */
const QUOTE_SEP = '::';

/** 命令型出处的判据（第一段是外壳名就够判；只认"真的能跑"的那些） */
const COMMAND_RE = /^(npm|npx|pnpm|yarn|node|git|pwsh|powershell|cmd|python|python3|pip|pip3|docker|make|cargo|go|deno|bun)\b/;
/** URL 型出处的判据（scheme://…） */
const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
/** `file:line` / `file:line-to`（`?` 惰性 + `$` 锚定 ⇒ `C:\x.md:12` 也能正确切出 `C:\x.md`） */
const FILE_LINE_RE = /^(.+?):(\d+)(?:-(\d+))?$/;
/** 没有行号时"这看着像一个文件路径吗"：含分隔符，或结尾是常见文本扩展名 */
const PATH_EXT_RE = /^[^\s]+\.(md|markdown|js|cjs|mjs|json|txt|html|htm|css|yml|yaml|py|ts|tsx|jsx|docx|pdf|png|jpg|jpeg|svg|log|ini|toml)$/i;

/* ============================================================================
 * 二、归一化与解析（纯函数）
 * ========================================================================== */

/**
 * `src` 归一成字符串数组。
 *
 * ⚠️ **归一化的唯一实现在 `src/item-index.js` 的 `srcList()`** —— 谓词（`string` 或
 * `string[]` ⇒ 只留**非空字符串**，保序、**不去重**）只在那里写一遍；本函数是它的**薄适配**：
 * 把"值"包成"条目形状"再交给那一处。**方向为什么是这个**（`scripts/dep-direction-check.js`
 * 的 LAYERS 实测：`src` 是 rank 1，两个文件**同层**、同 rank 互不判方向 ⇒ 形式上下两个方向都行）：
 *   · `src/item-index.js` 是 **UMD 双端**（那个模块的写法就为"浏览器侧 `<script>` 直载"，
 *     同目录的 `schema.js` / `query.js` 都是这个样子），本模块是 **Node-only**（要读盘）——
 *     双端模块若依赖 Node-only 模块，浏览器那一侧会**静默失效**（那边根本没有 `MMItemSrc`
 *     全局可注入，也没有 `root.MMItemSrc` 可传）；边界如实说：`item-index.js` **今天**还没被
 *     `renderer/index.html` 直载（只在 Node 侧被 require），但双端契约在，哪天被载进去就是坑；
 *   · 反方向（Node-only → UMD）是本工程**既有先例**：`src/doc-import.js` → `./convert.js` / `./markdown.js`；
 *   · 成环已核：`src/item-index.js` 只 require `./tree-utils.js` / `./convert.js`（都不指向本文件）
 *     ⇒ 不可能造出同层环，实跑读数见交付（S1 门禁）。
 * ⇒ 归一化留在双端那一侧；本文件只管这一维的**解析 / 判定 / 子串匹配**。
 */
function normalizeSrc(v) {
  return itemIndex.srcList({ src: v });
}

/** 看着像文件路径吗（没有行号时的兜底判据） */
function looksLikePath(s) {
  if (!s) return false;
  if (/[\\/]/.test(s)) return true;
  return PATH_EXT_RE.test(s);
}

/**
 * 把一条出处字符串解析成结构化 ref（**纯函数、不读盘**）。
 *
 * 认的形状（契约 §1 的三种 + 本流新增的引文扩展）：
 *   · `CHANGELOG.md:713` / `docs/ITEM-MODEL.md:66-70`  → file + line(/to)
 *   · `CHANGELOG.md`                                   → file（无行号）
 *   · `docs/ITEM-MODEL.md:66::逐字节相等`               → file + line + **引文**（扩展形式）
 *   · `https://…`                                      → url
 *   · `npm run verify` / `node cli/mm-cli.js …`         → command
 *   · 其余                                              → unknown（**如实报**，不硬猜成路径）
 *
 * @param {*} raw 出处原串
 * @returns {{raw:string, kind:string, file:(string|null), line:(number|null), to:(number|null),
 *            quote:(string|null), absolute:boolean}}
 */
function parseRef(raw) {
  const text = (raw === undefined || raw === null) ? '' : String(raw).trim();
  const ref = {
    raw: (raw === undefined || raw === null) ? String(raw) : String(raw),
    kind: 'unknown', file: null, line: null, to: null, quote: null, absolute: false
  };
  if (!text) return ref;
  // 引文在**最外层**切：先切引文，再解析 head（引文里允许出现冒号、逗号、空格）
  const qi = text.indexOf(QUOTE_SEP);
  const head = (qi >= 0 ? text.slice(0, qi) : text).trim();
  if (qi >= 0) {
    const q = text.slice(qi + QUOTE_SEP.length).trim();
    ref.quote = q || null;
  }
  if (URL_RE.test(head)) { ref.kind = 'url'; ref.file = head; return ref; }
  if (COMMAND_RE.test(head)) { ref.kind = 'command'; ref.file = head; return ref; }
  const m = FILE_LINE_RE.exec(head);
  if (m) {
    ref.kind = 'file';
    ref.file = m[1].trim();
    ref.line = Number(m[2]);
    ref.to = m[3] === undefined ? null : Number(m[3]);
  } else if (looksLikePath(head)) {
    ref.kind = 'file';
    ref.file = head;
  }
  if (ref.kind === 'file') ref.absolute = path.isAbsolute(ref.file);
  return ref;
}

/** 一次解析整份出处（归一化 + 逐条 parseRef） */
function parseSrcList(v) {
  return normalizeSrc(v).map(parseRef);
}

/**
 * `search --src` 的过滤口径（契约 §3.4：只命中 `src` 含**子串**的条目）。
 * 与 `src/item-index.js` 的 `passItemFilters` 里那条 `list.some(s => s.indexOf(f.src) >= 0)`
 * **逐字同义** —— 本模块是这一维的唯一实现处，检索面将来改成调它即可（不改行为）。
 */
function matchesSrc(itemOrSrc, needle) {
  if (needle === undefined || needle === null || needle === '') return false;
  const list = Array.isArray(itemOrSrc) ? normalizeSrc(itemOrSrc) : normalizeSrc(itemOrSrc && itemOrSrc.src);
  const q = String(needle);
  return list.some((s) => s.indexOf(q) >= 0);
}

/* ============================================================================
 * 三、读盘与"廉价前置"（同一文件在同一次运行里只读一次）
 * ========================================================================== */

/**
 * 一次复校/体检共用的缓存（`recheck` 与 `health` 各建一个，传到底）。
 *   · `files`  绝对路径 → 文件记录（内容 + sha256 + mtimeMs + 行数）——**一个文件读一次**
 *   · `quotes` `sha256\0引文` → 命中与否 —— 同一版本同一引文只搜一次
 *   · `reads`  真实读盘次数（测试用它证明"一个文件读一次"，别拿它当业务语义）
 */
function createCache() {
  return { files: new Map(), quotes: new Map(), reads: 0 };
}

/** sha256 十六进制（唯一实现处；别在别处再写一份指纹算法） */
function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 行数（空文件 = 0；末尾换行不额外算一行 —— 宁可少报一行，也不要把合法行号判成越界） */
function countLines(text) {
  const s = String(text);
  if (!s) return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

/** 出处相对工程根解析成绝对路径（相对 ⇒ 相对 `root`；绝对 ⇒ 原样） */
function resolveFile(ref, root) {
  const raw = String(ref.file).replace(/[\\/]+/g, path.sep);
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(root || process.cwd(), raw);
}

/**
 * 读一个出处文件（**带缓存**：绝对路径为键，一次运行只读一次）。
 * @returns {{ok:true, path, bytes, mtimeMs, sha256, text, lineCount}}
 *        | {{ok:false, path, code:'file-missing'|'file-unreadable', reason}}
 */
function loadFile(abs, cache) {
  const c = cache || createCache();
  const key = path.resolve(abs);
  const hit = c.files.get(key);
  if (hit) return hit;
  let rec;
  try {
    const text = fs.readFileSync(key, 'utf8');
    const st = fs.statSync(key);
    rec = {
      ok: true, path: key, bytes: st.size, mtimeMs: st.mtimeMs,
      sha256: sha256(text), text: text, lineCount: countLines(text)
    };
    c.reads++;
  } catch (e) {
    rec = {
      ok: false, path: key,
      code: (e && e.code === 'ENOENT') ? 'file-missing' : 'file-unreadable',
      reason: (e && e.message) || String(e)
    };
  }
  c.files.set(key, rec);
  return rec;
}

/** 文件级指纹（公开：`health --json` 的 `criteria` 与测试都用得到它；带缓存） */
function fingerprint(abs, cache) {
  const f = loadFile(abs, cache);
  if (!f.ok) return f;
  return {
    ok: true, path: f.path, bytes: f.bytes, sha256: f.sha256,
    mtimeMs: f.mtimeMs, lineCount: f.lineCount
  };
}

/** 「过期」判定：出处文件的 mtime **晚于** `verified.at`（没有可对照的时刻 ⇒ 判不了 ⇒ false） */
function isStale(fileRec, verifiedAt) {
  if (!fileRec || !fileRec.ok || !verifiedAt) return false;
  const t = Date.parse(String(verifiedAt));
  if (!Number.isFinite(t)) return false;
  return fileRec.mtimeMs > t;
}

/* ============================================================================
 * 四、单条出处的判定
 * ========================================================================== */

/** 长文本截断（报错/回显里点名的引文片段；只影响可读性） */
function clip(text, max) {
  const s = String(text);
  const n = max || 60;
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/**
 * 判一条出处。
 *
 * @param {{raw,kind,file,line,to,quote,absolute}} ref `parseRef` 的产物
 * @param {{root?:string, cache?:object, verifiedAt?:(string|null)}} [opts]
 * @returns {{raw, kind, verdict, code, detail, file?:string, lines?:number, line?:number, to?:number,
 *            quote?:string, stale?:boolean, outside?:boolean}}
 *   `verdict` ∈ VERDICTS；`code` 是**该 ref 的**细粒度原因（见 REASONS 的口径）。
 */
function judgeRef(ref, opts) {
  const o = opts || {};
  const root = o.root || process.cwd();
  const cache = o.cache || createCache();
  const out = { raw: ref.raw, kind: ref.kind, verdict: 'needs-recheck', code: '', detail: '' };
  if (ref.kind === 'url') {
    out.code = 'unverifiable-url';
    out.detail = 'URL 出处离线不可机核（复校不该发起网络访问）⇒ 需要人或模型去看：' + clip(ref.file, 80);
    return out;
  }
  if (ref.kind === 'command') {
    out.code = 'unverifiable-command';
    out.detail = '命令型出处不能由复校代跑（有副作用 / 有耗时）⇒ 需要人或模型去核：' + clip(ref.file, 80);
    return out;
  }
  if (ref.kind === 'unknown') {
    out.code = 'unrecognized-src';
    out.detail = '出处形状无法识别（契约 §1 允许 `file:line` / URL / 命令；'
      + '带引文写 `file:line::引文`）：' + clip(ref.raw, 80);
    return out;
  }
  // ---- file ----
  const abs = resolveFile(ref, root);
  out.file = ref.absolute ? abs : String(ref.file);
  out.line = ref.line === null ? undefined : ref.line;
  out.to = ref.to === null ? undefined : ref.to;
  if (ref.quote) out.quote = clip(ref.quote, 80);
  out.outside = !isInside(root, abs);
  const f = loadFile(abs, cache);
  if (!f.ok) {
    out.verdict = 'src-gone';
    out.code = 'src-gone';
    out.detail = (f.code === 'file-missing' ? '出处文件不存在' : '出处文件读不了') + '：' + out.file
      + (f.code === 'file-missing' ? '' : '（' + clip(f.reason, 120) + '）');
    return out;
  }
  out.lines = f.lineCount;
  const stale = isStale(f, o.verifiedAt);
  if (stale) out.stale = true;
  const at = '（现况 ' + f.bytes + ' 字节 / ' + f.lineCount + ' 行 / sha256 ' + f.sha256.slice(0, 12)
    + '…' + (out.outside ? '；⚠ 它在工程根之外' : '') + '）';
  if (ref.quote) {
    // 引文搜索：按 `sha256 + 引文` memo（同一文件的同一版本，同一引文只搜一次）
    const memoKey = f.sha256 + '\u0000' + ref.quote;
    let found = cache.quotes.get(memoKey);
    if (found === undefined) { found = f.text.indexOf(ref.quote) >= 0; cache.quotes.set(memoKey, found); }
    if (!found) {
      out.verdict = 'src-gone';
      out.code = 'quote-missing';
      out.detail = '引文在 ' + out.file + ' 里找不到了（出处所引的内容已不在那份文件里）：'
        + JSON.stringify(clip(ref.quote)) + at;
      return out;
    }
    if (stale) {
      out.verdict = 'needs-recheck';
      out.code = 'file-changed';
      out.detail = '引文仍在，但文件在核验（verified.at）之后改过 ⇒ 结论可能已被影响，需复核' + at;
      return out;
    }
    out.verdict = 'ok';
    out.code = 'ok';
    out.detail = '引文逐字命中' + (ref.line === null ? '' : '（记录行 ' + ref.line + '，只作导航）') + at;
    return out;
  }
  // ---- 没有引文：只能看文件在不在、行号还合不合法 ----
  if (ref.line !== null && ref.line > f.lineCount) {
    out.verdict = 'needs-recheck';
    out.code = 'line-out-of-range';
    out.detail = '行 ' + ref.line + ' 已越界（文件现在只有 ' + f.lineCount + ' 行）—— '
      + 'line 只作导航、允许腐坏，所以不是"出处失效"，但需要复核这条引用' + at;
    return out;
  }
  if (stale) {
    out.verdict = 'needs-recheck';
    out.code = 'file-changed';
    out.detail = '出处文件在核验（verified.at）之后改过 ⇒ 结论可能已被影响，需复核' + at;
    return out;
  }
  out.verdict = 'ok';
  out.code = 'ok';
  out.detail = '出处文件在' + (ref.line === null ? '' : '，记录行 ' + ref.line + ' 未越界') + at;
  return out;
}

/** `abs` 是否在 `root` 之内（`outside` 只是个**提示**：工程外的出处照核，但要让人看见） */
function isInside(root, abs) {
  if (!root) return true;
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* ============================================================================
 * 五、条目级裁决（**唯一的汇总处**）
 * ========================================================================== */

/** 条目的核验时刻（`verified` 三字段全必填；取不到就是"没核过"） */
function verifiedAtOf(item) {
  const v = item && item.verified;
  if (!v || typeof v !== 'object') return null;
  return (typeof v.at === 'string' && v.at) ? v.at : null;
}

/**
 * 逐条裁决一个条目（**纯函数 + 读盘**，读盘走缓存）。
 *
 * ## 裁决表（封闭；`recheck` 与 `health` 都只认这一张表）
 *   · 任一条 file 型出处的**文件没了/读不了**，或**引文找不到** ⇒ `src-gone`（出处失效）
 *   · 否则，任一条出处"判不过"（行号越界 / 文件在核验后改过 / URL / 命令 / 认不出来）
 *     ⇒ `needs-recheck`
 *   · 否则，条目**没有 `verified`** ⇒ `needs-recheck`（缺失 = 未核；核验记录是"怎么核的"的唯一凭据）
 *   · 否则 ⇒ `ok`
 *   `supersededBy` 指向不存在的条目 ⇒ 记 `dangling`（也进 `needs-recheck`）：
 *   它是**引用悬挂**，与出处是两件事，故单列字段、不混进 reason 的出处那一族。
 *
 * @param {object} item 条目
 * @param {string} root 出处相对路径的根（工程根）
 * @param {{cache?:object, itemIds?:(Set<string>|null)}} [opts]
 *        `itemIds` = 全项目条目 id 集合（给了才判 `supersededBy` 悬挂；不给就**如实不判**）
 * @returns {{verdict, reasons:[{code,detail}], refs:[…], src:string[], verified:boolean,
 *            verifiedAt:(string|null), stale:boolean, noSrc:boolean, superseded:boolean,
 *            dangling:[{code,detail}]}}
 */
function inspect(item, root, opts) {
  const o = opts || {};
  const cache = o.cache || createCache();
  const it = item || {};
  const src = normalizeSrc(it.src);
  const verifiedAt = verifiedAtOf(it);
  const refs = src.map((raw) => judgeRef(parseRef(raw), { root: root, cache: cache, verifiedAt: verifiedAt }));
  const reasons = [];
  const dangling = [];
  const bad = refs.filter((r) => r.verdict !== 'ok');

  if (!src.length) {
    reasons.push({ code: 'no-src', detail: '条目没有 `src`：机器无从复校（出处是可复核的前提）' });
  }
  bad.forEach((r) => {
    // ref 的 code 与条目级 reason 的取值表是**同一张表**（见 REASONS），所以直接透传
    reasons.push({ code: r.code, detail: r.detail + '｜出处：' + r.raw });
  });
  if (!verifiedAt) {
    reasons.push({
      code: 'unverified',
      detail: '没有 `verified` 记录（缺失 = 未核，契约 §1）—— 核验记录是"**怎么核的**"的唯一凭据，'
        + '写回：`item-edit … --verified --how "…"` 或 `recheck … --write-verified --how "…"`'
    });
  }
  if (it.supersededBy !== undefined && it.supersededBy !== null && it.supersededBy !== '') {
    if (o.itemIds && o.itemIds instanceof Set && !o.itemIds.has(String(it.supersededBy))) {
      reasons.push({
        code: 'superseded-unknown',
        detail: '`supersededBy` 指向的条目不存在: ' + it.supersededBy
          + '（悬挂引用 —— 要么补上那条，要么改指向）'
      });
      dangling.push({
        code: 'superseded-unknown',
        detail: 'supersededBy → ' + it.supersededBy + '（该条目不在本项目里）'
      });
    }
  }

  // 裁决（**顺序即优先级**）：出处失效 > 引用悬挂 > 出处判不过 / 未核 > 就绪
  const anyGone = bad.some((r) => r.verdict === 'src-gone');
  let verdict = 'ok';
  if (anyGone) verdict = 'src-gone';
  else if (dangling.length || bad.length || !verifiedAt) verdict = 'needs-recheck';

  return {
    verdict: verdict,
    reasons: reasons,
    refs: refs,
    src: src,
    verified: !!verifiedAt,
    verifiedAt: verifiedAt,
    stale: refs.some((r) => r.stale === true),
    noSrc: src.length === 0,
    superseded: !!(it.supersededBy !== undefined && it.supersededBy !== null && it.supersededBy !== ''),
    dangling: dangling
  };
}

/**
 * S4 派发词冻结的**简洁签名**：`judge(item, root, opts) -> 'ok' | 'needs-recheck' | 'src-gone'`。
 * 它就是 `inspect().verdict`（**只有一处实现**，别让两者各写一份裁决）。
 */
function judge(item, root, opts) {
  return inspect(item, root, opts).verdict;
}

module.exports = {
  // 取值表（封闭）
  VERDICTS: VERDICTS, KINDS: KINDS, REASONS: REASONS, QUOTE_SEP: QUOTE_SEP,
  // 归一化 / 解析（纯函数）
  normalizeSrc: normalizeSrc, parseRef: parseRef, parseSrcList: parseSrcList, matchesSrc: matchesSrc,
  // 读盘（带缓存）
  createCache: createCache, loadFile: loadFile, fingerprint: fingerprint,
  resolveFile: resolveFile, sha256: sha256, countLines: countLines,
  // 判定
  judgeRef: judgeRef, isStale: isStale, verifiedAtOf: verifiedAtOf,
  inspect: inspect, judge: judge
};
