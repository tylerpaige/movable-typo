import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Region } from "../editor/schema";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const GAP = 12;

interface Page {
  div: HTMLDivElement;
  canvas: HTMLCanvasElement;
  proxy: pdfjs.PDFPageProxy;
  /** PDF size in points. */
  size: [number, number];
  top: number;
  width: number;
  height: number;
  renderedAt: number;
}

/**
 * Continuous-scroll PDF pane. Positions are given in Marker's page coordinates,
 * which are converted to pixels with each page's scale.
 */
export class PdfViewer {
  readonly el: HTMLElement;
  private inner: HTMLDivElement;
  private pages: Page[] = [];
  private markerSizes: [number, number][] = [];
  private observer: IntersectionObserver;
  private marks: HTMLElement[] = [];
  zoom = 1;
  /** True while dragging out a capture, and just after, so the drag's click is not a sync click. */
  private capturing = false;
  onClick: (page: number, x: number, y: number, screenY: number) => void = () => {};

  constructor(el: HTMLElement) {
    this.el = el;
    this.inner = document.createElement("div");
    this.inner.className = "pdf-inner";
    el.append(this.inner);
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) this.request(Number((e.target as HTMLElement).dataset.page));
      },
      { root: el, rootMargin: "150% 0px" },
    );
    this.inner.addEventListener("click", (e) => {
      if (this.capturing) return;
      const div = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
      if (!div) return;
      const i = Number(div.dataset.page);
      const r = div.getBoundingClientRect();
      const s = this.scale(i);
      this.onClick(i, (e.clientX - r.left) / s, (e.clientY - r.top) / s, e.clientY - this.el.getBoundingClientRect().top);
    });
    new ResizeObserver(() => this.layout()).observe(el);
  }

  async load(data: Uint8Array, markerSizes: [number, number][]) {
    const base = new URL("pdfjs/", document.baseURI).href;
    const doc = await pdfjs.getDocument({
      data,
      wasmUrl: base + "wasm/",
      cMapUrl: base + "cmaps/",
      standardFontDataUrl: base + "standard_fonts/",
      iccUrl: base + "iccs/",
    }).promise;
    this.markerSizes = markerSizes;
    this.inner.replaceChildren();
    this.pages = [];
    for (let i = 0; i < doc.numPages; i++) {
      const proxy = await doc.getPage(i + 1);
      const vp = proxy.getViewport({ scale: 1 });
      const div = document.createElement("div");
      div.className = "pdf-page";
      div.dataset.page = String(i);
      const canvas = document.createElement("canvas");
      div.append(canvas);
      this.inner.append(div);
      this.pages.push({ div, canvas, proxy, size: [vp.width, vp.height], top: 0, width: 0, height: 0, renderedAt: 0 });
      this.observer.observe(div);
    }
    this.layout();
  }

  get pageCount() {
    return this.pages.length;
  }

  /** Lays pages out at the current zoom (1 = fit width). */
  layout() {
    const avail = this.el.clientWidth - 2 * GAP;
    if (avail <= 0) return;
    let top = GAP;
    for (const p of this.pages) {
      p.width = Math.round(avail * this.zoom);
      p.height = Math.round((p.width * p.size[1]) / p.size[0]);
      p.top = top;
      Object.assign(p.div.style, { width: p.width + "px", height: p.height + "px", top: top + "px" });
      top += p.height + GAP;
    }
    this.inner.style.height = top + "px";
    this.inner.style.width = Math.max(...this.pages.map((p) => p.width), 0) + 2 * GAP + "px";
    // Pages already on screen get no new intersection event, so render them here.
    const from = this.el.scrollTop - this.el.clientHeight;
    const to = this.el.scrollTop + 2 * this.el.clientHeight;
    this.pages.forEach((p, i) => {
      if ((p.renderedAt && p.renderedAt !== p.width) || (p.top < to && p.top + p.height > from)) this.request(i);
    });
  }

  private queue = new Set<number>();
  private rendering = false;

  /**
   * Renders pages one at a time, always the one nearest the middle of the view
   * first, so after a long jump the page being looked at appears first. Pages
   * that have scrolled far away by their turn are dropped; they are requested
   * again if they come back into view.
   */
  private request(i: number) {
    this.queue.add(i);
    if (this.rendering) return;
    this.rendering = true;
    void (async () => {
      while (this.queue.size) {
        const mid = this.el.scrollTop + this.el.clientHeight / 2;
        const dist = (j: number) => Math.abs(this.pages[j].top + this.pages[j].height / 2 - mid);
        const next = [...this.queue].sort((a, b) => dist(a) - dist(b))[0];
        this.queue.delete(next);
        if (dist(next) < 3 * this.el.clientHeight) await this.render(next);
      }
      this.rendering = false;
    })();
  }

  private async render(i: number) {
    const p = this.pages[i];
    if (!p || p.renderedAt === p.width || !p.width) return;
    p.renderedAt = p.width;
    const dpr = window.devicePixelRatio || 1;
    const viewport = p.proxy.getViewport({ scale: (p.width * dpr) / p.size[0] });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    try {
      await p.proxy.render({ canvas, viewport }).promise;
    } catch (e) {
      p.renderedAt = 0;
      console.error(`page ${i + 1} failed to render`, e);
      return;
    }
    p.canvas.replaceWith(canvas);
    p.canvas = canvas;
  }

  /** Pixels per Marker unit on page i. */
  scale(i: number) {
    const p = this.pages[i];
    const w = this.markerSizes[i]?.[0] ?? p.size[0];
    return p.width / w;
  }

  /** Scroll-content y (px) of a Marker y on page i. */
  contentY(page: number, y: number) {
    const p = this.pages[Math.min(page, this.pages.length - 1)];
    return p ? p.top + y * this.scale(page) : 0;
  }

  /** The page and Marker y at a scroll-content y. */
  pointAt(contentY: number): { page: number; y: number } | null {
    if (!this.pages.length) return null;
    let i = this.pages.findIndex((p) => contentY < p.top + p.height + GAP / 2);
    if (i < 0) i = this.pages.length - 1;
    const p = this.pages[i];
    return { page: i, y: Math.max(0, contentY - p.top) / this.scale(i) };
  }

  /** Scrolls so Marker y on `page` sits `screenY` px from the top of the pane. Returns the new scrollTop. */
  align(page: number, y: number, screenY: number) {
    const top = Math.max(0, Math.round(this.contentY(page, y) - screenY));
    this.el.scrollTop = top;
    return this.el.scrollTop;
  }

  /**
   * Lets the user drag a box on a page and returns that part of the page as a
   * PNG (rendered at 3× PDF resolution, about 216 dpi), with its position in
   * Marker units for sync. Esc cancels.
   */
  capture(): Promise<{ page: number; bbox: [number, number, number, number]; png: string } | null> {
    return new Promise((resolve) => {
      this.el.classList.add("capturing");
      this.capturing = true;
      let start: { page: number; x: number; y: number; div: HTMLElement } | null = null;
      const box = document.createElement("div");
      box.className = "pdf-capture";
      const local = (div: HTMLElement, e: MouseEvent) => {
        const r = div.getBoundingClientRect();
        return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
      };
      const finish = (v: Awaited<ReturnType<PdfViewer["capture"]>>) => {
        this.el.classList.remove("capturing");
        setTimeout(() => (this.capturing = false), 0);
        box.remove();
        this.inner.removeEventListener("mousedown", down, true);
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mouseup", up, true);
        window.removeEventListener("keydown", key, true);
        resolve(v);
      };
      const down = (e: MouseEvent) => {
        const div = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
        if (!div) return;
        e.preventDefault();
        e.stopPropagation();
        const p = local(div, e);
        start = { page: Number(div.dataset.page), ...p, div };
        Object.assign(box.style, { left: p.x + "px", top: p.y + "px", width: "0", height: "0" });
        div.append(box);
      };
      const move = (e: MouseEvent) => {
        if (!start) return;
        const p = local(start.div, e);
        Object.assign(box.style, {
          left: Math.min(p.x, start.x) + "px",
          top: Math.min(p.y, start.y) + "px",
          width: Math.abs(p.x - start.x) + "px",
          height: Math.abs(p.y - start.y) + "px",
        });
      };
      const up = async (e: MouseEvent) => {
        if (!start) return;
        e.stopPropagation();
        const p = local(start.div, e);
        const [x0, x1] = [Math.min(p.x, start.x), Math.max(p.x, start.x)];
        const [y0, y1] = [Math.min(p.y, start.y), Math.max(p.y, start.y)];
        if (x1 - x0 < 5 || y1 - y0 < 5) {
          start = null;
          box.remove();
          return;
        }
        const i = start.page;
        const s = this.scale(i);
        const png = await this.renderCrop(i, [x0, y0, x1, y1]);
        finish({ page: i, bbox: [x0 / s, y0 / s, x1 / s, y1 / s], png });
      };
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      };
      this.inner.addEventListener("mousedown", down, true);
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", up, true);
      window.addEventListener("keydown", key, true);
    });
  }

  /** Renders a rectangle of page i (given in on-screen pixels) to PNG base64. */
  private async renderCrop(i: number, [x0, y0, x1, y1]: number[]) {
    const p = this.pages[i];
    const k = 3; // render scale relative to PDF points
    const pxToPt = p.size[0] / p.width;
    const viewport = p.proxy.getViewport({ scale: k });
    const full = document.createElement("canvas");
    full.width = Math.floor(viewport.width);
    full.height = Math.floor(viewport.height);
    await p.proxy.render({ canvas: full, viewport }).promise;
    const crop = document.createElement("canvas");
    const sx = x0 * pxToPt * k;
    const sy = y0 * pxToPt * k;
    crop.width = Math.round((x1 - x0) * pxToPt * k);
    crop.height = Math.round((y1 - y0) * pxToPt * k);
    crop.getContext("2d")!.drawImage(full, sx, sy, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return crop.toDataURL("image/png").split(",")[1];
  }

  /** Outlines the block's regions; the active one is stronger and gets a line marker at lineY. */
  highlight(regions: Region[], active: number, lineY: number | null) {
    for (const m of this.marks) m.remove();
    this.marks = [];
    regions.forEach((r, i) => {
      const p = this.pages[r.page];
      if (!p) return;
      const s = this.scale(r.page);
      const [x0, y0, x1, y1] = r.bbox;
      const box = document.createElement("div");
      box.className = "pdf-box" + (i === active ? " active" : "");
      Object.assign(box.style, {
        left: x0 * s - 3 + "px",
        top: y0 * s - 3 + "px",
        width: (x1 - x0) * s + 6 + "px",
        height: (y1 - y0) * s + 6 + "px",
      });
      p.div.append(box);
      this.marks.push(box);
      if (i === active && lineY !== null) {
        const line = document.createElement("div");
        line.className = "pdf-line";
        Object.assign(line.style, { left: x0 * s - 8 + "px", top: (lineY - 6) * s + "px", height: 12 * s + "px" });
        p.div.append(line);
        this.marks.push(line);
      }
    });
  }
}
