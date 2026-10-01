import { Bridge, onEvent, type BtEvent, type GameState, type VpnEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Timer } from "../core/timer";
import type { Island } from "./island";

export function registerLive(island: Island) {
  Timer.restore();
  Timer.onFinish = () => {
    Sound.play("finish", true);
    window.setTimeout(() => Sound.play("approve", true), 650);
    if (State.pendingApproval) return;
    State.isPinned = true;
    island.alert("timer");
    window.setTimeout(() => {
      if (State.view !== "timer") return;
      State.isPinned = false;
      island.dropPin();
    }, 20_000);
  };

  void onEvent<GameState>("game-mode", (g) => island.setGameMode(g.active, g.app));
  void Bridge.gameStatus().then((g) => {
    if (g?.active) island.setGameMode(true, g.app);
  });

  void onEvent<VpnEvent>("vpn", (e) => {
    if (State.paused) return;
    State.vpnEvent = e;
    Sound.play(e.kind === "up" ? "approve" : "error", e.kind !== "up");
    if (State.pendingApproval) {
      State.notify();
      return;
    }
    if (e.kind !== "up") State.isPinned = true;
    island.alert("vpn");
    State.notify();
  });

  void onEvent<BtEvent>("bluetooth", (e) => {
    if (State.paused || !e.connected) return;
    if (State.mode === "expanded" && !e.test) return;
    if (State.pendingApproval) return;
    State.btEvent = e;
    Sound.play("pop");
    island.alert("bluetooth");
    State.notify();
  });

  void onEvent<BtEvent>("bluetooth-battery", (e) => {
    if (State.btEvent?.address !== e.address) return;
    State.btEvent = e;
    State.notify();
  });
}
