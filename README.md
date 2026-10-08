# Movable Typo

*Movable type, for the readings at typo.codes: turns a fixed PDF back into text you can move, correct and translate.*

Turns a PDF reading into clean, plain HTML and Markdown, with the PDF beside the text so every correction can be checked against the original.

1. **New reading** (`⌘O`): choose a PDF. Marker converts it (accurate mode re-OCRs every page; a short article takes a few minutes).
2. **Correct** it next to the PDF. Wherever the cursor is, the PDF shows the same line, outlined.
3. **Reading details** (`⌘E`): title, author, year, source, URL.
4. **Export** (`⌘⇧E`): writes `<export folder>/<slug>/<slug>.html`, `.md` and `images/`.

Readings in progress are kept in `~/Documents/Movable Typo/<slug>/` and saved automatically. Folders, the Marker path and the Marker mode are set in Settings (`⌘,`).

## Setting up

Movable Typo is a Mac app. It does the OCR with [Marker](https://github.com/datalab-to/marker), which you install separately.

**1. Install Marker.** Marker is a Python program and needs Python 3.10 or later. The simplest way to install it on its own is with [pipx](https://pipx.pypa.io), here via [Homebrew](https://brew.sh):

```sh
brew install pipx
pipx ensurepath          # then open a new terminal window
pipx install marker-pdf
which marker_single      # note this path for step 3
```

The first conversion downloads Marker's models (a few gigabytes) into `~/.cache`, so it takes much longer than later ones. No graphics card is needed; on a Mac it runs on the CPU. Accurate mode takes roughly 15–25 seconds a page.

**2. Get the app.** Build it from source with `pnpm package` (see [Development](#development) for what that needs). When it finishes, a disk image opens: drag **Movable Typo** onto **Applications**. The app is not signed by Apple, so the first time you open it macOS will refuse; open **System Settings → Privacy & Security** and choose **Open Anyway**.

**3. Point it at Marker.** Open Settings (`⌘,`) and check the Marker path. It defaults to `~/.local/bin/marker_single`, where pipx puts it; if `which marker_single` printed something else, use that. (An app started from the Finder does not see your shell's `PATH`, which is why the full path is needed.) Set the export folder to where your readings live.

## Keyboard

`⌘/` lists every shortcut and `⌘K` finds any command by name. The main ones:

|                                                      | Anywhere                | Block mode      |
| ---------------------------------------------------- | ----------------------- | --------------- |
| Block mode on / back to typing                       | `Esc`                   | `Enter`         |
| Next / previous block                                | `⌥↓` `⌥↑`               | `j` `k`         |
| Next flagged block (page-break split, unlinked ref…) | `⌘]`                    | `n`             |
| Join with next block                                 | `⌘J`                    | `J`             |
| Make footnote (block or selection)                   | `⌘⇧F`                   | `f`             |
| Insert / relink a footnote ref                       | `⌘⇧N`                   |                 |
| Jump between ref and note                            | `⌘⇧J`                   | `t`             |
| Check footnotes                                      | `⌘⇧K`                   |                 |
| Exclude from export / delete                         | `⌘⇧X`                   | `x` / `d`       |
| Heading / subheading / paragraph / quote             | `⌘⌥2` `⌘⌥3` `⌘⌥0` `⌘⌥Q` | `2` `3` `p` `q` |
| Italic / bold                                        | `⌘I` `⌘B`               |                 |
| Insert image from a file / captured from the PDF     | `⌘⌥I` / `⌘⌥C`           | `m` / `M`       |
| Find and replace                                     | `⌘F`                    | `/`             |
| Apply / preview a suggested fix                      | `⌘⇧A` / `⌘⇧R`           |                 |
| Sync on/off, re-center                               | `⌘L`, `⌘⇧P`             |                 |

**Footnotes.** Notes found by Marker are collected at the end and linked to their refs automatically. Numbers come from the order of the refs, so they never go stale. `f` on unnumbered note text (a note that ran over the page break) adds it to the end of the last note on the previous page.

**Block quotes.** Indented paragraphs are marked as quotes on import (with a short attribution line right after one). `q` toggles a quote; consecutive quoted paragraphs export as one `<blockquote>`.

**Fix once, fix everywhere.** Correct a word (`tbe` → `the`) or italicize a title, and a bar asks "Apply that fix to N other places?". `⌘⇧R` previews every case before and after; `Space` skips one, `Enter` applies the rest.

**Converting again.** "Run Marker again" (in `⌘K`) asks which mode to use for that one run, warns that the text will be replaced, and keeps the reading details. The previous version is saved as `project.backup.json` in the reading's folder. Each run's mode is recorded in `marker/run.json` and shown in the status bar and the list of readings. Settings only choose the mode for new readings.

**Images.** If Marker missed a figure, `⌘⌥C` lets you drag a box around it in the PDF; it is captured at about 216 dpi. `⌘⌥I` adds one from a file. On an existing figure, both replace its image and keep the caption.

## Development

You need:

- **Xcode Command Line Tools**: `xcode-select --install`
- **Rust**, via [rustup](https://rustup.rs): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node.js** 20.19+ or 22.12+ (required by Vite 8), and **pnpm**
  (`corepack enable`, or see [pnpm.io](https://pnpm.io/installation))
- **Marker**, only to convert new PDFs in the app; the tests use saved Marker
  output and never run it.

The first `pnpm tauri dev` or `pnpm tauri build` compiles the Rust side, which takes a few minutes; later builds are quick. Before the first `pnpm test:e2e`, run `pnpm exec playwright install webkit` once.

```sh
pnpm install
pnpm tauri dev           # the app
pnpm dev                 # the interface alone in a browser, with a mock backend and the test fixture
pnpm test                # unit tests
pnpm test:e2e            # keyboard workflows in WebKit (Tauri's engine on macOS)
(cd src-tauri && cargo test)
pnpm tauri build         # Movable Typo.app and a .dmg in src-tauri/target/release/bundle/
pnpm package             # the same, then opens the .dmg to drag the app to Applications
```

The test fixture, in `test/fixtures/mitchell/`, is W. J. T. Mitchell, "Beyond comparison: Picture, text and method", *Interfaces* 5 (1994), pp. 13–38 ([doi:10.3406/inter.1994.932](https://doi.org/10.3406/inter.1994.932)), as published by Persée under a Creative Commons license, with Marker's accurate-mode output. It is a 27-page scan with 38 notes, a few of them broken across pages.

More fixtures can sit beside it as `test/fixtures/<name>/source.pdf` and `source/source.json` (copy them from a reading's folder after Marker has run). In the browser version, `?fixture=<name>` opens one.

The app icon is generated from `app-icon.png` with `pnpm tauri icon app-icon.png`.

To check the real app's backend end to end (it runs Marker in fast mode and touches only the folder you give it):

```sh
pnpm tauri dev --config '{"identifier":"codes.typo.movable-typo.selftest","build":{"devUrl":"http://localhost:5173/?selftest=/tmp/pt&pdf=/path/to/file.pdf"}}'
```

The report is written to `/tmp/pt/readings/selftest/selftest.md`. The separate identifier gives the test its own settings file, so it never touches the settings of the app you use.

### Layout

- `src-tauri/`: runs Marker and reads/writes files; nothing else
- `src/editor/`: document schema, Marker import, commands, footnotes, find/replace, correction prompts
- `src/sync.ts`: maps cursor ↔ PDF position and keeps the panes aligned
- `src/export/`: HTML and Markdown
- `src/workspace.ts`: the command table, keys, autosave and export

## License

Copyright © 2026 Tyler Paige. Movable Typo is **free to use but not open source**. It is licensed under the [PolyForm Strict License 1.0.0](LICENSE): anyone may use it at no cost for noncommercial purposes, including at schools,
universities and other educational or public institutions. Modifying it, redistributing it, or using it commercially is not permitted without permission.

Movable Typo does not include [Marker](https://github.com/datalab-to/marker); it runs the copy you install yourself, under Marker's own license terms. The app is built with Tauri, ProseMirror and pdf.js, which keep their own open-source licenses.
