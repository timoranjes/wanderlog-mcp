import { z } from "zod";
import type { AppContext } from "../context.js";
import type { GuideGeoRef } from "../types.js";
import {
  WanderlogError,
  WanderlogValidationError,
} from "../errors.js";

export const searchGuidesInputSchema = {
  destination: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Free-text destination (e.g. 'Vietnam', 'Kyoto'). Resolved via geoAutocomplete; multi-match auto-picks the highest-popularity geo and surfaces up to 2 candidates in 'alternative_geos'.",
    ),
  geo_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Explicit Wanderlog geo id (from a prior response's 'geo' or 'alternative_geos').",
    ),
  response_format: z
    .enum(["concise", "detailed"])
    .default("concise")
    .describe(
      "Output verbosity. 'concise' (default) returns guide_key, title, author, place_count, view_count. 'detailed' adds blurb, like_count, edited_at, distinction, profile_picture_url, header_image_url.",
    ),
};

export const searchGuidesDescription = `
Lists user-written Wanderlog travel guides for a destination — long-form recommendations and
itineraries other travellers have published. Use this when the user asks for inspiration, an
itinerary they can copy, or "what guides exist for X".

Specify exactly one of destination or geo_id. For free-text destinations the highest-popularity
match is picked; up to 2 candidates appear in 'alternative_geos' as a soft hint. When the
destination has no curated guides yet, the response carries 'alternative_geos_with_guides'
with the top 5 nearby destinations that do.

Pass the returned guide_key to wanderlog_get_guide to read the full content of one guide.
`.trim();

export type SearchGuidesArgs = {
  destination?: string;
  geo_id?: number;
  response_format?: "concise" | "detailed";
};

export function validateArgs(args: SearchGuidesArgs): SearchGuidesArgs & {
  response_format: "concise" | "detailed";
} {
  const modesSet = [args.destination !== undefined, args.geo_id !== undefined].filter(
    Boolean,
  ).length;
  if (modesSet !== 1) {
    throw new WanderlogValidationError(
      "Pass exactly one of destination or geo_id.",
    );
  }
  return { ...args, response_format: args.response_format ?? "concise" };
}

export async function resolveGeo(
  ctx: AppContext,
  args: Pick<SearchGuidesArgs, "destination" | "geo_id">,
): Promise<{ geo: GuideGeoRef; alternative_geos: GuideGeoRef[] }> {
  if (args.geo_id !== undefined) {
    const g = await ctx.rest.getGeo(args.geo_id);
    return {
      geo: {
        geo_id: g.id,
        name: g.name,
        country: g.countryName ?? null,
        subcategory: null,
      },
      alternative_geos: [],
    };
  }
  const candidates = await ctx.rest.geoAutocomplete(args.destination!);
  if (candidates.length === 0) {
    throw new WanderlogError(
      `No geo found matching "${args.destination}"`,
      "destination_not_found",
      {
        hint: "Try a more specific name (include the country) or pass an explicit geo_id from a prior search.",
        followUps: [
          "Retry wanderlog_search_guides with a more specific destination (include the country or region).",
        ],
      },
    );
  }
  const ranked = [...candidates].sort(
    (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  );
  const top = ranked[0]!;
  const alternatives = ranked.slice(1, 3).map((c) => ({
    geo_id: c.id,
    name: c.name,
    country: c.countryName ?? null,
    subcategory: null,
  }));
  return {
    geo: {
      geo_id: top.id,
      name: top.name,
      country: top.countryName ?? null,
      subcategory: null,
    },
    alternative_geos: alternatives,
  };
}

export async function searchGuides(
  _ctx: AppContext,
  _args: SearchGuidesArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  throw new WanderlogError("Not implemented", "not_implemented");
}
