import { h } from "../views/dom";
import { proIcon, type ProIconName } from "../views/pro-icons";

export type Tone = "orange" | "pink" | "blue" | "green" | "purple" | "amber" | "cyan" | "red" | "gray" | "indigo";

type Kid = Node | string | null | undefined | false;

export function tile(icon: ProIconName, tone: Tone, size = 30): HTMLElement {
  const el = h("span", { class: `tile t-${tone}` }, proIcon(icon, Math.round(size * 0.53), 2));
  el.style.setProperty("--s", `${size}px`);
  return el;
}

export function toggle(on: boolean, onChange: (v: boolean) => void, disabled = false): HTMLButtonElement {
  const el = h("button", { class: on ? "switch on" : "switch", role: "switch", "aria-checked": on, type: "button" }, h("i")) as HTMLButtonElement;
  if (disabled) el.disabled = true;
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    el.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  return el;
}

export function segmented<T extends string>(options: { value: T; label: string; hint?: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const el = h("div", { class: "seg", role: "radiogroup" });
  const thumb = h("i", { class: "seg-thumb" });
  el.append(thumb);
  const buttons = options.map((o) => {
    const b = h("button", { type: "button", class: o.value === value ? "on" : "", title: o.hint ?? "" }, h("span", { text: o.label }));
    b.addEventListener("click", () => {
      if (b.classList.contains("on")) return;
      for (const x of buttons) x.classList.toggle("on", x === b);
      place();
      onChange(o.value);
    });
    el.append(b);
    return b;
  });
  const place = () => {
    const on = buttons.find((b) => b.classList.contains("on"));
    if (!on || !on.offsetWidth) return;
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  };
  requestAnimationFrame(() => {
    place();
    requestAnimationFrame(() => el.classList.add("ready"));
  });
  new ResizeObserver(place).observe(el);
  return el;
}

export function slider(opts: {
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onInput?: (v: number) => void;
  onChange: (v: number) => void;
}): HTMLElement {
  const input = h("input", { type: "range", min: String(opts.min), max: String(opts.max), step: String(opts.step), value: String(opts.value) }) as HTMLInputElement;
  const label = h("span", { class: "range-value" });
  const paint = () => {
    const v = Number(input.value);
    label.textContent = opts.format(v);
    input.style.setProperty("--p", `${((v - opts.min) / (opts.max - opts.min)) * 100}%`);
  };
  paint();
  input.addEventListener("input", () => {
    paint();
    opts.onInput?.(Number(input.value));
  });
  input.addEventListener("change", () => opts.onChange(Number(input.value)));
  return h("div", { class: "range" }, input, label);
}

export function button(label: string, kind: "primary" | "ghost" | "danger" | "soft" | "", onClick: () => void, icon?: ProIconName): HTMLButtonElement {
  const el = h("button", { type: "button", class: `btn ${kind}`.trim() }, icon ? proIcon(icon, 15, 2) : null, label ? h("span", { text: label }) : null) as HTMLButtonElement;
  el.addEventListener("click", onClick);
  return el;
}

export function testButton(onClick: () => void, label = "Tester"): HTMLButtonElement {
  const b = button(label, "soft", () => {
    onClick();
    b.classList.remove("fired");
    void b.offsetWidth;
    b.classList.add("fired");
  }, "play");
  b.classList.add("small");
  return b;
}

export function pill(kind: "ok" | "warn" | "off" | "info", text: string): HTMLElement {
  return h("span", { class: `pill ${kind}` }, h("i"), h("span", { text }));
}

export function inline(...kids: Kid[]): HTMLElement {
  return h("div", { class: "inline" }, ...kids);
}

export function row(opts: { icon?: ProIconName; tone?: Tone; title: string; desc?: string | null; control?: Node | null; keywords?: string; wide?: boolean }): HTMLElement {
  const el = h(
    "div",
    { class: opts.wide ? "row wide" : "row" },
    opts.icon ? tile(opts.icon, opts.tone ?? "gray") : null,
    h("div", { class: "row-text" }, h("div", { class: "row-title", text: opts.title }), opts.desc ? h("div", { class: "row-desc", text: opts.desc }) : null),
    opts.control ? h("div", { class: "row-control" }, opts.control) : null,
  );
  el.dataset.search = `${opts.title} ${opts.desc ?? ""} ${opts.keywords ?? ""}`.toLowerCase();
  el.dataset.title = opts.title;
  return el;
}

export function group(head: { title?: string; icon?: ProIconName; tone?: Tone; right?: Node | null; note?: string } | null, ...kids: Kid[]): HTMLElement {
  const el = h("section", { class: "group" });
  if (head?.title) el.dataset.title = head.title;
  if (head && (head.title || head.right)) {
    el.append(h("div", { class: "group-head" },
      h("div", { class: "group-title" }, head.icon ? tile(head.icon, head.tone ?? "gray", 22) : null, head.title ? h("h3", { text: head.title }) : null),
      head.right ?? null,
    ));
  }
  if (head?.note) el.append(h("p", { class: "group-note", text: head.note }));
  const body = h("div", { class: "group-body" }, ...kids);
  el.append(body);
  return el;
}

export function pageHead(icon: ProIconName, tone: Tone, title: string, subtitle: string): HTMLElement {
  return h("header", { class: "page-head" }, tile(icon, tone, 44), h("div", {}, h("h1", { text: title }), h("p", { text: subtitle })));
}

export function notice(kind: "warn" | "ok" | "err" | "info", text: string): HTMLElement {
  const icon: ProIconName = kind === "ok" ? "check" : kind === "err" ? "x" : kind === "warn" ? "bolt" : "info";
  return h("div", { class: `notice ${kind}` }, proIcon(icon, 14, 2.2), h("span", { text }));
}

export function kv(pairs: [string, string][]): HTMLElement {
  const el = h("div", { class: "kv" });
  for (const [k, v] of pairs) el.append(h("span", { text: k }), h("code", { text: v || "—" }));
  return el;
}

export function field(opts: { value: string; placeholder: string; secret?: boolean; button: string; onSubmit: (v: string) => void | Promise<void> }): { el: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: opts.secret ? "password" : "text", placeholder: opts.placeholder, autocomplete: "off", spellcheck: "false", value: opts.value }) as HTMLInputElement;
  const go = button(opts.button, "", () => void opts.onSubmit(input.value.trim()));
  go.classList.add("small");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void opts.onSubmit(input.value.trim());
  });
  return { el: h("div", { class: "field" }, input, go), input };
}

export function whenShown(el: Element, run: () => void) {
  requestAnimationFrame(() => {
    if (el.isConnected) run();
  });
}

export function chip(icon: ProIconName, text: string, kind: "" | "warn" = ""): HTMLElement {
  return h("span", { class: `chip ${kind}`.trim() }, proIcon(icon, 13, 2), h("span", { text }));
}
