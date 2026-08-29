import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const assets = new URL("../dist/assets/", import.meta.url);
const files = (await readdir(assets)).filter(name => name.endsWith(".js"));
assert.ok(files.length, "run npm run build before checking the production bundle");
const bundle = (await Promise.all(files.map(name => readFile(new URL(name, assets), "utf8")))).join("\n");
assert.doesNotMatch(bundle, /__buildPartyWebMcp|Development-only console harness/);
console.log("Production bundle excludes the WebMCP development harness.");
