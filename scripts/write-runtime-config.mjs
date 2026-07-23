#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

const storageDir = resolve(process.argv[2] || ".data");
const configPath = join(storageDir, "config", "runtime.json");

function currentConfig() {
  if (!existsSync(configPath)) return {};
  try { return JSON.parse(readFileSync(configPath, "utf8")); } catch { return {}; }
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("服务端口必须是 1024 到 65535 之间的整数");
  }
  return port;
}

function checkPort(port) {
  return new Promise((resolveCheck, rejectCheck) => {
    const server = createServer();
    server.unref();
    server.once("error", () => rejectCheck(new Error(`端口 ${port} 已被占用`)));
    server.listen(port, "0.0.0.0", () => server.close(resolveCheck));
  });
}

function writeJsonAtomic(path, value, modeValue = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: modeValue });
  renameSync(temporary, path);
  chmodSync(path, modeValue);
}

const previous = currentConfig();
const servicePort = validatePort(process.env.wizard_service_port || previous.servicePort || previous.directPort || 3334);
if (servicePort !== previous.servicePort && servicePort !== previous.directPort) await checkPort(servicePort);

writeJsonAtomic(configPath, { servicePort });

console.log(`健康档案运行配置已保存，服务端口：${servicePort}`);
