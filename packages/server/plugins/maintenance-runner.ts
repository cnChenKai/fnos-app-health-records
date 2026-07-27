import { definePlugin } from "nitro";
import { startMaintenanceRunner } from "../services/maintenance-runner.service";

export default definePlugin(() => {
  startMaintenanceRunner();
});
