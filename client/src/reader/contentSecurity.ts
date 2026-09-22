/** Applied before creating the book's blob URLs, including fixed layout and SVG. */
export function protectBookDocument(source: string, type: string): string {
  const mime = type === 'text/html' ? 'text/html' : type === 'image/svg+xml' ? type : 'application/xhtml+xml';
  const doc = new DOMParser().parseFromString(source, mime);
  if (doc.querySelector('parsererror')) throw new Error('无法安全解析书籍文档');
  // An XML stylesheet can be an XSLT program that produces a new, unsanitized
  // document. Removing processing instructions does not affect element CFIs.
  const instructions = doc.createTreeWalker(doc, 64 /* SHOW_PROCESSING_INSTRUCTION */);
  const remove: Node[] = [];
  while (instructions.nextNode()) remove.push(instructions.currentNode);
  for (const node of remove) node.parentNode?.removeChild(node);
  const clean = (root: Document | DocumentFragment) => {
    for (const el of root.querySelectorAll('script, iframe, frame, frameset, object, embed, base, form, meta[http-equiv], animate, animateMotion, animateTransform, set, discard')) {
      // Preserve element order and IDs for historical CFIs. Removing a body
      // element would shift every following positional CFI step. SVG animation
      // elements can mutate sanitized links/attributes, so retain inert slots.
      // HTML parsing treats <span> inside SVG as a namespace break-out. A <g>
      // keeps following artwork inside SVG when the serialized book is HTML.
      const inertName = el.namespaceURI === 'http://www.w3.org/2000/svg' ? 'g'
        : el.namespaceURI === 'http://www.w3.org/1998/Math/MathML' ? 'mrow' : 'span';
      const inert = doc.createElementNS(el.namespaceURI, inertName);
      if (el.id) inert.setAttribute('id', el.id);
      if (el.localName === 'form') while (el.firstChild) inert.append(el.firstChild);
      el.replaceWith(inert);
    }
    for (const el of root.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        // URL parsers ignore leading ASCII controls as well as whitespace.
        // eslint-disable-next-line no-control-regex
        const url = attr.value.replace(/[\s\u0000-\u0020\u007f-\u009f]/g, '');
        if (/^on/i.test(attr.name) || /^(?:javascript|vbscript):/i.test(url) || attr.name === 'srcdoc') el.removeAttributeNode(attr);
      }
      // Template contents are a separate fragment, invisible to document queries.
      if (el.localName === 'template' && 'content' in el) clean((el as HTMLTemplateElement).content);
    }
  };
  clean(doc);
  if (doc.head) {
    const meta = doc.createElementNS('http://www.w3.org/1999/xhtml', 'meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    doc.head.prepend(meta);
  }
  return new XMLSerializer().serializeToString(doc);
}
