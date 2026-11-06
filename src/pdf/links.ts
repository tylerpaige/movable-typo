// Reads the PDF's link annotations and the text under each one.

import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { PdfLink } from "../editor/links";

type Box = [number, number, number, number];

/** Web and mail links only; links to other pages of the PDF have nothing to point at once exported. */
const EXTERNAL = /^(https?:|mailto:)/i;

/**
 * Every external link in the PDF, with its box converted to Marker's page
 * coordinates (`markerSizes`, one [width, height] per page).
 */
export async function pdfLinks(doc: PDFDocumentProxy, markerSizes: [number, number][]): Promise<PdfLink[]> {
  const out: PdfLink[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const annots = (await page.getAnnotations()).filter((a) => a.subtype === "Link" && typeof a.url === "string" && EXTERNAL.test(a.url));
    if (!annots.length) continue;
    const items = (await page.getTextContent()).items.filter((it): it is TextItem => "str" in it && !!it.str);
    const vp = page.getViewport({ scale: 1 });
    const [mw, mh] = markerSizes[i] ?? [vp.width, vp.height];
    for (const a of annots) {
      const rect = a.rect as Box;
      const [x0, y0] = vp.convertToViewportPoint(rect[0], rect[1]);
      const [x1, y1] = vp.convertToViewportPoint(rect[2], rect[3]);
      const sx = mw / vp.width;
      const sy = mh / vp.height;
      out.push({
        page: i,
        bbox: [Math.min(x0, x1) * sx, Math.min(y0, y1) * sy, Math.max(x0, x1) * sx, Math.max(y0, y1) * sy],
        href: a.url,
        text: textIn(items, rect),
      });
    }
  }
  return out;
}

/**
 * The characters of horizontal text whose middle falls inside `rect` (PDF
 * space). A link often covers only part of a text item, so this goes
 * character by character, assuming even widths within an item.
 */
function textIn(items: TextItem[], rect: Box) {
  let text = "";
  for (const it of items) {
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue;
    const size = Math.abs(d) || it.height;
    const mid = f + size * 0.35;
    if (mid < rect[1] || mid > rect[3]) continue;
    const chars = [...it.str];
    const w = it.width / chars.length;
    chars.forEach((ch, k) => {
      const x = e + (k + 0.5) * w;
      if (x >= rect[0] && x <= rect[2]) text += ch;
    });
    text += " ";
  }
  return text.replace(/\s+/g, " ").trim();
}
