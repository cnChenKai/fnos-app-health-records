import { defineEventHandler } from "h3";
import { getDatabase } from "../database/client";

export default defineEventHandler(() => {
  getDatabase();
});
