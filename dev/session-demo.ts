import { handleHook, type HookPayload } from "../src/island/hooks";
import type { Island } from "../src/island/island";
import { State } from "../src/core/state";

const CWD = "C:\\Users\\dev\\projects\\korus";
const FILE = `${CWD}\\src\\invoice.ts`;

const INVOICE = [
  "import { Item } from './types'",
  "",
  "// VAT rate applied to every invoice line",
  "const TVA = 0.196",
  "",
  "export function total(items: Item[]) {",
  "  const sum = items.reduce((s, i) => s + i.price, 0)",
  "  return sum * (1 + TVA)",
  "}",
].join("\n");

const base = { session_id: "demo", cwd: CWD };

const steps: [number, HookPayload][] = [
  [0, { ...base, hook_event_name: "SessionStart" }],
  [400, { ...base, hook_event_name: "UserPromptSubmit", prompt: "Set VAT to 20%, round the total to the cent and run the tests" }],
  [1600, { ...base, hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_use_id: "t1", tool_input: { todos: [
    { content: "Set VAT to 20%", status: "in_progress", activeForm: "x" },
    { content: "Round the total to the cent", status: "pending", activeForm: "x" },
    { content: "Run the tests", status: "pending", activeForm: "x" },
  ] } }],
  [300, { ...base, hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_use_id: "t1", tool_response: {} }],
  [1400, { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: FILE } }],
  [500, { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "r1", tool_response: {
    type: "text", file: { filePath: FILE, content: INVOICE, numLines: 9, startLine: 1, totalLines: 9 },
  } }],
  [2600, { ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "e1", tool_input: {
    file_path: FILE,
    old_string: "const TVA = 0.196",
    new_string: "const TVA = 0.20 // 2026",
  } }],
  [1500, { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e1", tool_response: {
    filePath: FILE,
    structuredPatch: [{ oldStart: 1, oldLines: 7, newStart: 1, newLines: 7, lines: [
      " import { Item } from './types'", " ", " // VAT rate applied to every invoice line",
      "-const TVA = 0.196", "+const TVA = 0.20 // 2026", " ", " export function total(items: Item[]) {",
    ] }],
  } }],
  [2200, { ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "e2", tool_input: {
    file_path: FILE,
    old_string: "  return sum * (1 + TVA)",
    new_string: "  return Math.round(sum * (1 + TVA) * 100) / 100",
  } }],
  [1400, { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "e2", tool_response: {
    filePath: FILE,
    structuredPatch: [{ oldStart: 5, oldLines: 5, newStart: 5, newLines: 5, lines: [
      " ", " export function total(items: Item[]) {", "   const sum = items.reduce((s, i) => s + i.price, 0)",
      "-  return sum * (1 + TVA)", "+  return Math.round(sum * (1 + TVA) * 100) / 100", " }",
    ] }],
  } }],
  [2200, { ...base, hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_use_id: "b1", tool_input: { command: "npm test", description: "Run the test suite" } }],
  [2400, { ...base, hook_event_name: "PostToolUse", tool_name: "PowerShell", tool_use_id: "b1", tool_response: {
    stdout: "> korus@1.4.0 test\n> vitest run\n\n ✓ tests/invoice.test.ts (12 tests) 3ms\n   ✓ applies 20% VAT\n   ✓ rounds the total to the cent\n   ✓ handles an empty cart\n ✓ tests/cart.test.ts (36 tests) 9ms\n ✓ tests/discount.test.ts (8 tests) 2ms\n ✓ tests/shipping.test.ts (14 tests) 4ms\n ✓ tests/currency.test.ts (6 tests) 1ms\n\n Test Files  5 passed (5)\n      Tests  76 passed (76)\n   Start at  14:02:11\n   Duration  412ms (transform 96ms, setup 0ms, collect 210ms, tests 19ms)",
    stderr: "", interrupted: false,
  } }],
  [1800, { ...base, hook_event_name: "Stop" }],
];

const STOPS: Record<string, number> = { plan: 3, read: 5, edit: 6, diff: 9, shell: 11, done: 12 };

export function runSessionDemo(island: Island) {
  const until = STOPS[new URLSearchParams(location.search).get("until") ?? ""] ?? steps.length - 1;
  State.isPinned = true;
  let t = 4200;
  window.setTimeout(() => island.alert("session"), t);
  steps.slice(0, until + 1).forEach(([delay, payload]) => {
    t += delay;
    window.setTimeout(() => handleHook(island, payload), t);
  });
}
