# Docker 部署

Docker 版本与 fnOS 版本使用同一套业务代码和数据库格式。Docker 直接暴露根路径 `/`，使用独立本地管理员登录；fnOS 版本仍通过系统网关复用 fnOS 账号，不受 Docker 登录方式影响。

官方镜像发布到 GitHub Container Registry：

```text
ghcr.io/timor-m/fnos-app-health-records
```

不需要注册 Docker Hub 账号。GitHub Actions 使用仓库自带的 `GITHUB_TOKEN` 发布 GHCR 镜像；首次发布后应在 GitHub Package 设置中将镜像改为 Public，用户才能匿名执行 `docker compose pull`。若保持 Private，使用者需要先通过具备 `read:packages` 权限的 GitHub Token 登录 `ghcr.io`。

支持 `linux/amd64` 和 `linux/arm64`。镜像不内置完整 OCR Python 依赖，避免基础镜像过大；OCR 环境会在首次安装时写入持久化数据卷。

## 首次安装

需要 Docker Engine 24+ 和 Docker Compose v2。先下载仓库中的 `docker-compose.yml`，然后在同一目录创建管理员密码 Secret：

```bash
mkdir -p secrets
umask 077
printf '%s\n' '替换为至少12位的强密码' > secrets/local_admin_password.txt
```

密码长度必须为 12-128 个字符。不要把 `secrets/` 提交到 Git，也不要把密码直接写入 Compose 环境变量。

启动服务：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

默认访问地址为 `http://服务器地址:3334/`，默认用户名为 `admin`。可以在启动前通过环境变量调整：

```bash
LOCAL_ADMIN_USERNAME=healthadmin \
LOCAL_ADMIN_DISPLAY_NAME=家庭管理员 \
HEALTH_RECORDS_PORT=8334 \
docker compose up -d
```

管理员只会在空数据库首次启动时创建。之后修改 Secret 文件不会自动修改已有账号密码。登录后可在“我的 -> 账号安全”修改密码；修改成功会撤销该管理员的全部登录会话，需要使用新密码重新登录。

忘记密码时必须在 Docker 主机上离线重置。先停止服务，避免应用与重置命令同时写入 SQLite；然后把 Secret 文件替换为新密码并执行一次重置：

```bash
docker compose stop health-records
umask 077
printf '%s\n' '替换为新的至少12位强密码' > secrets/local_admin_password.txt
docker compose run --rm --no-deps health-records \
  node scripts/reset-local-admin-password.mjs \
  --password-file /run/secrets/local_admin_password \
  --username admin
docker compose start health-records
```

若首次安装时修改了 `LOCAL_ADMIN_USERNAME`，将命令中的 `admin` 替换为实际用户名。重置会撤销全部现有会话并写入操作审计，不会修改报告、成员或 fnOS 网关账号。

查看状态和日志：

```bash
curl http://127.0.0.1:3334/healthz
docker compose logs --tail=200 health-records
```

容器进程以非 root 用户运行。数据库、报告原件、缩略图、配置、日志、备份和 OCR 运行时统一保存在命名卷 `fnos-health-records-data` 的 `/data` 下。

## OCR 安装

登录后进入“我的 -> 运行与识别”，点击“安装 OCR 环境”。安装程序会在 `/data/ocr-venv` 创建 Python 虚拟环境，并下载 RapidOCR、PyMuPDF、Pillow 等依赖。该目录位于数据卷中，重建或升级容器后仍会保留。

首次安装需要访问 Python 包源，耗时和空间占用取决于设备架构与网络。若安装失败，在同一页面查看 OCR 安装诊断和日志。镜像已经包含 Python 3.11、`venv` 以及 OCR Worker 所需系统基础环境。

## AI 与 Ollama 地址

容器访问宿主机上的服务时不能使用 `127.0.0.1`。Compose 已配置 `host.docker.internal`，宿主机 Ollama 的 OpenAI-compatible 地址应使用：

```text
http://host.docker.internal:11434/v1
```

访问局域网其他机器上的 Provider 时，填写该机器的实际局域网 IP。Ollama 还需要监听容器可访问的网卡，并由主机防火墙允许对应来源；不要把 Ollama 端口直接暴露到公网。

## HTTPS 反向代理

建议通过 HTTPS 反向代理提供外部访问。代理负责 TLS，并完整传递原始 Host 和协议。Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name health.example.com;

    client_max_body_size 1g;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:3334;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

同时将 Compose 中的 `TRUST_PROXY` 设置为 `1`：

```bash
TRUST_PROXY=1 docker compose up -d
```

只有服务确实位于可信反向代理之后时才启用该选项。应用会据此识别 HTTPS、下发 Secure Cookie，并使用转发后的客户端地址执行登录限流。代理还应允许大文件上传和长时间流式下载，避免备份恢复出现 HTTP 413、500 或网关超时。

## 升级与回滚

正式环境建议固定版本，不要长期依赖 `latest`：

```bash
HEALTH_RECORDS_VERSION=0.2.2 docker compose pull
HEALTH_RECORDS_VERSION=0.2.2 docker compose up -d
```

升级到新版本：

```bash
HEALTH_RECORDS_VERSION=0.2.3 docker compose pull
HEALTH_RECORDS_VERSION=0.2.3 docker compose up -d
```

应用启动时会按数据库 schema 自动迁移，并在需要时创建迁移前备份。升级前仍建议在“我的 -> 备份与恢复”创建并下载一份完整备份。

回滚前必须确认旧镜像支持当前数据库 schema。若新版本已经执行不可向下兼容的迁移，不要直接启动旧镜像；应先保留当前数据卷，再使用升级前的完整备份恢复到独立卷或新实例中验证。

## 数据备份

首选应用内的“完整备份”，它包含一致性数据库快照、原件、配置和 AI 密钥，并带 SHA-256 清单。

也可以在维护窗口备份整个 Docker 卷。先停止应用，避免复制写入中的 SQLite：

```bash
docker compose stop health-records
docker run --rm \
  -v fnos-health-records-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.22 \
  tar -C /data -czf /backup/fnos-health-records-data.tar.gz .
docker compose start health-records
```

卷归档包含医疗资料和密钥，应加密保存并限制访问。恢复整个卷会覆盖当前数据，只应在已验证归档且应用停止的情况下操作。

## 常见问题

- 登录页提示“本地管理员尚未初始化”：检查 Secret 文件是否存在、容器内 `/run/secrets/local_admin_password` 是否可读，以及密码是否满足长度要求，然后查看容器日志。
- 忘记本地管理员密码：按首次安装章节后的离线重置步骤操作；不要在服务运行时直接编辑 SQLite。
- 登录后仍返回未认证：检查浏览器是否接受 Cookie；HTTPS 代理场景确认 `TRUST_PROXY=1` 且 `X-Forwarded-Proto=https`。
- 上传返回 413 或 500：先检查反向代理上传大小、请求体缓冲、临时目录空间和超时，再检查应用日志。
- 大备份下载长时间无响应：关闭代理响应缓冲，延长读取超时，并确认代理支持 Range 请求和流式响应。
- 宿主机 Ollama 无法连接：确认地址不是 `127.0.0.1`，并检查 Ollama 监听地址、主机防火墙和 `host.docker.internal` 解析。
- 数据卷权限异常：官方镜像以 Node 镜像内置的 `node` 用户运行。使用命名卷通常无需手工处理；改用 bind mount 时，需保证挂载目录可由容器中的该用户读写。
