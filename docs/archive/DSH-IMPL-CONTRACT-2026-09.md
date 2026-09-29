> ⚠️ **历史归档（2026-09 快照）**：**不是现状、勿据此改动**。
> 归档规则见 `docs/ARCHITECTURE.md` §5（归档族：只增不改、不进 G6 扫描、勿作现状引用）；
> 本文原属工程根下的一次性分析稿，2026-09-25 归位至此；其结论可能已被后续实现取代。

# DSH 内嵌实施接口

用户已确认：独立目录，开始实施。不得使用或修改当前全局 DSH / 3080 服务 / ~/.dsh 凭据与会话。

- 开发运行包：vendor/dsh；安装包：resources/dsh（electron-builder extraResources，真实文件路径）。
- 独立数据：app.getPath('userData')/dsh-home；更新包：userData/dsh-runtimes/<id>；active.json 原子选择版本。
- manifest schemaVersion 1，entries.node/dsh/pnpm/bin 均为包内相对路径，含精确版本、平台、哈希清单及许可证。
- 运行包包含独立 Node、DSH 实现和依赖、pnpm JS 包及 shims。不可依赖全局安装或包外 junction。
- 运行锁：userData/dsh-runtime.lock；维护锁与其双向互斥。服务退出完成后再解锁。更新不得覆盖 dsh-home。
- 子进程：捆绑 Node 执行 DSH web --host 127.0.0.1 --port 0 --no-open；清理继承的 DSH 会话环境，指定独立 HOME。
- 只接收自身子进程 stdout 中的 loopback token URL，并认证 HTTP 探活后嵌入。不得把 token 发到普通 renderer IPC、日志或更新清单。
- WebContentsView 单独 session partition、无宿主 preload、nodeIntegration false、contextIsolation true、sandbox true。
- 主 renderer 让出侧栏区域；菜单编辑快捷键只在导图获得焦点时操作导图，避免 DSH 中 Delete 等误删节点。
- 普通 smoke 用无网络 fixture 测试视图和生命周期；另跑真实包/独立 HOME/随机端口的 DSH 端到端集成测试，收集并清理全部进程。
- 验证：G1-G7、包内 native 模块、pnpm、安装/回滚、脱离全局路径后的启动、打包后 smoke。
