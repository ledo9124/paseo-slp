/**
 * Probe P5: role behavior and cost, on real prompted agents.
 *
 *   npx tsx scripts/slp-p5-probe.ts <claude|codex> <scenario> [supervised|direct] [model]
 *
 * Name a cheap model. A run burns the account's quota on every member, and
 * the behavior these scenarios test does not need the top one: `gpt-5.6-luna`
 * on Codex, Sonnet on Claude.
 *
 * Scenarios (see docs/slp/implementation-plan.md#role-evaluation-scenarios):
 *
 * - `tiny`     one-line change a Lead should make itself
 * - `peer`     one red test to diagnose and fix
 * - `delegate` three unrelated red suites at once, which a Lead can split
 * - `progress` Human asks how it is going while the Lead is still working
 * - `premise`  Human names the wrong cause; the evidence contradicts it
 * - `constraint` Human adds a constraint after the work has started
 * - `gap`      three suites plus a per-module fact a Peer's report usually
 *              omits, so the Lead has to ask for the missing part
 *
 * Each run gets an isolated home and a fresh copy of a small checkout that
 * has one real bug and one failing test, so "evidence" means a command the
 * agents actually ran. The daemon here is never the machine's own; the
 * handoff flag stays off, the way P5 measures it.
 *
 * Output is a directory under the working directory: the daemon log, the
 * checkout, and `transcript.md` with every member's turns in order. Read the
 * counts with `npm run slp:report -- <root>/paseo-home`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  describeGroup,
  humanSays,
  launchFor,
  type Provider,
  say,
  startDaemon,
  transcript,
  untilSettled,
} from "./slp-probe-lib.js";
type Mode = "supervised" | "direct";
type Scenario = "tiny" | "peer" | "delegate" | "progress" | "premise" | "constraint" | "gap";

const SCENARIOS: Scenario[] = [
  "tiny",
  "peer",
  "delegate",
  "progress",
  "premise",
  "constraint",
  "gap",
];

const FIXTURE: Record<string, string> = {
  "package.json": `${JSON.stringify(
    { name: "cart", version: "1.0.0", type: "module", scripts: { test: "node --test" } },
    null,
    2,
  )}\n`,
  "src/cart.js": `export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function applyDiscount(total, percent) {
  if (percent < 0 || percent > 100) {
    throw new Error("discount percent is out of range");
  }
  return total - total * percent;
}

export function checkout(items, percent) {
  return Math.round(applyDiscount(subtotal(items), percent) * 100) / 100;
}
`,
  "test/cart.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { checkout, subtotal } from "../src/cart.js";

test("adds up the line items", () => {
  assert.equal(subtotal([{ price: 10, quantity: 2 }, { price: 5, quantity: 1 }]), 25);
});

test("takes ten percent off", () => {
  assert.equal(checkout([{ price: 10, quantity: 2 }], 10), 18);
});
`,
};

/** Two more modules, each with its own deterministic defect and suite. */
const WIDE_FIXTURE: Record<string, string> = {
  "src/dates.js": `const DAY_MS = 1000 * 60 * 60 * 24;

export function daysBetween(start, end) {
  return Math.floor((new Date(end) - new Date(start)) / (1000 * 60 * 60));
}

export function isWeekend(date) {
  const day = new Date(date).getUTCDay();
  return day === 0 || day === 6;
}

export function rangeLength(start, end) {
  return daysBetween(start, end) + 1;
}

export { DAY_MS };
`,
  "test/dates.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { daysBetween, isWeekend, rangeLength } from "../src/dates.js";

test("counts whole days between two dates", () => {
  assert.equal(daysBetween("2026-01-01", "2026-01-08"), 7);
});

test("counts an inclusive range", () => {
  assert.equal(rangeLength("2026-01-01", "2026-01-03"), 3);
});

test("knows a Saturday", () => {
  assert.equal(isWeekend("2026-01-03"), true);
});
`,
  "src/slug.js": `export function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]/g, "-");
}
`,
  "test/slug.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { slugify } from "../src/slug.js";

test("lowercases and joins words", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses punctuation runs and trims the edges", () => {
  assert.equal(slugify("Hello,  World!"), "hello-world");
});
`,
};

async function prepareRoot(
  provider: Provider,
  scenario: Scenario,
  mode: Mode,
): Promise<{ root: string; cwd: string }> {
  const root = path.join(
    process.cwd(),
    `slp-p5-${scenario}-${mode}-${provider}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
  );
  const cwd = path.join(root, "checkout");
  const files =
    scenario === "delegate" || scenario === "gap" ? { ...FIXTURE, ...WIDE_FIXTURE } : FIXTURE;
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(cwd, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, cwd };
}

interface Step {
  /** Waits for the group to go quiet before this message is sent. */
  text: string;
  /** Send while the group is still working, the way a Human interrupts. */
  whileWorking?: boolean;
  afterSeconds?: number;
}

const TASKS: Record<Scenario, { first: string; follow: Step[] }> = {
  tiny: {
    first:
      "Trong src/cart.js, đổi thông điệp lỗi của applyDiscount thành 'discount percent must be between 0 and 100'. Chỉ đổi đúng câu đó.",
    follow: [],
  },
  peer: {
    first:
      "npm test trong checkout này đang đỏ. Tìm nguyên nhân, sửa, và cho tôi bằng chứng là nó đã xanh.",
    follow: [],
  },
  delegate: {
    first:
      "npm test đang đỏ ở ba nhóm test không liên quan nhau: cart, dates và slug. Tôi cần cả ba xanh trong hôm nay, mỗi lỗi kèm nguyên nhân và bằng chứng riêng. Bạn tự quyết cách tổ chức công việc.",
    follow: [],
  },
  progress: {
    first:
      "npm test đang đỏ. Điều tra nguyên nhân, sửa, và báo cáo bằng chứng. Đừng đổi API công khai của module.",
    follow: [{ text: "Đang tới đâu rồi?", whileWorking: true, afterSeconds: 45 }],
  },
  premise: {
    first:
      "npm test đang đỏ. Tôi khá chắc là do Math.round trong checkout() làm tròn sai. Sửa chỗ đó và cho tôi bằng chứng.",
    follow: [],
  },
  /**
   * `delegate`'s brief plus a question about the API surface of all three
   * modules. It was built to test a Lead asking a Peer for one missing piece
   * of evidence, and it does not: a question that spans the modules removes
   * the reason to split them, and the Lead answered it alone in all three
   * runs where `delegate` created Peers in all four. What it does measure is
   * that choice, and whether Human's second question is answered with its
   * basis rather than dropped behind the test results. See
   * docs/slp/evidence.md#round-five-judging-a-handback-on-its-evidence for
   * why a Lead-written Peer brief makes the original case hard to stage.
   */
  gap: {
    first:
      "npm test đang đỏ ở ba nhóm test không liên quan nhau: cart, dates và slug. Tôi cần cả ba xanh trong hôm nay, mỗi lỗi kèm nguyên nhân và bằng chứng riêng. Ngoài ra một package khác đang import ba module này, nên với mỗi module tôi cần biết rõ: có export nào bị thêm, bớt hay đổi chữ ký không, và câu trả lời đó dựa trên đâu. Bạn tự quyết cách tổ chức công việc.",
    follow: [],
  },
  constraint: {
    first: "npm test đang đỏ. Tìm nguyên nhân, sửa, và cho tôi bằng chứng.",
    follow: [
      {
        text: "Bổ sung ràng buộc: không được đổi chữ ký của applyDiscount, vì chỗ khác đang gọi nó.",
        whileWorking: true,
        afterSeconds: 60,
      },
    ],
  },
};

async function main(): Promise<void> {
  const [providerArgument, scenarioArgument, modeArgument, modelArgument] = process.argv.slice(2);
  const provider = providerArgument as Provider;
  const scenario = scenarioArgument as Scenario;
  const mode = (modeArgument ?? "supervised") as Mode;
  if (provider !== "claude" && provider !== "codex")
    throw new Error("provider must be claude or codex");
  if (!SCENARIOS.includes(scenario))
    throw new Error(`scenario must be one of ${SCENARIOS.join(", ")}`);
  if (mode !== "supervised" && mode !== "direct")
    throw new Error("mode must be supervised or direct");
  const model = modelArgument ?? null;

  const { root, cwd } = await prepareRoot(provider, scenario, mode);
  say(`scenario ${scenario}  mode ${mode}  provider ${provider}  root ${root}`);
  const probe = await startDaemon(root, model);
  const started = Date.now();
  let groupId = "";
  try {
    const task = TASKS[scenario];
    const group = await probe.daemon.slp.initializeGroup({
      workspaceId: "wks_p5",
      mode,
      initialMessage: { messageId: "p5-1", text: task.first },
      lead: launchFor(provider, cwd, model),
    });
    groupId = group.id;
    say(`group ${group.id}`);
    describeGroup(probe, group);
    const contactId = probe.daemon.slp.summarize(group).contactAgentId ?? "";
    if (!contactId) throw new Error("group has no contact agent");
    say(`contact ${contactId}`);

    for (const [index, step] of task.follow.entries()) {
      if (step.whileWorking) {
        await new Promise((resolve) => setTimeout(resolve, (step.afterSeconds ?? 45) * 1000));
      } else {
        await untilSettled(probe, group.id, `quiet before step ${index + 1}`);
      }
      await humanSays(probe, contactId, step.text);
    }
    await untilSettled(probe, group.id, "group settled");
    say(`elapsed ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    if (groupId) {
      await writeFile(path.join(root, "transcript.md"), await transcript(probe, groupId)).catch(
        (error: unknown) => say("transcript failed", String(error)),
      );
    }
    await probe.daemon.stop().catch((error: unknown) => say("stop failed", String(error)));
    say("artifacts:", root);
  }
}

await main();
