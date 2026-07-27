import { getDatabase } from "../database/client";
import type { RequestUser } from "../domain/request-user";
import { createId } from "../utils/identifier";

export function rebindRestoredGatewayAdministrator(user: RequestUser) {
  if (!user.authenticated || !user.isGatewayAdmin || !["fnos_gateway", "development"].includes(user.provider)) {
    throw new Error("恢复后的身份接管需要 fnOS 系统管理员");
  }
  const db = getDatabase();
  const previousAdmins = db.prepare(`
    SELECT id FROM users WHERE is_gateway_admin = 1 AND id <> ?
  `).all(user.id) as Array<{ id: string }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET is_gateway_admin = 0, updated_at = CURRENT_TIMESTAMP WHERE is_gateway_admin <> 0").run();
    db.prepare(`
      INSERT INTO users (id, display_name, is_gateway_admin)
      VALUES (?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        is_gateway_admin = 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(user.id, user.displayName);
    db.prepare(`
      INSERT INTO user_identities (id, user_id, provider, subject)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, subject) DO UPDATE SET user_id = excluded.user_id
    `).run(createId("identity"), user.id, user.provider, user.id);
    const permissionResult = db.prepare(`
      INSERT INTO member_permissions (member_id, user_id, permission, granted_by)
      SELECT id, ?, 'manager', ? FROM health_members WHERE deleted_at IS NULL
      ON CONFLICT(member_id, user_id) DO UPDATE SET
        permission = 'manager',
        granted_by = excluded.granted_by,
        granted_at = CURRENT_TIMESTAMP
    `).run(user.id, user.id);
    db.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail_json)
      VALUES (?, ?, 'backup.identity_rebind', 'user', ?, ?)
    `).run(createId("audit"), user.id, user.id, JSON.stringify({
      previousAdminCount: previousAdmins.length,
      memberPermissionCount: Number(permissionResult.changes)
    }));
    db.exec("COMMIT");
    return {
      userId: user.id,
      previousAdminCount: previousAdmins.length,
      memberPermissionCount: Number(permissionResult.changes)
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
