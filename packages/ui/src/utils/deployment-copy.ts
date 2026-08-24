import type { Session } from "../types/api";

type AuthMode = Session["authMode"] | undefined;

export function getDeploymentCopy(authMode: AuthMode) {
  if (authMode === "fnos") {
    return {
      administrator: "飞牛管理员",
      importEmptyTitle: "还没有可用的飞牛授权目录",
      importEmptyDescription: "请前往飞牛“应用设置 -> 授权目录”，为健康档案添加报告所在目录。"
    };
  }
  if (authMode === "local") {
    return {
      administrator: "Docker 管理员",
      importEmptyTitle: "还没有配置 NAS 导入目录",
      importEmptyDescription: "请在 Docker Compose 中设置 REPORTS_HOST_PATH，并重建容器使只读挂载生效。"
    };
  }
  if (authMode === "development") {
    return {
      administrator: "开发管理员",
      importEmptyTitle: "还没有配置开发导入目录",
      importEmptyDescription: "请设置 IMPORT_ROOTS 后重启开发服务。"
    };
  }
  return {
    administrator: "应用管理员",
    importEmptyTitle: "当前部署未配置导入目录",
    importEmptyDescription: "请联系应用管理员检查目录导入配置。"
  };
}
