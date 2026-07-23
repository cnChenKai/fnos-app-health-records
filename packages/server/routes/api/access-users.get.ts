import { defineEventHandler } from "h3";
import { listAccessUsers } from "../../services/member.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => ok(listAccessUsers(getRequestUser(event))));
