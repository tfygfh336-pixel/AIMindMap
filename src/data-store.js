/* ============================================================
 * src/data-store.js — 项目数据存取（UMD）
 * ------------------------------------------------------------
 * 纯 Node 侧（CLI 用）。渲染层经主进程 IPC 走 CLI，不直接 require。
 * 职责：
 *   - 解析项目名 → projects/<name>/<name>.json 绝对路径
 *   - 读 / 写项目 JSON（写前过 schema.validateProject）
 *   - 全部写盘走原子写（临时文件 + fsync + rename，见 writeFileAtomic）
 *   - 解析时剥离 UTF-8 BOM
 *   - 列出全部项目
 *   - assets/ 与 attachments/ 目录管理（确保存在）
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('fs'), require('path'), require('crypto'), require('./concurrency.js'), require('./changes.js'), require('./heat.js'));
  else root.MMDataStore = factory(null, null, null, null, null, null);
})(typeof self !== 'undefined' ? self : this, function (fs, path, crypto, concurrency, changes, heat) {
  'use strict';

  /**
   * 版本冲突的**错误码**（单源在 `src/concurrency.js`）。
   * 调用方（`src/concurrency.js` 的重放器）**只认这个码，不认错误文本** ——
   * 靠正则匹配报错文本会随文案漂移而**静默失效**（实测踩过：同一天里"守卫被改写作形式静默关掉"两次）。
   */
  const VERSION_CONFLICT = (concurrency && concurrency.VERSION_CONFLICT) || 'VERSION_CONFLICT';

  /** 解析项目 JSON：剥离 UTF-8 BOM（带 BOM 的文本 JSON.parse 会直接失败） */
  function parseProjectJson(text) {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''));
  }

  /**
   * 内容指纹（SHA-1 前 16 位）—— 版本闸门用的「这一版是哪一版」。
   *
   * **为什么不用 mtime / size**：mtime 粒度粗（同秒内的两次写常常拿到同一个 mtime），
   * size 遇到"原地改一个字段"也完全不变 —— 两者都会让闸门**静默失效**（假阴性）。
   * 内容哈希没有这两类漏洞，代价是一次额外的读+哈希（项目 JSON 百 KB 级，1 ms 量级）。
   */
  function versionOfText(text) {
    if (!crypto) return 'n' + String(text).length; // 浏览器端兜底（data-store 非 Node 会直接抛，实际到不了）
    return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16);
  }

  /** 项目文件的版本指纹；文件不存在 → null（新建项目时闸门据此放行） */
  function versionOf(file) {
    try { return versionOfText(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }

  /**
   * 原子写文件：同目录临时文件 → fsync 落盘 → rename 覆盖。
   * 同目录 rename 在 NTFS / POSIX 上均为原子操作，因此进程中断或磁盘写满
   * 只会留下临时文件，**不会产生被截断的目标文件**（防整库损坏）。
   * 失败时清理临时文件并抛出（原文件保持不动）。
   */
  function writeFileAtomic(file, content) {
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);          // 关键：先落盘，再 rename
      fs.closeSync(fd);
      fd = undefined;
      renameWithRetry(tmp, file);
    } catch (err) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      throw err;
    }
  }

  /**
   * rename 带**有界重试**：Windows 上目标文件被另一个进程短暂打开时，rename 会以
   * `EPERM` / `EBUSY` / `EACCES` 失败 —— 而"多个会话同时写同一个项目"是本工程的**常态**
   * （多路同时编辑那套机制就是为它做的）。
   * `[实测]` 一次真实并发导入里就出现过：`EPERM: operation not permitted, rename '…comnet.json.45304.…tmp' -> '…comnet.json'`，
   * 调用方原样重跑才成功 —— 那本该由这里吸收掉。
   * 只对**瞬时占用类**错误重试；其它错误立刻抛（不掩盖真问题）。重试次数与间隔都很小（约 100ms 上限），
   * 因为争用窗口极短；重试用尽仍失败 ⇒ 抛出**原错误**（文案里带"已重试 N 次"便于诊断）。
   */
  function renameWithRetry(from, to, attempts) {
    const max = attempts || 6;
    let last = null;
    for (let i = 0; i < max; i++) {
      try { fs.renameSync(from, to); return; } catch (err) {
        const code = err && err.code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
        last = err;
        // 忙等一小会儿（同步 API 场景下不便真睡；10ms 量级的自旋足够让占用方释放句柄）
        const until = Date.now() + 10 * (i + 1);
        while (Date.now() < until) { /* spin */ }
      }
    }
    if (last) last.message = last.message + '（rename 已重试 ' + max + ' 次仍失败）';
    throw last;
  }

  function createStore(rootDir, validate) {
    if (!fs || !path) throw new Error('data-store 仅支持 Node 环境（浏览器端请走 CLI/IPC）');

    /**
     * 项目目录。**必须同时挡住路径穿越**，不能只挡非法字符：
     * `name` 为 `..` 时 `path.join(rootDir,'..')` 会落到**项目根之外**，
     * 于是 `store.write('..')` 会在工程目录里写出 `...json`（曾实测）。
     * 触达路径：`mm-cli init ..`。故这里额外要求解析结果严格位于 rootDir 内部。
     */
    function projectDir(name) {
      if (typeof name !== 'string' || !name) throw new Error('非法项目名: ' + name);
      if (/[\\/:*?"<>|]/.test(name)) throw new Error('非法项目名: ' + name);
      // 单独挡掉 . 与 ..（path.join 会归一化它们，事后无法从字符串看出）
      if (name === '.' || name === '..') throw new Error('非法项目名: ' + name);
      const base = path.resolve(rootDir);
      const p = path.resolve(base, name);
      if (p.indexOf(base + path.sep) !== 0) throw new Error('非法项目名（越出项目根）: ' + name);
      return p;
    }
    function projectFile(name) {
      return path.join(projectDir(name), name + '.json');
    }
    /** 变更日志的绝对路径（`src/changes.js` 定文件名；**路径只在这里算一次**，别处不再推导） */
    function changeLogFile(name) {
      return path.join(projectDir(name), changes.FILE_NAME);
    }
    /**
     * 访问事件日志的绝对路径（`src/heat.js` 定文件名与格式）—— 与 `changeLogFile` 同一条规矩：
     * **路径只在这里推导一次**，命令层（`cli/commands/heat.js`）不许自己拼 `projects/<项目>/.visits.jsonl`。
     * 它同样是**旁路产物**：不是数据、不进 `export-json`、可随时删。
     */
    function visitLogFile(name) {
      return path.join(projectDir(name), heat.FILE_NAME);
    }

    /**
     * 追加一条变更日志（**唯一实现**：`write` 与主进程的 GUI 保存都调它）。
     *
     * 为什么要暴露出来：GUI 的保存**不走 `store.write`**（它自己跑 `mm-cli validate` 探针 +
     * `writeFileAtomic`，见 `main.js` 的 `project:save`）。若把记账逻辑在那边再写一份，
     * "改了什么"就有了两种定义 ⇒ 必然漂移（A3）。所以实现只有这里一份，两个出口都调它。
     *
     * **改了什么当场算**（用与冲突判定同一套指纹 `changedKeys`），不是谁手写的。
     * 首次落盘 / 需要裁剪窗口时走整份原子写；平时只追加一行（有界窗口见 `changes.MAX_ENTRIES`）。
     *
     * @param {string} name 项目名
     * @param {{oldText:(string|null), data:any, version:string, writer:string,
     *          idem?:(string|{key:string}), out?:string}} opts
     *        `oldText` = **本次写入之前**盘上的内容（null = 盘上原本没有 ⇒ 记为"新建"）
     *        `idem` / `out` = 写命令的**幂等键**与**首次回显**（可选，见 `src/changes.js` 的 `buildEntry`；
     *        调用方是 `cli/core.js` 的幂等守卫，这里只做**转交**，不判定、不解释）
     */
    function recordChange(name, opts) {
      if (!changes) return null;
      const o = opts || {};
      let oldData = null;
      if (o.oldText !== undefined && o.oldText !== null) {
        try { oldData = parseProjectJson(o.oldText); } catch (e) { oldData = null; }
      }
      // ⚠️ `changedKeys` 返回的是 **Set**，必须 `Array.from` —— 直接塞进 JSON 会序列化成 `{}`，
      //    而 `appendLog` 的 `Array.isArray` 检查会把它变成空数组 ⇒ 日志**每次都报"没有对象变化"**。
      //    这是可见性功能最坏的失效形态（告诉会话"没人动过"，而其实动了）。有一条单测锁它。
      const changedSet = (oldData === null || !concurrency) ? null : concurrency.changedKeys(oldData, o.data);
      const changed = changedSet ? Array.from(changedSet) : [];
      // 幂等键：两种形态都收（`{key}` 是核心层传的内部形状，字符串是直给）——
      // 归一放在这里**一处**，免得每个写入方各判一次"给了没给"。
      const idemRaw = o.idem && typeof o.idem === 'object' ? o.idem.key : o.idem;
      const file = changeLogFile(name);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = ''; }
      const r = changes.appendLog(text, {
        at: new Date().toISOString(),
        writer: o.writer,
        version: o.version,
        created: oldData === null,     // 盘上原本没有 ⇒ 这是"新建"，changed 为空是正常的
        changed: changed,
        idem: idemRaw,
        out: o.out
      }, changes.MAX_ENTRIES);
      if (!text || r.trimmed > 0) writeFileAtomic(file, r.text);   // 首次 / 裁剪窗口 ⇒ 整份原子写
      else fs.appendFileSync(file, changes.serializeEntry(r.entry), 'utf8');
      return r.entry;
    }

    /**
     * **补上一次写入的"首次回显"**（S7 的延迟落账）。
     *
     * 为什么需要"补"而不是"写的时候一起写"：写命令的收尾回执（`已添加: n-xxxx`）发生在
     * `store.write` **返回之后** ⇒ 写盘那一刻还拿不到它（见 `cli/core.js` 的 `markRecord`）。
     * 于是命令体跑完时用它把最后那几行补进**同一条**记录（按 `idem` 键定位），
     * 幂等重放才能复述出"首次那个随机 id"。
     *
     * 定位靠 `idem` 键：只改**最后一条**且键相同的那条（找到就从尾往前改第一条）。
     * 找不到就**什么都不做**（日志被裁剪 / 被删 / 键已被顶掉 ⇒ 宁可少一条回显，也不编造）。
     * @returns {boolean} 是否真的补上了
     */
    function recordChangeOut(name, idemKey, outText) {
      if (!changes || !idemKey) return false;
      const file = changeLogFile(name);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return false; }
      const parsed = changes.parseLog(text);
      const hit = changes.idemLookup(parsed.entries, idemKey);
      if (!hit) return false;
      // 逐行改写**最后一条**匹配记录（保留原行序、原条数 ⇒ 不破坏"日志是有界追加流"的性质）
      const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        let raw;
        try { raw = JSON.parse(lines[i]); } catch (e) { continue; }
        if (!raw || raw.idem !== idemKey) continue;
        raw.out = String(outText).slice(0, changes.OUT_MAX);
        lines[i] = changes.serializeEntry(changes.buildEntry(raw)).replace(/\n$/, '');
        writeFileAtomic(file, lines.join('\n') + '\n');
        return true;
      }
      return false;
    }

    return {
      rootDir,

      list() {
        if (!fs.existsSync(rootDir)) return [];
        return fs.readdirSync(rootDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, e.name + '.json')))
          .map((e) => {
            const jsonPath = path.join(rootDir, e.name, e.name + '.json');
            try {
              const data = parseProjectJson(fs.readFileSync(jsonPath, 'utf8'));
              return { name: e.name, meta: data.meta || null, file: jsonPath };
            } catch (err) {
              return { name: e.name, meta: null, file: jsonPath };
            }
          });
      },

      read(name) {
        const file = projectFile(name);
        if (!fs.existsSync(file)) throw new Error('项目不存在: ' + name);
        const text = fs.readFileSync(file, 'utf8');
        // version 一并返回：调用方（CLI 的 ctx / GUI 主进程）用它做写入前的并发闸门
        return { file, data: parseProjectJson(text), version: versionOfText(text) };
      },

      write(name, data, opts) {
        const o = opts || {};
        // 把项目名一并交给校验器：同项目的链接/关联成员要以"即将写下去的这份数据"
        // 为准（见 schema.validateProject 的 selfProject 说明），否则闸门慢一步。
        if (validate) validate(data, name); // 写盘前校验（安全闸门）
        const file = projectFile(name);

        // ---- 旧内容**只读一次** ----
        // 两个用途：① 并发版本闸门要比对它的指纹；② 变更日志要拿它算"改了什么"。
        // 读失败按"盘上没有"处理（与原先的 `versionOf` 语义一致：读不到 → null）。
        let oldText = null;
        try { oldText = fs.readFileSync(file, 'utf8'); } catch (e) { oldText = null; }
        const actualVersion = oldText === null ? null : versionOfText(oldText);

        // ---- 并发版本闸门 ----
        // 调用方若声明了「我读到的是哪一版」（expectVersion），就要求盘上仍是那一版。
        // 不是 → 说明读与写之间**别处写入过**，此时写下去会把那次改动**静默抹掉**。
        // 实测两条真路径（见 main.js project:save 的注释）：内存里是子集时写回会删掉
        // 其他笔记；AI/CLI 在界面打开期间写的笔记会被界面的整树覆盖。
        // 口径：**宁可失败，也不静默丢数据**。不传 expectVersion 时行为与从前完全一致。
        if (o.expectVersion !== undefined && o.expectVersion !== null) {
          if (actualVersion !== o.expectVersion) {
            const err = new Error('并发写入冲突：项目「' + name + '」在你读取之后已被其他写入者修改'
              + '（读到 ' + String(o.expectVersion).slice(0, 8) + '，盘上 '
              + (actualVersion === null ? '已不存在' : String(actualVersion).slice(0, 8)) + '）。'
              + '写入已中止，以免静默覆盖那次改动 —— 请重新读取该项目后再改。');
            // 错误码：`src/concurrency.js` 的自动重放据此判断"这是可重放的版本冲突"。
            // 有码之后，调用方不必去解析上面这段文案（文案会改）。
            err.code = VERSION_CONFLICT;
            err.expectVersion = o.expectVersion;
            err.actualVersion = actualVersion;
            throw err;
          }
        }

        fs.mkdirSync(projectDir(name), { recursive: true });
        // 原子写：临时文件 + fsync + rename（CLI 全部写命令经此出口）
        const json = JSON.stringify(data, null, 2);
        writeFileAtomic(file, json);
        // 一并回传"刚写下去的这一版"的指纹：调用方（ctx.write / 自动重放器）据此更新自己记的版本，
        // 免得同一条命令里紧接着再写一次时**误报**冲突。序列化只有这一处，不重复第二种写法。
        const version = versionOfText(json);
        // ---- 变更日志（阶段 3：让别的会话"事前避让"）----
        // 这是**辅助产物**（不是数据、不进 export-json、可随时删）。它失败**不能让本次写入失败**
        // —— 数据安全优先；但也**绝不静默**：打到 stderr，让调用方看得见（F1）。
        try {
          recordChange(name, {
            oldText: oldText, data: data, version: version, writer: o.writer,
            // 幂等键与首次回显：**只转交**（判定与回放都在 `cli/core.js` 的守卫里）。
            // 不走 `store.write` 的调用方（如 `import-json`）自然拿不到它们 ⇒ 字段缺席，行为与从前一致 ✓
            idem: o.idem, out: o.out
          });
        } catch (err) {
          console.error('warning: 变更日志写入失败（本次数据已写入，日志缺一条）：'
            + ((err && err.message) || err));
        }
        return { file, version: version };
      },

      assetDir(name) {
        const dir = path.join(projectDir(name), 'assets');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },

      attachmentDir(name) {
        const dir = path.join(projectDir(name), 'attachments');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },

      projectDir,
      projectFile,
      /** 变更日志路径（读方 —— 如 `changes` 命令 —— 用它，别自己拼路径） */
      changeLogFile,
      /** 访问事件日志路径（读方/写方 —— `heat` / `visit` —— 用它，别自己拼路径） */
      visitLogFile,
      /** 记一条变更日志（GUI 保存那条不走 `write` 的路径也要调它 —— 实现只有一份） */
      recordChange,
      /** 给**最近那条**带 `idem` 的记录补上"首次回显"（S7 的延迟落账；见该函数注释） */
      recordChangeOut,
      // 供 import-json 解包资源（图片/附件）使用，同样保证原子落盘
      writeFileAtomic
    };
  }

  return { createStore, writeFileAtomic, parseProjectJson, versionOf, versionOfText };
});
