import { createError } from "h3";
import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";

const relationships = new Set(["spouse", "child", "parent", "sibling", "other"]);
const sexes = new Set(["male", "female", "unknown"]);
const permissions = new Set(["viewer", "manager"]);

type MemberInput = {
  displayName?: unknown;
  relationship?: unknown;
  birthDate?: unknown;
  sex?: unknown;
};

type PermissionInput = {
  userId?: unknown;
  permission?: unknown;
};

function requireAuthenticated(user: RequestUser) {
  if (!user.authenticated) throw createError({ statusCode: 401, statusMessage: "请先登录" });
}

function requireAdmin(user: RequestUser) {
  requireAuthenticated(user);
  if (!user.isGatewayAdmin) {
    throw createError({ statusCode: 403, statusMessage: "仅管理员可管理成员授权" });
  }
}

function requireMemberManager(user: RequestUser, memberId: string) {
  requireAuthenticated(user);
  if (user.isGatewayAdmin) return;
  const permission = assertMemberAccess(user, memberId);
  if (permission !== "manager") {
    throw createError({ statusCode: 403, statusMessage: "仅有管理权限的账号可修改家庭成员" });
  }
}

function cleanName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw createError({ statusCode: 400, statusMessage: "成员姓名不能为空" });
  if (name.length > 40) throw createError({ statusCode: 400, statusMessage: "成员姓名不能超过 40 个字符" });
  return name;
}

function cleanRelationship(value: unknown) {
  const relationship = typeof value === "string" ? value : "";
  if (!relationships.has(relationship)) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的家庭关系" });
  }
  return relationship;
}

function cleanBirthDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw createError({ statusCode: 400, statusMessage: "出生日期格式应为 YYYY-MM-DD" });
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw createError({ statusCode: 400, statusMessage: "出生日期无效" });
  }
  if (value > new Date().toISOString().slice(0, 10)) {
    throw createError({ statusCode: 400, statusMessage: "出生日期不能晚于今天" });
  }
  return value;
}

function cleanSex(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !sexes.has(value)) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的性别" });
  }
  return value;
}

function memberRow(memberId: string) {
  return getDatabase().prepare(`
    SELECT id, display_name AS displayName, relationship, birth_date AS birthDate,
      sex, avatar_path AS avatarPath, created_by AS createdBy
    FROM health_members WHERE id = ? AND deleted_at IS NULL
  `).get(memberId) as {
    id: string;
    displayName: string;
    relationship: string;
    birthDate: string | null;
    sex: string | null;
    avatarPath: string | null;
    createdBy: string;
  } | undefined;
}

function requireMember(memberId: string) {
  const member = memberRow(memberId);
  if (!member) throw createError({ statusCode: 404, statusMessage: "家庭成员不存在" });
  return member;
}

function audit(user: RequestUser, action: string, targetId: string, detail: Record<string, unknown> = {}) {
  getDatabase().prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
    VALUES (?, ?, ?, 'health_member', ?, ?)
  `).run(createId("audit"), user.id, action, targetId, JSON.stringify(detail));
}

export function createMember(user: RequestUser, input: MemberInput) {
  requireAuthenticated(user);
  const member = {
    id: createId("member"),
    displayName: cleanName(input.displayName),
    relationship: cleanRelationship(input.relationship),
    birthDate: cleanBirthDate(input.birthDate),
    sex: cleanSex(input.sex)
  };
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO health_members (id, display_name, relationship, birth_date, sex, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(member.id, member.displayName, member.relationship, member.birthDate, member.sex, user.id);
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, 'manager', ?)
    `).run(member.id, user.id, user.id);
    audit(user, "member.create", member.id, { relationship: member.relationship });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ...member, avatarPath: null, permission: "manager" as const };
}

export function updateMember(user: RequestUser, memberId: string, input: MemberInput) {
  const current = requireMember(memberId);
  requireMemberManager(user, memberId);
  const nextRelationship = input.relationship === undefined
    ? current.relationship
    : current.relationship === "self"
      ? "self"
      : cleanRelationship(input.relationship);
  const next = {
    displayName: input.displayName === undefined ? current.displayName : cleanName(input.displayName),
    relationship: nextRelationship,
    birthDate: input.birthDate === undefined ? current.birthDate : cleanBirthDate(input.birthDate),
    sex: input.sex === undefined ? current.sex : cleanSex(input.sex)
  };
  getDatabase().prepare(`
    UPDATE health_members SET display_name = ?, relationship = ?, birth_date = ?, sex = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(next.displayName, next.relationship, next.birthDate, next.sex, memberId);
  audit(user, "member.update", memberId);
  const permission = getDatabase().prepare(`
    SELECT permission FROM member_permissions WHERE member_id = ? AND user_id = ?
  `).get(memberId, user.id) as { permission: "viewer" | "manager" } | undefined;
  return { ...current, ...next, permission: permission?.permission || "manager" };
}

export function deleteMember(user: RequestUser, memberId: string) {
  const member = requireMember(memberId);
  requireMemberManager(user, memberId);
  if (member.relationship === "self") {
    throw createError({ statusCode: 409, statusMessage: "本人档案不能删除" });
  }
  getDatabase().prepare(`
    UPDATE health_members SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(memberId);
  audit(user, "member.delete", memberId);
  return { id: memberId, deleted: true };
}

export function listAccessUsers(user: RequestUser) {
  requireAdmin(user);
  return getDatabase().prepare(`
    SELECT u.id, u.display_name AS displayName, u.is_gateway_admin AS isAdmin,
      GROUP_CONCAT(DISTINCT ui.provider) AS providers
    FROM users u
    JOIN user_identities ui ON ui.user_id = u.id AND ui.provider IN ('fnos_gateway', 'development')
    GROUP BY u.id
    ORDER BY u.is_gateway_admin DESC, u.display_name
  `).all();
}

export function listMemberPermissions(user: RequestUser, memberId: string) {
  requireAdmin(user);
  requireMember(memberId);
  return getDatabase().prepare(`
    SELECT u.id AS userId, u.display_name AS displayName, mp.permission,
      GROUP_CONCAT(DISTINCT ui.provider) AS providers
    FROM member_permissions mp
    JOIN users u ON u.id = mp.user_id
    LEFT JOIN user_identities ui ON ui.user_id = u.id
    WHERE mp.member_id = ?
    GROUP BY u.id, mp.permission
    ORDER BY u.display_name
  `).all(memberId);
}

export function setMemberPermission(user: RequestUser, memberId: string, input: PermissionInput) {
  requireAdmin(user);
  const member = requireMember(memberId);
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
    const target = getDatabase().prepare(`
      SELECT u.id FROM users u
      JOIN user_identities ui ON ui.user_id = u.id AND ui.provider IN ('fnos_gateway', 'development')
      WHERE u.id = ?
    `).get(userId);
  if (!target) throw createError({ statusCode: 404, statusMessage: "授权账号不存在" });
  if (member.relationship === "self" && member.createdBy === userId && input.permission === null) {
    throw createError({ statusCode: 409, statusMessage: "不能移除本人档案所有者的权限" });
  }
  if (input.permission !== null && (typeof input.permission !== "string" || !permissions.has(input.permission))) {
    throw createError({ statusCode: 400, statusMessage: "权限必须为查看或管理" });
  }
  const db = getDatabase();
  if (input.permission === null) {
    db.prepare("DELETE FROM member_permissions WHERE member_id = ? AND user_id = ?").run(memberId, userId);
    audit(user, "member.permission.remove", memberId, { userId });
  } else {
    db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(member_id, user_id) DO UPDATE SET
        permission = excluded.permission, granted_by = excluded.granted_by, granted_at = CURRENT_TIMESTAMP
    `).run(memberId, userId, input.permission, user.id);
    audit(user, "member.permission.update", memberId, { userId, permission: input.permission });
  }
  return listMemberPermissions(user, memberId);
}

export function assertMemberAccess(user: RequestUser, memberId: string) {
  requireAuthenticated(user);
  const row = getDatabase().prepare(`
    SELECT mp.permission FROM member_permissions mp
    JOIN health_members hm ON hm.id = mp.member_id
    WHERE mp.member_id = ? AND mp.user_id = ? AND hm.deleted_at IS NULL
  `).get(memberId, user.id) as { permission: "viewer" | "manager" } | undefined;
  if (!row) throw createError({ statusCode: 403, statusMessage: "无权访问该成员档案" });
  return row.permission;
}

export function assertMemberManage(user: RequestUser, memberId: string) {
  const permission = assertMemberAccess(user, memberId);
  if (permission !== "manager") {
    throw createError({ statusCode: 403, statusMessage: "仅有管理权限的账号可添加报告" });
  }
}
