import { describe, expect, it } from "vitest";
import { RANKS, getRank } from "../src/index.js";

describe("CS:GO rank mapping", () => {
  it("contains the complete ladder from Silver I through Global Elite", () => {
    expect(RANKS).toHaveLength(18);
    expect(RANKS[0]?.name).toBe("Silver I");
    expect(RANKS.at(-1)?.name).toBe("The Global Elite");
  });

  it.each(RANKS)("maps the $name threshold exactly", (rank) => {
    expect(getRank(rank.floor).name).toBe(rank.name);
  });

  it("reports promotion progress without hiding the numeric rating", () => {
    expect(getRank(1937)).toMatchObject({
      name: "Distinguished Master Guardian",
      nextRank: "Legendary Eagle",
      pointsIntoRank: 62,
      pointsForPromotion: 125
    });
    expect(getRank(1937).progress).toBeCloseTo(0.496);
  });
});

