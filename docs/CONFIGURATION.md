# 配置说明

本文汇总跨部署方式的常用配置。未列出的环境变量不建议在生产环境自行修改。

## 运行模式

| 配置 | fnOS 应用 | Docker |
| --- | --- | --- |
| 身份认证 | fnOS 网关账号 | 本地账号，首次登录默认 `admin/admin` |
| 数据目录 | 应用私有目录 | `/data` 或 `DATA_HOST_PATH` |
| 导入目录 | fnOS 应用设置授权目录 | `REPORTS_HOST_PATH` 只读挂载到 `/reports` |
| 访问前缀 | `/app/fnos-app-health-records` | `/` |
| 反向代理 | 通常由 fnOS 网关处理 | 用户自行配置，可信代理需设置 `TRUST_PROXY=1` |

## Docker 目录和端口

```dotenv
HEALTH_RECORDS_PORT=3334
REPORTS_HOST_PATH=/mnt/nas/health-reports
DATA_HOST_PATH=/mnt/nas/health-records
TZ=Asia/Shanghai
```

`REPORTS_HOST_PATH` 是已有报告的源目录，只读使用；`DATA_HOST_PATH` 保存数据库、原件、缩略图、OCR 环境、备份、日志和配置，必须可由容器 UID 1000 读写。详细操作见 [DOCKER_DEPLOYMENT.md](./DOCKER_DEPLOYMENT.md)。

## 反向代理

反向代理必须传递原始 Host、`X-Forwarded-Host`、`X-Forwarded-Proto` 和 `X-Forwarded-For`，并允许大文件上传、长时间请求和流式下载。只有服务确实位于可信代理之后时才启用：

```dotenv
TRUST_PROXY=1
```

错误配置可能导致登录 403、Cookie 无法保存、备份下载失败或上传超时。

## AI 与 Ollama

AI Provider 在“我的 -> AI 配置”中设置。Ollama 不需要 API Key。Docker 容器访问宿主机 Ollama 时使用：

```text
http://host.docker.internal:11434/v1
```

访问其他机器上的 Ollama 时使用局域网 IP，并确认 Ollama 监听容器可访问的网卡。不要把 Ollama 或 AI 接口直接暴露到公网。

## OCR

OCR 环境由应用在首次安装时创建并保存到数据目录。管理员在“我的 -> 运行与识别”中选择新批次使用本地 OCR、MinerU Agent 轻量解析或 MinerU 精准解析。默认是本地 OCR；设置保存在现有 `app_settings` 中，不依赖环境变量，也不会改变数据库 schema。

精准解析需要在界面输入 MinerU API Token。Token 使用 AES-256-GCM 加密，密钥文件保存在数据目录的 `secrets/ocr-recognition.key`，应用接口不返回明文；应用内完整备份会同时包含数据库和 `secrets`，恢复时应把两者作为同一个敏感备份保护。MinerU 固定访问 `https://mineru.net` 及其返回的官方签名上传/结果地址，不提供自定义 API 地址。

远程模式直接上传应用保存的原始 PDF/图片，不依赖 RapidOCR、PyMuPDF、Pillow 或本地 Worker；随机远程文件名保留正确扩展名，不包含本地文件名或路径。部署网络需要能够访问 MinerU 控制接口及其 HTTPS 签名存储地址；无需配置 MinerU 网关账号，也不要把 Token 写入 Compose、fnOS 授权目录或应用日志。只有 MinerU 官方限额降级到本地 OCR 时才需要本地环境；PDF 使用本地模式时默认按页面处理，必要时会将 PDF 文字层与高清渲染 OCR 合并。

| 参数 | 作用 |
| --- | --- |
| `OCR_PDF_RENDER_SCALE` | PDF OCR 渲染倍数，允许 `2-4`，默认 `3` |
| `OCR_UPGRADE_PIP` | 是否强制升级 pip，默认关闭 |
| `OCR_FORCE_REINSTALL` | 是否强制重装 OCR 环境，默认关闭 |
| `AI_EXTRACTION_CONCURRENCY` | AI 解析并发数，建议 `1-3` |

OCR、AI 输入脱敏和内部路由说明见 [AI_OCR_GUIDE.md](./AI_OCR_GUIDE.md)。
