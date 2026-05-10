/**
 * Build user-facing messages for dimension validation rules — storefront twin
 * of `app/services/dimension-rule-message.ts`. Keep these two files in sync.
 *
 * Usage:
 *   <script src="{{ 'dimension-rule-message.js' | asset_url }}" defer></script>
 *   ...
 *   PrintDockMessages.buildDimensionRuleMessages(rules, metadata)
 *
 * Also exposed as a CommonJS module for parity testing under Node/Vitest.
 *
 * Message format (single per-rule line, joins cleanly with `,` or ` · `):
 *   "Width: 24.50 in (required 22.00 in)"
 *   "Width: 13.50 in (required 4.00–12.00 in)"
 *   "Height: 5.50 in (required at least 6.00 in)"
 *   "DPI: 150 DPI (required 300 DPI)"
 *   "Width: cannot be measured — file is missing DPI metadata"
 */
(function (global) {
  "use strict";

  const SUPPORTED = ["widthInch", "heightInch", "dpi"];

  function isSupported(dimensionType) {
    return SUPPORTED.indexOf(dimensionType) !== -1;
  }

  function dimensionLabel(dimensionType) {
    if (dimensionType === "widthInch") return "Width";
    if (dimensionType === "heightInch") return "Height";
    return "DPI";
  }

  function dimensionUnit(dimensionType) {
    return dimensionType === "dpi" ? "DPI" : "in";
  }

  function formatValue(dimensionType, value) {
    if (dimensionType === "dpi") return String(Math.round(value));
    return Number(value).toFixed(2);
  }

  function valuesEqual(a, b) {
    return Math.abs(a - b) < 1e-6;
  }

  function ruleViolates(actual, operator, expected) {
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

  function groupRules(rules) {
    const groups = new Map();
    const legacyRules = [];
    for (const rule of rules) {
      if (!isSupported(rule.dimensionType)) {
        legacyRules.push(rule);
        continue;
      }
      const groupId = rule.groupId || rule.id;
      const key = rule.dimensionType + ":" + groupId;
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

  function computeShape(rules) {
    const lowerCandidates = rules
      .filter((rule) => rule.operator === "gte" || rule.operator === "gt")
      .map((rule) => Number(rule.value));
    const upperCandidates = rules
      .filter((rule) => rule.operator === "lte" || rule.operator === "lt")
      .map((rule) => Number(rule.value));
    const eqRule = rules.find((rule) => rule.operator === "eq");
    return {
      eqCandidate: eqRule ? Number(eqRule.value) : null,
      lowerBound: lowerCandidates.length > 0 ? Math.max.apply(null, lowerCandidates) : null,
      upperBound: upperCandidates.length > 0 ? Math.min.apply(null, upperCandidates) : null,
    };
  }

  function groupRequirementText(dimensionType, shape) {
    const unit = dimensionUnit(dimensionType);
    const fmt = (n) => formatValue(dimensionType, n) + " " + unit;
    if (shape.eqCandidate !== null) {
      return "required " + fmt(shape.eqCandidate);
    }
    if (shape.lowerBound !== null && shape.upperBound !== null) {
      if (valuesEqual(shape.lowerBound, shape.upperBound)) {
        return "required " + fmt(shape.lowerBound);
      }
      return (
        "required " +
        formatValue(dimensionType, shape.lowerBound) +
        "\u2013" +
        fmt(shape.upperBound)
      );
    }
    if (shape.lowerBound !== null) {
      return "required at least " + fmt(shape.lowerBound);
    }
    if (shape.upperBound !== null) {
      return "required at most " + fmt(shape.upperBound);
    }
    return "";
  }

  function buildGroupMessage(dimensionType, actual, shape) {
    const unit = dimensionUnit(dimensionType);
    const label = dimensionLabel(dimensionType);
    const actualText = formatValue(dimensionType, actual) + " " + unit;
    const requirement = groupRequirementText(dimensionType, shape);
    if (!requirement) {
      return label + ": " + actualText;
    }
    return label + ": " + actualText + " (" + requirement + ")";
  }

  function buildMissingDpiMessage(dimensionType) {
    return (
      dimensionLabel(dimensionType) +
      ": cannot be measured \u2014 file is missing DPI metadata. " +
      "Please re-export the file with DPI embedded."
    );
  }

  function buildLegacyMessage(rule, actual) {
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
    const fmt = (n) => n + unit;
    const actualText = actual !== null && actual !== undefined ? fmt(actual) : "\u2014";
    let requirement;
    const op = rule.operator;
    if (op === "eq") requirement = "required " + fmt(rule.value);
    else if (op === "gte" || op === "gt") requirement = "required at least " + fmt(rule.value);
    else if (op === "lte" || op === "lt") requirement = "required at most " + fmt(rule.value);
    else requirement = "required " + fmt(rule.value);
    return label + ": " + actualText + " (" + requirement + ")";
  }

  function buildDimensionRuleMessages(rules, metadata) {
    const results = [];
    const grouped = groupRules(rules || []);

    for (const group of grouped.supportedGroups) {
      const dimensionType = group.dimensionType;
      const actual = metadata && metadata[dimensionType] != null ? metadata[dimensionType] : null;

      const isInchRule = dimensionType === "widthInch" || dimensionType === "heightInch";
      const dpiPresent = metadata && metadata.dpi != null;
      if (isInchRule && (actual === null || !dpiPresent)) {
        const shape = computeShape(group.rules);
        results.push({
          ruleId: group.groupKey,
          severity: "warning",
          message: buildMissingDpiMessage(dimensionType),
          actual: null,
          expected:
            shape.eqCandidate !== null
              ? shape.eqCandidate
              : shape.lowerBound !== null
                ? shape.lowerBound
                : shape.upperBound !== null
                  ? shape.upperBound
                  : 0,
        });
        continue;
      }

      if (actual === null) continue;

      const violatedRules = group.rules.filter((rule) =>
        ruleViolates(actual, rule.operator, Number(rule.value)),
      );
      if (violatedRules.length === 0) continue;

      const shape = computeShape(group.rules);
      const severity = violatedRules.some((rule) => rule.action === "prevent")
        ? "blocking"
        : "warning";
      const expected =
        shape.eqCandidate !== null
          ? shape.eqCandidate
          : shape.lowerBound !== null
            ? shape.lowerBound
            : shape.upperBound !== null
              ? shape.upperBound
              : Number(violatedRules[0].value);

      results.push({
        ruleId: group.groupKey,
        severity,
        message: buildGroupMessage(dimensionType, actual, shape),
        actual,
        expected,
      });
    }

    for (const rule of grouped.legacyRules) {
      const actual =
        metadata && metadata[rule.dimensionType] != null ? metadata[rule.dimensionType] : null;
      if (actual === null) continue;
      if (!ruleViolates(actual, rule.operator, Number(rule.value))) continue;
      results.push({
        ruleId: rule.id,
        severity: rule.action === "prevent" ? "blocking" : "warning",
        message: buildLegacyMessage(rule, actual),
        actual,
        expected: Number(rule.value),
      });
    }

    return results;
  }

  const exported = { buildDimensionRuleMessages };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  global.PrintDockMessages = exported;
  // eslint-disable-next-line no-undef
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
