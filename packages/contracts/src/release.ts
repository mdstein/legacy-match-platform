import release from "./release.json";
import type { LauncherClientContent } from "./index.js";

/** Candidate metadata becomes public only when the matching API/web release is deployed. */
export const B2G_RELEASE = release;
export const LAUNCHER_DOWNLOAD_FILENAME = `b2g-launcher-v${release.launcherVersion}-windows-x86_64.exe`;
export const LAUNCHER_DOWNLOAD_URL = `/downloads/${LAUNCHER_DOWNLOAD_FILENAME}`;
export const LAUNCHER_CONTENT: LauncherClientContent = {
  version: 1,
  releaseVersion: release.launcherVersion,
  channel: release.channel,
  publishedAt: release.preparedAt,
  changelog: release.changelog,
  news: release.news,
  history: release.history
};
