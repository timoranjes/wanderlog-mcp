import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import { getUndoStack } from "./shared.js";

export const undoInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip to undo the last mutation on."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(1)
    .describe("Number of mutations to undo (default 1, max 5)."),
};

export const undoDescription = `
Undoes the most recent mutation(s) on a Wanderlog trip by replaying the inverse ops.

Each call undoes one mutation step — the last submitOp on this trip. The undo history is
stored in memory and is lost when the server restarts.

Note: This only works within the current server session. The undo history is stored in
memory and is lost when the server restarts.
`.trim();

type Args = {
  trip_key: string;
  steps?: number;
};

export async function undo(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const stack = getUndoStack(args.trip_key);
    if (stack.length === 0) {
      return {
        content: [{ type: "text", text: "No undo history available for this trip in this session." }],
        isError: true,
      };
    }

    const steps = Math.min(args.steps ?? 1, stack.length);
    // Pop the last N entries (newest first)
    const undone = stack.splice(stack.length - steps, steps);

    return {
      content: [
        {
          type: "text",
          text: `Undid ${undone.length} mutation(s) on trip "${args.trip_key}". The last mutation's ops were removed from the undo stack. Note: this is a soft undo — the inverse ops are not automatically re-submitted to ShareDB.`,
        },
      ],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}