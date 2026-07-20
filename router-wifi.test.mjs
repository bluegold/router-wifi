import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BAND_CONFIG,
  buildCronIntervalSpec,
  buildCronBlock,
  convertLikeCurrent,
  extractCsrfToken,
  formatLocalTimestamp,
  isWithinEnabledWindow,
  normalizeBoolean,
  outputResult,
  parseArgs,
  parseIntervalMinutes,
  parseTimeSpec,
  readPasswordFromEnvOrFile,
  removeManagedBlock,
  resolveBandConfig,
  serializeCookies,
  splitSetCookie,
  unique,
  upsertManagedBlock,
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

test("parseTimeSpec parses HH:MM", () => {
  assert.deepEqual(parseTimeSpec("07:05"), { hour: "7", minute: "5" });
  assert.deepEqual(parseTimeSpec("23:45"), { hour: "23", minute: "45" });
});

test("buildCronBlock creates on/off entries for default band", () => {
  const block = buildCronBlock({
    on: "07:00",
    off: "23:30",
    wrapper: "/tmp/router-wifi",
  });

  assert.match(block, /BEGIN router-wifi schedule/);
  assert.match(
    block,
    /\*\/15 \* \* \* \* \/tmp\/router-wifi guard --band 5g --on 07:00 --off 23:30 --log-file .*router-wifi\.log/,
  );
  assert.match(block, /END router-wifi schedule/);
});

test("buildCronBlock includes router override and band", () => {
  const block = buildCronBlock({
    band: "24g",
    on: "08:15",
    off: "22:45",
    wrapper: "/tmp/router-wifi",
    router: "http://192.0.2.1",
    interval: "10",
    logFile: "/tmp/router-wifi.log",
  });

  assert.match(
    block,
    /\*\/10 \* \* \* \* \/tmp\/router-wifi guard --band 24g --on 08:15 --off 22:45 --router http:\/\/192\.0\.2\.1 --log-file \/tmp\/router-wifi\.log/,
  );
});

test("upsertManagedBlock appends managed cron block", () => {
  const block = "# BEGIN router-wifi schedule\n0 7 * * * cmd\n# END router-wifi schedule";
  const current = "MAILTO=user@example.com\n0 0 * * * /bin/true\n";
  const updated = upsertManagedBlock(current, block);

  assert.equal(
    updated,
    "MAILTO=user@example.com\n0 0 * * * /bin/true\n\n# BEGIN router-wifi schedule\n0 7 * * * cmd\n# END router-wifi schedule\n",
  );
});

test("removeManagedBlock removes only managed section", () => {
  const current = [
    "MAILTO=user@example.com",
    "# BEGIN router-wifi schedule",
    "0 7 * * * cmd",
    "# END router-wifi schedule",
    "0 0 * * * /bin/true",
    "",
  ].join("\n");

  assert.equal(removeManagedBlock(current), "MAILTO=user@example.com\n0 0 * * * /bin/true");
});

test("isWithinEnabledWindow handles daytime window", () => {
  assert.equal(isWithinEnabledWindow({ on: "07:00", off: "23:00", now: "06:59" }), false);
  assert.equal(isWithinEnabledWindow({ on: "07:00", off: "23:00", now: "07:00" }), true);
  assert.equal(isWithinEnabledWindow({ on: "07:00", off: "23:00", now: "22:59" }), true);
  assert.equal(isWithinEnabledWindow({ on: "07:00", off: "23:00", now: "23:00" }), false);
});

test("isWithinEnabledWindow handles overnight window", () => {
  assert.equal(isWithinEnabledWindow({ on: "23:00", off: "07:00", now: "22:59" }), false);
  assert.equal(isWithinEnabledWindow({ on: "23:00", off: "07:00", now: "23:00" }), true);
  assert.equal(isWithinEnabledWindow({ on: "23:00", off: "07:00", now: "02:00" }), true);
  assert.equal(isWithinEnabledWindow({ on: "23:00", off: "07:00", now: "07:00" }), false);
});

test("parseIntervalMinutes validates interval", () => {
  assert.equal(parseIntervalMinutes("15"), 15);
  assert.equal(parseIntervalMinutes("60"), 60);
});

test("buildCronIntervalSpec formats cron minute field", () => {
  assert.equal(buildCronIntervalSpec(15), "*/15 * * * *");
  assert.equal(buildCronIntervalSpec(60), "0 * * * *");
});

test("outputResult appends JSON line to log file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "router-wifi-log-test-"));
  const logFile = path.join(tempDir, "router.log");
  const originalConsoleLog = console.log;
  console.log = () => {};

  try {
    await outputResult(
      { logFile },
      {
        band: "5g",
        changed: false,
        desired: "off",
        current: "off",
      },
    );
  } finally {
    console.log = originalConsoleLog;
  }

  const content = await readFile(logFile, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.band, "5g");
  assert.equal(parsed.changed, false);
  assert.equal(parsed.desired, "off");
  assert.equal(parsed.current, "off");
  assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("formatLocalTimestamp formats local time with offset", () => {
  const date = new Date("2026-07-20T03:04:05+09:00");
  const formatted = formatLocalTimestamp(date);
  assert.match(formatted, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
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
