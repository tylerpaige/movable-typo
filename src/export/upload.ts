// Uploading a reading to Typo School's library (economy.typo.school), keyed
// by the same slug as the export. Images go first, since the HTML has to carry
// their URLs; then the reading; then its PDF, which needs the reading to exist.

import type { Node as PMNode } from "prosemirror-model";
import type { Api, UploadedReading } from "../api";
import type { Meta } from "../editor/import";
import { images, slugify, toArticle } from "./toHtml";

/**
 * The fields of Typo School's reading that the details fill. Blank details are
 * left out, so they don't clear what was filled in on Typo School. A year
 * that isn't a plain number ("1977/1982") is left out too: the field is an integer.
 */
export function readingFields(meta: Meta, bodyHtml: string): Record<string, unknown> {
  const out: Record<string, unknown> = { title: meta.title, bodyHtml };
  if (meta.author) out.authorDisplay = meta.author;
  if (/^\d{1,4}$/.test(meta.year.trim())) out.publishedYear = Number(meta.year.trim());
  if (meta.source) out.originalPublication = meta.source;
  if (meta.url) out.originalUrl = meta.url;
  return out;
}

export async function uploadReading(
  api: Api,
  project: string,
  doc: PMNode,
  meta: Meta,
  progress: (msg: string) => void,
): Promise<UploadedReading & { images: number }> {
  const slug = slugify(meta.title);
  const figures = images(doc);
  const urls = new Map<string, string>();
  for (const [i, img] of figures.entries()) {
    progress(`Uploading image ${i + 1} of ${figures.length}…`);
    urls.set(img.name, await api.uploadImage(slug, img.name, img.mime, img.data));
  }
  progress("Uploading the text…");
  const body = toArticle(doc, meta, (name) => urls.get(name) ?? `images/${name}`).trim();
  const saved = await api.uploadReading(slug, readingFields(meta, body));
  progress("Uploading the PDF…");
  await api.uploadPdf(project, slug);
  return { ...saved, images: figures.length };
}
