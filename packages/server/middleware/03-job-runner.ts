import { defineEventHandler } from "h3";
import { startJobRunner } from "../services/job-runner.service";

export default defineEventHandler(() => {
  startJobRunner();
});
