import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolveDay } from "../resolvers/day.js";
import type { PlaceData } from "../types.js";
import {
  buildPlaceBlock,
  findDaySectionByDate,
  findPlacesToVisitSection,
  findTripCenter,
  requireUserId,
  submitOp,
} from "./shared.js";

export const batchAddPlacesInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add places to."),
  places: z
    .array(
      z.object({
        name: z.string().min(1).describe("Place name to search for."),
        note: z.string().optional().describe("Inline note for this place."),
        start_time: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
          .optional()
          .describe("Start time (HH:mm)."),
        end_time: z
          .string()
          .regex(/^\d{2}:\d{2}$/, "must be HH:mm")
          .optional()
          .describe("End time (HH:mm)."),
      }),
    )
    .min(1)
    .max(10)
    .describe("Places to add (1-10)."),
  day: z
    .string()
    .optional()
    .describe("Day to add all places to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'."),
};

export const batchAddPlacesDescription = `
Adds multiple places to a Wanderlog trip in a single tool call — faster and more reliable than
calling wanderlog_add_place repeatedly. Each place is searched, resolved, and added sequentially.

All places go to the same day (or "Places to visit" if no day is specified).
If a place can't be found, it's skipped with a warning rather than failing the whole batch.
`.trim();

type PlaceInput = {
  name: string;
  note?: string;
  start_time?: string;
  end_time?: string;
};

export async function batchAddPlaces(
  ctx: AppContext,
  args: { trip_key: string; places: PlaceInput[]; day?: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const results: string[] = [];
  let hasError = false;

  try {
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;
    const userId = requireUserId(ctx);

    // Resolve target section once
    let sectionIndex: number;
    let label: string;
    if (args.day) {
      const daySection = resolveDay(trip, args.day);
      const found = findDaySectionByDate(trip, daySection.date!);
      if (!found) throw new WanderlogValidationError(`Day ${args.day} not found`);
      sectionIndex = found.index;
      label = `day ${daySection.date}`;
    } else {
      const places = findPlacesToVisitSection(trip);
      if (!places) throw new WanderlogError("Trip has no 'Places to visit' list", "no_places_section");
      sectionIndex = places.index;
      label = "places to visit";
    }

    const center = findTripCenter(trip, entry.geos);
    if (!center) {
      throw new WanderlogValidationError("Cannot add places: no location anchor available");
    }

    for (const place of args.places) {
      try {
        const predictions = await ctx.rest.searchPlacesAutocomplete({
          input: place.name,
          sessionToken: randomUUID(),
          location: { latitude: center.lat, longitude: center.lng },
          radius: 15000,
        });

        if (predictions.length === 0) {
          results.push(`⚠️ Skipped "${place.name}" — not found`);
          hasError = true;
          continue;
        }

        const topPrediction = predictions[0]!;
        const detail: PlaceData = await ctx.rest.getPlaceDetails(topPrediction.place_id);
        const imageKeys = await ctx.rest.getPlacePhotos(detail);

        // Refresh snapshot for each insert
        const currentSnapshot = entry.snapshot;
        const blocks = currentSnapshot.itinerary.sections[sectionIndex]!.blocks;
        const insertIndex = blocks.length;
        const blockPath = ["itinerary", "sections", sectionIndex, "blocks", insertIndex];

        const block = buildPlaceBlock(detail, userId);
        const insertOps: Json0Op[] = [{ p: blockPath, li: block }];
        if (imageKeys.length > 0) {
          insertOps.push({ p: [...blockPath, "imageKeys"], oi: imageKeys });
        }
        await submitOp(ctx, args.trip_key, insertOps);

        if (place.note) {
          await submitOp(ctx, args.trip_key, [
            { p: [...blockPath, "text"], t: "rich-text", o: [{ insert: `${place.note}\n` }] },
          ]);
        }

        if (place.start_time || place.end_time) {
          const timeOps: Json0Op[] = [];
          if (place.start_time) timeOps.push({ p: [...blockPath, "startTime"], oi: place.start_time });
          if (place.end_time) timeOps.push({ p: [...blockPath, "endTime"], oi: place.end_time });
          await submitOp(ctx, args.trip_key, timeOps);
        }

        results.push(`✅ Added "${detail.name}"`);
      } catch (err) {
        results.push(`⚠️ Skipped "${place.name}" — ${(err as Error).message}`);
        hasError = true;
      }
    }

    const summary = `Batch added ${args.places.length} place(s) to ${label}:\n${results.join("\n")}`;
    return { content: [{ type: "text", text: summary }], isError: hasError };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}