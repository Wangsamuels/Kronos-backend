import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildModel, concreteContracts } from "../worker/ast.js";
import { mapHeuristic, draftHeuristic, mergeDrafts } from "../worker/agents/agents.js";
import { buildGuard } from "../worker/build.js";
import { KRONOS_SRC } from "../worker/util/paths.js";

/** Integration: sample -> solc AST -> mapper -> generator. Requires forge on PATH. */
describe("MiniLend sample through the deterministic pipeline", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "kronos-gen-"));
  const files = ["samples/MiniLend.sol", "samples/MiniLendCore.sol", "interfaces/IERC20.sol", "SafeTransfer.sol"];
  const root = path.join(ws, "src-root");
  for (const f of files) {
    await fs.mkdir(path.dirname(path.join(root, "src", f)), { recursive: true });
    await fs.copyFile(path.join(KRONOS_SRC, f), path.join(root, "src", f));
  }
  const model = await buildModel(root, files.map((f) => `src/${f}`), false, ws);

  it("compiles to a solc AST", () => {
    expect(model.astSource).toBe("solc");
    expect(concreteContracts(model).map((c) => c.name)).toEqual(["MiniLend"]);
  });

  it("maps entry points, key state and the compound-v2-style adapter", () => {
    const m = mapHeuristic(model);
    expect(m.adapter).toBe("compound-v2-style");
    expect(m.coreContract).toBe("MiniLendCore");
    expect(m.entrypoints.filter((e) => e.role === "user").map((e) => e.kind).sort()).toEqual(["borrow", "deposit", "liquidate", "repay", "withdraw"]);
    expect(m.entrypoints.find((e) => e.signature === "listAsset(address,address,uint8,uint256,uint256)")?.role).toBe("privileged");
    expect(m.keyState).toMatchObject({ health: "healthBps", spotPrice: "priceOf", totalLiabilities: "totalDeposits", listedAssets: "marketList" });
  });

  it("generates a fully resolved GuardConfig and Guarded contract", () => {
    const map = mapHeuristic(model);
    const merged = mergeDrafts(draftHeuristic("A", map, 1313161555), draftHeuristic("B", map, 1313161555));
    const g = buildGuard(
      { model, mapping: map, source: { foundryProject: false } } as never,
      merged.map((i) => ({ template: i.template, params: i.params, status: "approved" as const })),
    );
    expect(g.unresolved).toEqual([]);
    expect(g.ok).toBe(true);
    const guarded = g.files.find((f) => f.path.endsWith("GuardedMiniLend.sol"))!.content;
    expect(guarded).toContain("_borrow(_kronosSigner(), _kronosRecipient(intent), intent.amount)");
    expect(guarded).toContain("_repay(_kronosSigner(), intent.account, intent.amount)");
    expect(guarded).toContain("_liquidate(_kronosSigner(), _kronosRecipient(intent), intent.account, intent.asset, intent.amount)");
  });
});
