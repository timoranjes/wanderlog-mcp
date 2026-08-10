import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import { submitOp } from "./shared.js";

export const replacePlaceNoteInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip containing the place."),
  place: z
    .string()
    .min(1)
    .describe(
      "Natural-language reference to the place. Examples: 'Sensō-ji', 'the hotel', 'Queenstown Gardens on day 2'. Supports ordinals for duplicates: '2nd Starbucks'.",
    ),
  note: z
    .string()
    .describe(
      "The new note text — REPLACES any existing note entirely (does not append).",
    ),
};

export const replacePlaceNoteDescription = `
Replaces the inline note on a place with new text — unlike annotate_place which APPENDS,
this tool REPLACES the entire note. Use this when you want to overwrite a stale or
duplicated note rather than adding to it.

The place is resolved by natural-language reference (same syntax as wanderlog_remove_place).
If ambiguous, returns a disambiguation list without making changes.
`.trim();

type Args = {
  trip_key: string;
  place: string;
  note: string;
};

export async function replacePlaceNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    if (!args.note.trim()) {
      throw new WanderlogValidationError("Note text cannot be empty");
    }

    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;

    const result = resolvePlaceRef(trip, args.place);
    if (result.kind === "none") {
      throw new WanderlogError(
        `No place matching "${args.place}" found in "${trip.title}"`,
        "place_ref_not_found",
        {
          hint: "Check the place name or use wanderlog_get_trip to see what's in the itinerary.",
          followUps: [
            `Call wanderlog_get_trip with trip_key "${args.trip_key}" to see all places.`,
          ],
        },
      );
    }
    if (result.kind === "ambiguous") {
      const lines = result.candidates.map((c, i) => {
        const name = isPlaceBlock(c.block) ? c.block.place.name : `block #${c.block.id}`;
        const loc = c.section.date ? `day ${c.section.date}` : c.section.heading || "unscheduled";
        return `  ${i + 1}. ${name} (${loc})`;
      });
      const text = `Multiple places match "${args.place}":\n${lines.join("\n")}\n\nRetry with a more specific reference or an ordinal prefix (e.g. "1st ${args.place}").`;
      return { content: [{ type: "text", text }] };
    }

    const { sectionIndex, blockIndex, block } = result.match;
    const blockPath = ["itinerary", "sections", sectionIndex, "blocks", blockIndex];
    const placeName = isPlaceBlock(block) ? block.place.name : `block #${block.id}`;

    // REPLACE the entire text field using JSON0 oi/od (object insert with delete of old)
    const existingBlock = block as Record<string, unknown>;
    const oldText = existingBlock.text;
    const newText = { ops: [{ insert: `${args.note}\n` }] };

    const op: Json0Op = {
      p: [...blockPath, "text"],
      oi: newText,
      od: oldText,
    };

    await submitOp(ctx, args.trip_key, [op]);

    const preview = args.note.length > 60 ? `${args.note.slice(0, 57)}…` : args.note;
    return {
      content: [
        {
          type: "text",
          text: `Replaced note on ${placeName} in "${trip.title}". Note: "${preview}"`,
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