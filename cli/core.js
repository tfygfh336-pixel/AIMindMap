/* ============================================================
 * cli/core.js — CLI 共享上下文
 * ------------------------------------------------------------
 * 给每个命令一个 ctx：
 *   - store       DataStore（projects 根目录）
 *   - args        yargs 风格解析后的参数对象
 *   - projectName 首个位置参数（若存在）
 *   - read()      读取当前项目 { file, data }
 *   - write(data) 写回项目（过 schema 校验闸门）
 *   - mutate(fn)  读 → 改 → 写；**并发时可安全自动重放**（多路同时编辑的入口，见 src/concurrency.js）
 *   - root        当前项目 data.data（根节点）
 *   - find(id)    在树中查找节点
 *   - out(text)   stdout 输出
 *   - outJson(obj)  --json 时 JSON.stringify 输出
 *   - error(msg)  输出 error: 前缀并终止
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const { createStore } = require('../src/data-store.js');
const concurrency = require('../src/concurrency.js');
const schema = require('../src/schema.js');
const tree = require('../src/tree-utils.js');

/**
 * projects 根目录。
 *
 * 默认是工程内的 `projects/`。**可用环境变量 `AI_MINDMAP_PROJECTS_DIR` 覆盖** ——
 * 这是为了让宿主（main.js 的冒烟沙箱、未来的自动化）能把 CLI 的重定向到临时副本。
 *
 * 为什么必须支持覆盖：main.js 冒烟时把**自己**的 store 指向临时目录，但它经
 * `runCli()` 调起的 CLI 是**另一个进程**，自己算出 `projects/` 就是真实目录 ——
 * 于是"渲染层随便写、反正写的是副本"的假设在**经 CLI 的写操作**上不成立，
 * 冒烟会真的改动用户数据（曾实际发生：新增的关系审计断言调用 `link`，
 * 把一条链接写进了真实项目）。宿主必须能把写路径一并重定向。
 */
const PROJECTS_DIR = process.env.AI_MINDMAP_PROJECTS_DIR
  ? path.resolve(process.env.AI_MINDMAP_PROJECTS_DIR)
  : path.resolve(__dirname, '..', 'projects');

/** 极简参数解析：--key value / --key=value / --flag / 位置参数 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--brief') { out.brief = true; continue; }
    // 比 --brief 更窄一档：连 tags/links 也省掉（实测再省 27.5%）。纯 opt-in，不改默认。
    if (a === '--skeleton') { out.skeleton = true; continue; }
    // 全局开关：--json 不再缩进换行（实测在真实项目上省 24%，配 --brief 省 47%）。
    // 单行 JSON 对机器消费者（AI / MCP）毫无损失，省下的全是缩进与换行。
    if (a === '--compact') { out.compact = true; continue; }
    // 注意：--detail 不能放显式 flag 列表——它在 read/get 是 flag，
    // 在 add/edit 是带值参数（历史 bug：放这里导致 detail 永远=true 校验必失败）。
    if (a === '--images') { out.images = true; continue; }
    if (a === '--clear-detail') { out.clearDetail = true; continue; }
    if (a === '--clear-tags') { out.clearTags = true; continue; }
    if (a === '--full') { out.full = true; continue; }
    if (a === '--with-detail') { out.withDetail = true; continue; }
    if (a === '--deep') { out.deep = true; continue; }
    // 纯布尔 flag 显式登记：否则会被通用分支按"--key value"处理，
    // 一旦后面跟了位置参数（如 `mentions 项目 --include-structural 5`）就被误吞成值。
    if (a === '--content-only') { out.contentOnly = true; continue; }
    if (a === '--include-structural') { out.includeStructural = true; continue; }
    if (a === '--cross') { out.cross = true; continue; }
    if (a === '--clear-note') { out.clearNote = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--clean-assoc') { out.cleanAssoc = true; continue; }
    if (a === '--clean-links') { out.cleanLinks = true; continue; }
    // 其余纯布尔开关显式登记（否则会被通用分支按"--key value"吞掉下一个位置参数）
    if (a === '--clear') { out.clear = true; continue; }
    if (a === '--raw') { out.raw = true; continue; }
    if (a === '--unmounted') { out.unmounted = true; continue; }
    if (a === '--major') { out.major = true; continue; }
    if (a === '--minor') { out.minor = true; continue; }
    if (a === '--patch') { out.patch = true; continue; }
    if (a.startsWith('--')) {
      // `--key=value` 与 `--key value` 等价（**只有这一处归一**，见 optionKey）。
      // 为什么必须支持 `=`：不支持时 `--expanded=nonsense` 会变成一个**键里带等号**的怪选项，
      // 命令读不到 `args.expanded` ⇒ **静默当成默认值**（实测：盘上写的是默认 true）。
      const eq = a.indexOf('=');
      if (eq > 2) {
        out[optionKey(a)] = a.slice(eq + 1);
        continue;
      }
      const key = optionKey(a);
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) { out[key] = nxt; i++; }
      else out[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * `--foo-bar` / `--foo-bar=值` → 归一后的键名 `fooBar`。
 *
 * **唯一的归一实现**：解析（parseArgs）与未知选项检查（unknownOptions）必须用同一套规则，
 * 否则会出现"解析器认识、白名单不认识"的错杀（例如 `--detail-md` vs `detailMd`）。
 */
function optionKey(token) {
  const raw = String(token).replace(/^--/, '');
  const eq = raw.indexOf('=');
  return (eq >= 0 ? raw.slice(0, eq) : raw).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

/**
 * 扫出 argv 里**这条命令不认识**的选项（纯函数、无 IO ⇒ 可单测）。
 *
 * 为什么需要它（本工程实测的缺陷，2026-10-10）：写命令对不认识的选项**静默忽略** ——
 * `add <项目> root --topic X --tags aaa,bbb` 返回 exit 0 且打印"已添加"，
 * 但 `get` 里根本没有 tags、`stats` 报 `taggedNodes: 0`。调用方是 AI，
 * 它会把"退出码 0 + 成功话术"当成依据 ⇒ 一次静默 = 一条假数据 + 一个自以为成功的 AI。
 * 危险点在于 `--tags` 在 `edit` / `add-image` 上**是合法选项**，跨命令误用极其自然。
 *
 * @param {string[]} argv 命令名之后的参数
 * @param {string[]} allowed 该命令认识的选项键（camelCase，含全局输出开关）
 * @returns {Array<{key:string, token:string}>} 去重后的未知选项（按出现顺序）
 */
function unknownOptions(argv, allowed) {
  const known = new Set(allowed || []);
  const out = [];
  const seen = new Set();
  (argv || []).forEach((a) => {
    if (typeof a !== 'string' || a.length < 3 || a.slice(0, 2) !== '--') return;
    const key = optionKey(a);
    if (known.has(key) || seen.has(key)) return;   // 同一个未知选项重复出现只报一次
    seen.add(key);
    out.push({ key: key, token: a.split('=')[0] });
  });
  return out;
}

/**
 * @param {string[]} argv 去掉命令名之后的参数（`cli/main.js` 已切掉）
 * @param {{command?:string}} [meta] 命令名 —— 只用于**变更日志的"谁在写"**（见 writer）
 */
function createContext(argv, meta) {
  const args = parseArgs(argv);
  const projectName = args._[0];
  // 注意：`projectName` 必须在 store 之前取出 —— 校验器要拿它做 selfProject。
  // （`import-json` 的 `_[0]` 是文件路径而不是项目名，故校验器用的是 store.write 传进来的
  //   真实目标项目名 `name`，不是这里的闭包值。）
  const store = createStore(PROJECTS_DIR, (data, name) => {
    const v = schema.validateProject(data, PROJECTS_DIR, name);
    if (!v.ok) throw new Error('校验失败: ' + v.errors.join('; '));
  });
  /**
   * 「**谁在写**」—— 变更日志里那一列，多路同时编辑时用来回答"是谁改的"。
   * 外壳（MCP / 侧栏 / 界面代写）设 `MM_WRITER` 声明自己是谁；没设就是 `cli`。
   * 只影响日志的可读性，**不参与任何判定**（不是权限、不是闸门）。
   */
  const surface = (process.env.MM_WRITER || 'cli').trim() || 'cli';
  const writer = surface + ':' + ((meta && meta.command) || 'unknown');
  /** `read()` 读到的版本指纹。写回时交给 data-store 的**并发版本闸门**：
   *  若读与写之间别处写入过，写入会中止并报错，而不是静默抹掉那次改动。 */
  let readVersion;
  const ctx = {
    store,
    args,
    projectName,
    schema,
    tree,
    PROJECTS_DIR,
    /**
     * 「谁在写」（`<外壳>:<命令>`）—— 只用于变更日志。
     * 暴露出来是给**绕过 `ctx.write` 的写点**用的（如 `import-json`：它新建整个项目，
     * 走 `ctx.store.write` 而不走 `ctx.write`）。少了这个，那些写入在日志里会显示成 `unknown`。
     */
    writer,

    out(text) { process.stdout.write(text + '\n'); },
    // `--compact` 时输出单行 JSON：**机器消费者零损失**，省掉的纯是缩进与换行。
    outJson(obj) { process.stdout.write(JSON.stringify(obj, null, args.compact ? 0 : 2) + '\n'); },
    error(msg) { throw new Error(msg); },

    read() {
      if (!projectName) throw new Error('缺少项目名');
      const r = store.read(projectName);
      readVersion = r.version; // 记下「我读的是哪一版」，write 时用作并发闸门
      return r;
    },
    write(data) {
      // expectVersion 来自本 ctx 最近一次 read()。命令若没读过就直接写（如 import-json
      // 新建项目），readVersion 为 undefined ⇒ 闸门放行，行为与从前一致。
      const r = store.write(projectName, data, { expectVersion: readVersion, writer: writer });
      // 自己写下的这一份就是最新版，记下来 —— 同一条命令里再写一次时不会误报冲突
      if (r && r.version) readVersion = r.version;
      return data;
    },
    /**
     * **多路同时编辑的入口**：读 → 改 → 写，并在**可证明安全**时把改动自动重放到最新版。
     *
     * 与"自己 read() 再 write()"的区别只在冲突时：
     *   · 旧写法：别人在你读之后写过 ⇒ 整条命令失败，这次改动白做；
     *   · 本方法：先看**两路改动的对象是否相交**（`node:<id>` / `children:<父id>` / `assoc:<id>` / `meta`）——
     *     不相交 ⇒ 把你的改动套用到最新版上写入（**双方改动都保留**）；
     *     相交 ⇒ 拒绝并**指名**冲突对象（绝不静默覆盖）。
     *
     * @param {(data:any)=>any} fn 改动函数：接收一份拷贝、返回改好的数据。
     *        ⚠️ **不得在里面做 I/O / 打印 / 物理写盘** —— 并发重放会再调用它一次：
     *        打印会重复，物理写盘会留下孤儿文件（实测教训：附件复制必须留在 fn 之外）。
     *        要把结果带出去，记进闭包变量（如 `let addedId = null`）即可。
     * @param {{replayable?:boolean, maxAttempts?:number}} [opts]
     *        `replayable:false` 用于**不可重复执行**的改动（依赖时间/随机/追加语义）⇒ 冲突时不重放，直接拒绝
     * @returns {{data:any, attempts:number, merged:boolean}} `merged:true` 表示发生过自动重放
     */
    mutate(fn, opts) {
      if (!projectName) throw new Error('缺少项目名');
      if (typeof fn !== 'function') throw new Error('mutate 需要一个改动函数');
      return concurrency.withReplay({
        read: () => { const r = store.read(projectName); readVersion = r.version; return r; },
        write: (data, wopts) => {
          const r = store.write(projectName, data, Object.assign({}, wopts, { writer: writer }));
          if (r && r.version) readVersion = r.version;
        }
      }, fn, opts);
    },
    get root() {
      const { data } = this.read();
      return data.data;
    },
    find(id) {
      const { data } = this.read();
      return tree.find(data.data, id);
    }
  };
  return ctx;
}

module.exports = { createContext, parseArgs, optionKey, unknownOptions, PROJECTS_DIR };
