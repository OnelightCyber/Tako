import { UploadCanvas } from "../src/upload/canvas";
import { UploadSeq } from "../src/upload/sequence";
import { State } from "../src/core/state";

State.droppedFile = { name: "rapport-q3.pdf", path: "C:/tmp/rapport-q3.pdf" };

const stage = document.getElementById("stage")!;
const clock = document.getElementById("clock")!;

const canvas = new UploadCanvas({
  ask: () => (clock.textContent = "ASK clicked"),
  cancel: () => (clock.textContent = "CANCEL clicked"),
});
canvas.el.classList.add("on");
canvas.el.style.position = "absolute";
canvas.el.style.left = "0";
stage.append(canvas.el);

const CYCLE = 12;
let start = performance.now();
let dropped = false;
UploadSeq.enterZone(520, 96);

function loop(now: number) {
  let t = (now - start) / 1000;
  if (t >= CYCLE) {
    start = now;
    t = 0;
    dropped = false;
    UploadSeq.enterZone(520, 96);
  }
  if (!dropped) {
    const x = 520 - Math.min(1, t / 0.9) * 260;
    UploadSeq.updateCursor(x, 96);
    if (t >= 1.2) {
      dropped = true;
      UploadSeq.performDrop(2.4);
    }
  }
  canvas.draw(UploadSeq.frame(), now / 1000);
  clock.textContent = `t = ${t.toFixed(2)} s${dropped ? "  (dropped)" : "  (dragging)"}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
