// Copies non-TS assets next to the compiled output (Drizzle migrations for the release phase).
import fs from "node:fs";
fs.cpSync("db/migrations", "dist/db/migrations", { recursive: true });
console.log("copied db/migrations -> dist/db/migrations");
