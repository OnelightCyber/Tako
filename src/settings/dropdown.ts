import { h, clear } from "../views/dom";
import { proIcon, type ProIconName } from "../views/pro-icons";

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
  icon?: ProIconName;
}

let closeCurrent: (() => void) | null = null;

export function closeDropdowns() {
  closeCurrent?.();
}

function chevron(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", "14");
  el.setAttribute("height", "14");
  el.setAttribute("class", "dd-chevron");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M6 9l6 6 6-6");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "2");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  el.append(p);
  return el;
}

export function dropdown<T extends string>(choices: Choice<T>[], value: T, onChange: (v: T) => void): HTMLButtonElement {
  let current = value;
  const lead = h("span", { class: "dd-lead" });
  const label = h("span", { class: "dd-label" });
  const btn = h("button", { class: "dd", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" }, lead, label, chevron()) as HTMLButtonElement;

  const paint = () => {
    const choice = choices.find((c) => c.value === current);
    label.textContent = choice?.label ?? current;
    clear(lead);
    if (choice?.icon) lead.append(proIcon(choice.icon, 15));
    lead.hidden = !choice?.icon;
  };
  paint();

  const openMenu = () => {
    closeCurrent?.();
    let active = Math.max(0, choices.findIndex((c) => c.value === current));
    const menu = h("div", { class: "dd-menu", role: "listbox" });
    const items = choices.map((c, i) => {
      const item = h(
        "div",
        { class: `dd-item${c.value === current ? " selected" : ""}`, role: "option" },
        c.icon ? h("span", { class: "dd-item-icon" }, proIcon(c.icon, 15)) : null,
        h("div", { class: "dd-item-text" }, h("span", { text: c.label }), c.hint ? h("small", { text: c.hint }) : null),
        h("span", { class: "dd-check" }, proIcon("check", 14, 2.4)),
      );
      item.addEventListener("pointermove", () => setActive(i));
      item.addEventListener("click", () => choose(c.value));
      return item;
    });
    const setActive = (i: number) => {
      active = i;
      items.forEach((el, j) => el.classList.toggle("active", j === i));
    };
    menu.append(...items);
    setActive(active);
    document.body.append(menu);

    const r = btn.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(r.width, 220)}px`;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const below = window.innerHeight - r.bottom - 10;
    const up = below < height && r.top > below;
    menu.style.top = `${up ? Math.max(8, r.top - height - 6) : r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
    menu.classList.toggle("up", up);
    btn.classList.add("open");
    btn.setAttribute("aria-expanded", "true");

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        btn.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose(choices[active].value);
      } else if (e.key === "Tab") {
        close();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.contains(target) && !btn.contains(target)) close();
    };
    const onScroll = (e: Event) => {
      if (!menu.contains(e.target as Node)) close();
    };
    const close = () => {
      if (closeCurrent === close) closeCurrent = null;
      menu.classList.add("leaving");
      window.setTimeout(() => menu.remove(), 120);
      btn.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
    const choose = (v: T) => {
      close();
      btn.focus();
      if (v === current) return;
      current = v;
      paint();
      onChange(v);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    closeCurrent = close;
  };

  btn.addEventListener("click", () => (btn.classList.contains("open") ? closeCurrent?.() : openMenu()));
  btn.addEventListener("keydown", (e) => {
    if (btn.classList.contains("open")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu();
    }
  });
  return btn;
}
