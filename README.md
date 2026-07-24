# 健康档案

健康档案是一款运行在 fnOS 上的家庭医疗报告归档应用。应用支持拍照、多图和 PDF 上传，通过本地 OCR 与可选 AI 生成结构化记录，保留报告原件、PDF 单页高清图和字段证据，并按医院报告生成日期形成家庭成员健康时间轴。

当前版本已经具备核心档案闭环：概览、档案时间轴、上传处理进度、OCR 文本质量提示、AI 整理、报告校对、指标归一化趋势、提醒、重复报告检测、回收站、完整备份/校验/恢复、运行状态、AI 配置与审计。完整功能进度见 [健康档案应用-TODO.md](./健康档案应用-TODO.md)。

应用发布流程见 [应用发布与数据库升级流程](./docs/RELEASE_PROCESS.md)，版本升级、本地 SQLite 按需迁移和提交检查流程见 [版本与数据库迁移规范](./docs/VERSION_MIGRATION.md)。

## 应用定位

健康档案面向家庭长期健康资料管理，重点解决“报告保存了但很难用”的问题。体检报告、门诊检查、住院记录、检验单和 PDF 电子报告经常分散在医院公众号、手机相册、聊天记录、电脑文件夹和网盘里；真正复诊或回看指标时，很难快速找到同一成员、同一时间、同一项目的完整资料。

应用不会替代医生诊断，也不会根据报告生成疾病判断。它的目标是把原始报告可靠保存下来，并通过 OCR、AI 整理、时间轴、趋势和提醒降低家庭健康资料的整理成本：

- 报告原件留存在 NAS 应用私有目录，方便长期保存和备份。
- AI 负责辅助提取医院、日期、科室、部位、结论、建议和指标，最终仍以原报告为依据。
- 按报告生成日期归档，而不是按上传时间堆叠，适合补录多年历史报告。
- 指标趋势支持反向定位来源报告和单页高清图，便于核对原始依据。
- 多成员档案适合为父母、子女集中整理体检、检查、复查和住院资料。

## 典型场景

- **年度体检归档**：上传体检 PDF 或多张报告图片，AI 整理体检结论、异常项目、指标和复查建议，并按报告日期进入时间轴。
- **陪老人复诊**：按家庭成员快速查找历史 CT、超声、检验、住院记录和出院小结，必要时直接打开原件或单页高清图给医生查看。
- **儿童健康资料**：集中保存孩子的门诊检查、疫苗记录、口腔检查和住院单据，避免资料散在多个账号或设备里。
- **指标长期对比**：对血脂、血糖、尿酸、血红蛋白、BMI 等常见指标做名称和单位归一化，形成可信趋势。
- **复查事项提醒**：把报告中明确出现的复查要求整理为待确认提醒，减少“看完报告就忘”的情况。
- **重复报告清理**：基于报告内容而非单纯文件 hash 检测疑似重复，适合处理同一报告多次拍照或 PDF/图片重复上传的情况。

## 界面预览

截图位于 [snapshot/](./snapshot/)，包含 PC 与触屏端核心页面。仓库中的截图使用模拟数据生成，仅用于展示界面和功能流程。

### PC 端

![PC 概览](./snapshot/pc-01-overview.png)

概览页集中展示报告总数、已归档数量、待识别数量、待处理提醒、最近报告和待识别报告，适合作为家庭健康资料的入口工作台。

![PC 档案详情](./snapshot/pc-02-records-detail.png)

档案页采用左侧时间轴、右侧报告详情的分栏结构。报告按医院生成日期排序，详情中可以查看基础字段、AI 整理结果、OCR、处理进度、原件和校对入口。

![PC 指标趋势](./snapshot/pc-03-trends.png)

趋势页展示归一化后的指标序列。应用会结合指标名称、单位和报告上下文做保守归一化，趋势点支持回到来源报告和原图。

![PC 上传报告](./snapshot/pc-04-upload.png)

上传页支持图片、多图、拍照和多页 PDF。多张图片或 PDF 页面可以作为同一份报告进入识别流程，上传后后台任务会继续处理。

![PC 提醒](./snapshot/pc-06-reminders.png)

提醒页同时承载手工提醒、报告复查建议和任务完成/失败通知，支持到期、逾期、已读等状态管理。

![PC AI 审计](./snapshot/pc-07-ai-audit.png)

AI 审计页面向管理员，展示 AI 调用次数、成功失败、耗时、Token 消耗和模型信息，便于排查识别效果和调用成本。

### 触屏端

![触屏概览](./snapshot/touch-01-overview.png)

触屏端保留相同的信息结构，底部导航适配手机和飞牛 App WebView，适合随手拍照、查看最近报告和处理提醒。

![触屏报告详情](./snapshot/touch-09-report-detail.png)

触屏端点击报告会在当前页面打开详情抽屉，不跳转到列表页外，方便在移动端连续查看字段、OCR 和 AI 整理内容。

![触屏趋势来源原图](./snapshot/touch-10-trend-source-image.png)

查看指标来源时会打开当前页看图模式，支持单页高清图、缩放、翻页、下载和进入全屏查看。

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
- OCR 与 PDF：PDF 可拆分为单页记录；遇到原生文字层不完整、页面包含大面积扫描图或表格图片时，会按页高清渲染后 OCR，并与 PDF 文字层合并；OCR 结果记录质量分数、弱识别原因和详细处理日志；单页预览使用高清图，原 PDF 可单独查看。
- AI 结构化：管理员可配置 OpenAI-compatible 多模型 Provider；模型切换保留各自配置，API Key 加密存储；AI 输出报告标题、类型、医院、科室、部位、日期、结论、建议和指标。
- 报告详情：支持处理进度折叠、任务详细日志、失败重试、查看 OCR、查看原件、全屏看图、校对字段、手动触发 AI 整理、重新 OCR+AI、确认归档和移入回收站。
- 档案时间轴：按医院报告生成日期排序，首次加载 20 条，滚动到底部自动游标分页；搜索和成员切换会重置分页。
- 趋势与来源：基于内置指标字典、单位和报告上下文归一化常见体检指标；非预设指标会在 AI 已启用时走 AI 兜底归一化，高置信数值项进入趋势，文字/状态项仅标记为已识别但不默认进入折线趋势。趋势卡片展示可信度、来源名称、整理原因和指标说明，指标点可反向打开来源报告和对应单页高清图。
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

## OCR 安装失败排查

OCR 环境不会随应用包内置完整 Python 虚拟环境，首次使用前需要管理员在“我的 → 运行与识别”中安装。安装过程会在设备本地创建 `ocr-venv`，并下载 RapidOCR、PyMuPDF、Pillow 等 Python 依赖。安装完成后会加载 OCR 引擎，生成一张本地测试图片并执行 OCR 识别；只有测试通过后才会写入就绪标记并显示为可用。

默认策略会先检查设备现有环境，不覆盖系统 Python：

1. 已安装的应用私有 Python 3.11。
2. 系统 Python 3.11、3.10、3.9，优先使用 OpenVINO 后端。
3. 如果没有 3.9–3.11，会尝试安装应用私有 Python 3.11 到应用数据目录。
4. 如果没有配置私有 Python 安装包，最后才回退到系统 Python 3.12，并使用 ONNXRuntime 兼容后端。

OpenVINO 依赖安装或动态库加载失败时会自动切换到 ONNXRuntime 备用后端。Python 3.12 环境会直接使用 ONNXRuntime，因为当前锁定的 OpenVINO 版本范围没有 Python 3.12 可用 wheel。

应用私有 Python 不会写入 `/usr/bin`、`/usr/local/bin` 等系统路径，默认安装在：

```text
/var/apps/fnos-app-health-records/var/data/runtime/python-3.11
```

可通过以下方式提供应用私有 Python 包：

- 包内预置：`ocr-worker/python-runtimes/python-3.11-linux-x86_64.tar.gz`。
- 环境变量指定本地包：`OCR_PRIVATE_PYTHON_ARCHIVE=/path/to/python-3.11.tar.gz`。
- 环境变量指定下载地址：`OCR_PRIVATE_PYTHON_URL=https://.../python-3.11.tar.gz`。

如果安装失败，可以在“运行与识别 → OCR 安装诊断”查看：

- 当前运行环境的 Python、OCR 后端、识别模型、PyMuPDF、Pillow 和 HEIF 支持版本。
- 安装失败时的错误、告警和缺失路径。
- 最近安装日志尾部。
- 完整日志文件路径：`/var/apps/fnos-app-health-records/var/log/ocr-install.log`。

Python 3.12 使用 ONNXRuntime 后端时，首次安装会下载 rapidocr、onnxruntime、opencv、numpy、PyMuPDF、Pillow 等多个 wheel。低速网络下可能需要 10–30 分钟；安装期间服务端会每 30 秒写入一条心跳日志，看到 `still running` 不代表卡死。pip 版本满足要求时会跳过升级，减少慢网下载耗时；如需强制升级可设置 `OCR_UPGRADE_PIP=1`。

### PDF 清晰但 OCR 缺内容

有些医院 PDF 看起来很清晰，但内部可能只有一部分文字层，检查表格、图片化页面、盖章区域或扫描块并不能被 `PDF 文字提取`完整拿到。应用会按页判断文字层行数、文本量和图片覆盖面积：文字层可靠时直接使用 PDF 文字；文字层疑似不完整时，会把当前页以高清图片渲染后再做 OCR，并把 OCR-only 内容合并回文字层。报告详情的“处理进度 → 详细日志”会展示本页来源，例如“PDF 文字层+高清 OCR 合并”、渲染倍数和合并行数。

默认 PDF OCR 渲染倍数为 `3x`，可通过环境变量 `OCR_PDF_RENDER_SCALE` 调整，允许范围为 `2–4`。倍数越高，小字和密集表格越容易识别，但 CPU、内存和耗时也会增加。

常见失败原因：

- 设备上没有可用的 Python 3.9–3.12。
- Python 安装缺少 `venv` 或 `pip`。
- 设备无法访问 PyPI，或需要配置可用的 pip 镜像。
- 未配置应用私有 Python 包，且设备上只有 Python 3.12 时，会自动回退 ONNXRuntime，不会继续强装 OpenVINO。
- 当前 CPU 架构或 Python 版本没有 rapidocr-openvino/openvino 对应 wheel；应用会尽量自动切换到 ONNXRuntime 后端。
- 数据目录不可写或磁盘空间不足。
- macOS arm64 仅作为开发环境参考，OpenVINO macOS wheel 可能出现动态库加载兼容问题；fnOS OCR 验收应以 Linux 真机日志为准。

报告原件会先安全保存；OCR 安装成功后，可在报告详情中重试失败任务或重新执行 OCR+AI。

## 隐私边界

原件默认保存在 NAS 应用私有目录。AI 默认只接收 OCR 文本；只有 fnOS 系统管理员显式启用视觉增强后才会发送处理后的页面副本。身份证、电话和住址不会进入结构化字段、全文索引、日志或 AI 摘要。

开源仓库：[https://github.com/timor-m/fnos-app-health-records](https://github.com/timor-m/fnos-app-health-records)

项目基于 [fnos-app-template](https://github.com/timor-m/fnos-app-template) 初始化。
