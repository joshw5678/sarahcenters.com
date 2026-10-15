const fs = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const entries = [
  "favicon.png",
  "index.html",
  "admin.html",
  "success.html",
  "login.html",
  "create-account.html",
  "forgot-password.html",
  "reset-password.html",
  "verify-email.html",
  "account.html",
  "library.html",
  "claim-purchase.html",
  "src",
  "images",
  "assets",
];

async function build() {
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });

  await Promise.all(
    entries.map(async (entry) => {
      await fs.cp(path.join(root, entry), path.join(output, entry), {
        recursive: true,
        filter: (source) => path.basename(source) !== ".DS_Store",
      });
    })
  );

  console.log(`Prepared Worker static assets in ${output}`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
