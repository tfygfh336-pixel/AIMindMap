/* ============================================================
 * AI MindMap — 预加载脚本（contextBridge）
 * ------------------------------------------------------------
 * 向渲染层暴露安全的 window.desktop API（IPC 封装）：
 *   desktop.projects()                 → 项目列表
 *   desktop.project.read(name)         → { file, data }
 *   desktop.project.save(file, data)   → 写盘（CLI validate 闸门）
 *   desktop.asset.import(...)          → 导入图片到 assets/
 *   desktop.asset.importFile(...)      → 导入附件到 attachments/（v0.16）
 *   desktop.app.readFile(abs)          → 读附件文本（md 预览）
 *   desktop.app.openFile(abs)          → 系统默认应用打开附件
 *   desktop.app.exportMd(...)          → 导出 Markdown（v0.16 起为文件夹导出）
 *   desktop.app.related(...)           → 某节点的相关知识点（出边+入边）
 *   desktop.app.audit(name)            → 关系审计（orphans + mentions 两清单）
 *   desktop.app.linkNodes(...)         → 补一条链接（写操作，走 CLI 闸门）
 *   desktop.app.nodes(name)            → 扁平节点清单（命令面板模糊搜索用）
 *   desktop.app.assoc(name, nodeId?)   → 关联笔记（N 元关联实体）；给 nodeId 则只列该节点所属的
 *   desktop.app.assocEdit(...)         → 保存关联笔记（写操作，走 CLI 闸门；回读最新形态）
 *   desktop.app.assocPrune(name, ids)  → 删节点前在**磁盘上**剪掉这些节点在关联/链接里的引用
 *                                        （写操作只经 CLI —— 见 main.js 里的说明）
 *   desktop.app.version()              → 版本号
 *   desktop.on(channel, cb)            → 订阅菜单事件
 * ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  projects: () => ipcRenderer.invoke('project:list'),
  project: {
    read: (name) => ipcRenderer.invoke('project:read', name),
    save: (file, data, opts) => ipcRenderer.invoke('project:save', file, data, opts),
    watch: (absDir) => ipcRenderer.invoke('project:watch', absDir)
  },
  asset: {
    import: (projectName, nodeId, srcPath, caption, source, tags) =>
      ipcRenderer.invoke('asset:import', projectName, nodeId, srcPath, caption, source, tags),
    importFile: (projectName, nodeId, srcPath, caption, source) =>
      ipcRenderer.invoke('asset:import-file', projectName, nodeId, srcPath, caption, source)
  },
  app: {
    exportMd: (projectName, outFile) => ipcRenderer.invoke('app:export-md', projectName, outFile),
    exportMdDialog: (projectName) => ipcRenderer.invoke('app:export-md-dialog', projectName),
    importMd: (projectName, srcFile, parent) => ipcRenderer.invoke('app:import-md', projectName, srcFile, parent),
    readFile: (absPath) => ipcRenderer.invoke('app:read-file', absPath),
    openFile: (absPath) => ipcRenderer.invoke('app:open-file', absPath),
    search: (projectName, keyword) => ipcRenderer.invoke('app:search', projectName, keyword),
    backlinks: (projectName, nodeId) => ipcRenderer.invoke('app:backlinks', projectName, nodeId),
    related: (projectName, nodeId) => ipcRenderer.invoke('app:related', projectName, nodeId),
    audit: (projectName) => ipcRenderer.invoke('app:audit', projectName),
    linkNodes: (projectName, fromId, toProject, toId, caption) =>
      ipcRenderer.invoke('app:link-nodes', projectName, fromId, toProject, toId, caption),
    nodes: (projectName) => ipcRenderer.invoke('app:nodes', projectName),
    assoc: (projectName, nodeId) => ipcRenderer.invoke('app:assoc', projectName, nodeId),
    assocEdit: (projectName, assocId, title, noteMd) =>
      ipcRenderer.invoke('app:assoc-edit', projectName, assocId, title, noteMd),
    assocPrune: (projectName, ids) => ipcRenderer.invoke('app:pre-delete-cleanup', projectName, ids),
    version: () => ipcRenderer.invoke('app:version'),
    /* 界面状态上报（脏标记变化时推）：主进程写 projects/<项目>/.ui-state.json，
     * 侧栏 AI 用 `node cli/mm-cli.js ui-state --json` 读 —— 写前协调的可执行通道。 */
    uiState: (payload) => ipcRenderer.send('app:ui-state', payload)
  },
  on: (channel, cb) => {
    const wrap = (e, ...args) => cb(...args);
    ipcRenderer.on(channel, wrap);
    return () => ipcRenderer.removeListener(channel, wrap);
  },
  /* 项目文件被外部（侧栏 AI）修改的实时通知 */
  onProjectDiskChange: (cb) => {
    const wrap = (_e, filename) => cb(filename);
    ipcRenderer.on('project:disk-changed', wrap);
    return () => ipcRenderer.removeListener('project:disk-changed', wrap);
  },
  /* DSH 侧边栏：状态查询、布局事件、toggle 与拖宽（token/URL 永不进渲染层） */
  dsh: {
    status: () => ipcRenderer.invoke('dsh-sidebar:status'),
    toggle: () => ipcRenderer.send('dsh-sidebar:toggle'),
    beginDrag: () => ipcRenderer.send('dsh-sidebar:drag-start'),
    endDrag: () => ipcRenderer.send('dsh-sidebar:drag-end'),
    isDshOnly: () => ipcRenderer.invoke('dsh-sidebar:dsh-only')
  }
});
