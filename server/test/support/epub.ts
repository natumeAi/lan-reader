import AdmZip from 'adm-zip';

/** Builds a minimal but genuinely valid EPUB 2 in memory. */
export function buildEpub({ title, author, identifier }: { title: string; author: string; identifier: string }): Buffer {
  const zip = new AdmZip();

  // `mimetype` must be the first entry and stored uncompressed.
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));

  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
      'utf8',
    ),
  );

  const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#2f6f4f"/></svg>`;
  zip.addFile('OEBPS/cover.svg', Buffer.from(coverSvg, 'utf8'));

  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${title}</dc:title>
    <dc:creator opf:role="aut">${author}</dc:creator>
    <dc:identifier id="bookid">${identifier}</dc:identifier>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>Step Two Press</dc:publisher>
    <dc:description>A fixture built for the step 2 backend smoke.</dc:description>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="cover-image" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
  </spine>
</package>`,
      'utf8',
    ),
  );

  zip.addFile(
    'OEBPS/toc.ncx',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${identifier}"/></head>
  <docTitle><text>${title}</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>第一章</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`,
      'utf8',
    ),
  );

  zip.addFile(
    'OEBPS/chapter1.xhtml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head>
<body><h1>第一章</h1><p>步骤二后端冒烟测试用书。</p></body></html>`,
      'utf8',
    ),
  );

  return zip.toBuffer();
}
