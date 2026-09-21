import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The code under test only uses getPlayToken from Auth; stub it so the test does
// not touch localStorage (which some Node/jsdom setups do not provide).
vi.mock("../src/client/Auth", () => ({
  getPlayToken: vi.fn().mockResolvedValue("test-token"),
  getAuthHeader: vi.fn(),
  isSessionActive: vi.fn(),
  logOut: vi.fn(),
  userAuth: vi.fn(),
}));

import { listSavedLobbies } from "../src/client/Api";
import { ClientEnv } from "../src/client/ClientEnv";

function setConfig(numWorkers: number) {
  (window as unknown as { BOOTSTRAP_CONFIG: object }).BOOTSTRAP_CONFIG = {
    gameEnv: "dev",
    numWorkers,
    turnstileSiteKey: "x",
    jwtAudience: "localhost",
    instanceId: "test",
    gitCommit: "DEV",
  };
  ClientEnv.reset();
}

function stubResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("listSavedLobbies diagnostics", () => {
  beforeEach(() => setConfig(2));

  afterEach(() => {
    delete (window as unknown as { BOOTSTRAP_CONFIG?: object })
      .BOOTSTRAP_CONFIG;
    ClientEnv.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns saves and reports a rejected worker instead of hiding it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/w0/")) {
          return stubResponse(200, {
            saves: [{ gameID: "GAME0001", savedAt: 1 }],
          });
        }
        return stubResponse(401, "Invalid token");
      }),
    );

    const result = await listSavedLobbies();

    expect(result.workers).toBe(2);
    expect(result.saves.map((s) => s.gameID)).toEqual(["GAME0001"]);
    expect(result.errors).toEqual([
      { worker: 1, status: 401, message: "Invalid token" },
    ]);
  });

  it("reports a network failure per worker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/w0/")) throw new Error("boom");
        return stubResponse(200, { saves: [] });
      }),
    );

    const result = await listSavedLobbies();

    expect(result.saves).toEqual([]);
    expect(result.errors).toEqual([{ worker: 0, message: "boom" }]);
  });
});
