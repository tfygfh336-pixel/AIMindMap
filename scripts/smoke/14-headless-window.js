/* ============================================================
 * scripts/smoke/14-headless-window.js — 离屏窗口断言（headless 契约）
 * ------------------------------------------------------------
 * 背景：AI 迭代本工程跑 npm run smoke 时，窗口曾以默认 show:true 弹在
 * 用户桌面上（main.js createWindow 未区分 headless），违背"离屏渲染"契约。
 * 修复：--smoke / --export-image 创建窗口时 show:false + skipTaskbar（构造选项）
 *       + backgroundThrottling:false + paintWhenInitiallyHidden:true。
 * 本域断言两条**可观测副作用**，锁死不变量：
 *   ① smoke 模式下窗口隐藏（主进程 API：isVisible）——headless 核心契约；
 *      skipTaskbar 仅记录为信息（Windows 对从未显示的窗口查询不稳定，
 *      且未显示窗口本就不产生任务栏条目）。
 *   ② 隐藏状态下 capturePage 仍读到有效帧（非空、非纯色）——防止
 *      "窗口藏住了但 GPU 合成不产帧 → 截图黑屏/白屏"的次生回归。
 * 像素统计用 NativeImage.getBitmap()（Electron 内置，零第三方依赖），
 * 采样上限约 2 万像素点。阈值需满足"判别力"：真实导图截图 unique 数百+
 * 且 range≈255；全黑/全白 unique=1、range=0 → 必红。
 * ============================================================ */
'use strict';

// 像素统计**单源**在 scripts/vision/frame-stats.js（原先内联在本文件里，而当时另一份参考实现
// 对同一个 Buffer 的通道解读相反 —— Electron 声明该格式"平台相关"，
// 故本工程改为**让统计量与通道序无关**，细节见该文件头）。本文件不再自写统计。
const frameStats = require('../vision/frame-stats.js');
const analyzeFrame = frameStats.analyzeFrame;

const assertions = [
  {
    name: '离屏窗口：smoke 模式下窗口隐藏（isVisible=false，不弹桌面不抢焦点）',
    run: async (ctx) => {
      const win = ctx.win;
      if (!win || win.isDestroyed()) return { ok: false, text: 'win 不可用（主进程窗口句柄缺失）' };
      const vis = win.isVisible();
      // skipTaskbar 仅作信息记录，不参与判定：Windows 的任务栏条目只在窗口
      // **真正显示**时创建，show:false 的窗口本来就不会出现在任务栏；而
      // isSkipTaskbar() 对从未显示过的窗口查询不稳定（实测返回 false 但任务栏
      // 实际无此条目）。headless 的核心契约是 isVisible=false。
      let skip = 'n/a';
      try { skip = win.isSkipTaskbar(); } catch (e) { /* 个别平台无此方法 */ }
      return {
        ok: !vis,
        text: 'isVisible=' + vis + ' skipTaskbar=' + skip
          + (vis ? '（窗口仍可见——headless 契约被破坏）' : '')
      };
    }
  },
  {
    name: '离屏窗口：隐藏状态下 capturePage 读到有效帧（非空、非纯色，防黑屏/白屏回归）',
    run: async (ctx) => {
      const win = ctx.win;
      if (!win || win.isDestroyed()) return { ok: false, text: 'win 不可用' };
      let img;
      try { img = await win.webContents.capturePage(); }
      catch (err) { return { ok: false, text: 'capturePage 失败: ' + (err && err.message) }; }
      const st = analyzeFrame(img);
      const v = frameStats.passValidFrame(st);   // 阈值单源：scripts/vision/thresholds.js
      return {
        ok: v.ok,
        text: '采样=' + st.n + ' unique=' + st.unique + ' range=' + Math.round(st.range)
          + ' var=' + st.variance.toFixed(1)
          + (v.ok ? '' : '（疑似黑屏/白屏/空白帧）')
      };
    }
  }
];

module.exports = assertions;
module.exports.analyzeFrame = analyzeFrame;
