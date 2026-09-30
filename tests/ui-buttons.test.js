/* ============================================================
 * tests/ui-buttons.test.js — 界面按钮不许"只画不接"（死按钮门禁）
 * ------------------------------------------------------------
 * 由来（真实缺陷）：PDF 预览头部的 **✕ 关闭**按钮从来没接过线 ——
 * 19 个带 id 的按钮里只有它"在渲染层代码里找不到任何引用"，用户只能靠 Esc 关预览。
 * 这类缺陷的特点是**静态可查**：按钮画在 index.html 里，接线写在 renderer/*.js 里，
 * 两边对不上就是死按钮。所以把它做成机械检查，而不是靠人点一遍。
 *
 * 判据与边界（刻意保守，只抓"完全没接线"这一种）：
 *   · 采集 `renderer/index.html` 里所有 `<button id="X">`；
 *   · 要求 `renderer/*.js` 里出现过 `X`（写作 '#X' 或 'X' 都算）——不检查接得对不对，
 *     只抓"一个字都没提"的；接线方式千变万化（onclick 赋值 / addEventListener /
 *     事件委托 / 由 MM 转发），要求具体写法必然假红。
 *   · 判别力注入：喂一份"有按钮没接线"的合成 HTML，检查器必须报出它（否则本测试是假守护）。
 * ============================================================ */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'renderer', 'index.html');

/** 收集 `<button id="...">` 的 id（只认带 id 的按钮；class-only 的按钮无法机械归属，见文件头边界） */
function buttonIds(html) {
  return [...html.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
}

/** 在给定渲染层源码集合里找"完全没被提到"的按钮 id */
function unreferencedButtons(html, rendererSource) {
  return buttonIds(html).filter((id) => !rendererSource.includes("'" + id + "'")
    && !rendererSource.includes('#' + id) && !rendererSource.includes('"' + id + '"'));
}

function rendererBundle() {
  const dir = path.join(ROOT, 'renderer');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}

describe('界面按钮接线门禁', () => {
  it('判别力注入：没接线的按钮必须被报出来（否则本门禁是假守护）', () => {
    const fakeHtml = '<button id="btn-a">A</button><button id="btn-b">B</button>';
    const fakeJs = "document.querySelector('#btn-a').onclick = () => {};";
    expect(unreferencedButtons(fakeHtml, fakeJs)).toEqual(['btn-b']);
  });

  it('真工程：index.html 里每个带 id 的按钮都被渲染层引用到', () => {
    const html = fs.readFileSync(HTML, 'utf8');
    const dead = unreferencedButtons(html, rendererBundle());
    expect(dead, '这些按钮画在界面上却没有任何代码引用：' + dead.join(', ')).toEqual([]);
  });

  it('回归：✕ 关闭预览确实绑了点击（这条缺陷曾真实存在）', () => {
    const src = rendererBundle();
    expect(src).toContain('#fp-close');
    expect(src).toMatch(/\$\('#fp-close'\)[\s\S]{0,200}addEventListener\('click'/);
  });

  it('按钮数量本身不许"悄悄归零"（防止解析失效导致门禁空转）', () => {
    expect(buttonIds(fs.readFileSync(HTML, 'utf8')).length).toBeGreaterThanOrEqual(15);
  });
});
