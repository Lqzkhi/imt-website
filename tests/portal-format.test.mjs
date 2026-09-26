import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPortalInteger, isPortalNumber } from '../src/lib/testPortalNumbers.ts';
import { splitPortalEnumerates } from '../src/lib/testPortalStatement.ts';
test('integer extraction accepts long and signed integers and rejects ambiguous formats', () => {
  for (const v of ['0','-12','+12','00012','12345678','123456789','9'.repeat(100)]) assert.equal(isPortalInteger(v),true,v);
  for (const v of ['','12.0','12/1','1e3','12,345,678','0x12','Infinity','12 points',' 12','9'.repeat(101)]) assert.equal(isPortalInteger(v),false,v);
  assert.equal(isPortalNumber('1e3'),true);
  assert.equal(isPortalNumber('1e9999'),false);
});
test('proof conditions become a list while keeping text and math safe', () => {
  const parts=splitPortalEnumerates('Suppose:\\begin{enumerate}\n\\item For \\(A,B,C\\), majority stays in \\(\\mathcal F\\).\n\\item Every element belongs to half the members. <script>bad()</script>\n\\end{enumerate}Prove the result.');
  assert.deepEqual(parts, [
    {kind:'text',text:'Suppose:'},
    {kind:'list',items:['For \\(A,B,C\\), majority stays in \\(\\mathcal F\\).','Every element belongs to half the members. <script>bad()</script>']},
    {kind:'text',text:'Prove the result.'},
  ]);
  const malformed='Unclosed \\begin{enumerate}\\item A';
  assert.deepEqual(splitPortalEnumerates(malformed),[{kind:'text',text:malformed}]);
});
