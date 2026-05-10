/**
 * Build user-facing messages for dimension validation rules.
 *
 * Replaces the per-rule `warningMessage` field (which currently stores a
 * synthetic fingerprint token like `v1|<groupId>|eq|22`) with a dynamically
 * generated, professional message that includes the actual measured value.
 *
 * Used by both the server (`api.proxy.upload.confirm.tsx`) and the storefront
 * theme extension. The JavaScript twin lives at
 * `extensions/theme-extension/assets/dimension-rule-message.js` and must be
 * kept in sync — see `app/services/dimension-rule-message.test.ts` for the
 * parity sanity check.
 *
 * Message format (single per-rule line, joins cleanly with `,` or ` · `):
 *   "Width: 24.50 in (required 22.00 in)"
 *   "Width: 13.50 in (required 4.00–12.00 in)"
 *   "Height: 5.50 in (required at least 6.00 in)"
 *   "DPI: 150 DPI (required 300 DPI)"
 *   "Width: cannot be measured — file is missing DPI metadata"
 */

export type SupportedDimensionType = "widthInch" | "heightInch" | "dpi";

export interface DimensionRuleInput {
  id: string;
  groupId?: string;
  dimensionType: string;
  operator: "gt" | "lt" | "eq" | "gte" | "lte";
  value: number;
  action: "warning" | "prevent";
}

export interface DimensionMetadataInput {
  widthPx: number | null;
  heightPx: number | null;
  dpi: number | null;
  widthInch: number | null;
  heightInch: number | null;
  pageCount: number | null;
  fileSizeMB: number;
}

export interface DimensionMessage {
  ruleId: string;
  severity: "blocking" | "warning";
  message: string;
  actual: number | null;
  expected: number;
}

const SUPPORTED: SupportedDimensionType[] = ["widthInch", "heightInch", "dpi"];

function isSupported(dimensionType: string): dimensionType is SupportedDimensionType {
  return (SUPPORTED as readonly string[]).includes(dimensionType);
}

function dimensionLabel(dimensionType: SupportedDimensionType): string {
  if (dimensionType === "widthInch") return "Width";
  if (dimensionType === "heightInch") return "Height";
  return "DPI";
}

function dimensionUnit(dimensionType: SupportedDimensionType): string {
  return dimensionType === "dpi" ? "DPI" : "in";
}

function formatValue(dimensionType: SupportedDimensionType, value: number): string {
  if (dimensionType === "dpi") return String(Math.round(value));
  return value.toFixed(2);
}

function valuesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function ruleViolates(actual: number, operator: DimensionRuleInput["operator"], expected: number): boolean {
  switch (operator) {
    case "gt":
      return !(actual > expected);
    case "lt":
      return !(actual < expected);
    case "eq":
      return !valuesEqual(actual, expected);
    case "gte":
      return !(actual >= expected - 1e-6);
    case "lte":
      return !(actual <= expected + 1e-6);
    default:
      return false;
  }
}

interface GroupedRules {
  groupKey: string;
  dimensionType: SupportedDimensionType;
  rules: DimensionRuleInput[];
}

function groupRules(rules: DimensionRuleInput[]): {
  supportedGroups: GroupedRules[];
  legacyRules: DimensionRuleInput[];
} {
  const groups = new Map<string, GroupedRules>();
  const legacyRules: DimensionRuleInput[] = [];
  for (const rule of rules) {
    if (!isSupported(rule.dimensionType)) {
      legacyRules.push(rule);
      continue;
    }
    const groupId = rule.groupId || rule.id;
    const key = `${rule.dimensionType}:${groupId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rules.push(rule);
    } else {
      groups.set(key, {
        groupKey: key,
        dimensionType: rule.dimensionType,
        rules: [rule],
      });
    }
  }
  return { supportedGroups: Array.from(groups.values()), legacyRules };
}

interface GroupShape {
  eqCandidate: number | null;
  lowerBound: number | null;
  upperBound: number | null;
}

function computeShape(rules: DimensionRuleInput[]): GroupShape {
  const lowerCandidates = rules
    .filter((rule) => rule.operator === "gte" || rule.operator === "gt")
    .map((rule) => rule.value);
  const upperCandidates = rules
    .filter((rule) => rule.operator === "lte" || rule.operator === "lt")
    .map((rule) => rule.value);
  const eqCandidate = rules.find((rule) => rule.operator === "eq")?.value ?? null;
  return {
    eqCandidate,
    lowerBound: lowerCandidates.length > 0 ? Math.max(...lowerCandidates) : null,
    upperBound: upperCandidates.length > 0 ? Math.min(...upperCandidates) : null,
  };
}

function groupRequirementText(
  dimensionType: SupportedDimensionType,
  shape: GroupShape,
): string {
  const unit = dimensionUnit(dimensionType);
  const fmt = (n: number) => `${formatValue(dimensionType, n)} ${unit}`;
  if (shape.eqCandidate !== null) {
    return `required ${fmt(shape.eqCandidate)}`;
  }
  if (shape.lowerBound !== null && shape.upperBound !== null) {
    if (valuesEqual(shape.lowerBound, shape.upperBound)) {
      return `required ${fmt(shape.lowerBound)}`;
    }
    return `required ${formatValue(dimensionType, shape.lowerBound)}\u2013${fmt(shape.upperBound)}`;
  }
  if (shape.lowerBound !== null) {
    return `required at least ${fmt(shape.lowerBound)}`;
  }
  if (shape.upperBound !== null) {
    return `required at most ${fmt(shape.upperBound)}`;
  }
  return "";
}

function buildGroupMessage(
  dimensionType: SupportedDimensionType,
  actual: number,
  shape: GroupShape,
): string {
  const unit = dimensionUnit(dimensionType);
  const label = dimensionLabel(dimensionType);
  const actualText = `${formatValue(dimensionType, actual)} ${unit}`;
  const requirement = groupRequirementText(dimensionType, shape);
  if (!requirement) {
    return `${label}: ${actualText}`;
  }
  return `${label}: ${actualText} (${requirement})`;
}

function buildMissingDpiMessage(dimensionType: "widthInch" | "heightInch"): string {
  return `${dimensionLabel(dimensionType)}: cannot be measured \u2014 file is missing DPI metadata. Please re-export the file with DPI embedded.`;
}

function buildLegacyMessage(
  rule: DimensionRuleInput,
  actual: number | null,
): string {
  const label =
    rule.dimensionType === "widthPx"
      ? "Width (pixels)"
      : rule.dimensionType === "heightPx"
        ? "Height (pixels)"
        : rule.dimensionType === "pageCount"
          ? "Page count"
          : rule.dimensionType === "fileSizeMB"
            ? "File size"
            : rule.dimensionType;
  const unit =
    rule.dimensionType === "fileSizeMB"
      ? " MB"
      : rule.dimensionType === "pageCount"
        ? ""
        : rule.dimensionType === "widthPx" || rule.dimensionType === "heightPx"
          ? " px"
          : "";
  const op = rule.operator;
  const fmt = (n: number) => `${n}${unit}`;
  const actualText = actual !== null ? `${fmt(actual)}` : "—";
  let requirement: string;
  if (op === "eq") requirement = `required ${fmt(rule.value)}`;
  else if (op === "gte" || op === "gt") requirement = `required at least ${fmt(rule.value)}`;
  else if (op === "lte" || op === "lt") requirement = `required at most ${fmt(rule.value)}`;
  else requirement = `required ${fmt(rule.value)}`;
  return `${label}: ${actualText} (${requirement})`;
}

/**
 * Convert validation rules + measured metadata into a list of user-facing
 * messages. Returns one entry per failing dimension *group* (not per rule),
 * so a range expressed as gte+lte produces a single consolidated message.
 *
 * Rules that pass produce no entry. Groups that cannot be evaluated because
 * the file is missing the necessary metadata (e.g. inch rule with no DPI)
 * produce a "cannot be measured" warning.
 */
export function buildDimensionRuleMessages(
  rules: DimensionRuleInput[],
  metadata: DimensionMetadataInput,
): DimensionMessage[] {
  const results: DimensionMessage[] = [];
  const { supportedGroups, legacyRules } = groupRules(rules);

  for (const group of supportedGroups) {
    const dimensionType = group.dimensionType;
    const actual = metadata[dimensionType] as number | null;

    const isInchRule = dimensionType === "widthInch" || dimensionType === "heightInch";
    if (isInchRule && (actual === null || metadata.dpi === null)) {
      const shape = computeShape(group.rules);
      results.push({
        ruleId: group.groupKey,
        severity: "warning",
        message: buildMissingDpiMessage(dimensionType),
        actual: null,
        expected: shape.eqCandidate ?? shape.lowerBound ?? shape.upperBound ?? 0,
      });
      continue;
    }

    if (actual === null) continue;

    const violatedRules = group.rules.filter((rule) =>
      ruleViolates(actual, rule.operator, rule.value),
    );
    if (violatedRules.length === 0) continue;

    const shape = computeShape(group.rules);
    const severity: DimensionMessage["severity"] = violatedRules.some(
      (rule) => rule.action === "prevent",
    )
      ? "blocking"
      : "warning";
    const expected =
      shape.eqCandidate ??
      shape.lowerBound ??
      shape.upperBound ??
      violatedRules[0]!.value;

    results.push({
      ruleId: group.groupKey,
      severity,
      message: buildGroupMessage(dimensionType, actual, shape),
      actual,
      expected,
    });
  }

  for (const rule of legacyRules) {
    const actual =
      (metadata as unknown as Record<string, number | null | undefined>)[rule.dimensionType] ??
      null;
    if (actual === null) continue;
    if (!ruleViolates(actual, rule.operator, rule.value)) continue;
    results.push({
      ruleId: rule.id,
      severity: rule.action === "prevent" ? "blocking" : "warning",
      message: buildLegacyMessage(rule, actual),
      actual,
      expected: rule.value,
    });
  }

  return results;
}
