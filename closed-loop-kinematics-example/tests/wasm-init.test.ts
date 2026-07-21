import { describe, it, expect } from "vitest";
import { initPinocchio, isInitialized } from "../src/wasm-init";

describe("Pinocchio WASM initialization", () => {
  it("initializes and returns version info", async () => {
    const result = await initPinocchio();
    expect(result).toHaveProperty("version");
    expect(typeof result.version).toBe("string");
    expect(result.version.length).toBeGreaterThan(0);
  });

  it("sets initialized flag after loading", async () => {
    await initPinocchio();
    expect(isInitialized()).toBe(true);
  });
});
