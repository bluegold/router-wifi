import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BAND_CONFIG,
  convertLikeCurrent,
  extractCsrfToken,
  normalizeBoolean,
  parseArgs,
  readPasswordFromEnvOrFile,
  resolveBandConfig,
  serializeCookies,
  splitSetCookie,
  unique,
  withCsrf,
} from "./router-wifi.mjs";

test("parseArgs parses flags and positionals", () => {
  const parsed = parseArgs([
    "set",
    "--band",
    "24g",
    "--enabled=off",
    "--verbose",
    "extra",
  ]);

  assert.deepEqual(parsed.positionals, ["set", "extra"]);
  assert.deepEqual(parsed.flags, {
    band: "24g",
    enabled: "off",
    verbose: true,
  });
});

test("withCsrf appends token in router-specific format", () => {
  assert.equal(withCsrf("/api/stat/5g_enable", "TOKEN123"), "/api/stat/5g_enable&csrf_token=TOKEN123");
  assert.equal(
    withCsrf("/api/stat/5g_enable&csrf_token=TOKEN123", "TOKEN456"),
    "/api/stat/5g_enable&csrf_token=TOKEN123",
  );
  assert.equal(withCsrf("/api/stat/5g_enable", ""), "/api/stat/5g_enable");
});

test("extractCsrfToken returns token from inline script", () => {
  const html = "<script>var csrf_token = 'ABC123';</script>";
  assert.equal(extractCsrfToken(html), "ABC123");
  assert.equal(extractCsrfToken("<html></html>"), "");
});

test("normalizeBoolean handles router values", () => {
  assert.equal(normalizeBoolean("on"), true);
  assert.equal(normalizeBoolean("off"), false);
  assert.equal(normalizeBoolean("1"), true);
  assert.equal(normalizeBoolean("0"), false);
  assert.equal(normalizeBoolean(true), true);
  assert.equal(normalizeBoolean(false), false);
  assert.equal(normalizeBoolean("unknown"), null);
});

test("convertLikeCurrent preserves the current value type", () => {
  assert.equal(convertLikeCurrent("on", "off"), "on");
  assert.equal(convertLikeCurrent("off", "on"), "off");
  assert.equal(convertLikeCurrent("enabled", true), true);
  assert.equal(convertLikeCurrent("off", true), false);
  assert.equal(convertLikeCurrent("1", 0), 1);
  assert.equal(convertLikeCurrent("false", 1), 0);
});

test("resolveBandConfig uses defaults for each band", () => {
  assert.deepEqual(resolveBandConfig({}, "5g"), BAND_CONFIG["5g"]);
  assert.deepEqual(resolveBandConfig({}, "24g"), BAND_CONFIG["24g"]);
});

test("resolveBandConfig allows explicit overrides", () => {
  assert.deepEqual(resolveBandConfig(
    {
      endpoint: "/api/custom",
      field: "enabled",
      ssidField: "ssid",
    },
    "5g",
  ), {
    endpoint: "/api/custom",
    field: "enabled",
    ssidField: "ssid",
  });
});

test("serializeCookies formats Cookie header", () => {
  const cookies = new Map([
    ["token", "abc"],
    ["lang", "ja"],
  ]);
  assert.equal(serializeCookies(cookies), "token=abc; lang=ja");
});

test("splitSetCookie separates multiple cookies", () => {
  const header = "token=abc; Path=/; HttpOnly, lang=ja; Path=/";
  assert.deepEqual(splitSetCookie(header), [
    "token=abc; Path=/; HttpOnly",
    " lang=ja; Path=/",
  ]);
});

test("unique removes duplicates while preserving order", () => {
  assert.deepEqual(unique(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
});

test("readPasswordFromEnvOrFile reads ROUTER_PASSWORD first", async () => {
  const previousPassword = process.env.ROUTER_PASSWORD;
  const previousPasswordFile = process.env.ROUTER_PASSWORD_FILE;

  process.env.ROUTER_PASSWORD = "direct-secret";
  process.env.ROUTER_PASSWORD_FILE = "/does/not/matter";

  try {
    assert.equal(await readPasswordFromEnvOrFile(), "direct-secret");
  } finally {
    restoreEnv("ROUTER_PASSWORD", previousPassword);
    restoreEnv("ROUTER_PASSWORD_FILE", previousPasswordFile);
  }
});

test("readPasswordFromEnvOrFile reads and trims password file", async () => {
  const previousPassword = process.env.ROUTER_PASSWORD;
  const previousPasswordFile = process.env.ROUTER_PASSWORD_FILE;

  delete process.env.ROUTER_PASSWORD;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "router-wifi-test-"));
  const passwordFile = path.join(tempDir, "password");
  await writeFile(passwordFile, " file-secret \n", "utf8");
  process.env.ROUTER_PASSWORD_FILE = passwordFile;

  try {
    assert.equal(await readPasswordFromEnvOrFile(), "file-secret");
  } finally {
    restoreEnv("ROUTER_PASSWORD", previousPassword);
    restoreEnv("ROUTER_PASSWORD_FILE", previousPasswordFile);
  }
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
