// Small keyboard-first dialogs built on <dialog>, which gives Esc-to-close and
// focus trapping for free.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}
export { el };

function open<T>(build: (dlg: HTMLDialogElement, done: (v: T) => void) => void, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const dlg = el("dialog");
    document.body.append(dlg);
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener("close", () => done(fallback));
    // Keys pressed in a dialog never reach the editor's shortcuts.
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    build(dlg, done);
    dlg.showModal();
  });
}

export function prompt(label: string, initial = "", hint = ""): Promise<string | null> {
  return open<string | null>((dlg, done) => {
    const input = el("input", { type: "text", value: initial });
    const form = el("form", { method: "dialog" }, el("label", {}, label, input), hint ? el("p", { className: "hint" }, hint) : "");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done(input.value);
    });
    dlg.append(form);
    queueMicrotask(() => input.select());
  }, null);
}

export function confirm(message: string, ok = "OK"): Promise<boolean> {
  return open<boolean>((dlg, done) => {
    const yes = el("button", { type: "submit", textContent: ok });
    const no = el("button", { type: "button", textContent: "Cancel" });
    no.onclick = () => done(false);
    const form = el("form", { method: "dialog" }, el("p", {}, message), el("div", { className: "buttons" }, yes, no));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done(true);
    });
    dlg.append(form);
    queueMicrotask(() => yes.focus());
  }, false);
}

export function alertBox(title: string, body: string | Node): Promise<void> {
  return open<void>((dlg, done) => {
    const close = el("button", { type: "submit", textContent: "Close" });
    const form = el("form", { method: "dialog" }, el("h2", {}, title), typeof body === "string" ? el("p", {}, body) : body, close);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      done();
    });
    dlg.append(form);
    queueMicrotask(() => close.focus());
  }, undefined);
}

export interface Field {
  name: string;
  label: string;
  value: string;
  options?: { value: string; label: string }[];
  hint?: string;
}

/** A form of labelled text fields (or selects). Enter saves, Esc cancels. */
export function form(
  title: string,
  fields: Field[],
  opts: { intro?: string; submit?: string } = {},
): Promise<Record<string, string> | null> {
  return open<Record<string, string> | null>((dlg, done) => {
    const inputs = fields.map((f) => {
      if (f.options) {
        const s = el("select", { name: f.name });
        for (const o of f.options) s.append(el("option", { value: o.value, textContent: o.label, selected: o.value === f.value }));
        return s;
      }
      return el("input", { type: "text", name: f.name, value: f.value });
    });
    const rows = fields.map((f, i) => el("label", {}, f.label, inputs[i], f.hint ? el("span", { className: "hint" }, f.hint) : ""));
    const save = el("button", { type: "submit", textContent: opts.submit ?? "Save" });
    const cancel = el("button", { type: "button", textContent: "Cancel" });
    cancel.onclick = () => done(null);
    const intro = opts.intro ? el("p", { className: "intro" }, opts.intro) : "";
    const f = el("form", { method: "dialog", className: "fields" }, el("h2", {}, title), intro, ...rows, el("div", { className: "buttons" }, save, cancel));
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      done(Object.fromEntries(fields.map((fl, i) => [fl.name, inputs[i].value.trim()])));
    });
    dlg.append(f);
    queueMicrotask(() => (inputs[0] as HTMLInputElement).focus());
  }, null);
}

export interface Choice<T> {
  label: string;
  detail?: string;
  value: T;
}

/** A filterable list: type to narrow, ↑/↓ to move, Enter to choose. Used by the palette. */
export function choose<T>(title: string, items: Choice<T>[], placeholder = "Type to filter"): Promise<T | null> {
  return open<T | null>((dlg, done) => {
    const input = el("input", { type: "text", placeholder });
    const list = el("ul", { className: "choices" });
    let shown: Choice<T>[] = [];
    let sel = 0;
    const render = () => {
      const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      shown = items.filter((it) => q.every((w) => (it.label + " " + (it.detail ?? "")).toLowerCase().includes(w)));
      sel = Math.min(sel, Math.max(shown.length - 1, 0));
      list.replaceChildren(
        ...shown.map((it, i) => {
          const li = el("li", { className: i === sel ? "selected" : "" }, el("span", {}, it.label), it.detail ? el("kbd", {}, it.detail) : "");
          li.onclick = () => done(it.value);
          return li;
        }),
      );
      list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    };
    input.addEventListener("input", () => {
      sel = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) sel = Math.min(sel + 1, shown.length - 1);
      else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) sel = Math.max(sel - 1, 0);
      else if (e.key === "Enter") {
        e.preventDefault();
        if (shown[sel]) done(shown[sel].value);
        return;
      } else return;
      e.preventDefault();
      render();
    });
    dlg.append(el("h2", {}, title), input, list);
    dlg.className = "palette";
    render();
    queueMicrotask(() => input.focus());
  }, null);
}
