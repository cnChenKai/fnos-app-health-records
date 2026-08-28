# 备份、恢复与迁移

健康报告原件、OCR 数据和 AI 配置都属于敏感数据。备份文件应保存在可信位置，建议加密并限制访问权限。

## 应用内完整备份

进入“我的 -> 备份与恢复”，创建完整备份。备份包含 SQLite 一致性快照、报告原件、分页图、缩略图、运行配置、AI 配置及加密凭据，并提供文件大小和 SHA-256 校验清单。

恢复前应用会自动创建一份“恢复前安全备份”。上传外部备份后，先执行校验，再确认恢复。大文件下载或上传失败时，参考[常见问题排查](./TROUBLESHOOTING.md)。

## Docker 数据备份

优先使用应用内完整备份。使用 Docker 数据卷备份时，先停止应用，避免复制正在写入的 SQLite：

```bash
docker compose stop health-records
docker run --rm \
  -v fnos-health-records-data:/data:ro \
  -v "$PWD":/backup alpine:3.22 \
  tar -C /data -czf /backup/fnos-health-records-data.tar.gz .
docker compose start health-records
```

如果使用 `DATA_HOST_PATH`，停止容器后备份该主机目录即可。不要只备份 `REPORTS_HOST_PATH`，它只是外部源报告目录，不包含应用数据库和已处理结果。

## 恢复和跨设备迁移

1. 确认目标版本支持备份中的数据库 schema。
2. 为目标实例创建一份当前安全备份。
3. 使用应用内恢复，或停止 Docker 后恢复数据目录/数据卷。
4. 启动应用并检查成员、报告、原件、趋势和 AI 配置。
5. 确认无误后再删除旧实例或旧备份。

fnOS 与 Docker 使用相同的业务数据格式，但认证方式不同。跨设备恢复后，fnOS 管理权限由当前 fnOS 系统管理员接管；Docker 保留当前实例的本地管理员身份。

## 回滚限制

新版本启动后可能执行数据库迁移。回滚前必须确认旧镜像或旧 `.fpk` 支持当前 schema；不支持时不要直接启动旧版本，应使用升级前备份恢复到独立实例验证。
