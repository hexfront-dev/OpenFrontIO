/**
 * Emitted by the in-game save button. The ClientGameRunner asks its core worker
 * to capture and encode a checkpoint now; checkpoints are no longer captured on
 * a timer. Kept in its own module so both the HUD button and the game runner can
 * import it without a dependency cycle.
 */
export class SaveCheckpointEvent {}
