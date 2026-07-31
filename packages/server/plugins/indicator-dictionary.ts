import { definePlugin } from "nitro";
import { getDatabase } from "../database/client";
import { ensureCoreDictionaryMaterialized } from "../services/indicator-dictionary.service";
import {
  backfillLegacyMorphologyFindings,
  rebuildMorphologyTrackingIfNeeded
} from "../services/morphology-finding.service";

export default definePlugin(() => {
  getDatabase();
  ensureCoreDictionaryMaterialized();
  backfillLegacyMorphologyFindings();
  rebuildMorphologyTrackingIfNeeded();
});
