import { cpSync, existsSync } from "node:fs";

const from = "src/observability/static";
const to = "dist/observability/static";

if (existsSync(from)) {
  cpSync(from, to, { recursive: true });
}
