// Valve's final September 2023 items_game.txt, SHA-256:
// 510e09b68a01d88edba2342972960025fd6484aaaa58365fcf47d8513de79623
// Only definitions present in that client are eligible. In particular, 2015
// has two tiers, 2016 has six, and 2017 has seven.
const MEDAL_DEFINITIONS = [
  [2015, [1331, 1332]],
  [2016, [1339, 1340, 1341, 1342, 1343, 1344]],
  [2017, [1357, 1358, 1359, 1360, 1361, 1362, 1363]],
  [2018, [1367, 1368, 1369, 1370, 1371, 1372]],
  [2019, [1376, 1377, 1378, 1379, 1380, 1381]],
  [2020, [4674, 4675, 4676, 4677, 4678, 4679]],
  [2021, [4737, 4738, 4739, 4740, 4741, 4742]],
  [2022, [4819, 4820, 4821, 4822, 4823, 4824]],
  [2023, [4873, 4874, 4875, 4876, 4877, 4878]]
] as const;

export interface ServiceMedalDefinition {
  prestige: number;
  year: number;
  tier: number;
  definitionIndex: number;
  displayName: string;
  iconPath: string;
}

export const SERVICE_MEDAL_SEQUENCE: readonly ServiceMedalDefinition[] = Array.from(
  { length: 7 }, (_, index) => index + 1
).flatMap((tier) => MEDAL_DEFINITIONS.flatMap(([year, definitions]) => {
  const definitionIndex = definitions[tier - 1];
  return definitionIndex === undefined ? [] : [{
    year, tier, definitionIndex,
    displayName: `${year} Service Medal${tier > 1 ? ` (Level ${tier})` : ""}`,
    iconPath: `econ/status_icons/service_medal_${year}${year === 2015 ? (tier === 1 ? "" : "_2") : `_lvl${tier}`}`
  }];
})).map((medal, index) => ({ ...medal, prestige: index + 1 }));

export function nextServiceMedal(completedPrestiges: number): ServiceMedalDefinition | null {
  if (!Number.isInteger(completedPrestiges) || completedPrestiges < 0)
    throw new Error("Invalid service medal prestige.");
  return SERVICE_MEDAL_SEQUENCE[completedPrestiges] ?? null;
}
