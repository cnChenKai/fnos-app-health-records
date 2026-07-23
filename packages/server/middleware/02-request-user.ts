import { defineEventHandler } from "h3";
import { getRequestUser } from "../utils/request-user";

export default defineEventHandler((event) => {
  event.context.requestUser = getRequestUser(event);
});
