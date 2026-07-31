import coreTaxonomyDocument from "../../../../dictionary/core/taxonomy.json" with { type: "json" };

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
  groupKey: string;
  groupName: string;
  groupOrder: number;
  subgroupKey: string | null;
  subgroupName: string | null;
  subgroupOrder: number;
};

type TaxonomySubgroup = {
  key: TrendSubgroupKey;
  name: string;
  order: number;
  sectionHints: string[];
};

type TaxonomyGroup = {
  key: TrendGroupKey;
  name: string;
  order: number;
  sectionHints: string[];
  subgroups: TaxonomySubgroup[];
};

type TaxonomyCategory = {
  key: string;
  name: string;
  groupKey: TrendGroupKey;
  subgroupKey: TrendSubgroupKey | null;
  aliases: string[];
  sectionHints: string[];
};

const taxonomyGroups = coreTaxonomyDocument.groups as TaxonomyGroup[];
const taxonomyCategories = coreTaxonomyDocument.categories as TaxonomyCategory[];

export const trendGroups = taxonomyGroups.map((group) => ({
  key: group.key,
  name: group.name,
  order: group.order
}));
export const laboratorySubgroups = (taxonomyGroups.find((group) => group.key === "laboratory")?.subgroups || [])
  .map((subgroup) => ({ key: subgroup.key, name: subgroup.name, order: subgroup.order }));

const groupByKey = new Map(taxonomyGroups.map((group) => [group.key, group]));
const subgroupByKey = new Map(taxonomyGroups.flatMap((group) =>
  group.subgroups.map((subgroup) => [subgroup.key, { ...subgroup, groupKey: group.key }] as const)
));

function compact(value: string | null | undefined) {
  return (value || "")
    .normalize("NFKC")
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

function matchingCategory(value: string | null | undefined, exact: boolean) {
  const context = compact(value);
  if (!context) return null;
  return taxonomyCategories.find((category) => {
    const candidates = [category.name, ...category.aliases, ...category.sectionHints].map(compact);
    return exact ? candidates.includes(context) : candidates.some((hint) => hint && context.includes(hint));
  }) || null;
}

function matchingGroup(value: string | null | undefined) {
  const context = compact(value);
  if (!context) return null;
  for (const group of taxonomyGroups) {
    for (const subgroup of group.subgroups) {
      if (subgroup.sectionHints.some((hint) => context.includes(compact(hint)))) {
        return placement(group.key, subgroup.key);
      }
    }
    if (group.sectionHints.some((hint) => context.includes(compact(hint)))) {
      return group.key === "laboratory"
        ? placement("laboratory", "laboratory_other")
        : placement(group.key);
    }
  }
  return null;
}

export function trendPlacementFor(input: {
  category?: string | null;
  sectionName?: string | null;
  reportType?: string | null;
}): TrendPlacement {
  const category = matchingCategory(input.category, true);
  if (category) return placement(category.groupKey, category.subgroupKey);

  const sectionCategory = matchingCategory(input.sectionName, false);
  if (sectionCategory) return placement(sectionCategory.groupKey, sectionCategory.subgroupKey);
  const sectionGroup = matchingGroup(input.sectionName);
  if (sectionGroup) return sectionGroup;

  const reportType = compact(input.reportType);
  if (/laboratory|检验/.test(reportType)) return placement("laboratory", "laboratory_other");
  if (/imaging|影像/.test(reportType)) return placement("imaging");
  if (/functional|功能检查/.test(reportType)) return placement("functional");
  return placement("other");
}
