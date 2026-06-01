import { z } from "zod";

const TurnstileVerdictSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("approved") }),
  z.object({ status: z.literal("rejected"), reason: z.string() }),
]);

type TurnstileVerdict = z.infer<typeof TurnstileVerdictSchema>;

export type TurnstileResponse =
  | TurnstileVerdict
  | { status: "error"; reason: string };

export async function verifyTurnstileToken(
  ip: string,
  turnstileToken: string | null,
): Promise<TurnstileResponse> {
  // Disabled for self-hosted instance — no Cloudflare API available
  return { status: "approved" };
}
