import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import { findDaySectionByDate, submitOp } from "./shared.js";

export const movePlaceInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip containing the place."),
  place: z
    .string()
    .min(1)
    .describe("Natural-language reference to the place to move."),
  to_day: z
    .string()
    .min(1)
    .describe("Target day. Accepts 'day 2', 'May 4', or ISO '2026-05-04'."),
  to_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Optional position within the target day (0 = first). Defaults to the end."),
};

export const movePlaceDescription = `
Moves a place from its current day to a different day in a Wanderlog trip.

The place is resolved by natural-language reference. If ambiguous, returns a disambiguation
list. This is a single atomic operation — delete from source + insert at target.
`.trim();

type Args = {
  trip_key: string;
  place: string;
  to_day: string;
  to_index?: number;
};

export async function movePlace(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);

    // Find source place
    const result = resolvePlaceRef(trip, args.place);
    if (result.kind === "none") {
      throw new WanderlogError(
        `No place matching "${args.place}" found in "${trip.title}"`,
        "place_ref_not_found",
      );
    }
    if (result.kind === "ambiguous") {
      const lines = result.candidates.map((c, i) => {
        const name = isPlaceBlock(c.block) ? c.block.place.name : `block #${c.block.id}`;
        const loc = c.section.date ? `day ${c.section.date}` : c.section.heading || "unscheduled";
        return `  ${i + 1}. ${name} (${loc})`;
      });
      const text = `Multiple places match "${args.place}":\n${lines.join("\n")}\n\nRetry with a more specific reference.`;
      return { content: [{ type: "text", text }] };
    }

    const { sectionIndex: fromSection, blockIndex: fromBlock, block } = result.match;

    // Find target day
    const daySection = resolveDay(trip, args.to_day);
    const target = findDaySectionByDate(trip, daySection.date!);
    if (!target) {
      throw new WanderlogError(`Target day "${args.to_day}" not found`, "day_not_found");
    }
    const toSection = target.index;
    const toIndex = args.to_index ?? trip.itinerary.sections[toSection]!.blocks.length;

    const placeName = isPlaceBlock(block) ? block.place.name : `block #${block.id}`;

    // JSON0 lm (list move) - removes from source and inserts at target in one op
    const ops: Json0Op[] = [
      {
        p: ["itinerary", "sections", fromSection, "blocks", fromBlock],
        lm: toSection,
        // We need an intermediate path: move to target section, then adjust position
      },
    ];

    // Actually, JSON0 lm moves WITHIN the same array. For cross-section moves,
    // we need a different approach: ld (delete) + li (insert).
    // First, delete the block from source
    const deleteOp: Json0Op = {
      p: ["itinerary", "sections", fromSection, "blocks", fromBlock],
      ld: block,
    };
    await submitOp(ctx, args.trip_key, [deleteOp]);

    // Calculate adjusted insert index (if source was before target in same section,
    // the index shifted by -1 after deletion)
    let adjustedToIndex = toIndex;
    if (fromSection === toSection && fromBlock < toIndex) {
      adjustedToIndex = toIndex - 1;
    }

    // Insert into target section
    const insertOp: Json0Op = {
      p: ["itinerary", "sections", toSection, "blocks", adjustedToIndex],
      li: block,
    };
    await submitOp(ctx, args.trip_key, [insertOp]);

    const fromLabel = result.match.section.date ? `day ${result.match.section.date}` : result.match.section.heading || "unscheduled";
    const toLabel = target.section.date ? `day ${target.section.date}` : target.section.heading || "unscheduled";

    return {
      content: [{ type: "text", text: `Moved "${placeName}" from ${fromLabel} to ${toLabel} (position ${adjustedToIndex}).` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}