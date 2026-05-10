/**
 * Validation message tests for the dimension rule consolidator.
 *
 * Covers:
 *   – Server-side TS util (`app/services/dimension-rule-message.ts`)
 *   – Storefront JS twin (`extensions/theme-extension/assets/dimension-rule-message.js`)
 *
 * The parity block at the bottom requires both files to produce byte-identical
 * messages for the same inputs — they ship in two different runtimes (Node SSR
 * and the storefront DOM) and must stay in sync.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDimensionRuleMessages,
  type DimensionMetadataInput,
  type DimensionRuleInput,
} from "../app/services/dimension-rule-message";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Load the storefront JS twin in a sandbox that mimics the browser globals
 * the IIFE expects. The root `package.json` declares `"type": "module"`, so
 * `require()` would treat the file as ESM and skip the `module.exports`
 * branch — running the source as a script gives us exactly what the browser
 * sees.
 */
function loadJsTwin(): { buildDimensionRuleMessages: typeof buildDimensionRuleMessages } {
  const source = readFileSync(
    join(HERE, "..", "extensions/theme-extension/assets/dimension-rule-message.js"),
    "utf8",
  );
  // The IIFE assigns `PrintDockMessages` onto `globalThis`. In `runInNewContext`,
  // `globalThis` is the sandbox itself, so we read the binding back from there.
  const sandbox: { PrintDockMessages?: unknown } = {};
  runInNewContext(source, sandbox);
  return sandbox.PrintDockMessages as {
    buildDimensionRuleMessages: typeof buildDimensionRuleMessages;
  };
}

const jsTwin = loadJsTwin();

function meta(overrides: Partial<DimensionMetadataInput> = {}): DimensionMetadataInput {
  return {
    widthPx: null,
    heightPx: null,
    dpi: null,
    widthInch: null,
    heightInch: null,
    pageCount: null,
    fileSizeMB: 1,
    ...overrides,
  };
}

function rule(overrides: Partial<DimensionRuleInput> & Pick<DimensionRuleInput, "dimensionType" | "operator" | "value">): DimensionRuleInput {
  return {
    id: overrides.id ?? `${overrides.dimensionType}-${overrides.operator}-${overrides.value}`,
    groupId: overrides.groupId,
    dimensionType: overrides.dimensionType,
    operator: overrides.operator,
    value: overrides.value,
    action: overrides.action ?? "prevent",
  };
}

describe("buildDimensionRuleMessages — fixed (eq) rule", () => {
  it("produces a violation message when width does not match the fixed value", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "widthInch", operator: "eq", value: 22 })],
      meta({ widthInch: 24.5, dpi: 300, widthPx: 7350 }),
    );
    expect(results).toEqual([
      expect.objectContaining({
        severity: "blocking",
        message: "Width: 24.50 in (required 22.00 in)",
        actual: 24.5,
        expected: 22,
      }),
    ]);
  });

  it("emits nothing when the fixed value matches", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "widthInch", operator: "eq", value: 22 })],
      meta({ widthInch: 22, dpi: 300, widthPx: 6600 }),
    );
    expect(results).toEqual([]);
  });

  it("formats DPI as integer with DPI unit", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "dpi", operator: "eq", value: 300 })],
      meta({ dpi: 150 }),
    );
    expect(results[0]?.message).toBe("DPI: 150 DPI (required 300 DPI)");
  });
});

describe("buildDimensionRuleMessages — range rules", () => {
  it("consolidates gte + lte into a single message", () => {
    const groupId = "w-range";
    const results = buildDimensionRuleMessages(
      [
        rule({ dimensionType: "widthInch", operator: "gte", value: 4, groupId }),
        rule({ dimensionType: "widthInch", operator: "lte", value: 12, groupId }),
      ],
      meta({ widthInch: 13.5, dpi: 300, widthPx: 4050 }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.message).toBe("Width: 13.50 in (required 4.00\u201312.00 in)");
  });

  it("collapses range to fixed-style message when min equals max", () => {
    const groupId = "w-range";
    const results = buildDimensionRuleMessages(
      [
        rule({ dimensionType: "widthInch", operator: "gte", value: 4, groupId }),
        rule({ dimensionType: "widthInch", operator: "lte", value: 4, groupId }),
      ],
      meta({ widthInch: 3.99, dpi: 300, widthPx: 1197 }),
    );
    expect(results[0]?.message).toBe("Width: 3.99 in (required 4.00 in)");
  });

  it("uses 'at least' when only a lower bound is set", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "heightInch", operator: "gte", value: 6 })],
      meta({ heightInch: 5.5, dpi: 300, heightPx: 1650 }),
    );
    expect(results[0]?.message).toBe("Height: 5.50 in (required at least 6.00 in)");
  });

  it("uses 'at most' when only an upper bound is set", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "widthInch", operator: "lte", value: 12 })],
      meta({ widthInch: 13.5, dpi: 300, widthPx: 4050 }),
    );
    expect(results[0]?.message).toBe("Width: 13.50 in (required at most 12.00 in)");
  });

  it("does not emit when actual value is inside the range", () => {
    const groupId = "w-range";
    const results = buildDimensionRuleMessages(
      [
        rule({ dimensionType: "widthInch", operator: "gte", value: 4, groupId }),
        rule({ dimensionType: "widthInch", operator: "lte", value: 12, groupId }),
      ],
      meta({ widthInch: 8, dpi: 300, widthPx: 2400 }),
    );
    expect(results).toEqual([]);
  });
});

describe("buildDimensionRuleMessages — DPI-missing fallback", () => {
  it("emits a warning when the inch rule cannot be evaluated due to missing DPI", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "widthInch", operator: "eq", value: 22 })],
      meta({ widthInch: null, dpi: null, widthPx: 3000 }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.severity).toBe("warning");
    expect(results[0]?.message).toBe(
      "Width: cannot be measured \u2014 file is missing DPI metadata. " +
        "Please re-export the file with DPI embedded.",
    );
  });

  it("evaluates the DPI rule itself even when widthInch/heightInch cannot be measured", () => {
    const results = buildDimensionRuleMessages(
      [
        rule({ dimensionType: "widthInch", operator: "eq", value: 22 }),
        rule({ dimensionType: "dpi", operator: "eq", value: 300 }),
      ],
      meta({ widthInch: null, dpi: 150, widthPx: 3300, heightPx: 6600 }),
    );
    expect(results).toHaveLength(2);
    const widthResult = results.find((r) => r.ruleId.startsWith("widthInch:"));
    const dpiResult = results.find((r) => r.ruleId.startsWith("dpi:"));
    expect(widthResult?.severity).toBe("warning");
    expect(dpiResult?.message).toBe("DPI: 150 DPI (required 300 DPI)");
  });
});

describe("buildDimensionRuleMessages — multiple dimensions", () => {
  it("emits one message per failing dimension group", () => {
    const results = buildDimensionRuleMessages(
      [
        rule({ dimensionType: "widthInch", operator: "eq", value: 22 }),
        rule({ dimensionType: "dpi", operator: "eq", value: 300 }),
      ],
      meta({ widthInch: 24.5, dpi: 150, widthPx: 7350 }),
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.message).sort()).toEqual(
      [
        "DPI: 150 DPI (required 300 DPI)",
        "Width: 24.50 in (required 22.00 in)",
      ].sort(),
    );
  });

  it("severity is warning when the failing rule has action=warning", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "dpi", operator: "eq", value: 300, action: "warning" })],
      meta({ dpi: 150 }),
    );
    expect(results[0]?.severity).toBe("warning");
  });
});

describe("buildDimensionRuleMessages — legacy dimension types", () => {
  it("falls back to a per-rule message for widthPx", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "widthPx", operator: "gte", value: 1200 })],
      meta({ widthPx: 1199, heightPx: 1799 }),
    );
    expect(results[0]?.message).toBe(
      "Width (pixels): 1199 px (required at least 1200 px)",
    );
  });

  it("formats pageCount cleanly", () => {
    const results = buildDimensionRuleMessages(
      [rule({ dimensionType: "pageCount", operator: "lte", value: 1 })],
      meta({ pageCount: 5 }),
    );
    expect(results[0]?.message).toBe("Page count: 5 (required at most 1)");
  });
});

describe("buildDimensionRuleMessages — JS twin parity", () => {
  const scenarios: {
    name: string;
    rules: DimensionRuleInput[];
    metadata: DimensionMetadataInput;
  }[] = [
    {
      name: "fixed width violation",
      rules: [rule({ dimensionType: "widthInch", operator: "eq", value: 22 })],
      metadata: meta({ widthInch: 24.5, dpi: 300, widthPx: 7350 }),
    },
    {
      name: "DPI fixed violation",
      rules: [rule({ dimensionType: "dpi", operator: "eq", value: 300 })],
      metadata: meta({ dpi: 150 }),
    },
    {
      name: "width range consolidated",
      rules: [
        rule({ dimensionType: "widthInch", operator: "gte", value: 4, groupId: "g" }),
        rule({ dimensionType: "widthInch", operator: "lte", value: 12, groupId: "g" }),
      ],
      metadata: meta({ widthInch: 13.5, dpi: 300, widthPx: 4050 }),
    },
    {
      name: "missing DPI",
      rules: [rule({ dimensionType: "widthInch", operator: "eq", value: 22 })],
      metadata: meta({ widthInch: null, dpi: null }),
    },
    {
      name: "multiple dimensions",
      rules: [
        rule({ dimensionType: "widthInch", operator: "eq", value: 22 }),
        rule({ dimensionType: "dpi", operator: "eq", value: 300 }),
      ],
      metadata: meta({ widthInch: 24.5, dpi: 150, widthPx: 7350 }),
    },
    {
      name: "legacy widthPx rule",
      rules: [rule({ dimensionType: "widthPx", operator: "gte", value: 1200 })],
      metadata: meta({ widthPx: 1199 }),
    },
    {
      name: "no violations",
      rules: [rule({ dimensionType: "dpi", operator: "eq", value: 300 })],
      metadata: meta({ dpi: 300 }),
    },
    {
      name: "warning severity inherited from action",
      rules: [rule({ dimensionType: "dpi", operator: "eq", value: 300, action: "warning" })],
      metadata: meta({ dpi: 150 }),
    },
  ];

  it.each(scenarios)("produces identical output for: $name", ({ rules: input, metadata }) => {
    const tsResult = buildDimensionRuleMessages(input, metadata);
    const jsResult = jsTwin.buildDimensionRuleMessages(input, metadata);
    const sort = (arr: typeof tsResult) =>
      arr
        .slice()
        .sort((a, b) => a.ruleId.localeCompare(b.ruleId))
        .map((entry) => ({
          ruleId: entry.ruleId,
          severity: entry.severity,
          message: entry.message,
          actual: entry.actual,
          expected: entry.expected,
        }));
    expect(sort(jsResult)).toEqual(sort(tsResult));
  });
});
