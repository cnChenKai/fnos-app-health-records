import { defineEventHandler } from "h3";
import { rebuildMorphologyTrackingForAdministrator } from "../../../services/morphology-finding.service";
import { ok } from "../../../utils/api-response";
import { getRequestUser } from "../../../utils/request-user";

export default defineEventHandler((event) => {
  return ok(rebuildMorphologyTrackingForAdministrator(getRequestUser(event)));
});
