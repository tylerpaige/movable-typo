// One table of commands drives the key handling, the help overlay and the
// command palette, so they can never disagree.

export interface Cmd {
  id: string;
  label: string;
  group: string;
  /** Shortcuts that work anywhere in the workspace, e.g. "Mod-Shift-f". */
  keys?: string[];
  /** Single keys that work in block mode, e.g. "j", "Shift-j". */
  block?: string[];
  run: () => unknown;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);

const CODE_NAMES: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Slash: "/",
  Comma: ",",
  Period: ".",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
};

/**
 * A layout-independent name for a key press, like "Mod-Shift-f". Uses the
 * physical key so Alt combinations (which type symbols on a Mac) still match.
 */
export function keyName(e: KeyboardEvent): string {
  let base: string;
  if (/^Key[A-Z]$/.test(e.code)) base = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) base = e.code.slice(5);
  else if (CODE_NAMES[e.code]) base = CODE_NAMES[e.code];
  else base = e.key;
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (isMac && e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, base].join("-");
}

const SYMBOLS: Record<string, string> = isMac
  ? { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃", Enter: "↩", Escape: "Esc", ArrowDown: "↓", ArrowUp: "↑", Backspace: "⌫" }
  : { Mod: "Ctrl+", Shift: "Shift+", Alt: "Alt+", Ctrl: "Ctrl+", Enter: "Enter", Escape: "Esc", ArrowDown: "↓", ArrowUp: "↑" };

export function displayKey(k: string) {
  let parts = k.split("-");
  // "Mod--" means Mod plus the minus key.
  if (k.endsWith("--")) parts = [...k.slice(0, -2).split("-").filter(Boolean), "-"];
  const base = parts.pop()!;
  // In block mode Shift-j reads better as "J".
  if (parts.length === 1 && parts[0] === "Shift" && base.length === 1) return base.toUpperCase();
  const shown = base.length === 1 ? base.toUpperCase() : (SYMBOLS[base] ?? base);
  return parts.map((p) => SYMBOLS[p] ?? p).join("") + shown;
}

export function index(cmds: Cmd[]) {
  const keys = new Map<string, Cmd>();
  const block = new Map<string, Cmd>();
  for (const c of cmds) {
    for (const k of c.keys ?? []) {
      if (keys.has(k)) console.warn(`duplicate key ${k}: ${c.id} / ${keys.get(k)!.id}`);
      keys.set(k, c);
    }
    for (const k of c.block ?? []) block.set(k, c);
  }
  return { keys, block };
}
