// Checks that assets/zip.js writes archives that unzip to the original JSON.
// Run with: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const here = path.dirname(new URL(import.meta.url).pathname);
new Function(fs.readFileSync(path.join(here, "..", "assets", "zip.js"), "utf8"))();
const { ZipWriter, gzipToDeflate } = globalThis.RubricZip;

async function buildZip(files, text) {
  const chunks = [];
  const zip = ZipWriter((c) => { chunks.push(Buffer.from(c)); });
  for (const [name, body] of files) await zip.addGzip(name, new Uint8Array(zlib.gzipSync(body)));
  if (text) await zip.addText(text[0], text[1]);
  await zip.finish();
  return Buffer.concat(chunks);
}

function unzipTo(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-zip-"));
  fs.writeFileSync(path.join(dir, "out.zip"), buf);
  execFileSync("unzip", ["-q", "out.zip", "-d", "x"], { cwd: dir });
  return path.join(dir, "x");
}

test("gzip members are copied into the ZIP and unzip to the original bytes", async () => {
  const files = [
    ["reports/1EHZ.json", JSON.stringify({ pdb_id: "1EHZ", pairs: Array.from({ length: 500 }, (_, i) => ({ i })) })],
    ["reports/EMPTY.json", ""],
    ["reports/4V4G.json", "x".repeat(2_000_000)],
  ];
  const dir = unzipTo(await buildZip(files, ["reports/missing.txt", "9ZZZ\n"]));
  for (const [name, body] of files) assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), body);
  assert.equal(fs.readFileSync(path.join(dir, "reports/missing.txt"), "utf8"), "9ZZZ\n");
});

test("the archive passes unzip's integrity check", async () => {
  const buf = await buildZip([["a.json", "{}"]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rubric-zip-"));
  fs.writeFileSync(path.join(dir, "t.zip"), buf);
  execFileSync("unzip", ["-tq", "t.zip"], { cwd: dir });
});

test("gzip headers with a file name are skipped correctly", () => {
  const body = Buffer.from('{"a":1}');
  const plain = zlib.gzipSync(body);
  // Set FNAME and insert a name after the 10-byte header, as gzip(1) does.
  const named = Buffer.concat([plain.subarray(0, 3), Buffer.from([8]), plain.subarray(4, 10),
    Buffer.from("x.json\0"), plain.subarray(10)]);
  const d = gzipToDeflate(new Uint8Array(named));
  assert.equal(d.size, body.length);
  assert.deepEqual(zlib.inflateRawSync(d.data), body);
});

test("input that is not gzip is rejected", () => {
  assert.throws(() => gzipToDeflate(new Uint8Array(Buffer.from('{"not":"gzip","padding":"........"}'))), /not gzip/);
});
