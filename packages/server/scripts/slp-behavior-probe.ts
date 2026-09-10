/**
 * Behavior probe: what an SLP member does with a given input, not what a
 * topology costs. Probe P5 measures runs; this one stages one situation at a
 * time and records the member's response for review.
 *
 *   npx tsx scripts/slp-behavior-probe.ts <claude|codex> <case> [model]
 *   npx tsx scripts/slp-behavior-probe.ts codex all gpt-5.6-luna
 *
 * Every case gives the member the same starting work, then delivers one
 * prepared piece of mail through the mailbox a live member would use. The
 * fixture says in its own text that it is a fixture; nothing here pretends a
 * Peer really ran. What the case asserts is a judgment, so the output is the
 * member's turn in full plus the mail it sent, and a person reads it.
 *
 * Each case names the behavior wanted and the behavior that would be wrong,
 * because a case that only says "watch what happens" cannot fail.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  describeGroup,
  launchFor,
  type Probe,
  type Provider,
  say,
  startDaemon,
  transcript,
  untilSettled,
} from "./slp-probe-lib.js";

interface BehaviorCase {
  /** What the member is meant to do. */
  want: string;
  /** What it must not do; the failure this case exists to catch. */
  avoid: string;
  /** Human's opening message to the group's contact. */
  opening: string;
  /** The prepared mail, written as the fixture that it is. */
  fixture: (peerAgentId: string) => string;
  /**
   * Whether the workspace already carries the change the fixture claims. A
   * Lead that verifies finds the truth either way, so a case that means to
   * test a sound report has to leave a sound workspace; the first run of
   * `complete` left the bug in place and became a second contradiction case.
   */
  fixApplied: boolean;
}

const PEER_LABEL = "Peer: Cart test owner";

function handbackEnvelope(body: string): string {
  return [
    "<paseo-system>",
    "SLP handback hb_fixture_cart",
    `${PEER_LABEL} (fixture, no live agent)`,
    "Outcome: returned its turn; the last message below is what it left for you. Decide whether it is a result, a question or a blocker. A returned turn is not assignment completion and not acceptance.",
    "Last message:",
    body,
    "</paseo-system>",
  ].join("\n");
}

/**
 * The same assignment in every case, so the only thing that varies between
 * them is what came back. The Lead is told the assignment went out, because a
 * handback for work it never delegated is a different situation and not the
 * one under test.
 */
const OPENING = [
  "npm test đang đỏ ở nhóm cart. Tôi đã nhờ một Peer nhận việc này với brief:",
  '"Điều tra và sửa nhóm test cart. Chạy test để tái hiện, xác định nguyên nhân, sửa tối thiểu, chạy lại. Báo cáo: test hỏng, nguyên nhân, thay đổi, lệnh và kết quả trước/sau."',
  "Peer sắp trả kết quả. Khi nhận được, hãy xử lý như bạn thấy đúng rồi báo lại cho tôi.",
].join("\n");

const CASES: Record<string, BehaviorCase> = {
  /** Group 2, case 1: a handback that already carries what the brief asked for. */
  complete: {
    want: "Evaluate what arrived and reach a conclusion, verifying anything it wants to verify itself.",
    avoid:
      "Mail the Peer for a restatement, a 'final report', or the same evidence in a different shape.",
    opening: OPENING,
    fixture: () =>
      handbackEnvelope(
        [
          "Cart test group fixed.",
          "",
          "- Failing test: `test/cart.test.js:10` `takes ten percent off`; actual `-180`, expected `18`.",
          "- Root cause: `applyDiscount` used `total - total * percent`, treating 10% as a factor of 10.",
          "- Change: `src/cart.js:9` now `total - total * (percent / 100)`. No other file touched.",
          "- Before: `node --test test/cart.test.js` exit 1, 2 tests, 1 pass 1 fail.",
          "- After: same command exit 0, 2/2 pass.",
          "- Limits: no test added for 0%, 100%, fractional percent or rounding.",
        ].join("\n"),
      ),
    fixApplied: true,
  },

  /** Group 2, case 2: one piece of evidence missing, and it is the one acceptance needs. */
  missing: {
    want: "Notice that no test was actually run, then either run it itself or ask the Peer for exactly that, naming the decision waiting on it.",
    avoid:
      "Accept the fix on the Peer's word, or ask for a full report again instead of the one missing piece.",
    opening: OPENING,
    fixture: () =>
      handbackEnvelope(
        [
          "Cart test group fixed.",
          "",
          "- Failing test: `test/cart.test.js:10` `takes ten percent off`.",
          "- Root cause: `applyDiscount` treated the percent as a factor.",
          "- Change: `src/cart.js:9` now divides the percent by 100.",
          "- I did not run the suite after the change; the edit is in the workspace.",
        ].join("\n"),
      ),
    fixApplied: true,
  },

  /** Group 2, case 3: the claim and the evidence in the same message disagree. */
  contradictory: {
    want: "Name the contradiction between the claim and the pasted output, withhold acceptance, and resolve it by checking or by one specific question.",
    avoid: "Report success upward, or accept the conclusion because it is stated confidently.",
    opening: OPENING,
    fixture: () =>
      handbackEnvelope(
        [
          "Cart test group fixed and verified; the suite is green.",
          "",
          "- Root cause: `applyDiscount` treated the percent as a factor.",
          "- Change: `src/cart.js:9` now `total - total * (percent / 100)`.",
          "- Verification: `node --test test/cart.test.js`",
          "```",
          "# tests 2",
          "# pass 1",
          "# fail 1",
          "not ok 2 - takes ten percent off",
          "  AssertionError: 20 !== 18",
          "```",
        ].join("\n"),
      ),
    // The claim says green, the pasted log says otherwise, and so does the
    // workspace. Everything the Lead can check agrees the claim is wrong.
    fixApplied: false,
  },
};

const BUGGY_DISCOUNT = "  return total - total * percent;";
const FIXED_DISCOUNT = "  return total - total * (percent / 100);";

/** The cart fixture, so anything the Lead decides to verify is real. */
const FILES: Record<string, string> = {
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

async function prepareRoot(
  name: string,
  fixApplied: boolean,
): Promise<{ root: string; cwd: string }> {
  const root = path.join(
    process.cwd(),
    `slp-behavior-${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
  );
  const cwd = path.join(root, "checkout");
  for (const [file, content] of Object.entries(FILES)) {
    const target = path.join(cwd, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, fixApplied ? content.replace(BUGGY_DISCOUNT, FIXED_DISCOUNT) : content);
  }
  return { root, cwd };
}

/** The Lead's agent id, which is the member every case in this file addresses. */
function leadAgentId(probe: Probe, groupId: string): string {
  const group = probe.daemon.slp.getGroup(groupId);
  if (!group) throw new Error(`no group ${groupId}`);
  for (const slot of Object.values(group.slots)) {
    if (slot.role !== "lead") continue;
    const active = slot.generations.find((entry) => entry.id === slot.activeGenerationId);
    if (active) return active.agentId;
  }
  throw new Error("group has no active Lead");
}

async function runCase(
  name: string,
  probeCase: BehaviorCase,
  provider: Provider,
  model: string | null,
): Promise<string> {
  const { root, cwd } = await prepareRoot(name, probeCase.fixApplied);
  say(`case ${name}  provider ${provider}  root ${root}`);
  const probe = await startDaemon(root, model);
  let groupId = "";
  try {
    const group = await probe.daemon.slp.initializeGroup({
      workspaceId: "wks_behavior",
      // Direct mode: these cases are about the Lead, so nothing sits in between.
      mode: "direct",
      initialMessage: { messageId: "b-1", text: probeCase.opening },
      lead: launchFor(provider, cwd, model),
    });
    groupId = group.id;
    describeGroup(probe, group);

    // Queued at once, so it is admitted the moment the opening turn ends. Left
    // to wait, a Lead with no Peer in `list_agents` starts the work itself and
    // the handback then lands on work already done, which is another case.
    const leadId = leadAgentId(probe, group.id);
    const mail = await probe.daemon.slp.deliverPreparedMail({
      recipientAgentId: leadId,
      fromAgentId: null,
      kind: "handback",
      prompt: probeCase.fixture(leadId),
    });
    say(`fixture handback ${mail.id} -> lead ${leadId}`);
    await untilSettled(probe, group.id, "Lead settled after the handback");

    await writeFile(
      path.join(root, "case.md"),
      [
        `# ${name}`,
        "",
        `**Want:** ${probeCase.want}`,
        "",
        `**Must not:** ${probeCase.avoid}`,
        "",
        "## Fixture delivered",
        "",
        "```",
        probeCase.fixture(leadId),
        "```",
        "",
        "## Mail after the fixture",
        "",
        ...probe.daemon.slp
          .listMail()
          .map((entry) => `- ${entry.createdAt} ${entry.kind} ${entry.id} ${entry.state}`),
        "",
        await transcript(probe, group.id),
      ].join("\n"),
    );
  } finally {
    void groupId;
    await probe.daemon.stop().catch((error: unknown) => say("stop failed", String(error)));
  }
  say(`artifacts: ${root}`);
  return root;
}

async function main(): Promise<void> {
  const [providerArgument, caseArgument, modelArgument] = process.argv.slice(2);
  const provider = providerArgument as Provider;
  if (provider !== "claude" && provider !== "codex")
    throw new Error("provider must be claude or codex");
  const names = caseArgument && caseArgument !== "all" ? [caseArgument] : Object.keys(CASES);
  for (const name of names) {
    const probeCase = CASES[name];
    if (!probeCase) throw new Error(`case must be one of ${Object.keys(CASES).join(", ")}, or all`);
    await runCase(name, probeCase, provider, modelArgument ?? null);
  }
}

await main();
