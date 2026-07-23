import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests, getDatabase } from "../database/client.ts";
import type { RequestUser } from "../domain/request-user.ts";
import {
  assertMemberAccess,
  createMember,
  deleteMember,
  setMemberPermission,
  updateMember
} from "../services/member.service.ts";
import { listMembers } from "../services/records.service.ts";

const admin: RequestUser = {
  id: "admin-user",
  displayName: "管理员",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: true
};
const viewer: RequestUser = {
  id: "viewer-user",
  displayName: "查看账号",
  provider: "fnos_gateway",
  authenticated: true,
  isGatewayAdmin: false
};

function withDatabase(run: () => void) {
  const storageDir = mkdtempSync(join(tmpdir(), "health-records-members-"));
  process.env.STORAGE_DIR = storageDir;
  try {
    const db = getDatabase();
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, ?)")
      .run(admin.id, admin.displayName, 1);
    db.prepare("INSERT INTO users (id, display_name, is_gateway_admin) VALUES (?, ?, ?)")
      .run(viewer.id, viewer.displayName, 0);
    db.prepare("INSERT INTO user_identities (id, user_id, provider, subject) VALUES (?, ?, 'fnos_gateway', ?)")
      .run("identity-admin-user", admin.id, admin.id);
    db.prepare("INSERT INTO user_identities (id, user_id, provider, subject) VALUES (?, ?, 'fnos_gateway', ?)")
      .run("identity-viewer-user", viewer.id, viewer.id);
    run();
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

test("manages a family member and viewer access with audit records", () => {
  withDatabase(() => {
    const created = createMember(admin, {
      displayName: " 小明 ",
      relationship: "child",
      birthDate: "2020-05-10",
      sex: "male"
    });
    assert.equal(created.displayName, "小明");
    assert.equal(listMembers(admin).length, 1);

    const updated = updateMember(admin, created.id, { displayName: "小明同学", sex: "unknown" });
    assert.equal(updated.displayName, "小明同学");
    assert.equal(updated.sex, "unknown");

    setMemberPermission(admin, created.id, { userId: viewer.id, permission: "viewer" });
    assert.equal(assertMemberAccess(viewer, created.id), "viewer");
    assert.equal(listMembers(viewer)[0]?.displayName, "小明同学");

    assert.deepEqual(deleteMember(admin, created.id), { id: created.id, deleted: true });
    assert.equal(listMembers(admin).length, 0);
    const auditCount = getDatabase().prepare(`
      SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ?
    `).get(created.id) as { count: number };
    assert.equal(auditCount.count, 4);
  });
});

test("rejects non-admin member changes and protects self records", () => {
  withDatabase(() => {
    const viewerCreated = createMember(viewer, { displayName: "孩子", relationship: "child" });
    assert.equal(viewerCreated.permission, "manager");
    assert.equal(listMembers(viewer).some((member) => member.id === viewerCreated.id), true);
    const viewerUpdated = updateMember(viewer, viewerCreated.id, { displayName: "孩子档案" });
    assert.equal(viewerUpdated.displayName, "孩子档案");
    assert.deepEqual(deleteMember(viewer, viewerCreated.id), { id: viewerCreated.id, deleted: true });

    getDatabase().prepare(`
      INSERT INTO health_members (id, display_name, relationship, created_by)
      VALUES ('member-self', '管理员', 'self', ?)
    `).run(admin.id);
    getDatabase().prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES ('member-self', ?, 'manager', ?)
    `).run(admin.id, admin.id);
    assert.throws(
      () => deleteMember(admin, "member-self"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
  });
});

test("prevents viewer-only users from editing member profiles or permissions", () => {
  withDatabase(() => {
    const created = createMember(admin, { displayName: "父亲", relationship: "parent" });
    setMemberPermission(admin, created.id, { userId: viewer.id, permission: "viewer" });
    assert.throws(
      () => updateMember(viewer, created.id, { displayName: "不能改" }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403
    );
    assert.throws(
      () => setMemberPermission(viewer, created.id, { userId: viewer.id, permission: "manager" }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 403
    );
  });
});
