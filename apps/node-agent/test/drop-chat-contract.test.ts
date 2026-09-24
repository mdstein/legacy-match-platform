import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source contract + real SourcePawn compilation cover the payload we emit.
// Rendering the palette in the game still requires human UAT.
const source = readFileSync(new URL("../../../infra/game-server/plugins/aftertick_match.sp", import.meta.url), "utf8");
const command = source.slice(source.indexOf("public Action CommandAnnounceDrop("), source.indexOf("public Action CommandPresentXp("));

describe("native unboxing chat contract", () => {
  it.each([
    [1, "0A"], [2, "0B"], [3, "0C"], [4, "0D"], [5, "0E"], [6, "0F"], [7, "10"]
  ])("uses the CS:GO palette code for rarity %s", (rarity, color) => {
    expect(command).toContain(`case ${rarity}: rarityColor = 0x${color};`);
  });

  it("colors the item name, keeps quality qualifiers, and omits written rarity labels", () => {
    expect(command).toContain('%N\\x01 has opened a container and found: %c%s\\x01", target, rarityColor, itemName');
    expect(command).toContain('%N\\x01 has opened a container and found: %cStatTrak™ %s\\x01", target, rarityColor, itemName');
    expect(command).toContain('%N\\x01 has opened a container and found: %cSouvenir %s\\x01", target, rarityColor, itemName');
    const formattedMessages = command.match(/Format\(announcement,[^\r\n]+/g)?.join("\n");
    expect(formattedMessages).toBeTruthy();
    expect(formattedMessages).not.toMatch(/rarityName|Mil-Spec|Covert|Restricted|Classified/);
    expect(command).toContain('text.SetInt("ent_idx", 0)'); // neutral author, not the opener's team color
    expect(command).toContain('StartMessageAll("SayText2", USERMSG_RELIABLE)');
  });
});
