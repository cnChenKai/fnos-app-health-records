import { defineEventHandler } from "h3";
import { listLocalAccounts } from "../../../services/auth.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => ok(listLocalAccounts(getRequestUser(event))));
