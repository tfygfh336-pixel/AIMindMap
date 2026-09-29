/* ============================================================
 * AI MindMap — 浮动详情框：拖动 / 改大小 / 悬停提示（app-detail-drag.js）
 * ------------------------------------------------------------
 * 拆分自 renderer/app.js（拆分前所有函数同处一个 IIFE 闭包）。
 * 职责：
 *   1) 改大小：四边/四角把手（startFdResize / applyFdResize，最小尺寸约束）
 *   2) 拖动结束处理：拖出窗口即就地钉住并自动上小锁（fdEndDrag / fdEndResize）
 *   3) 全局拖动接线 bindFdGlobalDrag（全局只绑一次；鼠标移出窗口用 mouseout 兜底）
 *   4) 图片悬停提示 showFdImgTip / moveFdImgTip / hideFdImgTip
 * 边界（本文件不负责）：
 *   · 框池与定位算法 → app-detail.js；框内容渲染 → app-detail-content.js
 * 共享可变槽位 fdDrag / fdResize 定义在 app-core.js（同名全局槽位，
 * 因此函数体里的裸名读写与拆分前完全一致）。
 * 所有搬迁的函数体与拆分前逐字相同；本文件只新增顶部转发声明与 MM.x 导出行。
 * ============================================================ */
(function () {
  'use strict';
  const MM = window.MM || (window.MM = {});

  const $ = MM.$;
  const FD_LOCK = MM.FD_LOCK;
  const FD_MIN_W = 200, FD_MIN_H = 120; // 改大小的最小尺寸（布局 px）

  /* —— 改大小：四边/四角拖动（与 Windows 窗口一致的交互） —— */
  function startFdResize(box, dir, e) {
    const el = box.el;
    fdResize = {
      box, dir, S: fdZoom() || 1,
      x: e.clientX, y: e.clientY,
      l: parseFloat(el.style.left || 0), t: parseFloat(el.style.top || 0),
      w: el.offsetWidth, h: el.offsetHeight
    };
    el.style.maxWidth = 'none';   // 解除初始尺寸上限，允许自由改大小
    el.style.maxHeight = 'none';
    el.classList.add('resizing');
    bringFdBoxToFront(box);
  }

  function applyFdResize(e) {
    const r = fdResize;
    const el = r.box.el;
    const S = r.S;
    const dx = (e.clientX - r.x) / S, dy = (e.clientY - r.y) / S;
    let l = r.l, t = r.t, w = r.w, h = r.h;
    if (r.dir.indexOf('e') >= 0) w = r.w + dx;
    if (r.dir.indexOf('w') >= 0) { w = r.w - dx; l = r.l + dx; }
    if (r.dir.indexOf('s') >= 0) h = r.h + dy;
    if (r.dir.indexOf('n') >= 0) { h = r.h - dy; t = r.t + dy; }
    if (w < FD_MIN_W) { if (r.dir.indexOf('w') >= 0) l = r.l + (r.w - FD_MIN_W); w = FD_MIN_W; }
    if (h < FD_MIN_H) { if (r.dir.indexOf('n') >= 0) t = r.t + (r.h - FD_MIN_H); h = FD_MIN_H; }
    // 允许超出导图容器（可只显示一部分），但不超出软件窗口
    const container = document.getElementById('mindmap-container');
    if (container) {
      const cr = container.getBoundingClientRect();
      const minL = -cr.left, maxL = window.innerWidth - cr.left - w * S;
      const minT = -cr.top, maxT = window.innerHeight - cr.top - h * S;
      l = Math.max(minL, Math.min(l, Math.max(minL, maxL)));
      t = Math.max(minT, Math.min(t, Math.max(minT, maxT)));
    }
    el.style.left = Math.round(l) + 'px';
    el.style.top = Math.round(t) + 'px';
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
  }

  /** 结束拖动：自动上小锁（原本是大锁的保持大锁），并刷新锚点 */
  function fdEndDrag() {
    if (!fdDrag) return;
    const box = fdDrag.box;
    box.el.classList.remove('dragging');
    fdDrag = null;
    // 拖动即自动上小锁
    if (box.lock === FD_LOCK.FOLLOW) {
      box.lock = FD_LOCK.MAP;
      updateFdBoxButtons(box);
      setStatus('详情框：已自动上小锁（锁定到导图位置）');
    }
    if (box.lock === FD_LOCK.MAP) box.anchor = fdComputeAnchor(box);
    positionFdBox(box);
  }

  /** 结束改大小：若为小锁则刷新锚点 */
  function fdEndResize() {
    if (!fdResize) return;
    const box = fdResize.box;
    fdResize = null;
    box.el.classList.remove('resizing');
    if (box.lock === FD_LOCK.MAP) box.anchor = fdComputeAnchor(box);
    positionFdBox(box);
  }

  /** 详情框拖动 / 改大小（全局只绑一次）
   *  · 拖动**不夹取**：允许把框拖到导图容器之外（可以只显示一部分），
   *    这样不会因为"必须完整显示"而只能在上图画面范围内拖动；
   *  · 但指针一旦脱离软件窗口，立刻结束拖动并自动上小锁钉在当前位置，避免被"拖飞"。 */
  let fdGlobalDragBound = false;
  function bindFdGlobalDrag() {
    if (fdGlobalDragBound) return;   // 幂等：与 bindContainerControls 同规矩（防重复调用叠加监听）
    fdGlobalDragBound = true;
    document.addEventListener('mousemove', (e) => {
      if (fdResize) { e.preventDefault(); applyFdResize(e); return; }
      if (!fdDrag) return;
      if (e.clientX < 0 || e.clientY < 0
        || e.clientX > window.innerWidth || e.clientY > window.innerHeight) {
        fdEndDrag(); // 指针拖出软件界面 → 就地钉住
        return;
      }
      e.preventDefault();
      fdDrag.box.el.style.left = Math.round(fdDrag.l + (e.clientX - fdDrag.x)) + 'px';
      fdDrag.box.el.style.top = Math.round(fdDrag.t + (e.clientY - fdDrag.y)) + 'px';
    });
    document.addEventListener('mouseup', () => { fdEndResize(); fdEndDrag(); });
    // 真拖拽时指针移出窗口后浏览器可能不再派发 mousemove → 用 mouseout 兜底
    window.addEventListener('mouseout', (e) => {
      if (e.relatedTarget) return; // 仍是在窗口内元素间移动
      fdEndResize();
      fdEndDrag();
    });
  }

  /* —— 图片悬停提示（跟随鼠标显示"双击浏览"） —— */
  function showFdImgTip(e) {
    const tip = $('#fd-img-tip');
    if (!tip) return;
    tip.textContent = '双击浏览';
    tip.style.display = 'block';
    moveFdImgTip(e);
  }
  function moveFdImgTip(e) {
    const tip = $('#fd-img-tip');
    if (!tip || tip.style.display === 'none') return;
    tip.style.left = (e.clientX + 14) + 'px';
    tip.style.top = (e.clientY + 16) + 'px';
  }
  function hideFdImgTip() {
    const tip = $('#fd-img-tip');
    if (tip) tip.style.display = 'none';
  }

  /* —— 只转发「定义在其他文件」的函数（其他模块后加载，故用包装函数而非解构）—— */
  const fdZoom = () => MM.fdZoom();
  const bringFdBoxToFront = (box) => MM.bringFdBoxToFront(box);
  const updateFdBoxButtons = (box) => MM.updateFdBoxButtons(box);
  const fdComputeAnchor = (box) => MM.fdComputeAnchor(box);
  const positionFdBox = (box) => MM.positionFdBox(box);
  const setStatus = (text, isErr) => MM.setStatus(text, isErr);

  /* —— 本文件定义的东西挂到共享命名空间 —— */
  MM.startFdResize = startFdResize;
  MM.applyFdResize = applyFdResize;
  MM.fdEndDrag = fdEndDrag;
  MM.fdEndResize = fdEndResize;
  MM.bindFdGlobalDrag = bindFdGlobalDrag;
  MM.showFdImgTip = showFdImgTip;
  MM.moveFdImgTip = moveFdImgTip;
  MM.hideFdImgTip = hideFdImgTip;
})();
