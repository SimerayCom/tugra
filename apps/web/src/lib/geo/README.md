# geo

In-house map code for the traffic world map. No map library is used.

- `topojson.ts` decodes a TopoJSON topology (written from the public TopoJSON spec).
- `project.ts` is an equirectangular projection plus SVG path building.
- `world-countries-110m.json` is the vendored country dataset: Natural Earth, public domain, via the world-atlas dataset.
