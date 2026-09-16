export type ReplayTransition = "continue" | "replay" | "goLive" | "end";

// Decides what LocalServer.endTurn should do at the replay/live boundary.
// A pure replay ends when its history is exhausted; a resumed save switches
// to live play and keeps generating turns from player intents.
export function replayTransition(
  live: boolean,
  resuming: boolean,
  replayLength: number,
  turnsPlayed: number,
): ReplayTransition {
  if (live || replayLength === 0) {
    return "continue";
  }
  if (turnsPlayed < replayLength) {
    return "replay";
  }
  return resuming ? "goLive" : "end";
}
