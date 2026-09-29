/* ============================================================
 * cli/commands/assets.js — 图片与附件管理命令
 * ------------------------------------------------------------
 * 图片约定：
 *   - 文件复制进 projects/<name>/assets/（保留扩展名）
 *   - 节点 images: [{ file, caption, source?, tags? }]
 *   - caption 必填：AI 阅读笔记时凭 caption 理解图片内容
 * 附件约定（v0.16，借鉴 XMind 附件随文件保存的思路）：
 *   - 文件复制进 projects/<name>/attachments/（保留扩展名）
 *   - 节点 files: [{ file, caption, source? }]
 *   - caption 必填：说明该附件是什么、何时引用
 *   - 支持 md/pdf/txt 等任意文件；md/pdf 可在界面内预览
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

function copyAsset(ctx, srcPath) {
  if (!fs.existsSync(srcPath)) ctx.error('图片文件不存在: ' + srcPath);
  const ext = path.extname(srcPath).toLowerCase();
  if (!/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(ext)) ctx.error('不支持的图片格式: ' + ext);
  const assetDir = ctx.store.assetDir(ctx.projectName);
  // 随机后缀防同毫秒重名覆盖
  const base = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext;
  const dest = path.join(assetDir, base);
  fs.copyFileSync(srcPath, dest);
  return 'assets/' + base;
}

function copyAttachment(ctx, srcPath) {
  if (!fs.existsSync(srcPath)) ctx.error('附件文件不存在: ' + srcPath);
  const ext = path.extname(srcPath).toLowerCase() || '.bin';
  // 随机名防重名；保留扩展名便于按类型预览/打开
  const base = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext;
  const dest = path.join(ctx.store.attachmentDir(ctx.projectName), base);
  fs.copyFileSync(srcPath, dest);
  return 'attachments/' + base;
}

module.exports = {
  addImage(ctx) {
    const id = ctx.args._[1];
    const file = ctx.args.file;
    const caption = ctx.args.caption;
    if (!id) ctx.error('缺少节点 id');
    if (!file) ctx.error('缺少 --file 图片路径');
    if (!caption) ctx.error('缺少 --caption 内容备注（AI 凭此理解图片）');
    const pre = ctx.read();                             // 校验顺序与从前一致（B1）
    if (!ctx.tree.find(pre.data.data, id)) ctx.error('节点不存在: ' + id);
    // ⚠️ 物理落盘必须在改动函数**之外** —— fn 可能被并发重放，放里面会复制出第二份孤儿文件
    const rel = copyAsset(ctx, file);
    const img = { file: rel, caption };
    if (ctx.args.source) img.source = ctx.args.source;
    if (ctx.args.tags) img.tags = String(ctx.args.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      node.images = (node.images || []).concat(img);
      return data;
    });
    ctx.out('已添加图片: ' + rel + '（节点 ' + id + '）');
  },

  removeImage(ctx) {
    const id = ctx.args._[1];
    const file = ctx.args._[2];
    if (!id || !file) ctx.error('用法: remove-image <项目> <id> <assets/x.png>');
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      const before = (node.images || []).length;
      node.images = (node.images || []).filter((img) => img.file !== file);
      if (node.images.length === before) ctx.error('该图片不在节点上: ' + file);
      return data;
    });
    ctx.out('已移除图片引用: ' + file);
  },

  assets(ctx) {
    const { data } = ctx.read();
    const out = [];
    ctx.tree.walk(data.data, (n) => {
      (n.images || []).forEach((img) => out.push({
        node: n.id,
        topic: n.topic,
        file: img.file,
        caption: img.caption,
        source: img.source,
        tags: img.tags
      }));
    });
    if (ctx.args.json) ctx.outJson({ project: ctx.projectName, images: out });
    else out.forEach((i) => ctx.out(i.node + '  ' + i.file + '  — ' + i.caption));
  },

  /* ================= 附件（文件） ================= */
  addFile(ctx) {
    const id = ctx.args._[1];
    const file = ctx.args.file;
    const caption = ctx.args.caption;
    if (!id) ctx.error('缺少节点 id');
    if (!file) ctx.error('缺少 --file 附件路径');
    if (!caption) ctx.error('缺少 --caption 内容备注（AI 凭此理解附件用途）');
    const pre = ctx.read();                             // 校验顺序与从前一致（B1）
    if (!ctx.tree.find(pre.data.data, id)) ctx.error('节点不存在: ' + id);
    // ⚠️ 同 addImage：物理落盘在改动函数之外，重放不会复制出第二份孤儿附件
    const rel = copyAttachment(ctx, file);
    const f = { file: rel, caption };
    if (ctx.args.source) f.source = ctx.args.source;
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      node.files = (node.files || []).concat(f);
      return data;
    });
    ctx.out('已添加附件: ' + rel + '（节点 ' + id + '）');
  },

  removeFile(ctx) {
    const id = ctx.args._[1];
    const file = ctx.args._[2];
    if (!id || !file) ctx.error('用法: remove-file <项目> <id> <attachments/x.md>');
    ctx.mutate((data) => {
      const node = ctx.tree.find(data.data, id);
      if (!node) ctx.error('节点不存在: ' + id);
      const before = (node.files || []).length;
      node.files = (node.files || []).filter((f) => f.file !== file);
      if (node.files.length === before) ctx.error('该附件不在节点上: ' + file);
      return data;
    });
    ctx.out('已移除附件引用: ' + file);
  },

  files(ctx) {
    const { data } = ctx.read();
    const out = [];
    ctx.tree.walk(data.data, (n) => {
      (n.files || []).forEach((f) => out.push({
        node: n.id,
        topic: n.topic,
        file: f.file,
        caption: f.caption,
        source: f.source
      }));
    });
    if (ctx.args.json) ctx.outJson({ project: ctx.projectName, files: out });
    else out.forEach((f) => ctx.out(f.node + '  ' + f.file + '  — ' + f.caption));
  }
};
