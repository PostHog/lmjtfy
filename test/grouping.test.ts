import { describe, expect, it } from "vitest";
import { normalizeQuestion, questionId, tidyDisplay } from "../src/normalize";
import { verdictLabel } from "../src/jev";

describe("normalizeQuestion", () => {
  it("groups the same question across casing, punctuation and spacing", () => {
    const key = normalizeQuestion("Is a hot dog a sandwich?");
    expect(normalizeQuestion("is a HOT DOG a sandwich???")).toBe(key);
    expect(normalizeQuestion("  Is a hot dog a sandwich  ")).toBe(key);
    expect(normalizeQuestion("Hey Jev, is a hot dog a sandwich?")).toBe(key);
    expect(normalizeQuestion("jev: Is a hot-dog a sandwich!")).toBe(key);
  });

  it("strips diacritics and smart quotes", () => {
    expect(normalizeQuestion("Is naïve café cliché?")).toBe("is naive cafe cliche");
    expect(normalizeQuestion("Is it Jev’s call?")).toBe("is it jev s call");
  });

  it("keeps genuinely different questions apart", () => {
    expect(normalizeQuestion("Is TypeScript good?")).not.toBe(
      normalizeQuestion("Is TypeScript bad?"),
    );
    expect(normalizeQuestion("Should we ship on Friday?")).not.toBe(
      normalizeQuestion("Should we ship on Monday?"),
    );
  });

  it("does not collapse a rewording that Jev should judge instead", () => {
    // These mean the same thing but are left to the semantic match, because
    // a string rule that merged them would also merge good/bad.
    expect(normalizeQuestion("Is pineapple on pizza acceptable?")).not.toBe(
      normalizeQuestion("Does pineapple belong on a pizza?"),
    );
  });
});

describe("questionId", () => {
  it("is stable and 32 hex characters", async () => {
    const a = await questionId("is a hot dog a sandwich");
    const b = await questionId("is a hot dog a sandwich");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it("differs for different questions", async () => {
    expect(await questionId("is x good")).not.toBe(await questionId("is x bad"));
  });
});

describe("verdictLabel", () => {
  it("maps a Noul probability onto a stance", () => {
    expect(verdictLabel(0.99)).toBe("Yes");
    expect(verdictLabel(0.8)).toBe("Probably yes");
    expect(verdictLabel(0.6)).toBe("Leaning yes");
    expect(verdictLabel(0.5)).toBe("Jev is torn");
    expect(verdictLabel(0.3)).toBe("Leaning no");
    expect(verdictLabel(0.15)).toBe("Probably no");
    expect(verdictLabel(0.02)).toBe("No");
  });

  it("treats the middle band as an answer, not a failure", () => {
    // A Noul near 0.5 means yes and no are similarly likely. That is a real
    // reading and must not be rounded to a side.
    expect(verdictLabel(0.45)).toBe("Jev is torn");
    expect(verdictLabel(0.55)).toBe("Jev is torn");
  });
});

describe("tidyDisplay", () => {
  it("collapses whitespace without changing wording", () => {
    expect(tidyDisplay("  Is   this\n\nfine? ")).toBe("Is this fine?");
  });
});
