import { execFile as execFileCallback, spawn } from "node:child_process";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "..");
const toolsRoot = resolve(root, ".tools");
const sourceModScripting = resolve(toolsRoot, "plugin-toolchain/sourcemod/addons/sourcemod/scripting");
const compiler = resolve(sourceModScripting, process.platform === "win32" ? "spcomp.exe" : "spcomp");
const outputRoot = resolve(root, ".artifacts/sourcemod/smac");

const repositories = {
  smac: {
    directory: resolve(toolsRoot, "smac-source"),
    url: "https://github.com/Rushaway/sm-plugin-SMAC.git",
    commit: "ea15f3ec0c8d9c499d0e42d7174675dd6d30780b"
  },
  multicolors: {
    directory: resolve(toolsRoot, "multicolors-source"),
    url: "https://github.com/srcdslab/sm-plugin-MultiColors.git",
    commit: "d2f2dc9126255571c0fc4499d5729cacb57265ca"
  }
};

const modules = [
  "smac",
  "smac_aimbot",
  "smac_autotrigger",
  "smac_eyetest",
  "smac_speedhack",
  "smac_spinhack"
];

async function exists(path) {
  return stat(path).then(() => true).catch(() => false);
}

async function run(command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : reject(new Error(`${command} exited with code ${code ?? "unknown"}.`)));
  });
}

async function ensurePinnedRepository({ directory, url, commit }) {
  await mkdir(toolsRoot, { recursive: true });
  if (!await exists(resolve(directory, ".git"))) {
    if (await exists(directory)) {
      throw new Error(`Refusing to replace non-Git path: ${directory}`);
    }
    await run("git", ["init", directory]);
    await run("git", ["-C", directory, "remote", "add", "origin", url]);
  }

  const current = await execFile("git", ["-C", directory, "rev-parse", "HEAD"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
  if (current !== commit) {
    await run("git", ["-C", directory, "fetch", "--depth", "1", "origin", commit]);
    await run("git", ["-C", directory, "checkout", "--detach", "FETCH_HEAD"]);
  }

  const verified = (await execFile("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim();
  if (verified !== commit) {
    throw new Error(`Pinned source verification failed for ${url}: ${verified}`);
  }
}

async function compileModule(name) {
  const smacScripting = resolve(repositories.smac.directory, "addons/sourcemod/scripting");
  await run(compiler, [
    resolve(smacScripting, `${name}.sp`),
    `-i${resolve(sourceModScripting, "include")}`,
    `-i${resolve(smacScripting, "include")}`,
    `-i${resolve(repositories.multicolors.directory, "addons/sourcemod/scripting/include")}`,
    `-o${resolve(outputRoot, "plugins", `${name}.smx`)}`
  ]);
}

await Promise.all(Object.values(repositories).map(ensurePinnedRepository));
if (!await exists(compiler)) {
  throw new Error("Pinned SourceMod compiler is missing. Run npm run game:toolchain:install first.");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, "plugins"), { recursive: true });
await mkdir(resolve(outputRoot, "translations"), { recursive: true });
await mkdir(resolve(outputRoot, "licenses"), { recursive: true });
await mkdir(resolve(outputRoot, "source"), { recursive: true });

for (const moduleName of modules) {
  await compileModule(moduleName);
}

await cp(
  resolve(repositories.smac.directory, "addons/sourcemod/translations/smac.phrases.txt"),
  resolve(outputRoot, "translations/smac.phrases.txt")
);
await cp(resolve(repositories.smac.directory, "LICENSE.txt"), resolve(outputRoot, "licenses/SMAC-GPL-3.0.txt"));
await cp(resolve(repositories.multicolors.directory, "LICENSE"), resolve(outputRoot, "licenses/MultiColors-GPL-3.0.txt"));

for (const [name, repository] of Object.entries(repositories)) {
  const archive = resolve(outputRoot, "source", `${name}-${repository.commit}.tar.gz`);
  await mkdir(dirname(archive), { recursive: true });
  await run("git", ["-C", repository.directory, "archive", "--format=tar.gz", `--output=${archive}`, "HEAD"]);
}

await writeFile(resolve(outputRoot, "provenance.json"), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  policy: "server-side evidence only; automatic SMAC bans are disabled",
  modules,
  repositories: Object.fromEntries(Object.entries(repositories).map(([name, value]) => [name, {
    url: value.url,
    commit: value.commit,
    license: "GPL-3.0-or-later"
  }]))
}, null, 2)}\n`, "utf8");

console.log(`Built ${modules.length} pinned SMAC modules with corresponding source archives.`);
