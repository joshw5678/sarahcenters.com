import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const entries = [
  "favicon.png", "index.html", "admin.html", "success.html", "login.html",
  "create-account.html", "forgot-password.html", "reset-password.html", "verify-email.html",
  "account.html", "library.html", "claim-purchase.html", "images", "assets",
];

async function buildAssets(): Promise<void> {
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.join(output, "src"), { recursive: true });
  await Promise.all(entries.map((entry) => fs.cp(path.join(root, entry), path.join(output, entry), {
    recursive: true, filter: (source) => path.basename(source) !== ".DS_Store",
  })));
  await fs.copyFile(path.join(root, "src/styles.css"), path.join(output, "src/styles.css"));
  await build({
    absWorkingDir: root,
    entryPoints: ["src/main.ts", "src/account.ts", "src/admin.ts", "src/success.ts"],
    outdir: path.join(output, "src"), bundle: true, platform: "browser", format: "iife",
    target: "es2022", minify: true, legalComments: "none",
  });
  console.log(`Prepared Worker static assets in ${output}`);
}

buildAssets().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
