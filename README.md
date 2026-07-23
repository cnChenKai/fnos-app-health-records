# 健康档案

健康档案是一款运行在 fnOS 上的家庭医疗报告归档应用。应用支持拍照、多图和 PDF 上传，通过本地 OCR 与可选 AI 生成结构化记录，保留报告原件、PDF 单页高清图和字段证据，并按医院报告生成日期形成家庭成员健康时间轴。

当前版本已经具备核心档案闭环：概览、档案时间轴、上传处理进度、OCR 文本查看、AI 整理、报告校对、趋势、提醒、重复报告检测、回收站、完整备份/校验/恢复、运行状态、AI 配置与审计。完整功能进度见 [健康档案应用-TODO.md](./健康档案应用-TODO.md)。

应用发布流程见 [应用发布与数据库升级流程](./docs/RELEASE_PROCESS.md)，版本升级、本地 SQLite 按需迁移和提交检查流程见 [版本与数据库迁移规范](./docs/VERSION_MIGRATION.md)。

## 技术架构

- Vue 3、Vue Router、Vite
- Nitro 3、Node.js 22
- Node.js 内置 SQLite、WAL、版本化迁移
- RapidOCR/OpenVINO、PyMuPDF
- OpenAI-compatible 文本与视觉模型接口
- fnOS Unix Socket 统一网关与系统账号身份
- 安装时可配置服务端口，默认 3334

## 主要功能

- 家庭成员档案：支持默认本人、家庭成员新增维护，以及 fnOS 管理员对成员访问权限的管理。
- 报告上传：支持拍照、多图、拖放、HEIC、JPEG、PNG、WebP 和多页 PDF；上传后可离开页面，后台任务继续处理。
- OCR 与 PDF：PDF 可拆分为单页记录，优先提取原生文字，扫描页回退到渲染和 OCR；单页预览使用高清图，原 PDF 可单独查看。
- AI 结构化：管理员可配置 OpenAI-compatible 多模型 Provider；模型切换保留各自配置，API Key 加密存储；AI 输出报告标题、类型、医院、科室、部位、日期、结论、建议和指标。
- 报告详情：支持处理进度折叠、任务详细日志、失败重试、查看 OCR、查看原件、全屏看图、校对字段、手动触发 AI 整理、重新 OCR+AI、确认归档和移入回收站。
- 档案时间轴：按医院报告生成日期排序，首次加载 20 条，滚动到底部自动游标分页；搜索和成员切换会重置分页。
- 趋势与来源：基于同成员、同指标和兼容单位展示趋势，指标点可反向打开来源报告和对应单页高清图。
- 提醒和通知：支持手工提醒、报告复查建议生成提醒、处理完成/失败通知、已读归档和“我的”入口徽标。
- 重复报告：基于 AI 提取内容而非文件 hash 检测疑似重复，支持查看详情、合并原件页或移入回收站。
- 数据安全：报告删除先进入 30 天回收站，可恢复或永久删除；完整备份包含数据库、原件、缩略图、配置和 AI 密钥，内置 sha256 文件校验清单，支持下载、校验、上传外部备份恢复和删除备份记录。
- 运维审计：运行状态展示数据库、存储和任务队列；用户操作日志、AI 调用次数、耗时、Token 和失败状态支持分页查看。

## 开发

```bash
npm ci
npm run dev
```

默认地址：

```text
应用：http://127.0.0.1:3334/app/fnos-app-health-records/
Vite：http://127.0.0.1:3335/app/fnos-app-health-records/
```

端口被占用时可以覆盖：

```bash
APP_PORT=3350 WEB_PORT=3351 npm run dev
```

测试与构建：

```bash
npm test
npm run build
npm run pack:app
npm run pack:fpk
npm run release:ci
```

版本号统一由 `package.json` 管理，发布前使用：

```bash
npm run version:bump
npm run version:auto
npm run version:bump -- --yes
npm run version:bump -- patch
npm run version:bump -- minor
npm run version:bump -- 0.2.0
npm run version:bump -- patch --dry-run
pnpm version:bump
pnpm version:auto
pnpm version:bump --yes
pnpm version:bump minor
pnpm version:bump 0.2.0
pnpm version:bump --dry-run
pnpm version:auto --dry-run
```

本地发布使用：

```bash
pnpm release
```

该命令会要求工作区干净，交互选择版本，执行完整构建校验，创建版本提交和 `v版本号` tag。GitHub Actions 只使用 `release:ci` 基于已推送的 tag 构建产物，不修改版本、不打 tag。

## 目录

```text
packages/ui/                 Vue 页面、布局、组件和领域类型
packages/server/database/    SQLite Schema、迁移和连接
packages/server/domain/      健康报告与身份类型
packages/server/services/    报告、认证、OCR 和 AI 服务
packages/server/routes/api/  Nitro API
packages/ocr-worker/         OCR 与 PDF 处理 Worker
packages/assets/             fnOS 应用图标
scripts/                     开发、生命周期、构建和打包脚本
```

fnOS 包根目录 `ICON.PNG` 使用 512×512 图标，供应用中心/应用详情页大图展示；桌面入口继续使用 `app/ui/images/icon_{size}.png` 多尺寸图标。

## 数据目录

开发环境使用 `.data/`，fnOS 安装环境使用 `TRIM_PKGVAR/data/`：

```text
db/            SQLite 数据库
reports/       健康报告原件
thumbnails/    页面缩略图
models/        OCR 模型
backups/       备份文件
secrets/       AI 密钥
config/        安装向导生成的运行配置
ocr-venv/      OCR Python 虚拟环境
```

管理员可在“我的 → 备份与恢复”创建完整应用备份。完整备份位于 `backups/full/`，格式为 `.tar.gz`，包含 SQLite 一致性快照、报告原件、分页/缩略图、运行配置和 AI 密钥；备份清单内记录文件大小和 sha256，可在页面中手动校验。恢复支持选择已有备份或上传外部备份包，恢复前会自动额外创建一份“恢复前安全备份”；恢复完成后建议刷新页面或重新打开应用确认数据状态。备份包包含医疗数据和密钥，请仅保存在可信设备。

## fnOS 访问方式

- 桌面入口通过 `/app/fnos-app-health-records` 和 Unix Socket 复用 fnOS 登录态。
- 安装/配置向导只设置服务端口，默认 `3334`。
- 账号体系完全使用 fnOS 提供的用户身份，fnOS 系统管理员即应用管理员。
- 非 fnOS 网关请求不会信任外部提供的 `X-Trim-*` 头，也不提供独立账号登录。

## 隐私边界

原件默认保存在 NAS 应用私有目录。AI 默认只接收 OCR 文本；只有 fnOS 系统管理员显式启用视觉增强后才会发送处理后的页面副本。身份证、电话和住址不会进入结构化字段、全文索引、日志或 AI 摘要。

开源仓库：[https://github.com/timor-m/fnos-app-health-records](https://github.com/timor-m/fnos-app-health-records)

项目基于 [fnos-app-template](https://github.com/timor-m/fnos-app-template) 初始化，主要领域架构参考 [fnos-app-family-stock](https://github.com/timor-m/fnos-app-family-stock)。
