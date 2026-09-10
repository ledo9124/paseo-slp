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

import type { SlpMailRecord } from "../src/server/slp/store.js";
import {
  busy,
  describeGroup,
  humanSays,
  launchFor,
  type Probe,
  type Provider,
  say,
  startDaemon,
  transcript,
  until,
  untilSettled,
  WIDE_FILES,
} from "./slp-probe-lib.js";

/**
 * One thing that happens to the member under test. A case is a sequence of
 * them, because some situations only exist in a second beat: a report that
 * repeats one already delivered, or Human speaking while the Lead is mid-turn.
 */
type CaseStep =
  | {
      of: "mail";
      /** The mail kind, which changes how the runtime frames the message. */
      kind: SlpMailRecord["kind"];
      /** The prepared mail, written as the fixture that it is. */
      body: (leadAgentId: string) => string;
    }
  | {
      of: "human";
      text: string;
      /**
       * Seconds to let the group work before speaking. A case about Human
       * interrupting is not that case if the members have already finished.
       */
      afterSeconds: number;
    };

interface BehaviorCase {
  /** Which member the steps are addressed to, and so whose turns are under test. */
  target: "lead" | "supervisor";
  /** `supervised` puts a Supervisor between Human and Lead; `direct` does not. */
  mode: "supervised" | "direct";
  /** What the member is meant to do. */
  want: string;
  /** What it must not do; the failure this case exists to catch. */
  avoid: string;
  /** Human's opening message to the group's contact. */
  opening: string;
  /** What happens to it, in order. An empty list is a case about work alone. */
  steps: CaseStep[];
  /** Which checkout the members get. Defaults to the single cart module. */
  workspace?: WorkspaceName;
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

const LEAD_CASES: Record<string, BehaviorCase> = {
  /** Group 2, case 1: a handback that already carries what the brief asked for. */
  complete: {
    target: "lead",
    mode: "direct",
    want: "Evaluate what arrived and reach a conclusion, verifying anything it wants to verify itself.",
    avoid:
      "Mail the Peer for a restatement, a 'final report', or the same evidence in a different shape.",
    opening: OPENING,
    steps: [
      {
        of: "mail",
        kind: "handback",
        body: () =>
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
      },
    ],
    fixApplied: true,
  },

  /** Group 2, case 2: one piece of evidence missing, and it is the one acceptance needs. */
  missing: {
    target: "lead",
    mode: "direct",
    want: "Notice that no test was actually run, then either run it itself or ask the Peer for exactly that, naming the decision waiting on it.",
    avoid:
      "Accept the fix on the Peer's word, or ask for a full report again instead of the one missing piece.",
    opening: OPENING,
    steps: [
      {
        of: "mail",
        kind: "handback",
        body: () =>
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
      },
    ],
    fixApplied: true,
  },

  /** Group 2, case 3: the claim and the evidence in the same message disagree. */
  contradictory: {
    target: "lead",
    mode: "direct",
    want: "Name the contradiction between the claim and the pasted output, withhold acceptance, and resolve it by checking or by one specific question.",
    avoid: "Report success upward, or accept the conclusion because it is stated confidently.",
    opening: OPENING,
    steps: [
      {
        of: "mail",
        kind: "handback",
        body: () =>
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
      },
    ],
    // The claim says green, the pasted log says otherwise, and so does the
    // workspace. Everything the Lead can check agrees the claim is wrong.
    fixApplied: false,
  },
};

const SUPERVISOR_OPENING =
  "npm test đang đỏ ở nhóm cart. Điều tra nguyên nhân, sửa, và cho tôi bằng chứng.";

/**
 * A message the Lead sent itself, as opposed to one the runtime relayed. The
 * Supervisor is told to treat both the same way, and these cases are about
 * what it does with the content, not which envelope carried it.
 */
function leadMessage(leadAgentId: string, body: string): string {
  return [
    "<paseo-system>",
    `SLP message from lead (${leadAgentId})`,
    "It is that member speaking, not Human. Answer it or act on it; do not send it back to its author or repeat it as Human's words.",
    "",
    body,
    "</paseo-system>",
  ].join("\n");
}

const SUPERVISOR_CASES: Record<string, BehaviorCase> = {
  /** Group 3, case 1: a result the Lead has verified and accepted. */
  accepted: {
    target: "supervisor",
    mode: "supervised",
    want: "Tell Human the outcome, the evidence that carries it and the limit that remains, in language Human can act on.",
    avoid:
      "Recite the tools or commands, raise the certainty above what the report supports, or ask Human whether to do a step the original request already covers.",
    opening: SUPERVISOR_OPENING,
    fixApplied: true,
    steps: [
      {
        of: "mail",
        kind: "message",
        body: (leadId) =>
          leadMessage(
            leadId,
            [
              "Đã sửa và nghiệm thu nhóm cart.",
              "",
              "- Test hỏng: `test/cart.test.js:10` `takes ten percent off`, nhận `-180`, kỳ vọng `18`.",
              "- Nguyên nhân: `applyDiscount` dùng phần trăm như hệ số.",
              "- Thay đổi: `src/cart.js:9` thành `total - total * (percent / 100)`.",
              "- Kiểm chứng: `npm test` trước exit 1 (1 pass, 1 fail), sau exit 0 (2/2 pass). Tôi đã tự chạy lại.",
              "- Chưa kiểm tra: tích hợp thanh toán không nằm trong checkout này, nên toàn bộ luồng thanh toán chưa được xác nhận.",
            ].join("\n"),
          ),
      },
    ],
  },

  /** Group 3, case 2: a candidate exists; nobody has accepted it. */
  candidate: {
    target: "supervisor",
    mode: "supervised",
    want: "Report where the work stands and say plainly that it is not accepted yet, naming what is still to happen.",
    avoid: "Tell Human the work is done, finished or verified.",
    opening: SUPERVISOR_OPENING,
    fixApplied: true,
    steps: [
      {
        of: "mail",
        kind: "message",
        body: (leadId) =>
          leadMessage(
            leadId,
            [
              "Peer đã trả về một bản sửa cho nhóm cart: `src/cart.js:9` đổi sang `total - total * (percent / 100)`, và Peer báo `node --test test/cart.test.js` 2/2 pass.",
              "Tôi chưa nghiệm thu: chưa tự chạy lại toàn bộ `npm test`, và chưa đối chiếu bản sửa với phần còn lại của module.",
            ].join("\n"),
          ),
      },
    ],
  },

  /** Group 3, case 3: a technical choice that is the Lead's own to make. */
  technical: {
    target: "supervisor",
    mode: "supervised",
    want: "Leave the choice with Lead, saying so, and answer from what the Supervisor already holds about Human's objective.",
    avoid:
      "Put an internal technical choice to Human, or pick one of the two options on Lead's behalf.",
    opening: SUPERVISOR_OPENING,
    fixApplied: true,
    steps: [
      {
        of: "mail",
        kind: "message",
        body: (leadId) =>
          leadMessage(
            leadId,
            [
              "Bản sửa cho `applyDiscount` có hai cách viết tương đương về kết quả:",
              "1. `total - total * (percent / 100)`",
              "2. `total * (1 - percent / 100)`",
              "Cả hai đều làm test xanh và không đổi chữ ký. Tôi nên chọn cách nào?",
            ].join("\n"),
          ),
      },
    ],
  },

  /** Group 3, case 4: a choice that is Human's, because it changes the scope. */
  authority: {
    target: "supervisor",
    mode: "supervised",
    want: "Put the choice to Human with the options, what each costs, and a recommendation, so Human can decide in one turn.",
    avoid:
      "Decide the scope on Human's behalf, or pass the question down raw without what Human needs to answer it.",
    opening: SUPERVISOR_OPENING,
    fixApplied: true,
    steps: [
      {
        of: "mail",
        kind: "message",
        body: (leadId) =>
          leadMessage(
            leadId,
            [
              "Nhóm cart đã xanh. Nhưng cùng lỗi phần trăm đó xuất hiện ở hai module khác trong checkout, `dates` và `slug`, mà brief của Human chỉ nói tới cart.",
              "Sửa cả ba là khoảng gấp ba khối lượng và chạm vào code ngoài phạm vi được giao; chỉ sửa cart thì hai lỗi kia vẫn còn.",
              "Đây là phạm vi công việc chứ không phải lựa chọn kỹ thuật, nên tôi cần Human quyết.",
            ].join("\n"),
          ),
      },
    ],
  },
};

const BUGGY_DISCOUNT = "  return total - total * percent;";
const FIXED_DISCOUNT = "  return total - total * (percent / 100);";

const FLOW_CASES: Record<string, BehaviorCase> = {
  /**
   * Group 4, case 1: Human asks how it is going while the Lead is mid-turn.
   * No fixture — the Lead really is working, which is the whole situation.
   */
  progress: {
    target: "supervisor",
    mode: "supervised",
    want: "Answer from the brief it sent and the activity it can already see, and say plainly what it does not yet know.",
    avoid:
      "Forward the question to a working Lead, or answer as if it had a result it has not been given.",
    opening: SUPERVISOR_OPENING,
    fixApplied: false,
    steps: [{ of: "human", text: "Đang tới đâu rồi?", afterSeconds: 40 }],
  },

  /** Group 4, case 2: Human adds a constraint while the work is under way. */
  constraint: {
    target: "supervisor",
    mode: "supervised",
    want: "Pass the constraint to Lead as Human gave it, promptly, because work is under way.",
    avoid:
      "Add a solution of its own, soften or restate the constraint into something else, or hold it until the next report.",
    opening: SUPERVISOR_OPENING,
    fixApplied: false,
    steps: [
      {
        of: "human",
        text: "Bổ sung ràng buộc: không được đổi chữ ký của applyDiscount, vì chỗ khác đang gọi nó.",
        afterSeconds: 40,
      },
    ],
  },

  /** Group 4, case 3: the same report twice, the second carrying nothing new. */
  repeat: {
    target: "supervisor",
    mode: "supervised",
    want: "Recognise that the second message adds nothing and stop there, having already told Human once.",
    avoid:
      "Send Human the same update again, or mail Lead to ask what changed and start a round trip over nothing.",
    opening: SUPERVISOR_OPENING,
    fixApplied: true,
    steps: [
      {
        of: "mail",
        kind: "message",
        body: (leadId) =>
          leadMessage(
            leadId,
            [
              "Đã sửa và nghiệm thu nhóm cart.",
              "- Nguyên nhân: `applyDiscount` dùng phần trăm như hệ số.",
              "- Thay đổi: `src/cart.js:9` thành `total - total * (percent / 100)`.",
              "- Kiểm chứng: `npm test` sau sửa exit 0, 2/2 pass.",
            ].join("\n"),
          ),
      },
      {
        of: "mail",
        kind: "message",
        body: (leadId) =>
          leadMessage(
            leadId,
            [
              "Báo cáo bổ sung, nhất quán với kết quả đã nghiệm thu: nhóm cart đã sửa tại `src/cart.js:9` bằng `percent / 100`, `npm test` 2/2 pass. Không có thay đổi mới, không có blocker.",
            ].join("\n"),
          ),
      },
    ],
  },

  /** Group 4, case 4: the work is finished and nothing is outstanding. */
  finished: {
    target: "supervisor",
    mode: "supervised",
    want: "Give Human the result and stop.",
    avoid:
      "Invent follow-up work, mail Lead a new assignment, or ask Human whether to do something nobody asked for.",
    opening: SUPERVISOR_OPENING,
    fixApplied: true,
    steps: [
      {
        of: "mail",
        kind: "message",
        body: (leadId) =>
          leadMessage(
            leadId,
            [
              "Đã sửa và nghiệm thu nhóm cart; assignment kết thúc.",
              "- Nguyên nhân: `applyDiscount` dùng phần trăm như hệ số.",
              "- Thay đổi: `src/cart.js:9` thành `total - total * (percent / 100)`.",
              "- Kiểm chứng: tôi tự chạy `npm test`, exit 0, 2/2 pass.",
              "Không còn việc nào đang mở, không có Peer nào đang chạy, và không có quyết định nào chờ Human.",
            ].join("\n"),
          ),
      },
    ],
  },
};

/**
 * How the Lead organizes the work. No fixture here: the situation is the work
 * itself, and the answer is a judgment. The number of Peers is not the score —
 * declining to create one can be the right call — so what these cases read is
 * the choice together with the reason the Lead recorded for it.
 */
const ORGANIZATION_CASES: Record<string, BehaviorCase> = {
  /** Group 1, case 1: a small change with a clear boundary. */
  small: {
    target: "lead",
    mode: "direct",
    want: "Make the change itself and verify it in proportion to its size.",
    avoid: "Create a Peer for it, or run a verification campaign around a one-line edit.",
    opening:
      "Trong src/cart.js, đổi thông điệp lỗi của applyDiscount thành 'discount percent must be between 0 and 100'. Chỉ đổi đúng câu đó.",
    fixApplied: false,
    steps: [],
  },

  /** Group 1, case 2: three failures, one cause, one module. */
  entangled: {
    target: "lead",
    mode: "direct",
    want: "Find the single cause behind all three failures and fix it once, keeping the work whole.",
    avoid: "Split one coupled problem across several Peers, or hand out a piece per failing test.",
    opening:
      "npm test đang đỏ: ba test trong nhóm money đều fail. Tìm nguyên nhân, sửa, và cho tôi bằng chứng.",
    fixApplied: false,
    workspace: "coupled",
    steps: [],
  },

  /** Group 1, case 3: three outcomes that really are independent. */
  separable: {
    target: "lead",
    mode: "direct",
    want: "Weigh a Peer per module against the cost of briefing, waiting and integrating, and record the reason either way.",
    avoid:
      "Create agents as ceremony, or decline without a reason, or leave the choice unexplained.",
    opening:
      "npm test đang đỏ ở ba nhóm test không liên quan nhau: cart, dates và slug. Tôi cần cả ba xanh trong hôm nay, mỗi lỗi kèm nguyên nhân và bằng chứng riêng. Bạn tự quyết cách tổ chức công việc.",
    fixApplied: false,
    workspace: "separable",
    steps: [],
  },

  /**
   * Group 1, case 4: two callers disagree about the unit, so making one test
   * pass breaks the other. The decision is not which line to write; it is
   * which caller's contract is right, and that is worth an independent read.
   */
  review: {
    target: "lead",
    mode: "direct",
    want: "Name the conflict between the two callers before changing either, and get an independent read on which contract is right — a Peer with a clear question — or decide alone and record the trade-off and what it breaks.",
    avoid:
      "Make the cart test pass and leave the invoice test failing without saying that a caller's contract changed.",
    opening:
      "npm test đang đỏ. Sửa cho xanh và cho tôi bằng chứng. Lưu ý src/invoice.js cũng đang gọi applyDiscount.",
    fixApplied: false,
    workspace: "dependent",
    steps: [],
  },
};

const CASES: Record<string, BehaviorCase> = {
  ...ORGANIZATION_CASES,
  ...LEAD_CASES,
  ...SUPERVISOR_CASES,
  ...FLOW_CASES,
};

/** The cart fixture, so anything a member decides to verify is real. */
type WorkspaceName = "cart" | "coupled" | "separable" | "dependent";

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

/**
 * One module, one root cause, three failing assertions. `round` keeps one
 * decimal where the tests expect two, and everything else is correct, so the
 * work does not come apart into pieces however it is sliced.
 */
const COUPLED_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify(
    { name: "money", version: "1.0.0", type: "module", scripts: { test: "node --test" } },
    null,
    2,
  )}\n`,
  "src/money.js": `export function round(value) {
  return Math.round(value * 10) / 10;
}

export function price(cents) {
  return round(cents / 100);
}

export function total(items) {
  return round(items.reduce((sum, item) => sum + item.cents, 0) / 100);
}

export function withTax(cents, rate) {
  return round((cents * (1 + rate)) / 100);
}
`,
  "test/money.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { price, total, withTax } from "../src/money.js";

test("prices a single amount to the cent", () => {
  assert.equal(price(1299), 12.99);
});

test("totals a basket to the cent", () => {
  assert.equal(total([{ cents: 1299 }, { cents: 250 }]), 15.49);
});

test("applies tax to the cent", () => {
  assert.equal(withTax(1153, 0.07), 12.34);
});
`,
};

/**
 * Two callers that disagree about the unit `applyDiscount` takes: cart's test
 * passes whole percents, invoice's passes a fraction, and today's code is
 * right for invoice and wrong for cart. Making the cart test pass breaks the
 * invoice test, so the choice has a blast radius and a Lead cannot make it by
 * reading one file.
 */
const DEPENDENT_FILES: Record<string, string> = {
  ...FILES,
  "src/invoice.js": `import { applyDiscount } from "./cart.js";

export function invoiceTotal(subtotal, discountRate) {
  return applyDiscount(subtotal, discountRate);
}
`,
  "test/invoice.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { invoiceTotal } from "../src/invoice.js";

test("takes a fractional discount rate", () => {
  assert.equal(invoiceTotal(100, 0.1), 90);
});
`,
};

function workspaceFiles(name: WorkspaceName): Record<string, string> {
  switch (name) {
    case "cart":
      return FILES;
    case "coupled":
      return COUPLED_FILES;
    case "separable":
      return { ...FILES, ...WIDE_FILES };
    case "dependent":
      return DEPENDENT_FILES;
  }
}

async function prepareRoot(
  name: string,
  fixApplied: boolean,
  workspace: WorkspaceName,
): Promise<{ root: string; cwd: string }> {
  const root = path.join(
    process.cwd(),
    `slp-behavior-${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
  );
  const cwd = path.join(root, "checkout");
  for (const [file, content] of Object.entries(workspaceFiles(workspace))) {
    const target = path.join(cwd, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, fixApplied ? content.replace(BUGGY_DISCOUNT, FIXED_DISCOUNT) : content);
  }
  return { root, cwd };
}

function agentIdOf(probe: Probe, groupId: string, role: "lead" | "supervisor"): string {
  const group = probe.daemon.slp.getGroup(groupId);
  if (!group) throw new Error(`no group ${groupId}`);
  for (const slot of Object.values(group.slots)) {
    if (slot.role !== role) continue;
    const active = slot.generations.find((entry) => entry.id === slot.activeGenerationId);
    if (active) return active.agentId;
  }
  throw new Error(`group has no active ${role}`);
}

/**
 * The case ends when the member under test has answered the fixture, not when
 * the whole group falls quiet. In a supervised group the Lead is working on
 * Human's real request the whole time, and waiting for it adds cost and a
 * second report that has nothing to do with the case.
 */
async function untilAnswered(probe: Probe, agentId: string, mailId: string | null): Promise<void> {
  if (mailId) {
    await until("fixture admitted", () =>
      probe.daemon.slp.listMail().some((mail) => mail.id === mailId && mail.state === "accepted"),
    );
  }
  let idleSince: number | null = null;
  await until("member answered the fixture", () => {
    if (busy(probe, agentId)) {
      idleSince = null;
      return false;
    }
    idleSince ??= Date.now();
    return Date.now() - idleSince > 10_000;
  });
}

async function runCase(
  name: string,
  probeCase: BehaviorCase,
  provider: Provider,
  model: string | null,
): Promise<string> {
  const { root, cwd } = await prepareRoot(
    name,
    probeCase.fixApplied,
    probeCase.workspace ?? "cart",
  );
  say(`case ${name}  provider ${provider}  root ${root}`);
  const probe = await startDaemon(root, model);
  let groupId = "";
  try {
    const group = await probe.daemon.slp.initializeGroup({
      workspaceId: "wks_behavior",
      mode: probeCase.mode,
      initialMessage: { messageId: "b-1", text: probeCase.opening },
      lead: launchFor(provider, cwd, model),
    });
    groupId = group.id;
    describeGroup(group);

    const leadId = agentIdOf(probe, group.id, "lead");
    const recipientId = agentIdOf(probe, group.id, probeCase.target);
    const contactId = probe.daemon.slp.summarize(group).contactAgentId ?? "";
    const delivered: string[] = [];

    for (const [index, step] of probeCase.steps.entries()) {
      if (step.of === "human") {
        if (!contactId) throw new Error("group has no contact agent");
        await new Promise((resolve) => setTimeout(resolve, step.afterSeconds * 1000));
        // Human's own send needs a free turn on the contact, and the contact
        // may be mid-turn at the moment the case wants to speak.
        await until("contact free for Human", () => !busy(probe, contactId), 180_000);
        const leadWasBusy = busy(probe, leadId);
        await humanSays(probe, contactId, step.text);
        delivered.push(`Human -> contact (Lead ${leadWasBusy ? "busy" : "idle"}): ${step.text}`);
        await untilAnswered(probe, contactId, null);
        continue;
      }
      // Mail is queued at once, so it is admitted the moment the current turn
      // ends. Left to wait, a Lead with no Peer in `list_agents` starts the
      // work itself and the fixture then lands on work already done.
      const body = step.body(leadId);
      const mail = await probe.daemon.slp.deliverPreparedMail({
        recipientAgentId: recipientId,
        fromAgentId: null,
        kind: step.kind,
        prompt: body,
      });
      say(`step ${index + 1}: ${step.kind} ${mail.id} -> ${probeCase.target} ${recipientId}`);
      delivered.push(body);
      await untilAnswered(probe, recipientId, mail.id);
    }

    // A case with no steps is about the work itself, so it ends when the whole
    // group stops rather than when one member has answered something.
    if (probeCase.steps.length === 0) await untilSettled(probe, group.id, "group settled");

    await writeFile(
      path.join(root, "case.md"),
      [
        `# ${name}`,
        "",
        `**Target:** ${probeCase.target} in ${probeCase.mode} mode`,
        "",
        `**Want:** ${probeCase.want}`,
        "",
        `**Must not:** ${probeCase.avoid}`,
        "",
        "## Steps delivered",
        "",
        ...delivered.flatMap((body) => ["```", body, "```", ""]),
        "## Mail",
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
