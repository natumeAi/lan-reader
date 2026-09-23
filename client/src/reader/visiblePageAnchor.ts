/** The same visible-text midpoint identifies a page in previews and the foreground. */
export function getVisiblePageTextAnchor(visible: Range): Range | null {
  const walker = visible.startContainer.ownerDocument!.createTreeWalker(visible.commonAncestorContainer, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  if (visible.commonAncestorContainer.nodeType === 3) nodes.push(visible.commonAncestorContainer as Text);
  else { while (walker.nextNode()) if (visible.intersectsNode(walker.currentNode)) nodes.push(walker.currentNode as Text); }
  const pieces = nodes.map(node => ({ node, start: node === visible.startContainer ? visible.startOffset : 0, end: node === visible.endContainer ? visible.endOffset : node.length })).filter(p => p.end > p.start && /\S/.test(p.node.data.slice(p.start, p.end)));
  let middle = Math.floor(pieces.reduce((sum, p) => sum + p.end - p.start, 0) / 2);
  for (const p of pieces) {
    if (middle < p.end - p.start) {
      let offset = p.start + middle;
      // Stay inside the visible slice and avoid zero-width wrap whitespace.
      for (let distance = 0; distance < p.end - p.start; distance++) {
        const next = offset + distance;
        const previous = offset - distance;
        if (next < p.end && /\S/.test(p.node.data[next]!)) { offset = next; break; }
        if (previous >= p.start && /\S/.test(p.node.data[previous]!)) { offset = previous; break; }
      }
      const anchor = visible.cloneRange(); anchor.setStart(p.node, offset); anchor.collapse(true);
      return anchor;
    }
    middle -= p.end - p.start;
  }
  return null;
}
