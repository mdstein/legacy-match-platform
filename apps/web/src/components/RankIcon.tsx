import { RANKS } from "@aftertick/rating";

interface RankIconProps {
  rank: string;
  size?: "sm" | "md" | "lg";
  decorative?: boolean;
}

function rankIndex(rank: string): number {
  const index = RANKS.findIndex((candidate) => candidate.name === rank || candidate.shortName === rank);
  return index < 0 ? 0 : index;
}

export function RankIcon({ rank, size = "md", decorative = false }: RankIconProps) {
  const index = rankIndex(rank);
  const label = RANKS[index]?.name ?? rank;

  return (
    <span
      className={`rank-icon rank-icon--${size}`}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : `${label} rank`}
      aria-hidden={decorative ? "true" : undefined}
    >
      <img
        src={`/ranks/${index + 1}.svg`}
        alt=""
        draggable={false}
        loading={size === "sm" ? "lazy" : "eager"}
      />
    </span>
  );
}
