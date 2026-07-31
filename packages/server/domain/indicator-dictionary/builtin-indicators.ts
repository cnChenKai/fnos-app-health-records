import coreIndicatorsDocument from "../../../../dictionary/core/indicators.json" with { type: "json" };
import coreTaxonomyDocument from "../../../../dictionary/core/taxonomy.json" with { type: "json" };
import type { TrendGroupKey, TrendSubgroupKey } from "./trend-taxonomy";

export type ObservationKind = "quantitative" | "categorical";
export type IndicatorValueType = "numeric" | "text" | "positive_negative" | "ordinal";
export type IndicatorSpecimen = "blood" | "urine" | "serum" | "plasma" | "whole_blood" | "other" | null;
export type IndicatorUnitDimension =
  | "count_concentration"
  | "mass"
  | "length"
  | "pressure"
  | "frequency"
  | "volume"
  | "filtration_rate"
  | "ratio"
  | "index"
  | "enzyme_activity"
  | "molar_concentration"
  | "mass_concentration"
  | "time"
  | "categorical"
  | "text"
  | "other";

export type BuiltinIndicator = {
  canonicalKey: string;
  displayName: string;
  category: string;
  categoryKey: string;
  groupKey: TrendGroupKey;
  subgroupKey: TrendSubgroupKey | null;
  itemOrder: number;
  observationKind: ObservationKind;
  specimen: IndicatorSpecimen;
  defaultUnit: string | null;
  unitDimension: IndicatorUnitDimension;
  valueType: "numeric" | "text" | "positive_negative";
  trendEnabled: boolean;
  aliases: string[];
  allowedUnits: string[];
  sectionHints: string[];
  explanation: string;
};

type IndicatorDefinition = {
  canonicalKey: string;
  displayName: string;
  categoryKey: string;
  order: number;
  kind: ObservationKind;
  valueType: IndicatorValueType;
  specimen: IndicatorSpecimen;
  defaultUnit: string | null;
  unitDimension: IndicatorUnitDimension;
  aliases: string[];
  allowedUnits: string[];
  sectionHints: string[];
  explanation: string;
};

const categories = new Map(
  coreTaxonomyDocument.categories.map((category) => [category.key, {
    name: category.name,
    groupKey: category.groupKey as TrendGroupKey,
    subgroupKey: category.subgroupKey as TrendSubgroupKey | null
  }])
);
const definitions = coreIndicatorsDocument.indicators as IndicatorDefinition[];

export const builtinIndicatorVersion = `core-r${coreIndicatorsDocument.revision}`;
export const builtinIndicators: BuiltinIndicator[] = definitions
  .map((indicator) => {
    if (indicator.valueType === "ordinal") {
      throw new Error(`内置指标 ${indicator.canonicalKey} 暂不支持 ordinal valueType`);
    }
    const category = categories.get(indicator.categoryKey);
    if (!category) throw new Error(`内置指标 ${indicator.canonicalKey} 引用了不存在的分类 ${indicator.categoryKey}`);
    return {
      canonicalKey: indicator.canonicalKey,
      displayName: indicator.displayName,
      category: category.name,
      categoryKey: indicator.categoryKey,
      groupKey: category.groupKey,
      subgroupKey: category.subgroupKey,
      itemOrder: indicator.order,
      observationKind: indicator.kind,
      specimen: indicator.specimen,
      defaultUnit: indicator.defaultUnit,
      unitDimension: indicator.unitDimension,
      valueType: indicator.valueType,
      trendEnabled: indicator.kind === "quantitative" && indicator.valueType === "numeric",
      aliases: indicator.aliases,
      allowedUnits: indicator.allowedUnits,
      sectionHints: indicator.sectionHints,
      explanation: indicator.explanation
    };
  });
