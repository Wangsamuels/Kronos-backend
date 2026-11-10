/** Writes the OpenAPI 3.1 contract to contracts/openapi.json (the frontend generates its client from it). */
import fs from "node:fs";
import { buildApp } from "../api/app.js";

const app = await buildApp();
await app.ready();
const spec = app.swagger();
fs.writeFileSync("contracts/openapi.json", JSON.stringify(spec, null, 2) + "\n");
console.log(`wrote contracts/openapi.json (${Object.keys(spec.paths ?? {}).length} paths)`);
await app.close();
process.exit(0);
