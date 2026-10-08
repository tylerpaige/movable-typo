// Keyboard workflows on the test fixture: W. J. T. Mitchell, "Beyond
// Comparison" (27 pages, 38 notes; Creative Commons).
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto("/");
  await page.locator(".projects li").first().waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".pdf-page canvas").first().waitFor();
  await page.waitForTimeout(500);
}

const status = (page: Page) => page.locator("#status");
const blockText = (page: Page) =>
  page.evaluate(() => {
    const node = getSelection()?.anchorNode;
    const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
    const sel = document.querySelector(".ProseMirror-selectednode") ?? el?.closest("p,h2,h3,h4");
    return sel?.textContent ?? "";
  });

const countWord = (page: Page, re: string) =>
  page.evaluate((r) => (document.querySelector(".ProseMirror")!.textContent!.match(new RegExp(r, "g")) ?? []).length, re);

async function findAndSelect(page: Page, text: string) {
  await page.keyboard.press("Meta+f");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
}

test("the PDF lines up with the cursor", async ({ page }) => {
  await open(page);
  const para = page.locator(".ProseMirror > p", { hasText: "One can and must, however, avoid the trap" });
  await para.scrollIntoViewIfNeeded();
  const box = (await para.boundingBox())!;
  await page.mouse.click(box.x + 150, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const [caret, line] = await page.evaluate(() => {
    const r = getSelection()!.getRangeAt(0).getClientRects()[0];
    const l = document.querySelector(".pdf-line")!.getBoundingClientRect();
    return [(r.top + r.bottom) / 2, (l.top + l.bottom) / 2];
  });
  expect(Math.abs(caret - line)).toBeLessThan(4);
  await expect(page.locator(".pdf-box.active")).toBeVisible();
});

test("block mode: jump to a page-break split and join it", async ({ page }) => {
  await open(page);
  // "…I was always struck by the" | page break | "oddness, the arbitrariness…"
  await findAndSelect(page, "always struck by the");
  await page.keyboard.press("Escape");
  await expect(status(page)).toContainText("BLOCK");
  const before = await blockText(page);
  expect(before).toMatch(/struck by the$/);
  await page.keyboard.press("Shift+J");
  const after = await blockText(page);
  expect(after.length).toBeGreaterThan(before.length + 20);
  expect(after.startsWith(before)).toBe(true);
  await page.keyboard.press("Meta+z");
  expect(await blockText(page)).toBe(before);
});

test("notes are found and linked; jump between ref and note", async ({ page }) => {
  await open(page);
  await expect(status(page)).toContainText("38 notes ·");
  await expect(status(page)).not.toContainText("to check");
  // "…the problem of the image-text.⁹" and note 9.
  await findAndSelect(page, "the problem of the image-text.");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Meta+Shift+j");
  await expect.poll(() => blockText(page)).toMatch(/^I will employ the typographic convention/);
  await page.keyboard.press("Meta+Shift+j");
  await expect.poll(() => blockText(page)).toMatch(/^oddness, the arbitrariness/);
});

test("a note's continuation on the next page joins its note with one key", async ({ page }) => {
  await open(page);
  await findAndSelect(page, "Heath, 86), the process");
  await page.keyboard.press("Escape");
  await page.keyboard.press("f");
  await expect(status(page)).toContainText("Added to the end of footnote 15");
  const note15 = await page.locator(".footnote").nth(14).innerText();
  expect(note15).toContain("quoted in Heath, 86), the process");
});

test("make a footnote from a paragraph, then add its ref", async ({ page }) => {
  await open(page);
  await findAndSelect(page, "Fichier pdf généré le 14/03/2023");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.type("39 A note typed by hand.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("f");
  await expect(status(page)).toContainText("no matching ref was found");
  await expect(status(page)).toContainText("39 notes, 1 to check");
  await expect(page.locator(".footnote").last()).toHaveText("A note typed by hand.");
  // Put a ref at the end of that line and link it to note 39.
  await findAndSelect(page, "Fichier pdf généré le 14/03/2023");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Meta+Shift+n");
  await page.keyboard.type("39");
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("39 notes ·");
  await expect(status(page)).not.toContainText("to check");
});

test("fixing a word offers to fix it everywhere", async ({ page }) => {
  await open(page);
  await findAndSelect(page, "Blake");
  const count = await countWord(page, "\\bBlake\\b");
  await page.keyboard.type("Blayk");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#suggest-bar")).toContainText(`Apply that fix to ${count - 1} other places?`);
  await expect(page.locator("#suggest-bar")).toContainText("“Blake” → “Blayk”");
  await page.keyboard.press("Meta+Shift+a");
  const left = await countWord(page, "\\bBlake\\b");
  expect(left).toBe(0);
  await expect(page.locator("#suggest-bar")).toBeHidden();
});

test("find and replace all from the keyboard", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+f");
  await page.keyboard.type("image/text");
  await expect(page.locator(".find-status")).toContainText(/of \d+/);
  await page.keyboard.press("Tab");
  await page.keyboard.type("IMAGE-TEXT");
  await page.keyboard.press("Meta+Enter");
  await expect(status(page)).toContainText("Replaced");
  await expect(page.locator(".find-status")).toHaveText("No matches");
  await page.keyboard.press("Escape");
  await expect(page.locator("#find-panel")).toBeHidden();
});

test("details, export and the result", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+e");
  const dialog = page.locator("dialog[open]");
  await dialog.locator('input[name="title"]').fill("Beyond Comparison: Picture, Text and Method");
  await dialog.locator('input[name="author"]').fill("W. J. T. Mitchell");
  await dialog.locator('input[name="year"]').fill("1994");
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("Beyond Comparison: Picture, Text and Method");
  await page.keyboard.press("Meta+Shift+e");
  await expect(status(page)).toContainText("Exported to /mock/readings/beyond_comparison_picture_text_and_method");
  const html = await page.evaluate(() => (window as unknown as { __exports: { html: string }[] }).__exports[0].html);
  expect(html).toContain('<meta name="author" content="W. J. T. Mitchell">');
  expect(html.match(/class="footnote"/g)).toHaveLength(38);
  expect(html.match(/class="reversefootnote"/g)).toHaveLength(38);
  expect(html).toContain('the problem of the image-text.<sup><a href="#fn9" id="fnr9" title="see footnote" class="footnote">9</a></sup>');
  // A second export asks before overwriting.
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.locator("dialog[open]")).toContainText("This will overwrite");
  await page.keyboard.press("Escape");
});

test("help and the command palette", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+/");
  await expect(page.locator("dialog[open]")).toContainText("Join with next block");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("zoom in");
  await page.keyboard.press("Enter");
  await expect(status(page)).toContainText("Zoom 115%");
});

test("previewing a fix shows each case and lets you skip some", async ({ page }) => {
  await open(page);
  await findAndSelect(page, "Blake");
  const count = await countWord(page, "\\bBlake\\b");
  await page.keyboard.type("Blayk");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Meta+Shift+r");
  const panel = page.locator("#preview-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("li")).toHaveCount(count - 1);
  await expect(panel.locator("li").first().locator("del")).toHaveText("Blake");
  await expect(panel.locator("li").first().locator("ins")).toHaveText("Blayk");
  // Skip the first two cases, apply the rest.
  await page.keyboard.press(" ");
  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  await expect(panel.locator("h3")).toContainText(`${count - 3} of ${count - 1} selected`);
  // With the panel open above the text, the PDF still lines up with the case on screen.
  const [sel, line] = await page.evaluate(() => {
    const r = document.querySelector(".find-current")!.getBoundingClientRect();
    const l = document.querySelector(".pdf-line")!.getBoundingClientRect();
    return [(r.top + r.bottom) / 2, (l.top + l.bottom) / 2];
  });
  expect(Math.abs(sel - line)).toBeLessThan(15);
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  expect(await countWord(page, "\\bBlake\\b")).toBe(2);
});

test("deleting a line break does not prompt", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("n");
  await page.keyboard.press("j");
  await page.keyboard.press("Enter"); // cursor at the start of the next block
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  await expect(page.locator("#suggest-bar")).toBeHidden();
});

test("block quotes: detected on import, toggled with q, exported as <blockquote>", async ({ page }) => {
  await open(page);
  await expect(page.locator(".ProseMirror p.quote").first()).toContainText("There is no link");
  // The stray end of note 15 is indented on the page, so it came in as a quote: q turns that off.
  const stray = page.locator(".ProseMirror p", { hasText: "Heath, 86), the process" });
  await expect(stray).toHaveClass(/quote/);
  await findAndSelect(page, "Heath, 86), the process");
  await page.keyboard.press("Escape");
  await page.keyboard.press("q");
  await expect(stray).not.toHaveClass(/quote/);
  // And the paragraph after the epigraph, on: it joins the epigraph's blockquote.
  await findAndSelect(page, "Gilles Deleuze has suggested");
  await page.keyboard.press("Escape");
  await page.keyboard.press("q");
  await page.keyboard.press("Meta+Shift+e");
  const html = await page.evaluate(async () => {
    for (let i = 0; i < 50 && !(window as any).__exports.length; i++) await new Promise((r) => setTimeout(r, 100));
    return (window as any).__exports[0].html as string;
  });
  expect(html).toMatch(/<blockquote>\n\t\t\t<p><em>There is no link[^]*?<\/p>\n\t\t\t<p>Gilles Deleuze, <em>Foucault<\/em>.<\/p>\n\t\t\t<p>Gilles Deleuze has suggested/);
  expect(html).toContain("\t\t<p>Heath, 86), the process");
});

test("insert an image from a file", async ({ page }) => {
  await open(page);
  const figures = await page.locator(".ProseMirror figure").count();
  await findAndSelect(page, "Gilles Deleuze has suggested");
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Meta+Alt+i");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await (await chooser).setFiles({ name: "fig.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".ProseMirror figure")).toHaveCount(figures + 1);
  await page.keyboard.type("Fig. 1");
  await expect(page.locator(".ProseMirror figure figcaption", { hasText: "Fig. 1" })).toHaveCount(1);
});

test("capture a figure from the PDF", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+Alt+c");
  await expect(page.locator("#status")).toContainText("Drag a box");
  const pg = page.locator(".pdf-page").first();
  const b = (await pg.boundingBox())!;
  // Inside the visible part of the page (sync may have scrolled its top away).
  const top = Math.max(b.y, 0) + 150;
  await page.mouse.move(b.x + 50, top);
  await page.mouse.down();
  await page.mouse.move(b.x + 250, top + 150, { steps: 5 });
  await page.mouse.up();
  const captured = page.locator('.ProseMirror figure img[src^="data:image/png"]');
  await expect(captured).toHaveCount(1);
  const size = await captured.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]);
  expect(size[0]).toBeGreaterThan(400); // rendered at higher resolution than the screen
  await expect(page.locator("#status")).toContainText("Figure captured");
});

test("run Marker again in another mode, with a warning, a backup and a record of the mode", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".projects li").first()).toContainText("accurate mode");
  await page.keyboard.press("Enter");
  await page.locator(".pdf-page canvas").first().waitFor();
  await expect(status(page)).toContainText("Marker: accurate");

  // An edit that the re-run will discard.
  await findAndSelect(page, "Gilles Deleuze has suggested");
  await page.keyboard.type("XYZZY ");
  await expect(page.locator(".ProseMirror")).toContainText("XYZZY");

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("run marker again");
  await page.keyboard.press("Enter");
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toContainText("converted in accurate mode");
  await expect(dialog).toContainText("will be lost");
  await expect(dialog.locator("button[type=submit]")).toHaveText("Run Marker");
  await dialog.locator("select").selectOption("fast");
  await page.keyboard.press("Enter");

  await expect(status(page)).toContainText("Converted again in fast mode");
  await expect(status(page)).toContainText("Marker: fast");
  await expect(page.locator(".ProseMirror")).not.toContainText("XYZZY");
  const [runs, backup] = await page.evaluate(() => {
    const w = window as unknown as { __markerRuns: string[]; __saved: Map<string, string> };
    return [w.__markerRuns, w.__saved.get("fixture.backup") ?? ""];
  });
  expect(runs).toEqual(["fast"]);
  expect(backup).toContain("XYZZY");
});

test("cancelling the re-run changes nothing", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("run marker again");
  await page.keyboard.press("Enter");
  await page.locator("dialog[open]").waitFor();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __markerRuns: string[] }).__markerRuns)).toEqual([]);
  await expect(status(page)).toContainText("Marker: accurate");
});
