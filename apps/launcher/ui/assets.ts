import hero from "../assets/news-update.png";
import map from "../assets/news-map.png";
import avatar from "../assets/avatar.png";
import logo from "../assets/wordmark.svg";
const rankFiles = import.meta.glob("../../web/public/ranks/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
export const assets = { hero, map, avatar, logo };
export const rankImage = (rank: unknown) =>
  rankFiles[`../../web/public/ranks/${Number(rank)}.svg`];
