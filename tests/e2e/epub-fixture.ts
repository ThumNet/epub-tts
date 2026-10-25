import JSZip from "jszip";

export interface TestBook {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export const BOOK_TITLE = "Tiny Test Book";

const XHTML_NS = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"';

/** Sentence `n` of chapter `chapter`. About 35 characters, so the mock worker speaks it in about 2 s. */
export function sentenceText(chapter: number, n: number): string {
  return `Chapter ${chapter} line ${n} reads aloud.`;
}

function chapterXhtml(chapter: number, count: number): string {
  const paragraphs: string[] = [];
  for (let start = 1; start <= count; start += 3) {
    const sentences: string[] = [];
    for (let n = start; n < start + 3 && n <= count; n += 1) sentences.push(sentenceText(chapter, n));
    paragraphs.push(`<p>${sentences.join(" ")}</p>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<html ${XHTML_NS}><head><title>Chapter ${chapter}</title></head>` +
    `<body>${paragraphs.join("")}</body></html>`
  );
}

/**
 * Build a small valid EPUB in memory. Spine: an empty cover section, then chapter 1 (12 sentences),
 * chapter 2 (6 sentences) and chapter 3 (6 sentences). The chapter select shows "1. (no title)" for the cover
 * and "2. Chapter One", "3. Chapter Two", "4. Chapter Three".
 */
export async function buildTestBook(): Promise<TestBook> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:11111111-2222-3333-4444-555555555555</dc:identifier>` +
      `<dc:title>${BOOK_TITLE}</dc:title><dc:language>en</dc:language><dc:creator>Test Author</dc:creator>` +
      `<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>` +
      `<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
      `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>` +
      `<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>` +
      `<item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>` +
      `<item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/></manifest>` +
      `<spine><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<html ${XHTML_NS}><head><title>Contents</title></head><body>` +
      `<nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li><li><a href="c2.xhtml">Chapter Two</a></li>` +
      `<li><a href="c3.xhtml">Chapter Three</a></li></ol></nav></body></html>`,
  );
  zip.file(
    "OEBPS/cover.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<html ${XHTML_NS}><head><title>Cover</title></head><body></body></html>`,
  );
  zip.file("OEBPS/c1.xhtml", chapterXhtml(1, 12));
  zip.file("OEBPS/c2.xhtml", chapterXhtml(2, 6));
  zip.file("OEBPS/c3.xhtml", chapterXhtml(3, 6));
  const buffer = await zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
  return { name: "tiny.epub", mimeType: "application/epub+zip", buffer };
}
