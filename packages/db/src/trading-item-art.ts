import images from "./trading-item-images.json" with { type: "json" };

/** Immutable, same-origin thumbnails derived from the installed Valve archive. */
export function tradingItemImage(definitionIndex: number, paintIndex: number | null, sprayKitId: number | null): string | null {
  const key = sprayKitId !== null && [1348, 1349].includes(definitionIndex)
    ? `spray:${sprayKitId}` : `${definitionIndex}:${paintIndex ?? 0}`;
  return (images as Record<string, string>)[key] ?? null;
}
