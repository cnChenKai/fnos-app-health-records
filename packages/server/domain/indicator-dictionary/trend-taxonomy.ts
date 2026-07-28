export type TrendGroupKey =
  | "general"
  | "internal"
  | "surgery"
  | "ophthalmology"
  | "ent"
  | "oral"
  | "gynecology"
  | "laboratory"
  | "functional"
  | "imaging"
  | "other";

export type TrendSubgroupKey =
  | "blood"
  | "urine"
  | "liver"
  | "renal"
  | "lipid"
  | "glucose"
  | "electrolyte"
  | "thyroid"
  | "infectious"
  | "laboratory_other";

export type TrendPlacement = {
  groupKey: TrendGroupKey;
  groupName: string;
  groupOrder: number;
  subgroupKey: TrendSubgroupKey | null;
  subgroupName: string | null;
  subgroupOrder: number;
};

export const trendGroups: Array<{ key: TrendGroupKey; name: string; order: number }> = [
  { key: "general", name: "一般检查", order: 10 },
  { key: "internal", name: "内科检查", order: 20 },
  { key: "surgery", name: "外科检查", order: 30 },
  { key: "ophthalmology", name: "眼科检查", order: 40 },
  { key: "ent", name: "耳鼻喉科", order: 50 },
  { key: "oral", name: "口腔科", order: 60 },
  { key: "gynecology", name: "妇科检查", order: 70 },
  { key: "laboratory", name: "检验检查", order: 80 },
  { key: "functional", name: "功能检查", order: 90 },
  { key: "imaging", name: "影像检查", order: 100 },
  { key: "other", name: "其他检查", order: 110 }
];

export const laboratorySubgroups: Array<{ key: TrendSubgroupKey; name: string; order: number }> = [
  { key: "blood", name: "血常规", order: 10 },
  { key: "urine", name: "尿常规", order: 20 },
  { key: "liver", name: "肝功能", order: 30 },
  { key: "renal", name: "肾功能", order: 40 },
  { key: "lipid", name: "血脂", order: 50 },
  { key: "glucose", name: "血糖", order: 60 },
  { key: "electrolyte", name: "电解质", order: 70 },
  { key: "thyroid", name: "甲状腺功能", order: 80 },
  { key: "infectious", name: "感染及免疫", order: 90 },
  { key: "laboratory_other", name: "其他检验", order: 100 }
];

const groupByKey = new Map(trendGroups.map((group) => [group.key, group]));
const subgroupByKey = new Map(laboratorySubgroups.map((group) => [group.key, group]));

const categorySubgroups: Record<string, TrendSubgroupKey> = {
  血常规: "blood",
  尿常规: "urine",
  肝功能: "liver",
  肾功能: "renal",
  血脂: "lipid",
  血糖: "glucose",
  电解质: "electrolyte",
  甲状腺功能: "thyroid",
  感染筛查: "infectious",
  感染及免疫: "infectious"
};

function compact(value: string | null | undefined) {
  return (value || "")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, "")
    .replace(/[（）()[\]【】{}<>《》:：,，.。;；、/\\|_-]/g, "");
}

function placement(groupKey: TrendGroupKey, subgroupKey: TrendSubgroupKey | null = null): TrendPlacement {
  const group = groupByKey.get(groupKey) || groupByKey.get("other")!;
  const subgroup = subgroupKey ? subgroupByKey.get(subgroupKey) || null : null;
  return {
    groupKey: group.key,
    groupName: group.name,
    groupOrder: group.order,
    subgroupKey: subgroup?.key || null,
    subgroupName: subgroup?.name || null,
    subgroupOrder: subgroup?.order || 0
  };
}

export function trendPlacementFor(input: {
  category?: string | null;
  sectionName?: string | null;
  reportType?: string | null;
}): TrendPlacement {
  const category = (input.category || "").trim();
  const categorySubgroup = categorySubgroups[category];
  if (categorySubgroup) return placement("laboratory", categorySubgroup);
  if (category === "基础测量" || /一般检查|基础测量|一般项目|基本项目/.test(category)) return placement("general");
  if (/内科/.test(category)) return placement("internal");
  if (/外科/.test(category)) return placement("surgery");
  if (/眼科|视力|眼压/.test(category)) return placement("ophthalmology");
  if (/耳鼻喉/.test(category)) return placement("ent");
  if (/口腔|牙科/.test(category)) return placement("oral");
  if (/妇科|乳腺/.test(category)) return placement("gynecology");
  if (/心电|肺功能|骨密度|功能检查/.test(category)) return placement("functional");
  if (/影像|超声|彩超|ct|磁共振|放射/.test(category.toLocaleLowerCase("zh-CN"))) return placement("imaging");

  const context = compact(input.sectionName);
  if (/一般检查|一般项目|基础测量|基本项目|生命体征|体格测量/.test(context)) return placement("general");
  if (/内科/.test(context)) return placement("internal");
  if (/外科/.test(context)) return placement("surgery");
  if (/眼科|视力|眼压/.test(context)) return placement("ophthalmology");
  if (/耳鼻喉|耳科|鼻科|咽喉/.test(context)) return placement("ent");
  if (/口腔|牙科/.test(context)) return placement("oral");
  if (/妇科|乳腺/.test(context)) return placement("gynecology");
  if (/血常规|全血细胞|血液常规/.test(context)) return placement("laboratory", "blood");
  if (/尿常规|尿液/.test(context)) return placement("laboratory", "urine");
  if (/肝功能/.test(context)) return placement("laboratory", "liver");
  if (/肾功能/.test(context)) return placement("laboratory", "renal");
  if (/血脂/.test(context)) return placement("laboratory", "lipid");
  if (/血糖|葡萄糖/.test(context)) return placement("laboratory", "glucose");
  if (/电解质/.test(context)) return placement("laboratory", "electrolyte");
  if (/甲状腺|甲功/.test(context)) return placement("laboratory", "thyroid");
  if (/感染|免疫|乙肝|丙肝|梅毒|艾滋/.test(context)) return placement("laboratory", "infectious");
  if (/检验|生化|实验室/.test(context)) return placement("laboratory", "laboratory_other");
  if (/心电|肺功能|骨密度|动脉硬化|功能检查/.test(context)) return placement("functional");
  if (/影像|超声|彩超|ct|磁共振|mri|dr|x线|放射/.test(context)) return placement("imaging");

  const reportType = compact(input.reportType);
  if (/laboratory|检验/.test(reportType)) return placement("laboratory", "laboratory_other");
  if (/imaging|影像/.test(reportType)) return placement("imaging");
  if (/functional|功能检查/.test(reportType)) return placement("functional");
  return placement("other");
}

