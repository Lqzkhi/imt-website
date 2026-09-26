type StatementPart = { kind: 'text'; text: string } | { kind: 'list'; items: string[] };
/** Interpret supported LaTeX list syntax; content stays text, never HTML. */
export function splitPortalEnumerates(text: string): StatementPart[] {
  const result: StatementPart[] = [];
  const pattern = /\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g;
  let previous = 0;
  for (let match; (match = pattern.exec(text));) {
    const items = match[1].split(/\\item\b/);
    if (items[0].trim() || items.length < 2 || match[1].includes('\\begin{enumerate}')) continue;
    result.push({ kind: 'text', text: text.slice(previous, match.index) });
    result.push({ kind: 'list', items: items.slice(1).map((item) => item.trim()) });
    previous = pattern.lastIndex;
  }
  result.push({ kind: 'text', text: text.slice(previous) });
  return result;
}
