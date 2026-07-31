const trackableMorphologyPattern =
  /(囊肿|囊性灶|结节|斑块|息肉|结石|钙化灶?|占位|肿块|包块|团块|积液|增生|萎缩|狭窄|扩张|卵泡|脂肪肝|磨玻璃影|病灶|淋巴结|低回声(?:区|灶)?|高回声(?:区|灶)?|无回声(?:区|灶)?|混合回声(?:区|灶)?|密度影|异常信号|肿大|增大|增厚|变薄|缩小|不均匀|粗糙|迂曲|反流|硬化|炎症|化生|异型|腺瘤|肿瘤|癌|坏死|溃疡|糜烂|疝|静脉曲张|赘生物|瘢痕|出血|水肿)/;

const trackableAbsentObjectPattern =
  /(囊肿|囊性灶|结节|斑块|息肉|结石|钙化灶?|占位|肿块|包块|团块|积液|磨玻璃影|病灶|异常肿大淋巴结|腺瘤|肿瘤|癌|溃疡|糜烂|疝|静脉曲张|赘生物|出血)/;

const genericNormalPattern =
  /(未见|未发现|无)(?:明显|特殊|显著)?(?:的)?(?:异常|异常表现|异常改变|病变|占位性病变)|大致正常|基本正常|(?:大小|形态|结构|轮廓|边界|包膜|回声|密度|血流)(?:及|、|与|和|均|尚)*正常|形态规则|边界清晰|包膜完整|回声均匀/;

const placeholderFindingPattern =
  /^(?:检查发现|形态发现|异常|异常表现|检查异常|影像发现|超声发现|其他|待确认|未明确)$/;

type MorphologyRuleInput = {
  findingName?: string | null;
  findingType?: string | null;
  rawText?: string | null;
  morphology?: string | null;
  presence?: "present" | "absent" | "uncertain" | string | null;
};

function morphologyText(value: MorphologyRuleInput) {
  return [value.findingName, value.findingType, value.rawText, value.morphology]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKC");
}

export function isGenericNormalMorphologyFinding(value: MorphologyRuleInput) {
  const text = morphologyText(value);
  return genericNormalPattern.test(text) && !trackableMorphologyPattern.test(text);
}

export function isTrackableMorphologyFinding(value: MorphologyRuleInput) {
  const text = morphologyText(value);
  if (!text || isGenericNormalMorphologyFinding(value)) return false;
  const findingName = (value.findingName || "").normalize("NFKC").trim();
  const findingType = (value.findingType || "").normalize("NFKC").trim();
  if (placeholderFindingPattern.test(findingName) && placeholderFindingPattern.test(findingType)) return false;
  if (value.presence === "absent") return trackableAbsentObjectPattern.test(text);
  return trackableMorphologyPattern.test(text);
}
