import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "renderer");
const dest = join(root, "dist", "renderer");

mkdirSync(dest, { recursive: true });
for (const name of ["index.html", "styles.css"]) {
  copyFileSync(join(src, name), join(dest, name));
}
