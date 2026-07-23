import { defineEventHandler } from "h3";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => ok(getRequestUser(event)));
