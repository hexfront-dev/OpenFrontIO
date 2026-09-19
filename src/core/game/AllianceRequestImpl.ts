import { AllianceRequestCheckpoint } from "../Checkpoint";
import { AllianceRequest, Player, Tick } from "./Game";
import { GameImpl } from "./GameImpl";
import { AllianceRequestUpdate, GameUpdateType } from "./GameUpdates";

export class AllianceRequestImpl implements AllianceRequest {
  private status_: "pending" | "accepted" | "rejected" = "pending";

  constructor(
    private requestor_: Player,
    private recipient_: Player,
    private tickCreated: number,
    private game: GameImpl,
  ) {}

  status(): "pending" | "accepted" | "rejected" {
    return this.status_;
  }

  requestor(): Player {
    return this.requestor_;
  }

  recipient(): Player {
    return this.recipient_;
  }

  createdAt(): Tick {
    return this.tickCreated;
  }

  accept(): void {
    this.status_ = "accepted";
    this.game.acceptAllianceRequest(this);
  }
  reject(): void {
    this.status_ = "rejected";
    this.game.rejectAllianceRequest(this);
  }

  /** B2: capture the request, including whether it was already resolved. */
  checkpoint(): AllianceRequestCheckpoint {
    return {
      requestorId: this.requestor_.id(),
      recipientId: this.recipient_.id(),
      createdAt: this.tickCreated,
      status: this.status_,
    };
  }

  /**
   * B2: overwrite this request's resolution status from a checkpoint. The
   * requestor/recipient/tick are constructor arguments, not restored here.
   */
  restoreFromCheckpoint(cp: AllianceRequestCheckpoint): void {
    this.status_ = cp.status ?? "pending";
  }

  toUpdate(): AllianceRequestUpdate {
    return {
      type: GameUpdateType.AllianceRequest,
      requestorID: this.requestor_.smallID(),
      recipientID: this.recipient_.smallID(),
      createdAt: this.tickCreated,
    };
  }
}
