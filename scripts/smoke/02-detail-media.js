/* ============================================================
 * scripts/smoke/02-detail-media.js —— 冒烟断言分域 02：详情图片 / 灯箱 / 序列化 / 内存态编辑
 * （详情图片真实加载 / 灯箱双击+滚轮+关闭 / images 字段序列化 / 渲染层增删节点）
 *
 * 由入口 scripts/smoke-assertions.js 按顺序拼接执行。
 * 本文件是对拆分前单体 smoke-assertions.js 的逐字搬运，勿改断言文案与顺序。
 * ============================================================ */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const assertions = [
  {
    name: 'detail images',
    run: async (ctx) => {
      // 校验浮动详情里图片真实加载（naturalWidth > 0）；图片为异步加载，轮询等待
      for (let i = 0; i < 15; i++) {
        const chk = await ctx.exec(
          `(function () {
            var imgs = document.querySelectorAll('.float-detail .fd-images-content img[data-full]');
            if (!imgs.length) return 'no img in detail';
            var ws = Array.from(imgs).map(function (i) { return i.naturalWidth; });
            return 'imgs=' + imgs.length + ' naturalW=' + ws.join(',');
          })()`
        );
        if (/^imgs=\d+ naturalW=/.test(chk) && !/naturalW=0/.test(chk)) return { ok: true, text: chk };
        if (chk.indexOf('no img') >= 0) return { ok: false, text: chk };
        await sleep(200);
      }
      return { ok: false, text: 'timeout waiting images load' };
    }
  },
  {
    name: 'image lightbox: dblclick → wheel zoom → close',
    run: async (ctx) => {
      // 双击图片打开灯箱；灯箱内滚轮缩放；Esc/双击关闭
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var img = document.querySelector('.float-detail .fd-images-content img[data-full]');
          if (!img) return 'no img';
          img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          var lb = document.getElementById('lightbox');
          if (!lb || lb.style.display !== 'flex') return 'lightbox not open';
          var lbImg = document.getElementById('lightbox-img');
          var before = lbImg.style.transform;
          lb.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
          var after = lbImg.style.transform;
          app.closeLightbox();
          var closed = lb.style.display === 'none';
          return JSON.stringify({ opened: true, before: before, after: after, closed: closed });
        })()`
      );
      const ok = /"opened":true/.test(chk) && /"closed":true/.test(chk) && !/before":"scale\(1\)","after":"scale\(1\)"/.test(chk);
      return { ok, text: chk };
    }
  },
  {
    name: 'serialized images',
    run: async (ctx) => {
      // 验证 get_data('node_tree') 序列化时 images 扩展字段被平铺输出（界面保存链路依赖）
      const chk = await ctx.exec(
        `(function () {
          var app = window.MMApp;
          var jm = app && app.getState ? app.getState().jm : null;
          if (!jm) return 'no jm';
          var live = jm.get_node('tcp-handshake');
          var tree = app.serializeTree ? app.serializeTree() : null;
          var found = null;
          (function walk (n) { if (!found) { if (n.id === 'tcp-handshake') found = n; (n.children || []).forEach(walk); } })(tree && tree.data);
          return JSON.stringify({
            liveDataKeys: live && live.data ? Object.keys(live.data) : null,
            liveImages: live && (live.images || (live.data && live.data.images)) ? 'yes' : 'no',
            serializedImages: found ? (found.images ? 'yes:' + found.images.length : 'no') : 'node-not-found'
          });
        })()`
      );
      return { ok: /"serializedImages":"yes:\d+"/.test(chk), text: chk };
    }
  },
  {
    name: 'edit via in-app API (add + remove, no trace)',
    run: async (ctx) => {
      // 渲染层编辑链路无需人工/鼠标：加一个临时子节点再删除，验证可用且不留痕
      const chk = await ctx.exec(
        `(function () {
          try {
            var app = window.MMApp;
            var jm = app && app.getState ? app.getState().jm : null;
            if (!jm) return { ok: false, text: 'no jm' };
            var before = (jm.get_node('tcp-handshake').children || []).length;
            jm.add_node('tcp-handshake', 'smoke-tmp', 'smoke-tmp', { detail: '<p>tmp</p>' });
            var added = !!jm.get_node('smoke-tmp');
            var afterAdd = (jm.get_node('tcp-handshake').children || []).length;
            jm.remove_node('smoke-tmp');
            var removed = !jm.get_node('smoke-tmp');
            var afterRemove = (jm.get_node('tcp-handshake').children || []).length;
            return {
              ok: added && removed && before === afterRemove,
              text: 'before=' + before + ' add=' + added + '(' + afterAdd + ') remove=' + removed + '(' + afterRemove + ')'
            };
          } catch (e) { return { ok: false, text: 'err:' + e.message }; }
        })()`
      );
      return chk;
    }
  }
];

module.exports = assertions;
