import { defineEventHandler } from "h3";
import { logout } from "../../../services/auth.service";
import { ok } from "../../../utils/api-response";

export default defineEventHandler((event) => ok(logout(event)));
