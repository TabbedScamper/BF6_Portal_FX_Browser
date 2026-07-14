# BF6 Portal FX Library

A browsable, in-browser preview site for every **Battlefield 6 Portal placeable
particle effect** (the spatial `FX_*` spawn list creators can drop into a Portal
experience). Companion piece to the SFX Library soundboard.

The previews are not videos: each card re-simulates the effect live in WebGL2
from parameters decoded out of the game files — spawn rates, particle
lifetimes, drag / wind / buoyancy / gravity constants, tint colors, the exact
flipbook sprite sheets with their authored grid layouts, and (for mesh-emitting
effects) the actual game mesh.

Made by TabbedScamper. Fan-made reference; not affiliated with EA or DICE.

## Layout

```
tools/build_manifest.py      the mining pipeline (writes everything in site/)
site/index.html|app.js|style.css   static site, no build step, GitHub-Pages-ready
site/manifest.json           per-FX entries: emitters, decoded params, sprites, meshes
site/editor_fx_params.json   per-family look parameters (shared with the Godot overlay)
site/textures/*.png          ready-to-use flipbook sheets  <base>_<cols>x<frames>.png
site/meshes/*.glb            mesh-particle geometry
```

Run locally: `python -m http.server` inside `site/` (fetch() needs http).

## Data provenance — how an FX becomes a preview

1. **Portal catalog.** The placeable list + per-map level restrictions come from
   the Portal SDK export (`FbExportData/asset_types.json`) and the SFX/FX
   Folders addon collections (471 unique `FX_*` types).
2. **Wrapper -> blueprint.** Each Portal FX has a
   `modbuilder_fx_<name>.ebx` SpatialPrefabBlueprint in the retail data
   (`game/glacierportal/gamemodes/spatial/fx/`); its import table points at the
   real `fx_*.ebx` EffectBlueprint (317 resolve via wrapper, 15 via direct
   name; 139 live in map superbundles not present in the local dumps).
3. **Blueprint -> emitters.** The EffectBlueprint holds one
   `EmitterGraphEntityData` per emitter: a pointer to a shared `eg_*.ebx`
   EmitterGraph template, a per-emitter transform, an override block
   (spawn rate, particle lifetime, max count, initial count, spawn bounds) and
   optional per-emitter sprite/exposed-parameter overrides. Child `fx_*.ebx`
   imports are merged recursively.
4. **Template -> parameters.** The EmitterGraph template supplies spawn mode
   (continuous / burst), per-quality lifespans and distances, and the exposed
   Vec4 constant table. PropertyIds are djb2-xor hashes; named values were
   recovered by hashing the exe string table + compound identifiers against the
   ids and anchoring values (`Gravity = -9.81`, `Restitution = 0.3`,
   `SpawnRot`/`RotationSpeed`, `LifeMinMult`, `OpacityOverLife`,
   `SpeedMult`, `TurbulenceStrength`, ...).
5. **Flipbooks.** `GlobalSortingInfo -> AtlasTextureAsset` carries the
   authoritative grid (`AnimationColumnCount`, `AnimationFrameCount`,
   `LeftRightTiles`). The sibling `.AtlasTexture` resource header encodes the
   pixel dimensions (`W = 256*b[3]`, `H = 256*b[5]`, mip count `b[6]`; verified
   by exact chunk-size prediction across the atlas corpus) and the chunk GUID
   at offset 16. Chunks decode as **BC3**. `LeftRightTiles` sheets contain two
   side-by-side 6-way-lighting bases — the exporter crops the LEFT base, so
   every shipped PNG tiles directly as `cols x rows`. (Binding the full sheet
   as a flipbook double-tiles the smoke — the classic wrong-looking-smoke
   mistake.)
6. **Meshes.** Mesh-emitting graphs (debris chunks, darts, rockets, birds,
   drones...) import a `meshp_*.ebx` RigidMeshAsset; its `.MeshSet` resource is
   converted to a small GLB. Volume-decal / distortion graphs also import a box
   mesh, but that is a projection volume and is deliberately not rendered.

## Tier model

| Tier | Badge | Meaning | Count |
|-----:|-------|---------|------:|
| 1 | LIVE | billboard/flipbook family — real sprites + decoded params | 258 |
| 2 | PROC | sparks — procedural streaks from decoded gravity/bounce/speed/temperature | 17 |
| 4 | MESH | mesh-particle preview — real game mesh + decoded spawn params | 10 |
| 3 | SOON | placeholder — effect lives in an unmined map bundle (139), is a runtime-scripted stub, or runs on baked compute shaders (decals, screen effects) | 186 |

Classes: fire 65, smoke 102, explosion 47, spark 14, water 9, debris 9, other 225.

## What is real vs. approximated

**Real decoded data** (used as-is): spawn rate & mode, particle lifetime and
random life range, max/initial counts, spawn bounds per emitter, drag, wind
strength, buoyancy, gravity, restitution, rotation speed & spawn rotation,
opacity + fade direction, tint color, temperature (spark blackbody color),
flipbook sheet + exact grid, mesh geometry, per-map availability.

**Approximated** (flagged in the data files):
- `fps` — flipbook playback rate is baked into the compiled shader; the player
  spreads the frames over the particle lifetime (`frames / lifetime`).
- particle **size / size-over-life** — lives in baked GPU compute shaders; the
  per-class defaults in `editor_fx_params.json > class_defaults` are
  visual-reference tuned and scale with each emitter's authored bounds.
- billboard drift (updraft) — buoyancy in the data is 0 for most fires/smokes;
  the real motion comes from the baked sim, so per-class rise defaults apply.
- 6-way smoke lighting — the player lights the base with a fixed light
  direction instead of the game's full 6-way relighting.

The consistency check `rate * lifetime <= 1.5 * max_count` holds for 821/1335
looping emitters; burst emitters (explosions) intentionally exceed it and are
detected exactly by that signature.

## editor_fx_params.json

Per-graph look parameters for every emitter template the Portal catalog uses
(125 graphs), plus per-class defaults for the values that do not survive in
EBX. The site player and the Godot map-context overlay both consume this file,
so the two previews match by construction. Evidence and assumption notes are
embedded in the file's `_meta`.

## Progress log

### 2026-07-14 — colors, sizes, envelopes, sounds, viewer v2

**The per-emitter override table (the big one).** Authored per-effect
customization does NOT live in `EmitterGraphParams` (empty on almost every
effect) but in a second `GpuExposedParameterInput[]` on
`EmitterGraphEntityData` (raw field `f_512_4832ad52`, 20–70 entries per
emitter). Found by diffing the four color variants of
`fx_granite_strike_smoke_marker_{red,green,violet,yellow}` — the ONLY values
that differ between them are the Vec4s at PropertyIds `0xA1C184C8/0xA1C184C9`,
and their values are linear-RGB hues matching the variant names
(red `(0.913,0.031,0.038)`, green `(0.016,0.791,0.074)`,
violet `(0.748,0.016,0.791)`, yellow `(0.791,0.732,0.016)`). djb2-xor
confirms the pair is **Color0/Color1** ("Color0" hashes to `0xA1C184C8`,
one bit below the exe-anchored "Color1"). Colored marker smokes now render
in their real colors instead of white.

**322 PropertyIds named** (up from 30) by a compound djb2-xor vocabulary hunt
over every id used by the 376 graph templates (`tools/hunt_pid_names.py`,
values anchor-checked, ambiguous hits dropped). Highlights: `BaseSize` /
`BaseSizeBias` / `SpawnSize` / `SizeCurve` / `SizeOverLife` (real particle
sizes — the smoke-marker plume is authored at 3.5 m, its core puffs 0.9 m),
`SpawnSpeed(Min/Mult/Bias)` + `SpawnDirectionMin/Max` (mesh/billboard
ballistics), `EmissiveIntensityMult` (fire Color0/1 are HDR intensities ×14–18),
the `*OverLife` cubic-envelope family (`a·t³+b·t²+c·t+d`, anchored on
OpacityOverLife rise-and-fall shapes), `RandomForce`, `TurbulenceFrequency`,
`SpawnRotationSpeed`, `FadeInSpeed`, `ShrinkStartAge`, ...

**Blend mode: negative result, documented.** The 24+ draw-config booleans on
the graph root do NOT encode blending — fire and smoke templates are
bit-identical there (verified across all 376 graphs; no boolean correlates
with fire-vs-smoke naming). The engine selects Emissive vs VertexLit vs
GnomonLit per emitter via `ET_LightingModelGS` expression assets whose choice
is baked into compiled shaders. The pipeline instead derives a per-sheet
render hint from the decoded pixels (chromatic emissive sheets, mean
saturation ≈0.78 for fire vs ≈0.003 for lit smoke bases; `LeftRightTiles` =
6-way lit) — stored as `sprite.render` with the stats as evidence.

**Bursts.** `SpawnModeBurst` templates carry only `ParticleMaxCount` — a
one-shot with no authored interval (179 of 376 templates). The player
re-fires bursts on a site-side replay timer (toggleable), flagged as such.

**Sounds.** Effects reference engine sound configs
(`LegacySoundEffectEntityData.Sound` → e.g.
`bf03_gadgets_smokegrenade_marker_config_01`); each FX's configs are now in
the manifest (`sounds_ref`), token-matched against the BF6 Portal SoundBoard
manifest (the companion SFX Library). Matches stream the clip from the
soundboard's GitHub Pages — no audio is copied into this repo; unmatched
configs are listed by name.

**Coverage.** 21 per-map retail dumps (`A:\x\<code>\out`) joined the search
path (guid indexes generated for the 8 the pipeline hadn't indexed).
Fixed a nondeterministic atlas-decode failure (fixed-name temp DDS inside a
Dropbox-synced dir got transiently locked — now a unique file in the OS temp
dir), which had been silently costing random effects their sprites.

**Viewer v2.** The player stage now matches the Model Library site: dark
stage with a fading 1 m/5 m floor grid and an orange viewing-box frame sized
to each effect, orbit (drag) / proportional dolly (scroll) / pan (MMB) and
RMB freelook with WASD/QE fly (Shift boost, scroll = fly speed). Fixed the
inherited view matrix (right-vector was negated → the whole stage rendered
rotated 180° about the view axis; rising smoke used to drift DOWN on
screen). The player consumes the new decoded data: Color0→Color1 tinting
(linear→sRGB), decoded BaseSize/SizeCurve, OpacityOverLife envelopes,
SpawnSpeed ballistics, per-sheet render modes, burst replay, optional linked
audio, and a per-map availability filter (the same per-map view the SFX/FX
Folders addon gives creators in the SDK; dzonzla's bf6-portal-fx-showcase
confirmed the RuntimeSpawn enum source independently).

## Rebuilding

```
python tools/build_manifest.py            # full build (manifest + textures + meshes + editor params)
python tools/build_manifest.py --only FX_BASE_Fire_S,FX_Sparks
python tools/build_manifest.py --reindex  # re-walk the dumps' EBX name index
```

Requirements (local paths configured at the top of the script): the BF6 EBX
dumps (`A:\bf6dump`, `A:\aft`), the on-disk `bf6.exe` (type reflection), the
bf6-highpoly-pipeline tools + guid indexes, the BF2042 type dump (field-name
correlation), the SFX/FX Folders addon `collections.json`, the Portal SDK
`asset_types.json`, `Fb_bf6_mesh.exe`, Python 3.12 with Pillow + trimesh +
numpy.
