export type FsmState = "hidden" | "petit" | "home" | "tako";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  homeToPetitDelay = 15;

  petitToHiddenDelay = 60;

  greetAutoCollapseDelay = 0.6;

  greetHoverCollapseDelay = 10;

  pinned = false;

  keepCompact = false;

  suppressed = false;

  hold: (() => boolean) | null = null;

  homeHold: (() => boolean) | null = null;

  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;

  launch() {
    this.cancelTimers();
    this.transition("tako");
  }

  setKeepCompact(on: boolean) {
    if (this.keepCompact === on) return;
    this.keepCompact = on;
    if (on && this.state === "hidden" && !this.suppressed) {
      this.cancelTimers();
      this.transition("petit");
    } else if (!on && this.state === "petit") {
      this.schedulePetitHide();
    }
  }

  setSuppressed(on: boolean) {
    if (this.suppressed === on) return;
    this.suppressed = on;
    if (on) {
      this.cancelTimers();
      this.transition("hidden");
    } else if (this.keepCompact && this.state === "hidden") {
      this.transition("petit");
    }
  }

  mouseEntered() {
    if (this.suppressed) return;
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition("petit");
        break;
      case "petit":
        this.clear("petitHide");
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "tako":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  mouseLeft() {
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        this.scheduleHomeCollapse();
        break;
      case "tako":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  click() {
    if (this.state !== "petit" || this.suppressed) return;
    this.cancelTimers();
    this.transition("home");
  }

  greetComplete() {
    if (this.state !== "tako") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  reveal() {
    if (this.state !== "hidden" || this.suppressed) return;
    this.cancelTimers();
    this.transition("petit");
    this.schedulePetitHide();
  }

  forceHome() {
    if (this.suppressed) return;
    this.cancelTimers();
    this.transition("home");
  }

  forcePetit() {
    if (this.suppressed) return;
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  private schedulePetitHide() {
    this.clear("petitHide");
    this.petitHide = window.setTimeout(() => this.tryHide(), this.petitToHiddenDelay * 1000);
  }

  private tryHide() {
    this.petitHide = null;
    if (this.state !== "petit" || this.keepCompact) return;
    if (this.hold?.()) {
      this.petitHide = window.setTimeout(() => this.tryHide(), 1500);
      return;
    }
    this.transition("hidden");
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    if (this.pinned) return;
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      if (this.state !== "home") return;
      if (this.homeHold?.()) this.waitHomeHold();
      else this.transition("petit");
    }, this.homeToPetitDelay * 1000);
  }

  private waitHomeHold() {
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      if (this.state !== "home") return;
      if (this.homeHold?.()) this.waitHomeHold();
      else this.scheduleHomeCollapse();
    }, 1500);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "tako") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "greetCollapse") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
  }

  cancelTimers() {
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
