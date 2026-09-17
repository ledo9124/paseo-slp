import { describe, expect, test } from "vitest";

import { isInteractiveQuestionDenied } from "./authority.js";

describe("isInteractiveQuestionDenied", () => {
  test("keeps the channel for Supervisor, whose chat is the one Human reads", () => {
    expect(isInteractiveQuestionDenied("supervisor")).toBe(false);
  });

  test("denies Lead, which has no recipient to hand an unanswered question to", () => {
    expect(isInteractiveQuestionDenied("lead")).toBe(true);
  });

  test("denies Peer, which reaches its Lead only by ending its turn", () => {
    expect(isInteractiveQuestionDenied("peer")).toBe(true);
  });
});
