import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.js";
import { resolveGeo } from "../../src/tools/search-guides.js";

function fakeCtx(overrides: Partial<AppContext["rest"]> = {}): AppContext {
  return {
    rest: {
      geoAutocomplete: async () => [],
      getGeo: async () => {
        throw new Error("getGeo not stubbed");
      },
      ...overrides,
    },
  } as unknown as AppContext;
}

describe("search-guides resolveGeo", () => {
  it("auto-picks highest-popularity candidate and returns top 2 as alternatives", async () => {
    const ctx = fakeCtx({
      geoAutocomplete: async () => [
        { id: 1, name: "Vietnam", countryName: null, popularity: 5, latitude: 0, longitude: 0 },
        { id: 2, name: "Vietnam", countryName: null, popularity: 95, latitude: 0, longitude: 0 },
        { id: 3, name: "Vietnam-ish", countryName: null, popularity: 50, latitude: 0, longitude: 0 },
      ],
    });
    const result = await resolveGeo(ctx, { destination: "Vietnam" });
    expect(result.geo.geo_id).toBe(2);
    expect(result.alternative_geos.map((g) => g.geo_id)).toEqual([3, 1]);
  });

  it("throws destination_not_found when geoAutocomplete returns []", async () => {
    const ctx = fakeCtx({ geoAutocomplete: async () => [] });
    await expect(resolveGeo(ctx, { destination: "Nowhere" })).rejects.toMatchObject({
      code: "destination_not_found",
    });
  });

  it("uses getGeo for explicit geo_id and returns no alternatives", async () => {
    const ctx = fakeCtx({
      getGeo: async (id: number) => ({
        id,
        name: "Vietnam",
        countryName: null,
        bounds: [1, 2, 3, 4] as [number, number, number, number],
      }),
    });
    const result = await resolveGeo(ctx, { geo_id: 86655 });
    expect(result.geo.geo_id).toBe(86655);
    expect(result.geo.name).toBe("Vietnam");
    expect(result.alternative_geos).toEqual([]);
  });
});
