import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { Block, TripPlan } from "../types.js";
import { isPlaceBlock } from "../types.js";
import { findDaySectionByDate, submitOp } from "./shared.js";

export const reorderDayInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip containing the day to reorder."),
  day: z
    .string()
    .min(1)
    .describe("The day to reorder. Accepts 'day 2', 'May 4', or ISO '2026-05-04'."),
  mode: z
    .enum(["chronological", "reverse"])
    .default("chronological")
    .describe(
      "How to sort the day's blocks. 'chronological' sorts by start time (places with no time go last, keeping relative order). 'reverse' reverses the current order.",
    ),
};

export const reorderDayDescription = `
Reorders the blocks within a single day of a Wanderlog trip.

Wanderlog displays blocks in insertion order, NOT by scheduled clock time — so a day built
by adding places in a different order than their start times will look wrong. This tool
fixes that by sorting the day's blocks chronologically by their start_time.

Places with a start_time are sorted by time. Places without a time (or notes/checklists)
are kept in their current relative order and appended after the timed places.
`.trim();

type Args = {
  trip_key: string;
  day: string;
  mode?: "chronological" | "reverse";
};

/**
 * JSON0 move op: lm (list move) with value at index.
 * p: [..., "blocks", fromIndex], lm: toIndex
 */
function moveOp(
  sectionIndex: number,
  fromIndex: number,
  toIndex: number,
): Json0Op {
  return {
    p: ["itinerary", "sections", sectionIndex, "blocks", fromIndex],
    lm: toIndex,
  };
}

/** Extract a block's sortable start time, or null if it has none. */
function blockStartTime(block: Block): string | null {
  if (isPlaceBlock(block) && block.startTime) return block.startTime;
  return null;
}

export async function reorderDay(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const daySection = resolveDay(trip, args.day);
    const found = findDaySectionByDate(trip, daySection.date!);
    if (!found) {
      throw new WanderlogValidationError(`Day ${args.day} not found in trip`);
    }

    const { index: sectionIndex, section } = found;
    const blocks = section.blocks;

    if (blocks.length <= 1) {
      return {
        content: [
          {
            type: "text",
            text: `Day ${args.day} has only ${blocks.length} block(s) — nothing to reorder.`,
          },
        ],
      };
    }

    if (args.mode === "reverse") {
      const ops: Json0Op[] = [];
      // Reverse via successive moves: move last to front, second-last to front+1, ...
      for (let i = 0; i < Math.floor(blocks.length / 2); i++) {
        const fromHigh = blocks.length - 1 - i;
        if (fromHigh > i) {
          ops.push(moveOp(sectionIndex, fromHigh, i));
        }
      }
      await submitOp(ctx, args.trip_key, ops);
      return {
        content: [
          {
            type: "text",
            text: `Reversed ${blocks.length} blocks on day ${args.day}.`,
          },
        ],
      };
    }

    // Chronological: stable sort by start time. Timed places first (by time),
    // then untimed blocks (notes, checklists, time-less places) in original order.
    const timed = blocks
      .map((b, idx) => ({ block: b, idx }))
      .filter((x) => blockStartTime(x.block) !== null)
      .sort((a, b) => blockStartTime(a.block)!.localeCompare(blockStartTime(b.block)!));
    const untimed = blocks
      .map((b, idx) => ({ block: b, idx }))
      .filter((x) => blockStartTime(x.block) === null);

    const desiredOrder = [...timed, ...untimed].map((x) => x.idx);

    // Check if already in correct order
    const alreadyOrdered = desiredOrder.every((v, i) => v === i);
    if (alreadyOrdered) {
      return {
        content: [
          {
            type: "text",
            text: `Day ${args.day} is already in chronological order — no changes needed.`,
          },
        ],
      };
    }

    // Convert desired order into JSON0 lm moves.
    // Strategy: repeatedly move the block that should be at position i up to position i.
    // We work on a mutable copy of the array indices.
    const current = desiredOrder.map((x) => x); // current block offsets, in display order
    const ops: Json0Op[] = [];

    for (let target = 0; target < current.length; target++) {
      // Desired block at position target is desiredOrder[target] (original index).
      // Find where that original index currently sits.
      const wanted = desiredOrder[target]!;
      const currentPos = current.indexOf(wanted);
      if (currentPos !== target) {
        // Move the block from currentPos to target.
        ops.push(moveOp(sectionIndex, currentPos, target));
        // Update the working array: remove from currentPos, insert at target.
        const [moved] = current.splice(currentPos, 1);
        current.splice(target, 0, moved!);
      }
    }

    if (ops.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Day ${args.day} is already in chronological order — no changes needed.`,
          },
        ],
      };
    }

    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [
        {
          type: "text",
          text: `Reordered ${ops.length} block(s) on day ${args.day} chronologically.`,
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