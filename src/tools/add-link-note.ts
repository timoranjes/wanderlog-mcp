import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  buildNoteBlock,
  findTargetSection,
  requireUserId,
  submitOp,
} from "./shared.js";

export const addLinkNoteInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip to add the note to."),
  text: z
    .string()
    .min(1)
    .describe("The note text before/after the link. Plain text — can be multi-line."),
  link_url: z
    .string()
    .url()
    .describe("The URL to make clickable in the note."),
  link_text: z
    .string()
    .min(1)
    .describe("The display text for the clickable link."),
  day: z
    .string()
    .optional()
    .describe(
      "Optional day to add the note to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to add to the 'Places to visit' list.",
    ),
};

export const addLinkNoteDescription = `
Adds a note with a CLICKABLE link to a Wanderlog trip.

Unlike wanderlog_add_note (which sends plain text and URLs are NOT tappable), this tool
uses the Quill Delta \`link\` attribute so the link renders as a tappable hyperlink in the
Wanderlog app.

Use this for: Google Drive folders, booking confirmation URLs, maps links, official
websites — anything you want the user to be able to tap and open.

The \`text\` field is optional context placed around the link. The link is always rendered
as a bold, clickable line at the end of the note.
`.trim();

type Args = {
  trip_key: string;
  text: string;
  link_url: string;
  link_text: string;
  day?: string;
};

export async function addLinkNote(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const userId = requireUserId(ctx);
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;

    const target = findTargetSection(trip, args.day);

    // Step 1: Insert the note block
    const block = buildNoteBlock(userId);
    const insertIndex = target.section.blocks.length;
    const blockPath = ["itinerary", "sections", target.index, "blocks", insertIndex];
    const insertOps: Json0Op[] = [{ p: blockPath, li: block }];

    await submitOp(ctx, args.trip_key, insertOps);

    // Step 2: Build the Quill Delta ops with a clickable link
    // Structure: [optional text] + [link display text with link attribute] + newline
    const ops: Array<Record<string, unknown>> = [];

    if (args.text) {
      // Split text into lines, each a separate op
      const lines = args.text.split("\n");
      lines.forEach((line, i) => {
        ops.push({ insert: `${line}${i < lines.length - 1 ? "\n" : ""}` });
      });
      if (lines.length > 0) {
        // Ensure a newline before the link if text doesn't end with one
        ops.push({ insert: "\n" });
      }
    }

    // The clickable link (bold)
    ops.push({
      insert: `🔗 ${args.link_text}`,
      attributes: { link: args.link_url, bold: true },
    });
    ops.push({ insert: "\n" });

    // Replace the empty text ops with the full delta via JSON0 object-replace
    // (od + oi) rather than rich-text subtype to avoid [object Object] corruption
    const newDelta = { ops };
    const textOps: Json0Op[] = [
      {
        p: [...blockPath, "text"],
        od: block.text,
        oi: newDelta,
      },
    ];

    await submitOp(ctx, args.trip_key, textOps);

    const preview = args.link_text.length > 40 ? `${args.link_text.slice(0, 37)}…` : args.link_text;
    const text = `Added link note "${preview}" (${args.link_url}) to ${target.label} in "${trip.title}".`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}