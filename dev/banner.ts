import { blob } from "../src/settings/blob";
import { proIcon, type ProIconName } from "../src/views/pro-icons";

document.getElementById("blob")!.append(blob(150, { particles: true }));

const chips: [ProIconName, string][] = [
  ["code", "Live view"],
  ["chat", "No API key"],
  ["monitor", "Screen vision"],
  ["globe", "Browser agent"],
  ["slash", "Slash commands"],
];
const host = document.getElementById("chips")!;
for (const [icon, label] of chips) {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.append(proIcon(icon, 15, 2), document.createTextNode(label));
  host.append(chip);
}

window.dispatchEvent(new MouseEvent("mousemove", { clientX: 900, clientY: 150 }));
