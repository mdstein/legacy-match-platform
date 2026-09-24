import { B2G_RELEASE } from "@aftertick/contracts";

declare const __B2G_NODE_VERSION__: string;

// Release builds embed the packager's exact version; source runs use the candidate.
export const NODE_VERSION = typeof __B2G_NODE_VERSION__ === "undefined"
  ? B2G_RELEASE.nodeVersion
  : __B2G_NODE_VERSION__;
