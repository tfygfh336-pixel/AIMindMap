/* ============================================================
 * tests/html-whitelist.test.js — 「正文 HTML 子集」白名单表的**纯逻辑**判据（R7）
 * ------------------------------------------------------------
 * 为什么要有它（R3「改 `src/` 核心 → 加单测」）：
 *   `src/html-whitelist.js` 是三个消费者的**唯一一份表**（消毒模块 / 语料读数 / `markdownToHtml` 的 URL 档）。
 *   表本身是纯数据 + 纯判定 ⇒ 边界必须在这里钉死，而不是只在渲染层的真帧里试。
 *
 * 判据纪律（照设计稿 §⑫-3.4 的范式）：
 *   · **期望值不取自被测的同一个函数**：标签名单从**设计稿的档位**（用户拍板 A 档）逐条写在这里，
 *     与表做**集合比对**；URL 判据用"人写的样例 → 期望 kind"的表驱动；
 *   · 每条判据都能被打红（把表改一格 ⇒ 至少一条红），证明方式见 `.review/20261016-R7实现/README.md`。
 * ============================================================ */
'use strict';

import { describe, it, expect } from 'vitest';
import W from '../src/html-whitelist.js';

/** 用户拍板 A 档（§⑫-5.2）：**逐条手写**在这里，与表比对 —— 不从表里推导 */
const A_GEARMUST_ALLOW = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup', 'kbd', 'mark',
  'code', 'pre', 'blockquote', 'details', 'summary', 'a', 'img', 'div', 'span'
];
/** 用户点名的**禁**档（§⑫-5.2）：style / on* / script / iframe / svg */
const A_GEAR_MUST_BAN = ['style', 'script', 'iframe', 'svg', 'form', 'meta', 'base', 'object', 'embed', 'template'];

describe('src/html-whitelist.js — 白名单表', () => {
  it('A 档的每一条"允许"都在表里（逐条手写的期望值 vs 表）', () => {
    const missing = A_GEARMUST_ALLOW.filter((t) => !W.isAllowedTag(t));
    expect(missing, '用户拍板允许、但表里没有：' + missing.join(',')).toEqual([]);
  });

  it('用户点名的禁档一律**不在**允许名单里，且都在"整棵子树删掉"那一档里', () => {
    const wronglyAllowed = A_GEAR_MUST_BAN.filter((t) => W.isAllowedTag(t));
    expect(wronglyAllowed, '被禁却放行了：' + wronglyAllowed.join(',')).toEqual([]);
    const notDropped = A_GEAR_MUST_BAN.filter((t) => !W.isDropTag(t));
    expect(notDropped, '被禁但只拆壳（子树会留下）：' + notDropped.join(',')).toEqual([]);
  });

  it('⚠️ CSP 真空档四类都有名字：style / 框架类 / meta-base / svg', () => {
    // ① `style-src 'unsafe-inline'` 放行 style ⇒ 表必须显式拒
    expect(W.isDropTag('style')).toBe(true);
    expect(W.attrAllowed('p', 'style')).toBe(false);
    // ② 未声明 frame-src ⇒ 回落 default-src 的 data: ⇒ 框架类必须显式拒
    ['iframe', 'frame', 'frameset', 'object', 'embed'].forEach((t) => expect(W.isDropTag(t), t).toBe(true));
    // ③ CSP 管不到的：meta refresh / base
    ['meta', 'base'].forEach((t) => expect(W.isDropTag(t), t).toBe(true));
    // ④ svg 是 on* 与脚本宿主
    expect(W.isDropTag('svg')).toBe(true);
  });

  it('事件属性**按前缀**拒（不靠枚举——枚举一定会漏），data-* 只放行已知键', () => {
    ['onclick', 'onerror', 'onload', 'onx', 'ONMOUSEOVER'].forEach((a) => {
      expect(W.attrAllowed('img', a), a).toBe(false);
    });
    expect(W.attrAllowed('td', 'data-item-id')).toBe(true);
    expect(W.attrAllowed('td', 'data-随便')).toBe(false);
    expect(W.attrAllowed('a', 'href')).toBe(true);
    expect(W.attrAllowed('a', 'formaction')).toBe(false);
    expect(W.attrAllowed('img', 'referrerpolicy')).toBe(true);   // 允许远程图之后这一条有意义（别删）
  });

  it('URL 判据：`img` 放行 https（用户 2026-10-16 裁决）+ file/data/相对路径；明文 http 拒', () => {
    expect(W.classifyUrl('https://example.com/x.png', 'img').ok).toBe(true);
    expect(W.classifyUrl('data:image/png;base64,AAA', 'img').ok).toBe(true);
    expect(W.classifyUrl('file:///E:/x.png', 'img').ok).toBe(true);
    expect(W.classifyUrl('assets/x.png', 'img').kind).toBe('relative');
    const plain = W.classifyUrl('http://example.com/x.png', 'img');
    expect(plain.ok).toBe(false);
    expect(plain.code).toBe('url-http-img');
    // 链接那一档：外链三档 + 站内 scheme；可执行档一律拒
    ['http', 'https', 'mailto'].forEach((s) => expect(W.classifyUrl(s + '://x', 'a').ok, s).toBe(true));
    expect(W.classifyUrl('aimm://p/n', 'a').ok).toBe(true);
    ['javascript:alert(1)', 'vbscript:x', 'data:text/html,<b>', 'blob:https://x', '//evil.example/x']
      .forEach((u) => expect(W.classifyUrl(u, 'a').ok, u).toBe(false));
  });

  it('`parseAimUrl`：形状唯一（项目/节点id[#条目id]），烂形状响亮报错', () => {
    expect(W.parseAimUrl('aimm://comnet/tcp-handshake')).toEqual({ ok: true, project: 'comnet', id: 'tcp-handshake', item: '' });
    expect(W.parseAimUrl('aimm://comnet/tcp-handshake#item-1')).toEqual({ ok: true, project: 'comnet', id: 'tcp-handshake', item: 'item-1' });
    ['aimm://', 'aimm://comnet', 'http://comnet/x', 'aimm://comnet/'].forEach((u) => {
      expect(W.parseAimUrl(u).ok, u).toBe(false);
    });
  });

  it('`TAG_RE` 与允许名单同源（语料读数不许自写一份正则）', () => {
    expect(W.TAG_RE.test('<h3>x</h3>')).toBe(true);
    expect(W.TAG_RE.test('<style>x</style>')).toBe(false);
    expect(W.TAG_RE.test('纯文本，没有标签')).toBe(false);
  });
});
