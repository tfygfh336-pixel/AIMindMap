/* ============================================================
 * tests/dock-panel-page.test.js — 第 4 面板**页面本体**的单元测试（vitest，零 Electron）
 * ------------------------------------------------------------
 * 这张页面里那段 JS **只有在真起一个 WebContentsView 之后才会被解析**。本批实测踩到过一次：
 * 第一版把页面写成 `main-dsh-sidebar.js` 里的一条长 concat，页面 JS 里又嵌了 ASCII 双引号
 * ⇒ 把宿主那层单引号字符串提前截断 ⇒ **主进程那份源码本身就是语法错的**（那次被别的判据抓到）。
 * 能更早抓住它的地方就是这里：把页面脚本取出来 `new Function()` 跑一遍语法，不跑冒烟也能红。
 *
 * 三条纪律：
 *   ① 断言"页面能做的那三件事"（接收 / 请求 / 自报行数），而不是断言某段 HTML 长什么样；
 *   ② 断言"页面**不做**什么"（没有一次 innerHTML —— 文件名里的 `<`、`&`、`</script>` 不许变成结构）；
 *   ③ 断言"两种结局分得开"（`state:'empty'` 说"确实没有改动"，`state:'no-git'` 说"取不到"）——
 *      "把采不到说成没改动"是本工程最重的损害类别，靠代码结构守，不靠文案自觉。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MARKERS, pageHtml, dataUrl, scriptOf, LINES } from '../src/dock-panel-page.js';

const ROOT = path.resolve(__dirname, '..');

/* 页面脚本的语法闸门：new Function 一跑就知道有没有语法错（不执行任何 DOM 代码） */
function parsePageScript() {
  const body = scriptOf();
  expect(body, '页面里没有 <script> —— 那这张页面就是死的').not.toBe(null);
  // 只做语法解析，不执行（new Function 构造时不跑函数体）
  return new Function(body);
}

describe('面板页 ① 页面脚本真的能解析（这是最容易"写完看不见"的那一类错）', () => {
  it('`new Function(scriptOf())` 不抛 ⇒ 页面 JS 语法没问题', () => {
    expect(() => parsePageScript()).not.toThrow();
  });

  it('页面脚本恰好一段，且不是空串', () => {
    const html = pageHtml();
    expect((html.match(/<script>/g) || []).length).toBe(1);
    expect((html.match(/<\/script>/g) || []).length).toBe(1);
    expect(scriptOf().length).toBeGreaterThan(1000);
  });

  it('`data:` URL 是 encodeURIComponent 过的（页面里的引号/换行不会破坏 URL 结构）', () => {
    const url = dataUrl();
    expect(url.indexOf('data:text/html;charset=utf-8,') === 0).toBe(true);
    const body = url.slice('data:text/html;charset=utf-8,'.length);
    expect(body.indexOf('\n')).toBeLessThan(0);     // 换行必须被编码掉
    expect(decodeURIComponent(body)).toBe(pageHtml());
  });
});

describe('面板页 ② 三个锚点（页面与主进程靠它们对上话，对不上就静默失联）', () => {
  it('接收函数 `window.__mmChangeLog.receive` 在（主进程推数据打这里）', () => {
    expect(pageHtml()).toContain('window.__mmChangeLog = { state: S, receive: render }');
  });

  it('请求标记与页面模块的 MARKERS 逐字一致（唯一真源，不许两边各写一份）', () => {
    const html = pageHtml();
    expect(html).toContain(MARKERS.req);        // '[mm-changelog:req]'（里面那个 ? 只是个字面量）
    expect(html).toContain(MARKERS.reqForce);
    expect(html).toContain(MARKERS.close);
    // 反向：MARKERS 的每个值都必须真的出现在页面里（否则主进程在等一个永远不会来的标记）
    Object.keys(MARKERS).forEach((k) => {
      expect(html.indexOf(MARKERS[k]) >= 0, '页面里缺标记：' + k + '=' + MARKERS[k]).toBe(true);
    });
  });

  it('行标记 `data-mm-cl-row` 在（冒烟域 22 用它在 DOM 里数行，不靠猜）', () => {
    expect(pageHtml()).toContain('data-mm-cl-row');
  });

  it('页面自报行数（`[mm-changelog:rendered]` + S.rendered 计数）', () => {
    const html = pageHtml();
    expect(html).toContain('[mm-changelog:rendered]');
    expect(html).toContain('S.rendered++');
  });

  it('关闭按钮仍走既有的 `[dock-close]`（底座批的关面板通道一个字没变）', () => {
    expect(pageHtml()).toContain('console.log("[dock-close]")');
  });

  it('重开面板会重新要一次读数（关闭期间页面状态是活的、会过时）', () => {
    expect(pageHtml()).toContain('window.addEventListener("resize"');
    expect(pageHtml()).toContain('window.innerWidth > 0');
  });
});

describe('面板页 ③ 页面**不做**什么：不拼 HTML、不算数、不读盘', () => {
  it('一次 innerHTML 都没有（文件名里的 < & </script> 不可能变成结构）', () => {
    expect(pageHtml().indexOf('innerHTML')).toBeLessThan(0);
    expect(pageHtml()).toContain('textContent');
    expect(pageHtml()).toContain('createElement');
  });

  it('页面里没有 fs / require / IPC（沙箱 + 无 preload ⇒ 它连"自己去读那个 jsonl"都做不到）', () => {
    const body = scriptOf();
    ['require(', 'nodeIntegration', 'ipcRenderer', 'readFileSync'].forEach((bad) => {
      expect(body.indexOf(bad), '页面脚本里出现了不该有的能力：' + bad).toBeLessThan(0);
    });
  });

  it('页面自己不算合计（合计只显示主进程给的 totals）', () => {
    const body = scriptOf();
    // 反向取证：页面里**没有**任何累加（`+=` 只允许出现在拼字符串的 tail 那一处）
    expect(body.indexOf('totals.added +')).toBeLessThan(0);
    expect(body.indexOf('reduce(')).toBeLessThan(0);
    expect(body).toContain('p.totals');
  });
});

describe('面板页 ④ 两种"没有行"必须分得开（采不到 ≠ 没有改动）', () => {
  it('`state:empty` 说"确实没有改动"；`no-git`/`no-repo`/`error` 走响亮报错分支', () => {
    const body = scriptOf();
    // 分支条件必须是"只要不是 ok/empty 就走报错分支"（白名单式，而不是逐个黑名单漏一种）
    expect(body).toContain('p.state !== "ok" && p.state !== "empty"');
    expect(body).toContain('取不到改动清单');
    expect(body).toContain('确实没有改动');
  });

  it('口径逐字印在页面上（"相对 HEAD 的累计" —— 唯一能和 kernel 那个数混的地方）', () => {
    expect(pageHtml()).toContain('p.unitText');
    expect(pageHtml()).toContain('追溯');
    expect(pageHtml()).toContain('p.trace');
  });

  it('复用来的读数会标年龄（不许把 1.5s 前的快照装成刚采的）', () => {
    const body = scriptOf();
    expect(body).toContain('p.cached');
    expect(body).toContain('cachedAgeMs');
  });
});

describe('面板页 ⑤ 结构：页面本体只在 src/ 这里一份（`main-dsh-sidebar.js` 只许委派）', () => {
  it('`main-dsh-sidebar.js` 里 `dockPanelPageHtml` 是一行委派，没有第二份页面文本', () => {
    const t = readFileSync(path.join(ROOT, 'main-dsh-sidebar.js'), 'utf8');
    expect(t).toContain('function dockPanelPageHtml() { return dockPanelPage.dataUrl(); }');
    expect((t.match(/function dockPanelPageHtml\(\)/g) || []).length).toBe(1);
    // 旧占位页的两句特征串不许残留（它们就是"面板还是空白的"那版）
    expect(t.indexOf('这一版**只造底座**')).toBeLessThan(0);
    expect(t.indexOf('停靠面板（第 4 个原生视图 · 底座）')).toBeLessThan(0);
  });

  it('`LINES` 拼出来的就是 `pageHtml()`（改行只需改数组，不必动拼接逻辑）', () => {
    expect(LINES.join('\n')).toBe(pageHtml());
  });
});
