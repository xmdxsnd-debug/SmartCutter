const fs = require("node:fs");
const path = require("node:path");

const userAgent = process.env.npm_config_user_agent || "";
if (!userAgent.startsWith("pnpm/")) {
  console.error("This workspace must be installed with pnpm.");
  process.exit(1);
}

for (const lockfile of ["package-lock.json", "yarn.lock"]) {
  fs.rmSync(path.join(process.cwd(), lockfile), { force: true });
}
