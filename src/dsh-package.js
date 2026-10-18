/* ============================================================
 * src/dsh-package.js — 独立 DSH 运行包的解析/校验/安装/回滚（纯逻辑 + fs）
 * ------------------------------------------------------------
 * 形态：CommonJS（main.js 与脚本侧 require）；浏览器侧不用它。
 * 失败约定：throw Error，err.code 标明类别（ENOTFOUND / ECORRUPT / ELOCKED / EINVAL）。
 *
 * manifest（由 scripts/vendor-dsh.js 产出）：
 *   { schemaVersion:1, id, dshVersion, pnpmVersion, nodeVersion,
 *     platform, arch, createdAt,
 *     entries:{ node:'node/node.exe', dsh:'app/lib/bin.js',
 *               pnpm:'tools/pnpm/bin/pnpm.cjs', bin:'bin' },
 *     files:{ '<rel>':{size,sha256} }, totalBytes }
 *
 * 目录约定：
 *   bundledRoot —— 应用自带的运行包（dev: <工程>/vendor/dsh；安装包: resources/dsh）
 *   userData/dsh-runtimes/<id>/ —— 导入的更新包（只增不覆盖）
 *   userData/dsh-runtimes/active.json —— 当前选择（原子写）：
 *     { schemaVersion:1, current:'<id>'|'bundled', previous:…, updatedAt }
 *   userData/dsh-runtime.lock —— 运行锁（服务存续期间存在；维护操作见 dsh-runtime.guard）
 *   userData/dsh-runtime.guard —— 维护互斥（install/rollback 持有期间存在）
 *
 * 原则（.review/dsh-implementation-contract.md）：
 *   · active 坏 / installed 缺失 → 报错，绝不静默降级 bundled；
 *   · 安装/回滚绝不触碰 userData/dsh-home（用户会话与插件数据）；
 *   · 运行锁存在时拒绝维护；guard 存在时拒绝启动 —— 双向互斥。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fs'), require('path'), require('./data-store.js'));
  } else {
    root.MMDshPackage = factory(null, null, null);
  }
})(typeof self !== 'undefined' ? self : this, function (fs, path, dataStore) {
  'use strict';

  const ACTIVE = 'active.json';
  const RUNTIMES_DIR = 'dsh-runtimes';
  const RUNTIME_LOCK = 'dsh-runtime.lock';
  const MAINT_GUARD = 'dsh-runtime.guard';

  function err(code, msg) {
    const e = new Error(msg);
    e.code = code;
    return e;
  }

  function sha256File(fsMod, file) {
    const crypto = require('crypto');
    const h = crypto.createHash('sha256');
    h.update(fsMod.readFileSync(file));
    return h.digest('hex');
  }

  /* ---------- manifest 读取与结构校验 ---------- */

  function readManifest(root) {
    const mp = path.join(root, 'manifest.json');
    if (!fs.existsSync(mp)) throw err('ENOTFOUND', 'manifest.json 不存在: ' + root);
    let m;
    try {
      m = JSON.parse(fs.readFileSync(mp, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      throw err('ECORRUPT', 'manifest.json 无法解析: ' + e.message);
    }
    if (m.schemaVersion !== 1) throw err('ECORRUPT', 'manifest schemaVersion 不支持: ' + m.schemaVersion);
    for (const k of ['id', 'dshVersion', 'pnpmVersion', 'platform', 'arch', 'entries', 'files']) {
      if (!m[k]) throw err('ECORRUPT', 'manifest 缺字段: ' + k);
    }
    for (const k of ['node', 'dsh', 'pnpm', 'bin']) {
      if (!m.entries[k]) throw err('ECORRUPT', 'manifest.entries 缺: ' + k);
    }
    return m;
  }

  /** 相对路径安全校验（正斜杠、无 ..、无盘符、无保留名） */
  function assertSafeRel(rel) {
    if (!rel || typeof rel !== 'string' || rel.indexOf('\\') >= 0) {
      throw err('EINVAL', '清单路径必须是正斜杠相对路径: ' + rel);
    }
    if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
      throw err('EINVAL', '清单路径必须是相对路径: ' + rel);
    }
    const parts = rel.split('/');
    if (parts.some((p) => p === '..' || p === '.')) {
      throw err('EINVAL', '清单路径禁止 . / ..: ' + rel);
    }
    const bad = new Set(['CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);
    parts.forEach((p) => {
      const base = p.replace(/^(.+?)\..*$/, '$1');
      if (bad.has(p.toUpperCase()) || bad.has(base.toUpperCase())) {
        throw err('EINVAL', 'Windows 保留名: ' + rel);
      }
    });
  }

  /** 解出的绝对路径必须仍在 root 内（防清单路径逃逸） */
  function safeJoin(root, rel) {
    assertSafeRel(rel);
    const abs = path.resolve(root, rel);
    const normRoot = path.resolve(root) + path.sep;
    if (!(abs + path.sep).startsWith(normRoot) && abs !== path.resolve(root)) {
      throw err('EINVAL', '清单路径逃逸: ' + rel);
    }
    return abs;
  }

  /* ---------- 校验 / 解析 ---------- */

  /** validateRuntime(root, opts) → { root, manifest, manifestPath, node, dsh, pnpm, bin }
   *  opts.verifyHashes 默认 true（全量 sha256；体积大但只在选择/导入时做一次）。
   *  opts.platform / opts.arch 默认取本机。 */
  function validateRuntime(root, opts) {
    opts = opts || {};
    const manifest = readManifest(root);
    const platform = opts.platform || process.platform;
    const arch = opts.arch || process.arch;
    if (manifest.platform !== platform || manifest.arch !== arch) {
      throw err('EINVAL', '运行包平台不符: ' + manifest.platform + '-' + manifest.arch
        + '（本机 ' + platform + '-' + arch + '）');
    }
    const out = {
      root: path.resolve(root),
      manifest,
      manifestPath: path.join(root, 'manifest.json'),
      node: safeJoin(root, manifest.entries.node),
      dsh: safeJoin(root, manifest.entries.dsh),
      pnpm: safeJoin(root, manifest.entries.pnpm),
      bin: safeJoin(root, manifest.entries.bin)
    };
    for (const k of ['node', 'dsh', 'pnpm']) {
      if (!fs.existsSync(out[k])) throw err('ENOTFOUND', 'entries.' + k + ' 不存在: ' + out[k]);
    }
    if (opts.verifyHashes !== false) {
      verifyFiles(root, manifest);
    }
    return out;
  }

  function verifyFiles(root, manifest) {
    const keys = Object.keys(manifest.files || {});
    if (!keys.length) throw err('ECORRUPT', 'manifest.files 为空');
    for (const rel of keys) {
      assertSafeRel(rel);
      const abs = safeJoin(root, rel);
      let st;
      try { st = fs.statSync(abs); } catch (e) {
        throw err('ENOTFOUND', '文件缺失: ' + rel);
      }
      const f = manifest.files[rel];
      if (st.size !== f.size) throw err('ECORRUPT', '大小不符: ' + rel + ' 期望 ' + f.size + ' 实际 ' + st.size);
      const h = sha256File(fs, abs);
      if (h !== f.sha256) throw err('ECORRUPT', 'sha256 不符: ' + rel);
    }
  }

  /* ---------- active.json（选择/安装/回滚的唯一状态） ---------- */

  function readActive(userDataPath) {
    const p = activePath(userDataPath);
    if (!fs.existsSync(p)) return null;
    let a;
    try {
      a = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      throw err('ECORRUPT', p + ' 无法解析（需人工修复，不静默降级）: ' + e.message);
    }
    if (a.schemaVersion !== 1) throw err('ECORRUPT', 'active.json schemaVersion 不支持');
    if (!a.current || typeof a.current !== 'string') throw err('ECORRUPT', 'active.json 缺 current');
    return a;
  }

  function runtimesDir(userDataPath) {
    return path.join(userDataPath, RUNTIMES_DIR);
  }
  function activePath(userDataPath) {
    return path.join(runtimesDir(userDataPath), ACTIVE);
  }

  /** 原子写 active.json —— **走唯一写盘出口**：`src/data-store.js` 的 `writeFileAtomic`
   *  （同目录临时文件 → fsync → rename；rename 带**有界重试**，吸收 Windows 上目标被另一个
   *  进程短暂占用时的 `EPERM`/`EBUSY`/`EACCES`）。
   *  ⚠️ 这里**曾经是自造的第二份 tmp+rename**（2026-10-19 已偿），注释给的理由是"本模块可能在没有
   *  data-store 的环境（纯脚本）里被 require" —— **该理由经实测不成立**：
   *  全部消费者都在仓内 Node 端（`main-dsh-sidebar.js` / `src/dsh-ask.js` /
   *  `scripts/dsh-e2e.js` / `scripts/dsh-maintenance.js` / `tests/dsh-package.test.js`），
   *  `data-store.js` 自身也是 CommonJS + 纯 Node。而且自造那版比出口版**弱**：没有 rename 重试。
   *  UMD 形态保留（浏览器分支不 require 任何东西，见文件头"浏览器侧不用它"），`require` 只发生在
   *  Node 分支；因此浏览器分支下 `dataStore` 为 null，误用会**响亮报错**而不是静默半截写。 */
  function writeActiveAtomic(userDataPath, data) {
    if (!dataStore || typeof dataStore.writeFileAtomic !== 'function') {
      throw err('EINVAL', 'writeActiveAtomic 仅支持 Node 环境（浏览器端不写 active.json）');
    }
    fs.mkdirSync(runtimesDir(userDataPath), { recursive: true });
    dataStore.writeFileAtomic(activePath(userDataPath), JSON.stringify(data, null, 2));
  }

  /* ---------- 锁 ---------- */

  /** 进程活性：读 pid，用 kill(pid, 0) 探测（Windows 上 Node 的实现映射到
   *  OpenProcess，进程存在即 0/true，不存在即 EPERM/ESRCH 之外可判失败）。
   *  拿不到 pid 视为死锁文件。 */
  function pidAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
  }

  /** 读锁文件内容；不存在/坏 JSON 返回 null（坏 JSON 当陈旧处理，不永久阻塞） */
  function readLockFile(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) { return null; }
  }

  /** 运行锁 / 维护互斥（v0.16.2：陈旧锁可接管）。
   *  acquireRuntimeLock(userDataPath, owner, type) → { file, token, owner, release() }
   *  · guard 存在 → 维护/启动拒绝（维护是秒级短事务，保守对待）；
   *  · lock 存在 → 读 pid：持有者进程还活着 → ELOCKED；进程已死 → **接管**
   *    （强杀/崩溃残留的死锁文件不能永久阻塞下一次启动）；
   *  · lock 内容 { token, pid, owner, since }；release() 校验 token 后删除。 */
  function acquireRuntimeLock(userDataPath, owner, type) {
    const kind = type === 'guard' ? MAINT_GUARD : RUNTIME_LOCK;
    const other = type === 'guard' ? RUNTIME_LOCK : MAINT_GUARD;
    const otherPath = path.join(userDataPath, other);
    if (fs.existsSync(otherPath)) {
      const otherLock = readLockFile(otherPath);
      if (otherLock && type === 'run' && otherLock.kind === 'guard' && !pidAlive(otherLock.pid)) {
        try { fs.unlinkSync(otherPath); } catch (e) { /* 保守：删不掉就让它走 ELOCKED */ }
      } else {
        throw err('ELOCKED', (type === 'guard' ? 'DSH 服务运行中' : '维护进行中')
          + '（' + other + ' 存在）— 拒绝' + (type === 'guard' ? '维护' : '启动'));
      }
    }
    fs.mkdirSync(userDataPath, { recursive: true });
    const file = path.join(userDataPath, kind);
    // 陈旧检测：已有 lock 且持有者进程已死 → 接管；活着 → ELOCKED
    if (fs.existsSync(file)) {
      const cur = readLockFile(file);
      if (cur && pidAlive(cur.pid)) {
        throw err('ELOCKED', (type === 'guard' ? 'DSH 服务已由另一进程持有'
          : 'DSH 服务运行中') + '（pid=' + cur.pid + '，since=' + cur.since + '）');
      }
      // 死锁文件（进程不在了）：接管
      try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        throw err('ELOCKED', '锁文件被并发创建（' + kind + '）');
      }
      throw e;
    }
    const token = require('crypto').randomBytes(16).toString('hex');
    try {
      fs.writeSync(fd, JSON.stringify({
        token, pid: process.pid, kind, owner: owner || {}, since: new Date().toISOString()
      }));
    } finally { fs.closeSync(fd); }
    return {
      file, token,
      release() {
        try {
          const cur = readLockFile(file);
          if (cur && cur.token !== token) return; // 不是自己的锁（被接管过），不动它
          fs.unlinkSync(file);
        } catch (e) { /* 已消失 */ }
      }
    };
  }

  /** 把运行锁的 pid 改指到**服务进程**（孵化后调用）。
   *
   *  为什么必须改：锁默认记 `process.pid`（= 孵化者）。驻留语义下孵化者（主界面）
   *  会先退出，而服务继续活着 —— 锁里那个 pid 死了，后来者按"陈旧锁"接管，
   *  `npm run dsh:maint -- import` 就能在一个**活着的服务脚下**把运行包换掉
   *  （服务仍在跑旧包，新主界面接管它，状态自相矛盾）。
   *  改成服务 pid 后：「锁活着」与「服务活着」同义，维护互斥重新成立。
   *
   *  @returns {boolean} 是否改写成功（token 已被接管 / 文件消失 → false，不动别人的锁）
   */
  function retargetRuntimeLock(lock, pid) {
    if (!lock || !lock.file || !pid) return false;
    try {
      const cur = readLockFile(lock.file);
      if (!cur || cur.token !== lock.token) return false;
      fs.writeFileSync(lock.file, JSON.stringify({
        token: cur.token,
        pid,
        kind: cur.kind,
        owner: cur.owner,
        since: cur.since,
        holder: 'service',          // 语义标记：此锁代表一个驻留服务
        launcherPid: cur.pid        // 留档：谁孵化的（排查用）
      }));
      return true;
    } catch (e) { return false; }
  }

  /** 清掉「属于某个已死服务」的运行锁（按记录 pid 精确匹配）。
   *
   *  场景：接管实例（本进程没拿锁）点「停止 DSH 服务」—— 服务被杀掉了，但锁文件
   *  留在盘上（pid 指向刚被杀的服务）。陈旧锁虽会被下次启动接管，但"服务已停、
   *  锁还在"会让维护门禁读到一个假持有者。这里按 pid 精确匹配后删除：
   *  只有确实属于这个服务的锁才会被清，别人的锁一律不动。
   *  @returns {boolean} 是否清掉了
   */
  function clearRuntimeLockFor(userDataPath, pid) {
    if (!pid) return false;
    try {
      const file = path.join(userDataPath, RUNTIME_LOCK);
      const cur = readLockFile(file);
      if (!cur || cur.pid !== pid) return false;
      fs.unlinkSync(file);
      return true;
    } catch (e) { return false; }
  }

  /* ---------- resolve / install / rollback ---------- */

  /** resolveRuntime({ bundledRoot, userDataPath, verifyHashes })
   *  → validateRuntime 的结果 + source:'bundled'|'installed'。
   *  · 无 active.json → bundled（首次运行的常态）。
   *  · active.current === 'bundled' → bundled。
   *  · active.current === '<id>' → userData/dsh-runtimes/<id>；缺失/坏 → **报错不降级**。 */
  function resolveRuntime(opts) {
    if (!opts || !opts.bundledRoot) throw err('EINVAL', 'resolveRuntime 需要 bundledRoot');
    const userDataPath = opts.userDataPath;
    const verifyHashes = opts.verifyHashes !== false;
    if (userDataPath && fs.existsSync(activePath(userDataPath))) {
      const a = readActive(userDataPath);
      if (a.current === 'bundled') {
        const r = validateRuntime(opts.bundledRoot, { verifyHashes });
        return Object.assign(r, { source: 'bundled' });
      }
      const dir = path.join(runtimesDir(userDataPath), a.current);
      const r = validateRuntime(dir, { verifyHashes });
      return Object.assign(r, { source: 'installed' });
    }
    const r = validateRuntime(opts.bundledRoot, { verifyHashes });
    return Object.assign(r, { source: 'bundled' });
  }

  /** installRuntime(packageDir, userDataPath) → { id, active }
   *  · packageDir 必须是 vendor-dsh 产出的完整包（校验哈希后复制进 runtimes/<id>）。
   *  · 运行锁存在 → 拒绝（先停服务再更新）。
   *  · 同 id 已存在 → 幂等：校验现有目录哈希一致即直接切 active，不一致报错。 */
  function installRuntime(packageDir, userDataPath) {
    const src = validateRuntime(packageDir, { verifyHashes: true });
    const dest = path.join(runtimesDir(userDataPath), src.manifest.id);
    const lock = acquireRuntimeLock(userDataPath, { op: 'install' }, 'guard');
    try {
      if (fs.existsSync(dest)) {
        // 幂等导入：校验已存在目录与源哈希一致
        validateRuntime(dest, { verifyHashes: true });
      } else {
        fs.mkdirSync(dest, { recursive: true });
        copyTree(fs, path, packageDir, dest);
        // 复制后校验（防止复制过程中途失败留下半截）
        validateRuntime(dest, { verifyHashes: true });
      }
      const prev = fs.existsSync(activePath(userDataPath))
        ? readActive(userDataPath).current : null;
      writeActiveAtomic(userDataPath, {
        schemaVersion: 1, current: src.manifest.id, previous: prev,
        updatedAt: new Date().toISOString()
      });
      return { id: src.manifest.id, active: readActive(userDataPath) };
    } finally {
      lock.release();
    }
  }

  /** rollbackRuntime(userDataPath) → 回到 bundled；没有可回滚项时报错 */
  function rollbackRuntime(userDataPath) {
    const a = fs.existsSync(activePath(userDataPath)) ? readActive(userDataPath) : null;
    if (!a) throw err('EINVAL', '没有 active.json，无从回滚');
    const lock = acquireRuntimeLock(userDataPath, { op: 'rollback' }, 'guard');
    try {
      if (a.current === 'bundled') throw err('EINVAL', '当前已是 bundled，没有可回滚项');
      writeActiveAtomic(userDataPath, {
        schemaVersion: 1, current: 'bundled', previous: a.current,
        updatedAt: new Date().toISOString()
      });
      return readActive(userDataPath);
    } finally {
      lock.release();
    }
  }

  /** 复制目录（物化，拒绝符号链接）—— 与 vendor-dsh.js 保持同一策略 */
  function copyTree(fsMod, pathMod, src, dst) {
    const st = fsMod.lstatSync(src);
    if (st.isSymbolicLink()) throw err('EINVAL', '拒绝复制符号链接: ' + src);
    fsMod.mkdirSync(dst, { recursive: true });
    for (const e of fsMod.readdirSync(src, { withFileTypes: true })) {
      const s = pathMod.join(src, e.name);
      const d = pathMod.join(dst, e.name);
      const est = fsMod.lstatSync(s);
      if (est.isSymbolicLink()) throw err('EINVAL', '拒绝复制符号链接: ' + s);
      if (est.isDirectory()) copyTree(fsMod, pathMod, s, d);
      else if (est.isFile()) fsMod.copyFileSync(s, d);
      else throw err('EINVAL', '非常规文件: ' + s);
    }
  }

  return {
    ACTIVE, RUNTIMES_DIR, RUNTIME_LOCK, MAINT_GUARD,
    readManifest, validateRuntime, resolveRuntime,
    installRuntime, rollbackRuntime, acquireRuntimeLock, retargetRuntimeLock,
    clearRuntimeLockFor,
    readActive, writeActiveAtomic, assertSafeRel, safeJoin, verifyFiles,
    activePath, runtimesDir
  };
});
