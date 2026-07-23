# Contributing

欢迎基于这个模板继续完善 fnOS 应用开发体验。

## Development

```bash
npm ci
npm run dev
```

## Build

```bash
npm run build
npm run pack:app
npm run pack:fpk
npm run release:ci
```

发布前通过 `pnpm version:bump` 交互选择版本类型，或通过 `pnpm version:bump patch|minor|major|x.y.z` 直接指定；CI/非交互环境可以加 `--yes` 默认升 patch，也可以加 `--dry-run` 预览。

本地完整发布使用 `pnpm release`：该命令会选择版本、执行 `release:ci`、创建版本提交和 tag。GitHub Actions 只执行 `release:ci`。

## Notes

- 请优先修改 `template.config.json`
- 版本号以 `package.json` 为主
- `prepare-package` 会自动同步版本到 `manifest`
- 涉及数据库表、字段、索引、约束或结构化数据语义变化时，必须按 `docs/VERSION_MIGRATION.md` 新增迁移记录和测试
- 变更打包逻辑后必须执行 `npm run pack:app`，确保包结构校验通过
- fnOS 规范和设备测试清单见 `docs/FNOS_DEVELOPMENT.md`
