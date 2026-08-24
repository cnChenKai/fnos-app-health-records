import { defineEventHandler } from "h3";
import { getDatabase } from "../database/client";
import { bootstrapLocalAdministrator } from "../services/auth.service";

export default defineEventHandler(() => {
  getDatabase();
  bootstrapLocalAdministrator();
});
