// Встраивает файлы из public/ в src/assets.generated.js, чтобы воркер отдавал их сам.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

const entries = {};
for (const name of readdirSync(dir).sort()) {
  const type = TYPES[extname(name)];
  if (!type) continue;
  const buf = readFileSync(join(dir, name));
  entries[`/${name}`] = type.startsWith("text/") ? { type, text: buf.toString("utf8") } : { type, base64: buf.toString("base64") };
}
writeFileSync(
  join(root, "src", "assets.generated.js"),
  `// Сгенерировано scripts/build-assets.mjs — не редактируйте вручную.\nexport const ASSETS = ${JSON.stringify(entries)};\n`,
);
console.log(`assets: ${Object.keys(entries).join(", ")}`);
