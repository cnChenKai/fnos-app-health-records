import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getDeploymentCopy } from "../../ui/src/utils/deployment-copy.ts";

test("uses deployment-specific directory and administrator guidance", () => {
  const fnos = getDeploymentCopy("fnos");
  assert.match(fnos.importEmptyDescription, /飞牛.*授权目录/);
  assert.doesNotMatch(fnos.importEmptyDescription, /Docker/);
  assert.equal(fnos.administrator, "飞牛管理员");

  const docker = getDeploymentCopy("local");
  assert.match(docker.importEmptyDescription, /Docker Compose.*REPORTS_HOST_PATH/);
  assert.doesNotMatch(docker.importEmptyDescription, /飞牛|fnOS/);
  assert.equal(docker.administrator, "Docker 管理员");

  const development = getDeploymentCopy("development");
  assert.match(development.importEmptyDescription, /IMPORT_ROOTS/);
  assert.equal(development.administrator, "开发管理员");
});

test("keeps shared client connection errors deployment-neutral", () => {
  for (const path of ["packages/ui/src/utils/api.ts", "packages/ui/src/utils/download.ts"]) {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    assert.doesNotMatch(source, /请检查网络或 fnOS 网关状态/);
    assert.match(source, /请检查网络与应用服务状态/);
  }
});
