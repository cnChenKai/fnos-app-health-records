# fnOS 安装与升级

本文面向使用飞牛应用中心的用户。fnOS 版本通过系统网关复用 fnOS 登录态，不使用 Docker 的本地账号体系。

## 安装

推荐通过飞牛应用中心安装。需要手动测试或分发 `.fpk` 时：

```bash
appcenter-cli install-fpk fnos-app-health-records-<version>.fpk
```

安装后从应用中心或桌面入口打开健康档案。应用默认通过 `/app/fnos-app-health-records` 访问，账号和密码由 fnOS 提供。

## 授权 NAS 目录

1. 在应用中心打开健康档案的应用设置。
2. 授权包含待导入报告的目录，并保存设置。
3. 停止后重新启动健康档案，让 fnOS 重新注入授权目录。
4. 在“上传报告 -> 从 NAS 导入”中选择文件。

应用只读取授权目录，并将选中的文件复制到应用私有存储，不会移动或修改源文件。目录授权与 Docker 的 `REPORTS_HOST_PATH` 无关。

## OCR 首次安装

进入“我的 -> 运行与识别”，安装 OCR 环境。应用会在私有数据目录创建 OCR 环境并运行本地自检。首次安装需要下载 Python 依赖，耗时取决于设备架构和网络。

安装失败时，先查看同一页面的 OCR 安装诊断和日志，再参考[常见问题排查](./TROUBLESHOOTING.md)。报告原件会先保存，OCR 环境恢复后可以在报告详情中重试。

## 升级与卸载

- 升级前建议在“我的 -> 备份与恢复”创建完整备份。
- 升级会在服务端启动时按当前数据库版本执行迁移。
- 卸载时根据需要选择保留或删除应用数据；不确定时选择保留。
- 不要直接删除应用私有数据目录，也不要用 Docker 文档中的卷命令处理 fnOS 数据。

## fnOS 模式边界

- fnOS 系统管理员是应用管理员。
- 普通用户权限由 fnOS 身份和应用成员权限共同决定。
- fnOS 目录授权由应用中心管理，应用内不能替代系统授权。
- 访问异常、网关 403 或授权目录不显示时，优先停止并重新启动应用。

## 手动验证

```bash
appcenter-cli start fnos-app-health-records
appcenter-cli stop fnos-app-health-records
```

发布包、manifest、生命周期和 fnOS 开发规范见 [FNOS_DEVELOPMENT.md](./FNOS_DEVELOPMENT.md)。
