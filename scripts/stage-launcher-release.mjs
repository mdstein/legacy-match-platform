import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(await readFile(resolve(root, "packages/contracts/src/release.json"), "utf8"));
const version = release.launcherVersion;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid launcher version.");
const cargo = await readFile(resolve(root, "apps/launcher/Cargo.toml"), "utf8");
if (!cargo.includes(`version = "${version}"`)) throw new Error("Cargo and shared release metadata disagree.");
const source = resolve(root, "apps/launcher/target/release/b2g-launcher.exe");
const reported = execFileSync(source, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
if (reported !== `B2G Launcher ${version}`) throw new Error("Built executable version disagrees with metadata.");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = await readFile(source);
const sourceHash = sha256(sourceBytes);
const nativeSource = await readFile(resolve(root, "apps/launcher/src/lib.rs"), "utf8");
const nativeArtifacts = {};
for (const [file, pin] of [["csgo.exe", "GC_CLIENT_WRAPPER_SHA256"], ["csgo_gc.dll", "GC_LIBRARY_SHA256"]]) {
  const bytes = await readFile(resolve(root, "vendor/csgo-gc/prebuilt/windows-x86", file));
  const expected = nativeSource.match(new RegExp(`const ${pin}: &str =\\s*"([a-fA-F0-9]{64})"`))?.[1]?.toLowerCase();
  if (!expected || sha256(bytes) !== expected) throw new Error(`Native pin mismatch for ${file}.`);
  nativeArtifacts[file] = { sha256: expected, sizeBytes: bytes.length };
}
const directory = resolve(root, "apps/web/public/downloads");
await mkdir(directory, { recursive: true });
const filename = `b2g-launcher-v${version}-windows-x86_64.exe`;
const target = resolve(directory, filename);
try {
  await copyFile(source, target, constants.COPYFILE_EXCL);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  if (sha256(await readFile(target)) !== sourceHash) throw new Error("This immutable launcher version already contains different bytes. Bump the release version.");
}
const checksum = `${sourceHash}  ${filename}\n`;
try {
  await writeFile(`${target}.sha256`, checksum, { flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  if (await readFile(`${target}.sha256`, "utf8") !== checksum) throw new Error("Existing launcher checksum disagrees.");
}
const report = { launcherVersion: version, nodeVersion: release.nodeVersion, filename, sha256: sourceHash, sizeBytes: sourceBytes.length, nativeArtifacts, distribution: "unsigned private alpha", published: false };
await mkdir(resolve(root, ".artifacts/releases"), { recursive: true });
await writeFile(resolve(root, `.artifacts/releases/launcher-${version}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
