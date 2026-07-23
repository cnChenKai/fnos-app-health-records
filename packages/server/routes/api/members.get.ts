import { defineEventHandler } from "h3";
import { listMembers } from "../../services/records.service";
import { ok } from "../../utils/api-response";
import { getRequestUser } from "../../utils/request-user";

export default defineEventHandler((event) => ok(listMembers(getRequestUser(event))));
