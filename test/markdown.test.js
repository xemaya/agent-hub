import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

test('Markdown renders the structures used by real deliverables', () => {
  const html = renderMarkdown(`# 南瓜夜游会

**40人**参加，预算为 \`1800元\`。

## 玩法

1. 第一组解谜
2. 第二组投掷

| 时间 | 安排 |
| --- | --- |
| 18:30 | 签到 |
| 18:45 | 开场 |

- 不强制装扮
- 保留休息区

> 现场安全优先

\`\`\`text
完整结果 <不作为HTML>
\`\`\`

[项目说明](https://example.com/docs)`);
  assert.match(html, /<h2>南瓜夜游会<\/h2>/);
  assert.match(html, /<strong>40人<\/strong>/);
  assert.match(html, /<code>1800元<\/code>/);
  assert.match(html, /<ol><li><p>第一组解谜<\/p><\/li><li><p>第二组投掷<\/p><\/li><\/ol>/);
  assert.match(html, /<th>时间<\/th><th>安排<\/th>/);
  assert.match(html, /<td>18:30<\/td><td>签到<\/td>/);
  assert.match(html, /<blockquote><p>现场安全优先<\/p><\/blockquote>/);
  assert.match(html, /完整结果 &lt;不作为HTML&gt;/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('Markdown escapes raw HTML and rejects unsafe links', () => {
  const html = renderMarkdown(`<img src=x onerror=alert(1)>

[危险链接](javascript:alert(1))

[**安全链接**](https://example.com/?a=1&b=2)`);
  assert.ok(!html.includes('<img'));
  assert.doesNotMatch(html, /<[^>]*onerror/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /\[危险链接\]\(javascript:alert\(1\)\)/);
  assert.match(html, /<a href="https:\/\/example.com\/\?a=1&amp;b=2"/);
});

test('Markdown preserves nested lists and long output without clipping', () => {
  const ending = 'FULL_RESULT_ENDING';
  const html = renderMarkdown(`- 外层
  - 内层 **结果**
- 第二项

${'很长的交付内容'.repeat(2000)}
${ending}`);
  assert.match(html, /<ul><li><p>外层<\/p><ul><li><p>内层 <strong>结果<\/strong>/);
  assert.match(html, new RegExp(`${ending}</p></div>$`));
  assert.equal(html.includes('…'), false);
});
