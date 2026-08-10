import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { isPlaceBlock } from "../types.js";
import { submitOp } from "./shared.js";

export const removeDuplicatePlacesInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip to remove duplicates from."),
  day: z
    .string()
    .optional()
    .describe("Optional day to scan. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to scan the entire trip."),
  dry_run: z
    .boolean()
    .default(true)
    .describe("When true, only report duplicates without removing them. Set to false to actually remove."),
};

export const removeDuplicatePlacesDescription = `
Detects duplicate places within a Wanderlog trip — places with the same name and Google
place_id appearing multiple times in the same day. Reports them and optionally removes
the duplicates (keeping the first occurrence, which has the original note and timing).

Use dry_run=true first to see what would be removed, then call again with dry_run=false
to actually remove.
`.trim();

type Args = {
  trip_key: string;
  day?: string;
  dry_run?: boolean;
};

export async function removeDuplicatePlaces(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);
    const sections = args.day
      ? trip.itinerary.sections.filter((s) => s.mode === "dayPlan" && s.date === args.day)
      : trip.itinerary.sections;

    if (sections.length === 0) {
      return {
        content: [{ type: "text", text: args.day ? `Day ${args.day} not found.` : "No sections found in trip." }],
      };
    }

    const allDuplicates: { sectionIndex: number; blockIndex: number; name: string; sectionLabel: string }[] = [];

    for (const section of sections) {
      const sectionIndex = trip.itinerary.sections.indexOf(section);
      const sectionLabel = section.date ? `day ${section.date}` : section.heading || "unscheduled";
      const seen = new Map<string, number>(); // place_id -> first occurrence index

      for (let bi = 0; bi < section.blocks.length; bi++) {
        const block = section.blocks[bi]!;
        if (!isPlaceBlock(block)) continue;
        const pid = block.place.place_id;
        if (!pid) continue; // skip places without a Google place_id

        if (seen.has(pid)) {
          allDuplicates.push({ sectionIndex, blockIndex: bi, name: block.place.name, sectionLabel });
        } else {
          seen.set(pid, bi);
        }
      }
    }

    if (allDuplicates.length === 0) {
      return { content: [{ type: "text", text: "No duplicate places found." }] };
    }

    if (args.dry_run !== false) {
      const lines = allDuplicates.map(
        (d) => `  "${d.name}" (${d.sectionLabel}) — duplicate at position ${d.blockIndex}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Found ${allDuplicates.length} duplicate(s):\n${lines.join("\n")}\n\nCall again with dry_run:false to remove them.`,
          },
        ],
      };
    }

    // Remove duplicates: delete from highest index to lowest to avoid index shifting
    // Group by section and sort descending
    const bySection = new Map<number, { blockIndex: number; name: string }[]>();
    for (const d of allDuplicates) {
      if (!bySection.has(d.sectionIndex)) bySection.set(d.sectionIndex, []);
      bySection.get(d.sectionIndex)!.push({ blockIndex: d.blockIndex, name: d.name });
    }

    let removed = 0;
    for (const [si, duplicates] of bySection) {
      duplicates.sort((a, b) => b.blockIndex - a.blockIndex); // descending
      for (const d of duplicates) {
        const ops: Json0Op[] = [
          { p: ["itinerary", "sections", si, "blocks", d.blockIndex], ld: {} },
        ];
        await submitOp(ctx, args.trip_key, ops);
        removed++;
      }
    }

    return {
      content: [
        { type: "text", text: `Removed ${removed} duplicate place(s) from "${trip.title}".` },
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