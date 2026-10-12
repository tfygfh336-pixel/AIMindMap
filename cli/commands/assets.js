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
/* 资源新名字的**唯一实现**在 `src/markdown.js`（【批10】并入）。
 * 为什么要 require 而不是在本文件再写一份：命名 + 唯一性是两个命令族（`add-image` / `add-file`
 * 与 `import-md` / `import-project` / `import-dir`）**同一条规则**。从前这里各写了一份同形表达式
 * （`Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + ext`），靠两条"逐字同形"
 * 断言钉住；同形断言挡不住"只改一处"的漂移，更挡不住两份实现里只有一份拿到唯一性闸。
 * 依赖方向：`cli/`(rank 2) → `src/`(rank 1) 合法，`node scripts/dep-direction-check.js` 实跑 135 条边全朝下、无环（本文件这条 `require` 就是新增的那一条）。
 * 为什么**只能**走模块属性调用（`markdown.newResourceName(...)`）而不是 `const { newResourceName } = require(...)`：
 * 那会把函数**取值一次**绑进本模块的局部名，判据"两处调的是同一个函数"就变成不可注入的空话
 * （`tests/import-refs.test.js` 的【批10】T8 就是靠替换**模块导出项**来证明"只走这一处"的；
 * 属性调用让那次替换对本模块同样生效 —— 这与 `cli/commands/project.js` 调 `markdown.resolveImportRefs` 的写法一致）。 */
const markdown = require('../../src/markdown.js');

/** 复制失败时的"出路"文案（图片/附件各一条，与本文件既有的两条"不存在/格式"报错同一个口气）。 */
function uniqueNameError(ctx, kind, srcPath, err) {
  return err.message + '  · 出路：本次 ' + kind + ' 没有落盘、引用也**没有**写进节点'
    + '（错在"新名字是否已存在"这一步，不在源文件 —— 源文件 ' + srcPath + ' 没动）。'
    + '先确认那个已存在的文件不是你要的，再重跑一次这条命令即可（新名字是随机的，重跑就会换一个）。';
}

function copyAsset(ctx, srcPath) {
  if (!fs.existsSync(srcPath)) ctx.error('图片文件不存在: ' + srcPath);
  const ext = path.extname(srcPath).toLowerCase();
  if (!/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(ext)) ctx.error('不支持的图片格式: ' + ext);
  const assetDir = ctx.store.assetDir(ctx.projectName);
  /* 【批10】目标名走唯一性闸（撞名就重摇、绝不覆盖已存在的文件、连撞到上界响亮报错）：
   * 从前这里是裸 `path.join(assetDir, Date.now().toString(36) + Math.random()… + ext)` 直接
   * `copyFileSync` —— 同一毫秒 + 同 4 位随机时第二个 `copyFileSync` 会**静默覆盖**掉第一个
   * （两个不同源文件丢一份；取证与逐档读数见 tests/import-refs.test.js 的【批10】组）。
   * 不撞名时拿到的就是原来那一个值 ⇒ **正常路径逐字节不变**。 */
  let dest;
  try { dest = markdown.uniqueResourcePath(assetDir, ext); }
  catch (err) { ctx.error(uniqueNameError(ctx, '图片', srcPath, err)); }
  fs.copyFileSync(srcPath, dest);
  return 'assets/' + path.basename(dest);
}

function copyAttachment(ctx, srcPath) {
  if (!fs.existsSync(srcPath)) ctx.error('附件文件不存在: ' + srcPath);
  const ext = path.extname(srcPath).toLowerCase() || /* 附件没有扩展名时的兜底（与 src/markdown.js 的 ATTACH_EXT_DEFAULT 同一条） */ '.bin';
  // 【批10】与 copyAsset 同一道闸、同一个命名函数：保留扩展名便于按类型预览/打开
  let dest;
  try { dest = markdown.uniqueResourcePath(ctx.store.attachmentDir(ctx.projectName), ext); }
  catch (err) { ctx.error(uniqueNameError(ctx, '附件', srcPath, err)); }
  fs.copyFileSync(srcPath, dest);
  return 'attachments/' + path.basename(dest);
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
