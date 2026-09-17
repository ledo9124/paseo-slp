import { describe, expect, test } from "vitest";

import { isControlMail, SlpControlTurns } from "./control-turns.js";
import type { SlpMailRecord } from "./store.js";

describe("isControlMail", () => {
  test("activation and control are the runtime's own mail", () => {
    expect(isControlMail("activation")).toBe(true);
    expect(isControlMail("control")).toBe(true);
  });

  test("interrupted is deliberately not control mail: a Peer's lost turn is ordinary project work", () => {
    expect(isControlMail("interrupted")).toBe(false);
  });

  test("message and handback and report are never control mail", () => {
    const kinds: SlpMailRecord["kind"][] = ["message", "handback", "report"];
    for (const kind of kinds) expect(isControlMail(kind)).toBe(false);
  });
});

describe("SlpControlTurns", () => {
  test("a claimed turn settles once and only once", () => {
    const turns = new SlpControlTurns();
    turns.claim("agt_1");
    expect(turns.settle("agt_1")).toBe(true);
    expect(turns.settle("agt_1")).toBe(false);
  });

  test("a released claim never settles", () => {
    const turns = new SlpControlTurns();
    turns.claim("agt_1");
    turns.release("agt_1");
    expect(turns.settle("agt_1")).toBe(false);
  });
});
