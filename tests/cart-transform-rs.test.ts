import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, beforeAll, expect, it } from "vitest";
import {
  getFunctionInfo,
  loadFixture,
  loadInputQuery,
  loadSchema,
  runFunction,
  validateTestAssets,
} from "@shopify/shopify-function-test-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const functionDir = path.join(repoRoot, "extensions/auto-pricing-rs");
const fixturesDir = path.join(functionDir, "tests/fixtures");

const ALLOWED_OPERATION_KEYS = new Set(["lineExpand"]);

type CartTransformOperation = Record<string, unknown>;

function assertAllowlistLineExpandOnly(operations: unknown, fixtureName: string) {
  expect(Array.isArray(operations), `${fixtureName}: operations must be an array`).toBe(true);
  const ops = operations as CartTransformOperation[];
  for (const op of ops) {
    const keys = Object.keys(op);
    expect(keys, `${fixtureName}: each operation must contain exactly one key`).toHaveLength(1);
    expect(
      ALLOWED_OPERATION_KEYS.has(keys[0]!),
      `${fixtureName}: disallowed operation ${keys[0]} — only lineExpand is permitted (never lineUpdate/linesMerge)`,
    ).toBe(true);
    expect(op.lineExpand, `${fixtureName}: lineExpand payload must be an object`).toBeTruthy();
  }
}

describe("auto-pricing-rs cart_transform_run (deployed WASM)", () => {
  let schema: Awaited<ReturnType<typeof loadSchema>>;
  let functionInfo: Awaited<ReturnType<typeof getFunctionInfo>>;
  let schemaPath: string;
  let functionRunnerPath: string;
  let wasmPath: string;
  let targeting: Awaited<ReturnType<typeof getFunctionInfo>>["targeting"];

  beforeAll(async () => {
    execSync("shopify app function build --path auto-pricing-rs", {
      cwd: repoRoot,
      stdio: "inherit",
    });
    functionInfo = await getFunctionInfo(functionDir);
    ({ schemaPath, functionRunnerPath, wasmPath, targeting } = functionInfo);
    schema = await loadSchema(schemaPath);
  }, 120_000);

  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(fixturesDir, file));

  fixtureFiles.forEach((fixtureFile) => {
    const fixtureName = path.basename(fixtureFile);

    it(`runs ${fixtureName} and allowlists lineExpand-only operations`, async () => {
      const fixture = await loadFixture(fixtureFile);
      const targetInputQueryPath = targeting[fixture.target].inputQueryPath;
      const inputQueryAST = await loadInputQuery(targetInputQueryPath);

      const validationResult = await validateTestAssets({ schema, fixture, inputQueryAST });
      expect(validationResult.inputQuery.errors, fixtureName).toEqual([]);
      expect(validationResult.inputFixture.errors, fixtureName).toEqual([]);
      expect(validationResult.outputFixture.errors, fixtureName).toEqual([]);

      const runResult = await runFunction(
        fixture,
        functionRunnerPath,
        wasmPath,
        targetInputQueryPath,
        schemaPath,
      );
      expect(runResult.error, fixtureName).toBeNull();
      expect(runResult.result?.output, fixtureName).toEqual(fixture.expectedOutput);
      assertAllowlistLineExpandOnly(runResult.result?.output?.operations, fixtureName);
    }, 30_000);
  });
});
