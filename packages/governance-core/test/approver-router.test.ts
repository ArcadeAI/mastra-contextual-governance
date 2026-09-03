/**
 * ApproverRouter (#9). Table-driven: every row states the amount, who asked,
 * the roster, and who the router must land on — or that it must land on nobody.
 *
 * The roster is the demo cast from DESIGN.md, because "$95K goes to Riley, not
 * Morgan" is a line the presenter says out loud and this is where it is pinned.
 */
import { describe, expect, it } from "bun:test";
import { aSubject, type Subject } from "@cg/policy-schema";
import { routeApproval, type RoutingResult } from "../src/approver-router.ts";

const dana = aSubject({ user_id: "dana@example.com", display_name: "Dana", clearance: 50_000 });
const sam = aSubject({ user_id: "sam@example.com", display_name: "Sam", clearance: 0 });
const riley = aSubject({ user_id: "riley@example.com", display_name: "Riley", clearance: 250_000 });
const morgan = aSubject({
  user_id: "morgan@example.com",
  display_name: "Morgan",
  clearance: 5_000_000,
});

/** The full cast, deliberately in an order that is neither by id nor by clearance. */
const CAST: readonly Subject[] = [morgan, dana, sam, riley];

type Row = {
  name: string;
  amount: number;
  requester: string;
  roster: readonly Subject[];
  /** `user_id` of the expected approver, or `null` for no eligible approver. */
  expect: string | null;
  /** Expected `candidates`, as user ids in order. */
  candidates: readonly string[];
};

const rows: readonly Row[] = [
  {
    name: "the headline case: $95K from Dana goes to Riley, not Morgan",
    amount: 95_000,
    requester: dana.user_id,
    roster: CAST,
    expect: riley.user_id,
    candidates: [riley.user_id, morgan.user_id],
  },
  {
    name: "exact boundary: an amount equal to a clearance is covered by it",
    amount: 250_000,
    requester: dana.user_id,
    roster: CAST,
    expect: riley.user_id,
    candidates: [riley.user_id, morgan.user_id],
  },
  {
    name: "exact boundary + 1: one over Riley's ceiling escalates to Morgan",
    amount: 250_001,
    requester: dana.user_id,
    roster: CAST,
    expect: morgan.user_id,
    candidates: [morgan.user_id],
  },
  {
    name: "exact boundary at the top: Morgan's own ceiling still resolves",
    amount: 5_000_000,
    requester: dana.user_id,
    roster: CAST,
    expect: morgan.user_id,
    candidates: [morgan.user_id],
  },
  {
    name: "requester excluded despite sufficient authority: Riley asking for $95K",
    amount: 95_000,
    requester: riley.user_id,
    roster: CAST,
    expect: morgan.user_id,
    candidates: [morgan.user_id],
  },
  {
    name: "requester excluded despite sufficient authority: Dana asking for $10K goes to Riley",
    amount: 10_000,
    requester: dana.user_id,
    roster: CAST,
    expect: riley.user_id,
    candidates: [riley.user_id, morgan.user_id],
  },
  {
    name: "requester excluded even at the top: Morgan asking for $1M has nobody",
    amount: 1_000_000,
    requester: morgan.user_id,
    roster: CAST,
    expect: null,
    candidates: [],
  },
  {
    name: "no eligible approver: the amount exceeds every clearance",
    amount: 5_000_001,
    requester: dana.user_id,
    roster: CAST,
    expect: null,
    candidates: [],
  },
  {
    name: "several eligible resolve to the lowest, not the first in roster order",
    amount: 1_000,
    requester: sam.user_id,
    roster: CAST,
    expect: dana.user_id,
    candidates: [dana.user_id, riley.user_id, morgan.user_id],
  },
  {
    name: "single-person roster, that person is sufficient and not the requester",
    amount: 95_000,
    requester: dana.user_id,
    roster: [riley],
    expect: riley.user_id,
    candidates: [riley.user_id],
  },
  {
    name: "single-person roster, that person is the requester",
    amount: 1_000,
    requester: riley.user_id,
    roster: [riley],
    expect: null,
    candidates: [],
  },
  {
    name: "single-person roster, that person is insufficient",
    amount: 95_000,
    requester: riley.user_id,
    roster: [dana],
    expect: null,
    candidates: [],
  },
  {
    name: "empty roster",
    amount: 95_000,
    requester: dana.user_id,
    roster: [],
    expect: null,
    candidates: [],
  },
  {
    name: "requester not on the roster at all is still routed normally",
    amount: 95_000,
    requester: "stranger@example.com",
    roster: CAST,
    expect: riley.user_id,
    candidates: [riley.user_id, morgan.user_id],
  },
  {
    name: "zero clearance covers a zero amount (pure inequality, no special case)",
    amount: 0,
    requester: dana.user_id,
    roster: CAST,
    expect: sam.user_id,
    candidates: [sam.user_id, riley.user_id, morgan.user_id],
  },
];

describe("routeApproval", () => {
  for (const row of rows) {
    it(row.name, () => {
      const result = routeApproval(row.amount, row.requester, row.roster);

      expect(result.required_clearance).toBe(row.amount);
      expect(result.candidates.map((s) => s.user_id)).toEqual([...row.candidates]);

      if (row.expect === null) {
        expect(result.outcome).toBe("no_eligible_approver");
        expect(result.approver).toBeNull();
      } else {
        expect(result.outcome).toBe("routed");
        expect(result.approver?.user_id).toBe(row.expect);
        // The approver is always the head of the candidate list.
        expect(result.approver).toBe(result.candidates[0] as Subject);
      }
    });
  }
});

describe("tie-breaking is deterministic and documented", () => {
  const b = aSubject({ user_id: "b@example.com", display_name: "B", clearance: 100 });
  const a = aSubject({ user_id: "a@example.com", display_name: "A", clearance: 100 });
  const c = aSubject({ user_id: "c@example.com", display_name: "C", clearance: 100 });

  it("equal clearances resolve to the lexicographically smallest user_id", () => {
    const result = routeApproval(50, "nobody@example.com", [b, c, a]);
    expect(result.approver?.user_id).toBe("a@example.com");
    expect(result.candidates.map((s) => s.user_id)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });

  it("compares ids by code unit, not by locale (uppercase sorts before lowercase)", () => {
    const upper = aSubject({ user_id: "Zed@example.com", display_name: "Z", clearance: 100 });
    const lower = aSubject({ user_id: "abe@example.com", display_name: "a", clearance: 100 });
    // A locale-aware compare would put "abe" first. Code-unit order puts "Zed"
    // first, which is what Python's default string ordering does too.
    const result = routeApproval(50, "nobody@example.com", [lower, upper]);
    expect(result.approver?.user_id).toBe("Zed@example.com");
  });

  it("is independent of roster order", () => {
    const permutations: Subject[][] = [
      [morgan, dana, sam, riley],
      [riley, morgan, dana, sam],
      [sam, riley, morgan, dana],
      [dana, sam, riley, morgan],
    ];
    const results = permutations.map((roster) =>
      routeApproval(95_000, dana.user_id, roster),
    );
    for (const result of results) {
      expect(result.approver?.user_id).toBe(riley.user_id);
      expect(result.candidates.map((s) => s.user_id)).toEqual([
        riley.user_id,
        morgan.user_id,
      ]);
    }
  });
});

describe("routeApproval is pure", () => {
  it("does not mutate the roster it is given", () => {
    const roster = [morgan, dana, sam, riley];
    const before = [...roster];
    routeApproval(95_000, dana.user_id, roster);
    expect(roster).toEqual(before);
  });

  it("returns the same answer for the same inputs", () => {
    const first = routeApproval(95_000, dana.user_id, CAST);
    const second = routeApproval(95_000, dana.user_id, CAST);
    expect(second).toEqual(first);
  });

  it("returns the roster's own Subject objects, not copies", () => {
    const result = routeApproval(95_000, dana.user_id, CAST) as Extract<
      RoutingResult,
      { outcome: "routed" }
    >;
    expect(result.approver).toBe(riley);
  });
});

describe("invalid amounts are programming errors, not routing outcomes", () => {
  const bad: ReadonlyArray<readonly [label: string, amount: number]> = [
    ["a negative amount", -1],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ];
  for (const [label, amount] of bad) {
    it(`rejects ${label} rather than reporting no eligible approver`, () => {
      expect(() => routeApproval(amount, dana.user_id, CAST)).toThrow(RangeError);
    });
  }
});
