#!/usr/bin/env node

import { publicEncrypt, constants } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "http://192.168.244.254";
const SNAPSHOT_DIR = path.resolve(".router-snapshots");
const DEFAULT_WRAPPER_PATH = path.resolve("router-wifi");
const DEFAULT_LOG_FILE = path.resolve("router-wifi.log");
export const BAND_CONFIG = {
  "5g": {
    endpoint: "/api/stat/5g_enable",
    field: "5g_enabled",
    ssidField: "5g_ssid",
  },
  "24g": {
    endpoint: "/api/stat/24g_enable",
    field: "24g_enabled",
    ssidField: "24g_ssid",
  },
};
export const DEFAULT_BAND = "5g";
const BOOLEAN_FLAGS = new Set(["help", "verbose"]);
const execFileAsync = promisify(execFile);
const CRON_BEGIN_MARKER = "# BEGIN router-wifi schedule";
const CRON_END_MARKER = "# END router-wifi schedule";

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [command] = args.positionals;

  if (!command || args.flags.help) {
    printHelp();
    process.exit(args.flags.help ? 0 : 1);
  }

  const client = new RouterClient({
    baseUrl: args.flags.router ?? DEFAULT_BASE_URL,
    verbose: Boolean(args.flags.verbose),
  });

  switch (command) {
    case "discover":
      await requireCredentials(args.flags);
      await client.login({
        username: args.flags.username,
        password: args.flags.password,
      });
      await runDiscover(client, args.flags);
      break;
    case "fetch":
      await requireCredentials(args.flags);
      requireFlag(args.flags.path, "--path");
      await client.login({
        username: args.flags.username,
        password: args.flags.password,
      });
      await runFetch(client, args.flags.path);
      break;
    case "status":
      await requireCredentials(args.flags);
      await client.login({
        username: args.flags.username,
        password: args.flags.password,
      });
      await runStatus(client, args.flags);
      break;
    case "set":
      await requireCredentials(args.flags);
      requireFlag(args.flags.enabled, "--enabled");
      await client.login({
        username: args.flags.username,
        password: args.flags.password,
      });
      await runSet(client, args.flags);
      break;
    case "guard":
      await requireCredentials(args.flags);
      requireFlag(args.flags.on, "--on");
      requireFlag(args.flags.off, "--off");
      await client.login({
        username: args.flags.username,
        password: args.flags.password,
      });
      await runGuard(client, args.flags);
      break;
    case "schedule":
      await runSchedule(args.flags);
      break;
    default:
      fail(`未知のコマンドです: ${command}`);
  }
}

async function runDiscover(client, flags) {
  const targets = [
    "pages.html",
    "main.html",
    "PAGE_STAT.html",
    "PAGE_WIFI_24G.html",
    "PAGE_WIFI_24G_ACBL.html",
    "PAGE_WIFI_5G.html",
    "PAGE_WIFI_5G_ACBL.html",
    "js/models.js",
    "js/collections.js",
    "js/views.js",
    "js/PAGES.js",
  ];

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputDir = path.join(SNAPSHOT_DIR, timestamp);
  await mkdir(outputDir, { recursive: true });

  const summary = [];
  for (const target of targets) {
    try {
      const text = await client.fetchText(target);
      const fileName = target.replaceAll("/", "__");
      const filePath = path.join(outputDir, fileName);
      await writeFile(filePath, text, "utf8");
      summary.push({
        target,
        filePath,
        apiPaths: unique(text.match(/\/api\/[A-Za-z0-9_./?-]+/g) ?? []),
        wifiFields: unique(
          [...text.matchAll(/['"]([0-9a-z_]+(?:wifi|wps|ssid|enable|function)[0-9a-z_]*)['"]/gi)].map(
            (match) => match[1],
          ),
        ),
      });
    } catch (error) {
      summary.push({
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report = {
    router: client.baseUrl,
    createdAt: new Date().toISOString(),
    summary,
  };
  const reportPath = path.join(outputDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`snapshot: ${outputDir}`);
  console.log(`report: ${reportPath}`);
  for (const item of summary) {
    if (item.error) {
      console.log(`- ${item.target}: ERROR ${item.error}`);
      continue;
    }
    const apiPreview = item.apiPaths.slice(0, 5).join(", ") || "(none)";
    const fieldPreview = item.wifiFields.slice(0, 8).join(", ") || "(none)";
    console.log(`- ${item.target}`);
    console.log(`  api: ${apiPreview}`);
    console.log(`  fields: ${fieldPreview}`);
  }
}

async function runFetch(client, targetPath) {
  const text = await client.fetchText(targetPath);
  process.stdout.write(text);
}

async function runStatus(client, flags) {
  const results = {};

  for (const band of Object.keys(BAND_CONFIG)) {
    const config = resolveBandConfig(flags, band);
    const payload = await client.fetchJson(client.withCsrf(config.endpoint));
    const value = payload[config.field];
    if (value === undefined) {
      fail(`フィールド ${config.field} が見つかりません`);
    }

    results[band] = {
      endpoint: config.endpoint,
      field: config.field,
      ssidField: config.ssidField,
      ssid: payload[config.ssidField],
      value,
      enabled: normalizeBoolean(value),
      payload,
    };
  }

  console.log(JSON.stringify(results, null, 2));
}

async function runSet(client, flags) {
  const band = flags.band ?? DEFAULT_BAND;
  const config = resolveBandConfig(flags, band);

  const current = await client.fetchJson(client.withCsrf(config.endpoint));
  if (!(config.field in current)) {
    fail(`フィールド ${config.field} が見つかりません`);
  }
  if (!(config.ssidField in current)) {
    fail(`SSID フィールド ${config.ssidField} が見つかりません`);
  }

  const nextValue = convertLikeCurrent(flags.enabled, current[config.field]);
  const nextPayload = {
    [config.ssidField]: current[config.ssidField],
    [config.field]: nextValue,
  };
  const updated = await client.saveJson(config.endpoint, nextPayload);

  console.log(
    JSON.stringify(
      {
        band,
        endpoint: config.endpoint,
        field: config.field,
        previous: current[config.field],
        next: nextValue,
        payload: nextPayload,
        response: updated,
      },
      null,
      2,
    ),
  );
}

export async function runGuard(client, flags) {
  const band = flags.band ?? DEFAULT_BAND;
  const config = resolveBandConfig(flags, band);
  const current = await client.fetchJson(client.withCsrf(config.endpoint));
  if (!(config.field in current)) {
    fail(`フィールド ${config.field} が見つかりません`);
  }
  if (!(config.ssidField in current)) {
    fail(`SSID フィールド ${config.ssidField} が見つかりません`);
  }

  const desiredEnabled = isWithinEnabledWindow({
    on: flags.on,
    off: flags.off,
    now: flags.now ?? currentTimeString(),
  });
  const currentEnabled = normalizeBoolean(current[config.field]);
  if (currentEnabled === null) {
    fail(`現在値 ${JSON.stringify(current[config.field])} を true/false に解釈できません`);
  }

  if (currentEnabled === desiredEnabled) {
    await outputResult(flags, {
      band,
      changed: false,
      desired: desiredEnabled ? "on" : "off",
      current: current[config.field],
    });
    return;
  }

  const nextPayload = {
    [config.ssidField]: current[config.ssidField],
    [config.field]: convertLikeCurrent(desiredEnabled ? "on" : "off", current[config.field]),
  };
  const updated = await client.saveJson(config.endpoint, nextPayload);
  await outputResult(flags, {
    band,
    changed: true,
    desired: desiredEnabled ? "on" : "off",
    previous: current[config.field],
    payload: nextPayload,
    response: updated,
  });
}

export async function runSchedule(flags) {
  const action = flags.action ?? "show";

  switch (action) {
    case "show": {
      requireFlag(flags.on, "--on");
      requireFlag(flags.off, "--off");
      const cronBlock = buildCronBlock(flags);
      process.stdout.write(`${cronBlock}\n`);
      break;
    }
    case "install": {
      requireFlag(flags.on, "--on");
      requireFlag(flags.off, "--off");
      const cronBlock = buildCronBlock(flags);
      const current = await readCrontab();
      const next = upsertManagedBlock(current, cronBlock);
      await writeCrontab(next);
      console.log("router-wifi schedule を crontab に登録しました");
      break;
    }
    case "remove": {
      const current = await readCrontab();
      const next = removeManagedBlock(current);
      await writeCrontab(next);
      console.log("router-wifi schedule を crontab から削除しました");
      break;
    }
    default:
      fail(`未対応の schedule action です: ${action}`);
  }
}

export class RouterClient {
  constructor({ baseUrl, verbose }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.verbose = verbose;
    this.cookies = new Map();
    this.csrfToken = "";
    this.loginInfo = null;
  }

  async login({ username, password }) {
    this.loginInfo = await this.fetchJson("/api/login");

    const encryptedUsername = encryptWithRouterKey(username, this.loginInfo.enc_pub_key);
    const encryptedPassword = encryptWithRouterKey(password, this.loginInfo.enc_pub_key);

    const response = await this.fetchJson("/api/login", {
      method: "POST",
      json: {
        username: encryptedUsername,
        password: encryptedPassword,
      },
    });

    if (response.return_code !== "1") {
      fail(`ログイン失敗: return_code=${response.return_code ?? "(none)"}`);
    }

    const pagesHtml = await this.fetchText("/pages.html");
    this.csrfToken = extractCsrfToken(pagesHtml);
    return response;
  }

  async fetchJson(targetPath, options = {}) {
    const text = await this.fetchText(targetPath, {
      ...options,
      headers: {
        Accept: "application/json, text/plain, */*",
        ...(options.headers ?? {}),
      },
    });

    try {
      return JSON.parse(text);
    } catch (error) {
      fail(`JSON 解析失敗: ${targetPath}\n${text.slice(0, 400)}`);
    }
  }

  async saveJson(targetPath, payload) {
    return this.fetchJson(this.withCsrf(targetPath), {
      method: "POST",
      json: payload,
    });
  }

  withCsrf(targetPath) {
    return withCsrf(targetPath, this.csrfToken);
  }

  async fetchText(targetPath, options = {}) {
    const url = this.toUrl(targetPath);
    const headers = new Headers(options.headers ?? {});
    if (!headers.has("Accept")) {
      headers.set("Accept", "text/html,application/json;q=0.9,*/*;q=0.8");
    }

    const cookieHeader = serializeCookies(this.cookies);
    if (cookieHeader) {
      headers.set("Cookie", cookieHeader);
    }

    let body;
    if (options.json) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    }

    if (this.verbose) {
      console.error(`${options.method ?? "GET"} ${url}`);
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body,
      redirect: "manual",
    });

    this.captureCookies(response.headers);
    const text = await response.text();

    if (response.status >= 400) {
      fail(`HTTP ${response.status} ${response.statusText}: ${targetPath}\n${text.slice(0, 400)}`);
    }

    return text;
  }

  toUrl(targetPath) {
    if (/^https?:\/\//.test(targetPath)) {
      return targetPath;
    }
    return new URL(targetPath.startsWith("/") ? targetPath : `/${targetPath}`, this.baseUrl).toString();
  }

  captureCookies(headers) {
    const setCookies = headers.getSetCookie?.() ?? splitSetCookie(headers.get("set-cookie"));
    for (const value of setCookies) {
      const [pair] = value.split(";", 1);
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
}

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (BOOLEAN_FLAGS.has(key) && inlineValue === undefined) {
      flags[key] = true;
      continue;
    }
    const next = inlineValue ?? argv[index + 1];
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }

  return { flags, positionals };
}

export function printHelp() {
  console.log(`usage:
  router-wifi discover --username USER --password PASS [--router URL]
  router-wifi fetch --username USER --password PASS --path PATH
  router-wifi status --username USER --password PASS
  router-wifi set --username USER --password PASS --enabled on|off [--band 5g|24g]
  router-wifi guard --username USER --password PASS [--band 5g|24g] --on HH:MM --off HH:MM [--log-file PATH]
  router-wifi schedule --action show|install|remove [--band 5g|24g] [--on HH:MM] [--off HH:MM] [--interval MINUTES] [--log-file PATH]

examples:
  router-wifi discover --username admin --password secret
  router-wifi status --username admin --password secret
  router-wifi set --username admin --password secret --enabled off
  router-wifi set --username admin --password secret --band 24g --enabled on
  router-wifi guard --username admin --password secret --on 07:00 --off 23:00
  router-wifi schedule --on 07:00 --off 23:00
  router-wifi schedule --action install --band 24g --on 08:00 --off 22:00 --log-file /var/log/router-wifi.log`);
}

export async function requireCredentials(flags) {
  if (!flags.username) {
    flags.username = process.env.ROUTER_USERNAME ?? "";
  }
  if (!flags.password) {
    flags.password = await readPasswordFromEnvOrFile();
  }
  requireFlag(flags.username, "--username or ROUTER_USERNAME env");
  requireFlag(flags.password, "--password or ROUTER_PASSWORD env");
}

export async function readPasswordFromEnvOrFile() {
  if (process.env.ROUTER_PASSWORD) {
    return process.env.ROUTER_PASSWORD;
  }

  const filePath = process.env.ROUTER_PASSWORD_FILE;
  if (!filePath) {
    return "";
  }

  return (await readFile(filePath, "utf8")).trim();
}

export function requireFlag(value, name) {
  if (value === undefined || value === "") {
    fail(`${name} が必要です`);
  }
}

export function encryptWithRouterKey(plainText, base64Body) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${base64Body}\n-----END PUBLIC KEY-----`;
  return publicEncrypt(
    {
      key: pem,
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(plainText, "utf8"),
  ).toString("base64");
}

export function extractCsrfToken(html) {
  const match = html.match(/var\s+csrf_token\s*=\s*['"]([^'"]*)['"]/);
  return match?.[1] ?? "";
}

export function withCsrf(targetPath, csrfToken) {
  if (!csrfToken) {
    return targetPath;
  }
  if (targetPath.includes("csrf_token=")) {
    return targetPath;
  }
  return `${targetPath}&csrf_token=${encodeURIComponent(csrfToken)}`;
}

export function serializeCookies(cookies) {
  return [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function splitSetCookie(header) {
  if (!header) {
    return [];
  }
  return header.split(/,(?=[^;]+=[^;]+)/g);
}

export function unique(values) {
  return [...new Set(values)];
}

export function normalizeBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "on" || value === "1" || value === 1 || value === "true") {
    return true;
  }
  if (value === "off" || value === "0" || value === 0 || value === "false") {
    return false;
  }
  return null;
}

export function convertLikeCurrent(input, current) {
  const enabled = /^(1|true|on|enable|enabled)$/i.test(input);

  if (typeof current === "boolean") {
    return enabled;
  }
  if (typeof current === "number") {
    return enabled ? 1 : 0;
  }
  if (typeof current === "string") {
    if (["on", "off"].includes(current)) {
      return enabled ? "on" : "off";
    }
    if (["1", "0"].includes(current)) {
      return enabled ? "1" : "0";
    }
    if (["true", "false"].includes(current)) {
      return enabled ? "true" : "false";
    }
  }

  fail(`現在値 ${JSON.stringify(current)} から有効/無効の型を推定できません`);
}

export function resolveBandConfig(flags, band) {
  if (!BAND_CONFIG[band]) {
    fail(`未対応の band です: ${band}`);
  }

  const base = BAND_CONFIG[band];
  return {
    endpoint: flags.endpoint ?? base.endpoint,
    field: flags.field ?? base.field,
    ssidField: flags.ssidField ?? base.ssidField,
  };
}

export function buildCronBlock(flags) {
  const band = flags.band ?? DEFAULT_BAND;
  if (!BAND_CONFIG[band]) {
    fail(`未対応の band です: ${band}`);
  }

  parseTimeSpec(flags.on);
  parseTimeSpec(flags.off);
  const intervalMinutes = parseIntervalMinutes(flags.interval ?? "15");
  const wrapperPath = shellEscape(flags.wrapper ?? DEFAULT_WRAPPER_PATH);
  const routerArg = flags.router ? ` --router ${shellEscape(flags.router)}` : "";
  const logFileArg = ` --log-file ${shellEscape(flags.logFile ?? DEFAULT_LOG_FILE)}`;
  const intervalSpec = buildCronIntervalSpec(intervalMinutes);

  return [
    CRON_BEGIN_MARKER,
    `${intervalSpec} ${wrapperPath} guard --band ${band} --on ${flags.on} --off ${flags.off}${routerArg}${logFileArg}`,
    CRON_END_MARKER,
  ].join("\n");
}

export function parseTimeSpec(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  if (!match) {
    fail(`時刻は HH:MM 形式で指定してください: ${value ?? ""}`);
  }
  return { hour: String(Number(match[1])), minute: String(Number(match[2])) };
}

export function isWithinEnabledWindow({ on, off, now }) {
  const onMinutes = timeSpecToMinutes(on);
  const offMinutes = timeSpecToMinutes(off);
  const nowMinutes = timeSpecToMinutes(now);

  if (onMinutes === offMinutes) {
    return true;
  }
  if (onMinutes < offMinutes) {
    return nowMinutes >= onMinutes && nowMinutes < offMinutes;
  }
  return nowMinutes >= onMinutes || nowMinutes < offMinutes;
}

export function timeSpecToMinutes(value) {
  const { hour, minute } = parseTimeSpec(value);
  return Number(hour) * 60 + Number(minute);
}

export function parseIntervalMinutes(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 60) {
    fail(`interval は 1 から 60 の整数で指定してください: ${value}`);
  }
  return number;
}

export function buildCronIntervalSpec(intervalMinutes) {
  if (intervalMinutes === 60) {
    return "0 * * * *";
  }
  return `*/${intervalMinutes} * * * *`;
}

export function upsertManagedBlock(currentCrontab, managedBlock) {
  const withoutManagedBlock = removeManagedBlock(currentCrontab).trimEnd();
  if (!withoutManagedBlock) {
    return `${managedBlock}\n`;
  }
  return `${withoutManagedBlock}\n\n${managedBlock}\n`;
}

export function removeManagedBlock(currentCrontab) {
  return currentCrontab
    .replace(new RegExp(`${escapeRegExp(CRON_BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(CRON_END_MARKER)}\\n?`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readCrontab() {
  try {
    const { stdout } = await execFileAsync("crontab", ["-l"]);
    return stdout;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && Number(error.code) === 1) {
      return "";
    }
    throw error;
  }
}

export async function writeCrontab(content) {
  const normalized = content.trim();
  const input = normalized ? `${normalized}\n` : "";
  await runCommandWithInput("crontab", ["-"], input);
}

export function shellEscape(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export async function outputResult(flags, payload) {
  const line = JSON.stringify({
    timestamp: formatLocalTimestamp(new Date()),
    ...payload,
  });
  console.log(JSON.stringify(payload, null, 2));

  const logFile = flags.logFile ?? DEFAULT_LOG_FILE;
  await mkdir(path.dirname(logFile), { recursive: true });
  await appendFile(logFile, `${line}\n`, "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentTimeString() {
  const now = new Date();
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

export function formatLocalTimestamp(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHour = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, "0");
  const offsetMinute = String(absoluteOffsetMinutes % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

async function runCommandWithInput(command, args, input) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim()}`));
    });

    child.stdin.end(input);
  });
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
