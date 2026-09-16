import { describe, expect, it } from "vitest";
import { replayTransition } from "../src/client/ReplayTransition";

describe("replayTransition", () => {
  it("continues normal live games", () => {
    expect(replayTransition(true, false, 0, 5)).toBe("continue");
    expect(replayTransition(true, true, 10, 10)).toBe("continue");
  });

  it("replays while history remains", () => {
    expect(replayTransition(false, false, 10, 3)).toBe("replay");
    expect(replayTransition(false, true, 10, 3)).toBe("replay");
  });

  it("ends a pure replay at the end of its history", () => {
    expect(replayTransition(false, false, 10, 10)).toBe("end");
    expect(replayTransition(false, false, 10, 12)).toBe("end");
  });

  it("switches a resumed save to live at the end of its history", () => {
    expect(replayTransition(false, true, 10, 10)).toBe("goLive");
    expect(replayTransition(false, true, 10, 12)).toBe("goLive");
  });
});
