import { Hud, ago, type HudShown } from "../core/hud";
import { h, clear } from "../views/dom";
import { proIcon } from "../views/pro-icons";

export const HUD_SIZES = {
  simple: { w: 330, h: 38 },
  rich: { w: 410, h: 50 },
  banner: { w: 460, h: 78 },
} as const;

const BANNER_MIN = 62;
const BANNER_MAX = 104;

export function hudSize(spec: HudShown): { w: number; h: number } {
  if (spec.banner) {
    const h = spec.height ? Math.max(BANNER_MIN, Math.min(BANNER_MAX, spec.height)) : HUD_SIZES.banner.h;
    return { w: HUD_SIZES.banner.w, h };
  }
  if (spec.detail || spec.actions?.length) return HUD_SIZES.rich;
  return HUD_SIZES.simple;
}

function numeric(text: string): boolean {
  return /^[\d\s,.%:+\-−°]+$/.test(text.replace(/ /g, " "));
}

export class HudLayer {
  readonly el: HTMLElement;
  private inner: HTMLElement;
  private lead: HTMLElement;
  private body: HTMLElement;
  private top: HTMLElement;
  private title: HTMLElement;
  private detail: HTMLElement;
  private bar: HTMLElement;
  private fill: HTMLElement;
  private meta: HTMLElement;
  private actions: HTMLElement;
  private shownId = -1;
  private leadKey = "";
  private spec: HudShown | null = null;

  constructor() {
    this.lead = h("div", { class: "hud-lead" });
    this.top = h("div", { class: "hud-top" });
    this.title = h("div", { class: "hud-title" });
    this.detail = h("div", { class: "hud-detail" });
    this.body = h("div", { class: "hud-body" }, this.top, this.title, this.detail);
    this.fill = h("i");
    this.bar = h("div", { class: "hud-bar" }, this.fill);
    this.meta = h("div", { class: "hud-meta" });
    this.actions = h("div", { class: "hud-actions" });
    this.inner = h("div", { class: "hud-inner" }, this.lead, this.body, this.bar, this.meta, this.actions);
    this.el = h("div", { id: "hud" }, this.inner);
    this.el.addEventListener("mousedown", (e) => {
      const spec = this.spec;
      if (!spec) return;
      if ((e.target as HTMLElement).closest(".hud-actions")) {
        e.stopPropagation();
        return;
      }
      if (!spec.onClick) return;
      e.stopPropagation();
      spec.onClick();
      Hud.dismiss();
    });
    this.el.addEventListener("mouseenter", () => Hud.hold(true));
    this.el.addEventListener("mouseleave", () => Hud.hold(false));
  }

  sync(visible: boolean) {
    const spec = Hud.current;
    const on = visible && !!spec;
    this.el.classList.toggle("on", on);
    if (!spec) {
      this.spec = null;
      return;
    }
    if (spec.id === this.shownId && this.spec === spec) return;
    const fresh = spec.id !== this.shownId;
    this.shownId = spec.id;
    this.spec = spec;
    this.render(spec, fresh);
  }

  private render(spec: HudShown, fresh: boolean) {
    const kind = spec.banner ? "banner" : spec.detail || spec.actions?.length ? "rich" : "simple";
    const on = this.el.classList.contains("on");
    this.el.className = `hud-${kind}${on ? " on" : ""}${spec.pulse ? " hud-pulse" : ""}${spec.onClick ? " hud-click" : ""}`;
    this.el.style.setProperty("--hud", spec.tone);
    this.el.dataset.key = spec.key.split("-")[0];

    const leadKey = `${spec.image ?? ""}|${spec.icon ?? ""}|${spec.initials ?? ""}|${kind}`;
    if (leadKey !== this.leadKey) {
      this.leadKey = leadKey;
      clear(this.lead);
      if (spec.image && spec.image.startsWith("data:image/")) {
        this.lead.append(h("img", { src: spec.image, alt: "" }));
      } else if (spec.icon) {
        this.lead.append(proIcon(spec.icon, spec.banner ? 20 : 17, 2));
      } else {
        this.lead.append(h("span", { class: "hud-initials", text: spec.initials ?? "?" }));
      }
      this.lead.classList.toggle("avatar", !spec.icon || !!spec.image);
    }
    if (fresh) {
      this.el.classList.remove("hud-pop");
      void this.el.offsetWidth;
      this.el.classList.add("hud-pop");
    }

    clear(this.top);
    if (spec.banner) {
      this.top.append(h("span", { class: "hud-app", text: spec.meta ?? "" }), h("span", { class: "hud-time", text: ago(spec.at ?? Date.now()) }));
    }
    this.top.style.display = spec.banner ? "" : "none";
    this.title.textContent = spec.title;
    this.title.style.display = spec.title ? "" : "none";
    this.detail.textContent = spec.detail ?? "";
    this.detail.style.display = spec.detail ? "" : "none";
    this.body.style.display = spec.title || spec.detail || spec.banner ? "" : "none";

    const showBar = spec.value != null && !spec.banner;
    this.bar.style.display = showBar ? "" : "none";
    this.bar.classList.toggle("wide", showBar && !spec.title);
    if (showBar) this.fill.style.width = `${Math.round(Math.max(0, Math.min(1, spec.value ?? 0)) * 100)}%`;

    const meta = spec.banner ? "" : spec.meta ?? "";
    this.meta.textContent = meta;
    this.meta.style.display = meta ? "" : "none";
    this.meta.classList.toggle("word", !!meta && !numeric(meta));
    this.meta.style.color = spec.metaTone ?? "";

    clear(this.actions);
    for (const a of spec.actions ?? []) {
      const b = h("button", { class: a.primary ? "hud-btn primary" : "hud-btn", text: a.label });
      b.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        a.run();
        Hud.dismiss();
      });
      this.actions.append(b);
    }
    this.actions.style.display = spec.actions?.length ? "" : "none";

    if (spec.banner) {
      const id = spec.id;
      requestAnimationFrame(() => {
        if (this.spec?.id !== id) return;
        const style = getComputedStyle(this.inner);
        const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const needed = Math.ceil(Math.max(this.body.offsetHeight, this.lead.offsetHeight) + pad);
        Hud.measured(id, needed);
      });
    }
  }
}
