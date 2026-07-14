"""BF6 Portal FX-preview site: manifest, texture, mesh and editor-params builder.

Pipeline (all real game data, no invented parameters):
  Portal FX_ name (SDK RuntimeSpawn / bf6-sfx-fx-folders collections.json)
    -> modbuilder_fx_<name>.ebx SpatialPrefabBlueprint wrapper in the dumps
       (game/glacierportal/gamemodes/spatial/fx/) -- its import list points at
       the real fx_*.ebx EffectBlueprint  [fallback: direct fx_<name>.ebx]
    -> EffectBlueprint: N x EmitterGraphEntityData, each referencing a shared
       eg_*.ebx EmitterGraph template + a per-effect override block
       (spawn rate / particle lifetime / max count / spawn bounds) + THE
       per-emitter exposed-parameter override table (f_512: Color0/Color1
       tints, BaseSize, SpawnSpeed, opacity/size envelopes, ...) + sound
       config refs (joined to the SFX Library soundboard, reference-only)
    -> EmitterGraph template: spawn mode (continuous/burst), per-quality
       lifespans, exposed-parameter constant table (Buoyancy/Drag/WindStrength/
       Color1/Opacity/Temperature/Gravity/Restitution/...),
       GlobalSortingInfo -> AtlasTextureAsset flipbook (authoritative grid),
       mesh-emitter RigidMeshAsset imports (debris chunks, darts, ...)
    -> .AtlasTexture resource: header dims (W=256*b[3], H=256*b[5],
       mips=b[6]) + chunk GUID @16 -> BC3 chunk -> PNG
       (LeftRightTiles sheets are cropped to the LEFT lighting base so the
       exported PNG is directly usable as a cols x rows flipbook)
    -> meshp_*.ebx RigidMeshAsset -> sibling .MeshSet -> Fb_bf6_mesh -> GLB

Outputs:
  site/manifest.json           per-FX entries (emitters, params, sprites, meshes)
  site/textures/*.png          ready-to-use flipbook sheets (<base>_<cols>x<frames>.png)
  site/meshes/*.glb            mesh-particle geometry
  site/editor_fx_params.json   per-family look parameters (site player + Godot
                               overlay consume the same file)

Field-name recovery: BF6 type GUIDs carry over from the BF2042 SDK dump but
field-name hashes do not; names are correlated by offset + field-type GUID.
Struct fields with no 2042 candidate keep their raw "f_<offset>_<namehash>"
key -- those keys are stable per type and are matched verbatim below.
PropertyIds are djb2-xor hashes; names below were recovered by hashing the
exe's string table + a compound wordlist against the ids and anchor-checking
values (e.g. Gravity = -9.81).

Usage:  python tools/build_manifest.py [--limit N] [--only NAME[,NAME]]
"""
import argparse
import functools
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import time

# ---------------------------------------------------------------- paths ----
PIPELINE = r"C:\Users\mwalt\Dropbox\Personal-Files\Portal\bf6-highpoly-pipeline"
TOOLS = os.path.join(PIPELINE, "tools")
DATA = os.path.join(PIPELINE, "data")
FX_MINE = os.path.join(DATA, "mined", "MP_Aftermath", "fx_mine")
TYPES2042 = (r"C:\Users\mwalt\Dropbox\Personal-Files\Portal\PortalSDK"
             r"\_Research\frosty-bf6-mining\type_dumps\BF2042gen.types.json")
COLLECTIONS = (r"C:\Users\mwalt\Dropbox\Personal-Files\Portal"
               r"\bf6-sfx-fx-folders\addons\bf6_sfx_fx\collections.json")
ASSET_TYPES = (r"C:\Users\mwalt\Dropbox\Personal-Files\Portal\PortalSDK"
               r"\FbExportData\asset_types.json")
SOUNDBOARD = (r"C:\Users\mwalt\Dropbox\Personal-Files\Portal\BF_Undead"
              r"\tools\soundboard\manifest.json")
SOUNDBOARD_URL = "https://tabbedscamper.github.io/BF6_Portal_SoundBoard/"
# per-map retail dumps (A:\x\<code>\out) from the overnight rollout
XMAP_CODES = ["abb", "afp", "bad", "bat", "con", "dum", "eas", "fir", "gcl",
              "gma", "gmr", "gol", "grd", "gst", "gtc", "gun", "lim", "ots",
              "pla", "sbs", "tun"]
DUMP_ROOTS = ([r"A:\bf6dump\bundles", r"A:\aft\bundles"] +
              [r"A:\x\%s\out\bundles" % c for c in XMAP_CODES])
CHUNK_DIRS = ([r"A:\bf6dump\chunks", r"A:\aft\chunks"] +
              [r"A:\x\%s\out\chunks" % c for c in XMAP_CODES])
GUID_INDEXES = ([os.path.join(DATA, f) for f in
                 ("guid_index.tsv", "guid_index_aft.tsv",
                  "guid_index_dum.tsv")] +
                [os.path.join(DATA, "guid_index_%s.tsv" % c)
                 for c in XMAP_CODES] +
                # indexes we generated ourselves for dumps the pipeline
                # hadn't indexed yet (same EFIX scan; see tools/.cache)
                [os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              ".cache", "guid_index_%s.tsv" % c)
                 for c in XMAP_CODES])
AFTERMATH_FX = os.path.join(FX_MINE, "aftermath_fx.json")

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
MESHEXE = os.path.join(HERE, "bin", "Fb_bf6_mesh.exe")
SITE = os.path.join(PROJ, "site")
TEXOUT = os.path.join(SITE, "textures")
MESHOUT = os.path.join(SITE, "meshes")
CACHE = os.path.join(HERE, ".cache")

MAX_TEX_DIM = 1024   # exported PNG cap (longest side)
BC3_UNORM = 77       # atlas chunks are BC3 (clean alpha + clean color verified)

sys.path.insert(0, TOOLS)
import typesdk            # noqa: E402  (exe reflection reader)
import ebx as ebxmod      # noqa: E402  (RIFF EBX container)
import ebx_deser          # noqa: E402  (value deserializer)
from PIL import Image     # noqa: E402

# ------------------------------------------------- stable raw field keys ----
# EmitterGraphEntityData override block (type d4e79a7a-d7a6-5d62-ff19-233c0dc3512c).
# Semantics fixed by value anchoring against the graph templates: rate*lifetime
# stays <= max_count for looping emitters; burst emitters set rate >> max.
OV_BBOX_MIN = "f_0_03677a99"
OV_BBOX_MAX = "f_16_9fcfdc5c"
OV_UNK40 = "f_40_955ef9a5"
OV_SPAWNRATE = "f_56_1e554fb9"
OV_UNK72 = "f_72_66de2067"
OV_INITCOUNT = "f_88_67133a03"
OV_MAXCOUNT = "f_104_71363fe0"
OV_UNK120 = "f_120_bd5a8a76"
OV_LIFETIME = "f_136_8e72b110"
# EmitterGraphEntityData: per-emitter texture override array
ENT_TEXOVERRIDE = "f_520_1c1e4b15"
ENT_TEXOVERRIDE_PTR = "f_0_8cf424e7"
# EmitterGraphEntityData: THE per-emitter exposed-parameter override table
# (GpuExposedParameterInput[], 20-70 entries on authored effects). Found by
# diffing the color variants of fx_granite_strike_smoke_marker_* -- the
# Color0/Color1 tints that distinguish red/green/violet/yellow live here
# (the previously-read EmitterGraphParams array is empty on those effects).
ENT_PARAM_OVERRIDES = "f_512_4832ad52"
# 2042-correlated label of the pointer to the eg_*.ebx template
ENT_GRAPH_PTR = "EmitterGraphComputeShaderTextures"
ENT_OVERRIDES = "EmitterGraphOverrides"
ENT_PARAMS = "EmitterGraphParams"
ENT_MESH_PTRS = "EmitterGraphMeshEmitter"
# EmitterGraph root: five QualityScalableFloat core params in field order
GR_CORE_NAMES = ["emitter_lifespan", "max_spawn_distance", "particle_lifespan",
                 "min_spawn_distance", "culling_distance"]
GR_GLOBALSORT = "f_144_af0e5c31"       # GlobalSortingInfo struct
GR_PARAMTABLE = "CustomMaskTextures"   # 2042 label collision: exposed params

# PropertyId -> name: tools/pid_names.json (322 names; exe-string anchors +
# compound djb2-xor hunt, values anchor-checked -- see tools/hunt_pid_names.py).
# Key finds this round: Color0 (0xA1C184C8, the second tint of the smoke-marker
# color pair), BaseSize/BaseSizeBias/SpawnSize/SizeCurve (real particle sizes),
# EmissiveIntensityMult/Curve, the *OverLife cubic envelope family, and the
# mesh-ballistics set (SpawnDirectionMin/Max, SpawnSpeedMin/Mult/Bias, ...).

CLASS_RULES = [
    ("fire", r"fire|flame|burn|ignit|torch|candle|molotov|incendiar"),
    ("smoke", r"smoke|dust|fog|steam|ash|haze|mist|vapor|exhaust"),
    ("spark", r"spark|electric|arc|weld|shortcircuit|wire"),
    ("debris", r"debris|rubble|pebble|rockfall|shrapnel|paper|leaves|leaf|trash"),
    ("explosion", r"explo|detonat|blast|artillery|mortar|airburst|jdam|missile"),
    ("water", r"water|splash|rain|drip|hydrant|ocean|fountain"),
]
RENDER_FAMS_T1 = {"globalsorting"}
RENDER_FAMS_T2 = {"sparks", "thindebris", "pebbles"}
MESH_FAMS = {"meshdebris"}


# ------------------------------------------------------------ deser core ----
pe = typesdk.PE(typesdk.EXE)
_db = json.load(open(TYPES2042, encoding="utf-8"))
_by_guid = {v["guid"]: k for k, v in _db.items() if v.get("guid")}


@functools.lru_cache(maxsize=None)
def _flat2042_by_off(guid):
    name = _by_guid.get(guid)
    if not name:
        return None, ()
    chain, t, seen = [], name, set()
    while t and t not in seen:
        seen.add(t)
        v = _db.get(t) or _db.get(t.split(".")[-1])
        if not v:
            break
        chain.append(v)
        t = v.get("base").split(".")[-1] if v.get("base") else None
    fields = {}
    for v in reversed(chain):
        for f in v.get("fields", []):
            fields[f["offset"]] = f
    return name, tuple(sorted(fields.items()))


class AnnoDeser(ebx_deser.Deser):
    """Deser variant emitting 2042-name-candidate keys (offset-correlated);
    unmatched fields keep stable raw f_<offset>_<namehash> keys."""

    def _read_struct(self, guid_bytes, base, depth):
        lay = self.layout(guid_bytes)
        if not lay or depth > 8:
            return None
        gs = ebxmod._guid_str(guid_bytes)
        tname, f42items = _flat2042_by_off(gs)
        f42 = dict(f42items)
        out = {"__type": tname or gs}
        for fld in sorted(lay["fields"], key=lambda f: f["offset"]):
            pos = base + fld["offset"]
            val = self._decode(pos, fld["typeVA"], depth)
            cand = f42.get(fld["offset"])
            key = cand["name"] if cand is not None else \
                "f_%d_%08x" % (fld["offset"], fld["nameHash"])
            while key in out:
                key += "_"
            out[key] = val
        return out

    def _pointer_ref(self, pos):
        idx = struct.unpack_from("<q", self.d, pos)[0]
        if idx == 0:
            return None
        if idx & 1:
            imp = self.f.imports[idx >> 1]
            return {"import": imp[2], "path": self.gi.get(imp[2])}
        inst_off = (pos + idx) - self.payload
        ii = self.instmap.get(inst_off)
        return {"instance": ii}

    def _read_array(self, pos, elemVA, depth):
        aoff = struct.unpack_from("<i", self.d, pos)[0]
        array_data = (pos + 4) + aoff - 8
        if array_data < 0 or array_data + 4 > len(self.d):
            return []
        count = struct.unpack_from("<i", self.d, array_data)[0]
        if count < 0 or count > 100000:
            return []
        elem = array_data + 4
        rt = typesdk.resolve_type(self.pe, elemVA) if elemVA else None
        te = rt["te"] if rt else 0x10
        items = []
        if te == 0x02:
            lay = self.layout(rt["guid_raw"])
            if not lay:
                return []
            sz = ebx_deser.align_up(lay["size"], lay.get("align", 1) or 1)
            for i in range(count):
                items.append(self._read_struct(rt["guid_raw"], elem + i * sz, depth + 1))
        elif te in (0x03, 0x01):
            for i in range(count):
                items.append(self._pointer_ref(elem + i * 8))
        elif te == 0x07:
            for i in range(count):
                items.append(self._cstring(elem + i * 8))
        elif te == 0x13:
            for i in range(count):
                items.append(struct.unpack_from("<f", self.d, elem + i * 4)[0])
        else:
            for i in range(count):
                items.append(struct.unpack_from("<I", self.d, elem + i * 4)[0])
        return items


def dump_ebx(path, gi):
    dz = AnnoDeser(pe, path, gi)
    insts = []
    for i in range(len(dz.f.instance_offsets)):
        try:
            insts.append(dz.read_instance(i))
        except Exception:
            insts.append(None)
    imports = [(im[2], gi.get(im[2])) for im in dz.f.imports]
    return {"path": path, "imports": imports, "instances": insts}


# ------------------------------------------------------------- indexing ----
def load_guid_index():
    gi = {}
    for fn in GUID_INDEXES:
        if not os.path.exists(fn):
            continue
        for ln in open(fn, encoding="utf-8"):
            p = ln.rstrip("\n").split("\t", 1)
            if len(p) == 2:
                gi.setdefault(p[0], p[1])
    return gi


def load_name_index(refresh=False):
    """lower basename (no .ebx) -> [full paths] across both dumps."""
    os.makedirs(CACHE, exist_ok=True)
    cache = os.path.join(CACHE, "ebx_name_index.json")
    if os.path.exists(cache) and not refresh:
        return json.load(open(cache, encoding="utf-8"))
    idx = {}
    for root in DUMP_ROOTS:
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                fl = f.lower()
                if fl.endswith(".ebx"):
                    idx.setdefault(fl[:-4], []).append(os.path.join(dirpath, f))
    json.dump(idx, open(cache, "w"))
    return idx


def portal_fx_list():
    """[(portal_name, [maps])] from the SDK export (level restrictions) plus
    the folders-addon collections (the actually placeable set)."""
    cols = json.load(open(COLLECTIONS, encoding="utf-8"))
    names = {}
    for c in cols:
        for a in c["assets"]:
            if "/fx/" in a["path"]:
                nm = a["path"].rsplit("/", 1)[-1][:-5]
                names.setdefault(nm, set())
    at = json.load(open(ASSET_TYPES, encoding="utf-8"))["AssetTypes"]
    for e in at:
        t = e.get("type", "")
        if t in names:
            names[t] = set(e.get("levelRestrictions") or [])
    return sorted((n, sorted(m)) for n, m in names.items())


def _bp_from_wrapper(wrapper_path, name_idx, gi):
    """modbuilder wrapper -> on-disk fx_* blueprint path (via imports)."""
    try:
        f = ebxmod.parse(wrapper_path)
    except Exception:
        return None
    cands = []
    for im in f.imports:
        p = gi.get(im[2]) or ""
        b = os.path.basename(p).lower()
        if b.startswith(("fx_", "ve_")) and "glacierportal" not in p.lower():
            cands.append(p)
    if not cands:
        return None
    cands.sort(key=lambda p: (0 if p.lower().startswith("common") else 1, len(p)))
    return find_dump_file(cands[0], name_idx)


def resolve_blueprint(portal_name, name_idx, gi, portal_keys=frozenset()):
    """Portal FX name -> (effect blueprint path, how)."""
    key = portal_name.lower()
    wrapper = name_idx.get("modbuilder_" + key)
    if wrapper:
        got = _bp_from_wrapper(wrapper[0], name_idx, gi)
        if got:
            return got, "wrapper"
    direct = name_idx.get(key)
    if direct:
        return direct[0], "direct"
    # fuzzy wrapper fallback: some authored wrapper names differ from the
    # Portal enum by an extra size/family suffix (fallingdust -> _m,
    # marketstalltarp_blue_m -> _gs), an inserted map prefix
    # (fx_snow_... -> fx_mp_aftermath_s01b1_snow_...) or a data-side typo
    # (suction -> "sucktion"). Candidates that are the exact wrapper of a
    # DIFFERENT catalog FX are excluded, and the match is flagged "fuzzy".
    rest = key[3:] if key.startswith("fx_") else key
    cands = []
    for k in name_idx:
        if not k.startswith("modbuilder_fx"):
            continue
        base = k[len("modbuilder_"):]
        if base in portal_keys and base != key:
            continue
        if base.startswith(key + "_") or \
                (len(rest) >= 10 and base.endswith("_" + rest)):
            cands.append(k)
    if not cands:
        import difflib
        pool = [k for k in name_idx if k.startswith("modbuilder_fx_")]
        near = difflib.get_close_matches("modbuilder_" + key, pool,
                                         n=2, cutoff=0.92)
        cands = [k for k in near
                 if k[len("modbuilder_"):] not in portal_keys]
    if cands:
        cands.sort(key=len)
        got = _bp_from_wrapper(name_idx[cands[0]][0], name_idx, gi)
        if got:
            return got, "fuzzy"
    return None, "unmatched"


def find_dump_file(relpath, name_idx):
    """guid-index relpath -> on-disk dump path (basename lookup + suffix check)."""
    base = os.path.basename(relpath).lower()
    if base.endswith(".ebx"):
        base = base[:-4]
    rel_norm = relpath.replace("\\", "/").lower()
    for p in name_idx.get(base, []):
        if p.replace("\\", "/").lower().endswith(rel_norm):
            return p
    lst = name_idx.get(base)
    return lst[0] if lst else None


# ------------------------------------------------------ graph & effects ----
def qsf(v, quality="High"):
    if isinstance(v, dict) and quality in v:
        return v[quality]
    return v


PID_NAMES = {int(k): v for k, v in
             json.load(open(os.path.join(HERE, "pid_names.json"),
                            encoding="utf-8")).items() if k != "_meta"}


def graph_family(relpath):
    rl = relpath.replace("\\", "/").lower()
    m = re.search(r"emittergraph/([a-z0-9]+)/", rl)
    if m:
        return m.group(1)
    if "/portal/" in rl:
        if "spark" in rl:
            return "sparks"
        if "_gs_" in rl:
            return "globalsorting"
        return "portal"
    return "other"


# parameter names whose Vec4 payload is a real vector/curve (cubic envelope
# coefficients, RGB colors, per-axis values) -- everything else broadcasts one
# scalar across xyzw (per-quality) or packs it as (value,0,0,0)
VEC_PID_RE = re.compile(
    r"color|curve|overlife|overz|overradius|overfacing|minmax|axis|"
    r"direction$|position$|offset$|pivot$|range\d?$|heightalpha|frame(range)",
    re.I)


def pid_value(nm, v):
    vec = [round(v.get(a, 0), 6) for a in "xyzw"]
    if VEC_PID_RE.search(nm):
        return vec
    # scalar packings: per-quality broadcast (x,x,x,x) or plain (x,0,0,0)
    if vec[1] == vec[2] == vec[3] == 0 or vec.count(vec[0]) == 4:
        return vec[0]
    return vec


def param_table(inst_or_root, key=GR_PARAMTABLE):
    out = {}
    for p in (inst_or_root.get(key) or []):
        if not isinstance(p, dict):
            continue
        pid = (p.get("Normalize") or 0) & 0xFFFFFFFF
        nm = PID_NAMES.get(pid)
        v = p.get("Value")
        if nm and isinstance(v, dict):
            out[nm.lower()] = pid_value(nm, v)
    return out


def param_table_unknown_count(inst_or_root, key=GR_PARAMTABLE):
    n = 0
    for p in (inst_or_root.get(key) or []):
        if isinstance(p, dict) and \
                ((p.get("Normalize") or 0) & 0xFFFFFFFF) not in PID_NAMES:
            n += 1
    return n


class GraphCache:
    def __init__(self, name_idx, gi):
        self.name_idx = name_idx
        self.gi = gi
        self.cache = {}

    def get(self, relpath):
        key = relpath.replace("\\", "/").lower()
        if key in self.cache:
            return self.cache[key]
        g = self._parse(relpath)
        self.cache[key] = g
        return g

    def _parse(self, relpath):
        path = find_dump_file(relpath, self.name_idx)
        fam = graph_family(relpath)
        out = {"ebx": relpath.replace("\\", "/"), "family": fam, "name": None,
               "core": {}, "spawn": None, "params": {}, "n_params": 0,
               "global_sorting": False, "atlas": None, "bbox": None,
               "mesh": None, "sliders": []}
        if not path:
            out["family"] = fam or "missing"
            return out
        try:
            d = dump_ebx(path, self.gi)
        except Exception:
            return out
        root = next((i for i in d["instances"]
                     if isinstance(i, dict) and i.get("__type") == "EmitterGraph"), None)
        if root is None:
            root = d["instances"][0] if d["instances"] and isinstance(d["instances"][0], dict) else None
        if not isinstance(root, dict):
            return out
        out["name"] = (root.get("Name") or relpath).split("/")[-1]
        # the five core QualityScalableFloats are identified by TYPE in field
        # order (their 2042 name candidates collide with unrelated labels)
        core_vals = [v for v in root.values()
                     if isinstance(v, dict) and
                     v.get("__type") == "QualityScalableFloat"]
        for nm, v in zip(GR_CORE_NAMES, core_vals):
            if "High" in v:
                out["core"][nm] = round(v["High"], 6)
        bmin, bmax = root.get("BoundingBoxMin"), root.get("BoundingBoxMax")
        if isinstance(bmin, dict) and isinstance(bmax, dict):
            out["bbox"] = [[round(bmin.get(a, 0), 3) for a in "xyz"],
                           [round(bmax.get(a, 0), 3) for a in "xyz"]]
        for inst in d["instances"]:
            if not isinstance(inst, dict):
                continue
            t = inst.get("__type")
            if t == "SpawnModeContinuous":
                # BF6 swapped SpawnRate <-> InitialParticleCount vs the 2042
                # layout (float-vs-int type identity disambiguates)
                out["spawn"] = {
                    "mode": "continuous",
                    "rate": qsf(inst.get("InitialParticleCount")),
                    "max_count": qsf(inst.get("ParticleMaxCount")),
                    "initial_count": qsf(inst.get("SpawnRate")),
                }
            elif t == "SpawnModeBurst":
                out["spawn"] = {
                    "mode": "burst",
                    "rate": None,
                    "max_count": qsf(inst.get("ParticleMaxCount")),
                    "initial_count": qsf(inst.get("ParticleMaxCount")),
                }
            elif t == "GpuGraphParamUiSlider":
                out["sliders"].append([inst.get("SliderRangeMin"),
                                       inst.get("SliderRangeMax"),
                                       bool(inst.get("UseLogSlider"))])
        out["params"] = param_table(root)
        out["n_params"] = len(root.get(GR_PARAMTABLE) or [])
        gsi = root.get(GR_GLOBALSORT)
        if isinstance(gsi, dict):
            out["global_sorting"] = bool(gsi.get("Enabled"))
            for ref in (gsi.get("AtlasTextureParametersRuntime") or []):
                if isinstance(ref, dict) and ref.get("path"):
                    out["atlas"] = ref["path"].replace("\\", "/")
                    break
        # mesh-emitter reference: RigidMeshAsset imports (meshdebris chunks,
        # darts, casings ...) live in the graph's import table
        for _g, p in d["imports"]:
            if p and re.search(r"(_es_mesh|/meshes/[^/]+)\.ebx$",
                               p.replace("\\", "/").lower()):
                out["mesh"] = p.replace("\\", "/")
                break
        return out


# ------------------------------------------------------------- textures ----
DDS_T = bytes([68, 68, 83, 32, 124, 0, 0, 0, 7, 16, 0, 0])
DDS_T1 = bytes([0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0] + [0] * 44 + [32, 0, 0, 0, 4, 0, 0, 0])
DDS_T2 = bytes([0] * 21 + [16] + [0] * 18)
DDS_T3 = bytes([3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])
DDS_X = bytes([68, 88, 49, 48])


def decode_bcn_top(pix, w, h, dxgi):
    # 8-byte blocks: BC1 (70-72) and BC4 (79-81); all other BCn are 16-byte
    block = 8 if dxgi in (70, 71, 72, 79, 80, 81) else 16
    need = max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * block
    dds = (DDS_T + struct.pack("<I", h) + struct.pack("<I", w) + DDS_T1 +
           DDS_X + DDS_T2 + struct.pack("<i", dxgi) + DDS_T3 + pix[:need])
    # unique name in the REAL temp dir -- a fixed name inside the (Dropbox-
    # synced) .cache dir gets transiently locked by the sync client, which
    # made random atlases fail to decode per run
    fd, tmp = tempfile.mkstemp(suffix=".dds")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(dds)
        im = Image.open(tmp)
        im.load()
        im = im.convert("RGBA")
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return im


def solve_atlas_dims(nbytes, block=16):
    """Exact mip-chain size match fallback: [(w, h, mips)] candidates."""
    hits = []
    p2 = [1 << i for i in range(2, 14)]
    for w in p2:
        for h in p2:
            tot, ww, hh, mips = 0, w, h, 0
            while True:
                tot += max(1, (ww + 3) // 4) * max(1, (hh + 3) // 4) * block
                mips += 1
                if tot == nbytes:
                    hits.append((w, h, mips))
                    break
                if tot > nbytes or (ww == 1 and hh == 1):
                    break
                ww = max(1, ww // 2)
                hh = max(1, hh // 2)
    return hits


def read_chunk(guid_hex):
    for d in CHUNK_DIRS:
        p = os.path.join(d, guid_hex.upper() + ".chunk")
        if os.path.exists(p):
            return open(p, "rb").read()
    return None


class AtlasCache:
    """AtlasTextureAsset -> decoded, ready-to-use flipbook PNG.

    .AtlasTexture resource header (92 B, verified against 135/141 atlases by
    exact chunk-size prediction): b[3] = width/256, b[5] = height/256,
    b[6] = stored mip count, chunk GUID @16. Pixels are BC3.
    LeftRightTiles sheets hold TWO side-by-side 6-way-lighting bases; the
    export crops the LEFT base so cols x rows tiles the whole PNG."""

    def __init__(self, name_idx, gi):
        self.name_idx = name_idx
        self.gi = gi
        self.cache = {}

    def get(self, relpath):
        key = relpath.replace("\\", "/").lower()
        if key in self.cache:
            return self.cache[key]
        a = self._build(relpath)
        self.cache[key] = a
        return a

    def _build(self, relpath):
        path = find_dump_file(relpath, self.name_idx)
        if not path:
            return None
        try:
            d = dump_ebx(path, self.gi)
        except Exception:
            return None
        root = next((i for i in d["instances"]
                     if isinstance(i, dict) and i.get("__type") == "AtlasTextureAsset"), None)
        if not root:
            return None
        cols = root.get("AnimationColumnCount") or 1
        frames = root.get("AnimationFrameCount") or 1
        lr = bool(root.get("LeftRightTiles"))
        res = os.path.splitext(path)[0] + ".AtlasTexture"
        if not os.path.exists(res):
            return None
        rd = open(res, "rb").read()
        if len(rd) < 32:
            return None
        guid = rd[16:32].hex().upper()
        pix = read_chunk(guid)
        if pix is None:
            return None
        w, h = 256 * rd[3], 256 * rd[5]
        if not (w and h):    # tiny atlas (<256): exact-size fallback
            cands = solve_atlas_dims(len(pix), 16)
            if not cands:
                return None
            w, h, _m = cands[0]
        try:
            im = decode_bcn_top(pix, w, h, BC3_UNORM)
        except Exception:
            return None
        if lr:               # keep the left 6-way lighting base only
            im = im.crop((0, 0, w // 2, h))
        rows = max(1, math.ceil(frames / cols))
        scale = min(1.0, MAX_TEX_DIM / max(im.size))
        if scale < 1.0:
            im = im.resize((max(1, int(im.size[0] * scale)),
                            max(1, int(im.size[1] * scale))), Image.LANCZOS)
        base = os.path.splitext(os.path.basename(relpath))[0].lower()
        png = "%s_%dx%d.png" % (re.sub(r"_\d+x\d+", "", base), cols, frames)
        os.makedirs(TEXOUT, exist_ok=True)
        im.save(os.path.join(TEXOUT, png), optimize=True)
        # blend/lighting hint from the sheet pixels. The draw-config booleans
        # do NOT encode blending (fire and smoke graphs are bit-identical
        # there); the engine picks Emissive vs (Gnomon/Vertex)Lit via
        # ET_LightingModelGS expressions baked into compiled shaders. What
        # DOES survive is the sheet itself: emissive sheets carry chromatic
        # flame color in RGB, lit smoke sheets are desaturated lighting bases.
        sm = im.resize((64, 64))
        pix = list(sm.getdata())
        n = sat = luma = 0
        for r_, g_, b_, a_ in pix:
            if a_ > 60:
                n += 1
                mx, mn = max(r_, g_, b_), min(r_, g_, b_)
                sat += (mx - mn) / 255.0
                luma += mx / 255.0
        sat = sat / n if n else 0.0
        luma = luma / n if n else 0.0
        render = "sixway" if lr else ("emissive" if sat > 0.18 else "lit")
        return {"file": "textures/" + png, "sheet_px": [im.size[0], im.size[1]],
                "source_px": [w, h], "cols": cols, "frames": frames,
                "rows": rows, "left_right_tiles": lr,
                "render": render, "sheet_sat": round(sat, 3),
                "sheet_luma": round(luma, 3),
                "ebx": relpath.replace("\\", "/")}


# --------------------------------------------------------------- meshes ----
class MeshCache:
    """meshp_*.ebx RigidMeshAsset -> small GLB in site/meshes/."""

    def __init__(self, name_idx):
        self.name_idx = name_idx
        self.cache = {}

    def get(self, relpath):
        key = relpath.replace("\\", "/").lower()
        if key in self.cache:
            return self.cache[key]
        m = self._build(relpath)
        self.cache[key] = m
        return m

    def _build(self, relpath):
        ebx_path = find_dump_file(relpath, self.name_idx)
        if not ebx_path:
            return None
        ms = os.path.splitext(ebx_path)[0] + ".MeshSet"
        if not os.path.exists(ms):
            return None
        name = os.path.splitext(os.path.basename(relpath))[0].lower()
        glb = os.path.join(MESHOUT, name + ".glb")
        if not os.path.exists(glb):
            try:
                import numpy as np
                import trimesh
                from build_multimat import parse_ascii
                with tempfile.TemporaryDirectory() as td:
                    subprocess.run([MESHEXE, ms], cwd=td, capture_output=True,
                                   timeout=120)
                    asc = [f for f in os.listdir(td) if f.endswith(".ascii")]
                    if not asc:
                        return None
                    subs = parse_ascii(os.path.join(td, asc[0]))
                if not subs:
                    return None
                meshes = []
                for V, _UV, F in subs:
                    if len(V) and len(F):
                        meshes.append(trimesh.Trimesh(vertices=V, faces=F,
                                                      process=False))
                if not meshes:
                    return None
                mesh = trimesh.util.concatenate(meshes)
                if max(mesh.extents) > 50:      # cm-unit export -> metres
                    mesh.apply_scale(0.01)
                mesh.visual = trimesh.visual.TextureVisuals(
                    material=trimesh.visual.material.PBRMaterial(
                        baseColorFactor=[140, 132, 122, 255],
                        metallicFactor=0.4, roughnessFactor=0.7))
                os.makedirs(MESHOUT, exist_ok=True)
                mesh.export(glb)
            except Exception:
                return None
        return {"mesh_name": name, "glb": "meshes/" + name + ".glb",
                "ebx": relpath.replace("\\", "/")}


# ------------------------------------------------------- soundboard join ---
class SoundMatcher:
    """FX sound-config name -> BF6 Portal SoundBoard clip (reference only;
    audio stays hosted on the soundboard's GitHub Pages).

    The FX blueprints reference engine sound configs
    (bf03_gadgets_smokegrenade_marker_config_01); the soundboard manifest
    carries the Portal SFX_ names of its 1,5xx captured clips. Joined by
    name-token overlap; conservative threshold, unmatched configs are kept
    in the manifest as plain names."""

    STOP = {"bf01", "bf03", "bf04", "bf06", "config", "sound", "snd", "sfx",
            "vo", "one", "shot", "oneshot", "oneshot3d", "simpleloop3d",
            "lfe", "2d", "3d", "v1", "v2", "amb", "emt", "master"}
    # structural / location tokens: shared by unrelated sounds, so they carry
    # no evidence of a real match (fire_medium was matching Water_Splash via
    # levels+shared+spots before this list existed)
    GENERIC = {"levels", "shared", "spots", "base", "small", "medium",
               "large", "big", "close", "distant", "loop", "start", "stop",
               "world", "bigworld", "event", "spawnable", "generic",
               "brooklyn", "cairo", "gibraltar", "utar", "vtar", "dumbo",
               "granite", "aftermath", "subsurface", "battery", "outskirts",
               "firestorm", "golmud", "limestone", "plaza", "eastwood",
               "badlands", "contaminated", "nightraid", "oceanpark",
               "abbasid", "sand", "portal",
               # broad category words shared by unrelated sounds
               "vehicles", "weapons", "gadgets", "destruction", "explosion",
               "explosions", "abilities", "handheld", "impacts", "props",
               "soldier", "damage", "throwables"}

    def __init__(self):
        self.entries = []
        try:
            sb = json.load(open(SOUNDBOARD, encoding="utf-8"))
        except Exception:
            sb = []
        for e in sb:
            if e.get("vo"):
                continue
            toks = self._toks(e.get("name", ""))
            if toks:
                self.entries.append((toks, e))

    def _toks(self, s):
        out = set()
        for t in re.split(r"[^a-z0-9]+", s.lower()):
            if len(t) > 2 and t not in self.STOP and not t.isdigit():
                out.add(t)
        return out

    def match(self, cfg):
        want_all = self._toks(cfg)
        want = want_all - self.GENERIC
        joined = "".join(sorted(want))
        best, bs = None, (0, 0)
        for toks, e in self.entries:
            spec = toks - self.GENERIC
            inter = want & spec
            score = sum(len(t) for t in inter)
            # long compound tokens count when embedded (crateexplode in
            # supplydrop_crateexplode etc.); >=8 chars so short fragments
            # of a longer word ("deploy" inside "deployablecover") don't
            # outrank an exact sibling
            for t in spec - inter:
                if len(t) >= 8 and t in joined:
                    score += len(t) - 2
            # tiebreak on the full overlap so e.g. DeployableCover
            # "Destruction" beats "Deploy" when the specific score ties
            tie = sum(len(t) for t in (want_all & toks))
            if (score, tie) > bs:
                bs, best = (score, tie), e
        # only distinctive-token evidence counts; 8+ chars of shared
        # specific tokens (e.g. "autocannon", "deployablecover", or
        # "supplydrop") -- weak single-theme overlaps stay unmatched
        if best and bs[0] >= 8:
            return {"sb_name": best["name"], "clip": best["file"],
                    "dur": best.get("dur"), "loop": best.get("loop"),
                    "score": bs[0]}
        return None


# ------------------------------------------------------------ classify -----
def classify(portal_name, emitters):
    hay = portal_name.lower() + " " + " ".join(
        (e.get("graph") or "") for e in emitters)
    for cls, rx in CLASS_RULES:
        if re.search(rx, hay):
            return cls
    return "other"


def effect_tier(emitters):
    if any(e["family"] in RENDER_FAMS_T1 and e.get("sprite")
           for e in emitters if e.get("renderable")):
        return 1
    fams = {e["family"] for e in emitters if e.get("renderable")}
    if fams & RENDER_FAMS_T2:
        return 2
    if any(e.get("mesh") for e in emitters):
        return 4    # mesh-particle preview
    return 3


# --------------------------------------------------------------- effect ----
def vec3(v):
    if isinstance(v, dict):
        return [round(v.get(a, 0), 4) for a in "xyz"]
    return None


def parse_effect(path, gi, graphs, atlases, meshes, name_idx, depth=0, seen=None):
    """EffectBlueprint -> emitters (recursing into child fx blueprints)."""
    seen = seen or set()
    key = path.replace("\\", "/").lower()
    if key in seen or depth > 2:
        return [], {}
    seen.add(key)
    d = dump_ebx(path, gi)
    emitters, meta = [], {"lights": 0, "sounds": 0, "other_entities": [],
                          "sound_configs": []}
    for inst in d["instances"]:
        if not isinstance(inst, dict):
            continue
        t = inst.get("__type") or ""
        if t == "EmitterGraphEntityData":
            em = parse_emitter(inst, graphs, atlases, meshes)
            if em:
                emitters.append(em)
        elif t == "EffectEntityData":
            meta["cull_distance"] = qsf(inst.get("CullDistance"))
            meta["max_active"] = qsf(inst.get("MaxActiveInstanceCount"))
        elif "Light" in t:
            meta["lights"] += 1
        elif "Sound" in t:
            meta["sounds"] += 1
            # sound config reference (e.g. LegacySoundEffectEntityData.Sound
            # -> common/sound/.../bf03_gadgets_smokegrenade_marker_config_01)
            for v in inst.values():
                if isinstance(v, dict) and v.get("import") and v.get("path") \
                        and "sound" in v["path"].replace("\\", "/").lower():
                    cfg = os.path.basename(v["path"])[:-4]
                    if cfg not in meta["sound_configs"]:
                        meta["sound_configs"].append(cfg)
        elif t and t not in ("InterfaceDescriptorData", "CompareBoolEntityData",
                             "SelectIntEntityData") and not t.startswith("f_") \
                and "-" not in t:
            meta["other_entities"].append(t)
    for _g, rel in d["imports"]:
        if not rel:
            continue
        b = os.path.basename(rel).lower()
        rl = rel.replace("\\", "/").lower()
        if b.startswith("fx_") and ("/fx/" in rl or rl.startswith("common/fx")):
            child = find_dump_file(rel, name_idx)
            if child and child.replace("\\", "/").lower() != key:
                sub, m2 = parse_effect(child, gi, graphs, atlases, meshes,
                                       name_idx, depth + 1, seen)
                for e in sub:
                    e["from_child"] = os.path.basename(rel)
                emitters.extend(sub)
                for cfg in m2.get("sound_configs", []):
                    if cfg not in meta["sound_configs"]:
                        meta["sound_configs"].append(cfg)
                meta["sounds"] += m2.get("sounds", 0)
    return emitters, meta


def parse_emitter(inst, graphs, atlases, meshes):
    gptr = inst.get(ENT_GRAPH_PTR)
    if not isinstance(gptr, dict) or not gptr.get("path"):
        return None
    grel = gptr["path"]
    g = graphs.get(grel)
    fam = g["family"]
    em = {"graph": g["name"] or os.path.basename(grel)[:-4],
          "family": fam, "renderable": False}
    tr = inst.get("Transform") or {}
    em["pos"] = vec3(tr.get("trans")) or [0, 0, 0]
    ov = inst.get(ENT_OVERRIDES) or {}
    bmin, bmax = vec3(ov.get(OV_BBOX_MIN)), vec3(ov.get(OV_BBOX_MAX))
    if bmin and bmax:
        em["bbox"] = [bmin, bmax]
    rate = qsf(ov.get(OV_SPAWNRATE))
    life = qsf(ov.get(OV_LIFETIME))
    maxc = qsf(ov.get(OV_MAXCOUNT))
    init = qsf(ov.get(OV_INITCOUNT))
    g_spawn = g["spawn"] or {}
    g_life = (g["core"] or {}).get("particle_lifespan")
    em["spawn_mode"] = g_spawn.get("mode") or "continuous"
    em["spawn_rate"] = {"value": rate if rate else g_spawn.get("rate"),
                        "source": "effect_override" if rate else "graph_default"}
    em["lifetime"] = {"value": life if life else g_life,
                      "source": "effect_override" if life else "graph_default"}
    em["max_count"] = maxc if maxc else g_spawn.get("max_count")
    em["initial_count"] = init or 0
    unk = {}
    for lbl, k in (("f40", OV_UNK40), ("f72", OV_UNK72), ("f120", OV_UNK120)):
        v = qsf(ov.get(k))
        if v:
            unk[lbl] = round(v, 4)
    if unk:
        em["raw_overrides"] = unk
    p = dict(g["params"])
    # per-emitter exposed-parameter override table (the authored per-effect
    # customization; this is where the smoke-marker colors live)
    ov_params = param_table(inst, ENT_PARAM_OVERRIDES)
    p.update(ov_params)
    p.update(param_table(inst, ENT_PARAMS))
    em["params"] = p
    if ov_params:
        em["n_overrides"] = len(inst.get(ENT_PARAM_OVERRIDES) or [])
    # sprite: per-emitter texture override beats the template default
    atlas_rel = None
    for e in (inst.get(ENT_TEXOVERRIDE) or []):
        if isinstance(e, dict):
            ptr = e.get(ENT_TEXOVERRIDE_PTR)
            if isinstance(ptr, dict) and ptr.get("path"):
                atlas_rel = ptr["path"]
                break
    if not atlas_rel:
        atlas_rel = g.get("atlas")
    # mesh emitter: graph-level RigidMeshAsset import, or entity-level pointers.
    # volume-decal / distortion graphs also import a box mesh, but that is a
    # projection volume, not a rendered particle -- skip those families.
    # Unit-primitive meshes (defaulttriangle/unitquad/debug axis/null) are
    # GPU-sim placeholders scaled in shaders, not real geometry -- skip them
    # so pebbles/thindebris stay on their procedural path.
    UTIL_MESH = r"defaulttriangle|unitquad|debug_axis|_null_|lasersightbeam"
    mesh_rel = g.get("mesh") if fam not in ("volumedecals", "smokefire") else None
    if mesh_rel and "volumedecal" in mesh_rel.lower():
        mesh_rel = None
    for ptr in (inst.get(ENT_MESH_PTRS) or []):
        if isinstance(ptr, dict) and ptr.get("path"):
            mesh_rel = ptr["path"]
            break
    if mesh_rel and re.search(UTIL_MESH, os.path.basename(mesh_rel).lower()):
        mesh_rel = None
    if fam in RENDER_FAMS_T1 and atlas_rel:
        sp = atlases.get(atlas_rel)
        if sp:
            em["sprite"] = sp
            em["renderable"] = True
    elif fam in RENDER_FAMS_T2:
        em["renderable"] = True
    if mesh_rel:
        m = meshes.get(mesh_rel)
        if m:
            em["mesh"] = m
            em["renderable"] = True
            if not em.get("sprite"):
                em["family"] = "mesh" if fam in MESH_FAMS or fam == "other" else fam
    if fam == "dummy":
        em["renderable"] = False
    return em


# ------------------------------------------------- editor look parameters ----
def build_editor_params(graphs, atlases, entries):
    """Per-family look file consumed by BOTH the site player and the Godot
    overlay. Real decoded values are listed plainly; anything derived or
    tuned is in "assumed"."""
    # most-placed families on Aftermath (per-blueprint placement census)
    top_effects = {}
    if os.path.exists(AFTERMATH_FX):
        af = json.load(open(AFTERMATH_FX, encoding="utf-8"))
        for e in af.get("fx", []):
            nm = e.get("effect")
            if nm:
                top_effects[nm] = top_effects.get(nm, 0) + 1
    fam_entries = {}
    for key, g in graphs.cache.items():
        if not g or not g.get("name"):
            continue
        fam_entries.setdefault(g["family"], []).append(g)

    def graph_entry(g):
        p = g["params"]
        life = (g["core"] or {}).get("particle_lifespan")
        sp = atlases.cache.get((g.get("atlas") or "").replace("\\", "/").lower())
        e = {
            "graph": g["name"], "family": g["family"],
            "lifetime_s": life,
            "spawn": g["spawn"],
            "drag": p.get("drag"),
            "wind_strength": p.get("windstrength"),
            "buoyancy": p.get("buoyancy"),
            "gravity": p.get("gravity"),
            "restitution": p.get("restitution"),
            "speed_mult": p.get("speedmult"),
            "spawn_speed": p.get("spawnspeed"),
            "turbulence_strength": p.get("turbulencestrength"),
            "rotation_speed_deg": p.get("rotationspeed"),
            "spawn_rot_deg": p.get("spawnrot"),
            "life_min_mult": p.get("lifeminmult"),
            "opacity": p.get("opacity"),
            "opacity_min_mult": p.get("opacityminmult"),
            "opacity_over_life": p.get("opacityoverlife"),
            "color": p.get("color1"),
            "color0": p.get("color0"),
            "temperature": p.get("temperature"),
            "intensity": p.get("intensity"),
            # newly-cracked pid set (2026-07): real sizes + envelopes
            "base_size": p.get("basesize"),
            "base_size_bias": p.get("basesizebias"),
            "spawn_size": p.get("spawnsize"),
            "size_curve": p.get("sizecurve"),
            "size_over_life": p.get("sizeoverlife"),
            "spawn_rotation_speed": p.get("spawnrotationspeed"),
            "emissive_intensity_mult": p.get("emissiveintensitymult"),
            "fade_in_speed": p.get("fadeinspeed"),
            "fade_start_age": p.get("fadestartage"),
            "shrink_start_age": p.get("shrinkstartage"),
            "spawn_speed_min": p.get("spawnspeedmin"),
            "spawn_speed_mult": p.get("spawnspeedmult"),
            "spawn_direction_min": p.get("spawndirectionmin"),
            "spawn_direction_max": p.get("spawndirectionmax"),
            "random_force": p.get("randomforce"),
            "turbulence_frequency": p.get("turbulencefrequency"),
            "slider_ranges": g.get("sliders") or None,
            "emitter_bbox": g.get("bbox"),
        }
        if sp:
            e["sheet"] = sp["file"]
            e["cols"] = sp["cols"]
            e["rows"] = sp["rows"]
            e["frames"] = sp["frames"]
            e["fps"] = round(sp["frames"] / life, 2) if life else None
            e["six_way_lighting"] = sp["left_right_tiles"]
            e["render"] = sp.get("render")
        if g.get("mesh"):
            e["mesh_ebx"] = g["mesh"]
        return {k: v for k, v in e.items() if v is not None}

    CLASS_SIZE = {
        # size is baked into compiled compute shaders (not in EBX); these
        # start values reproduce in-game scale reference shots and are the
        # single knob to retune via the PhotoMatch workflow.
        "globalsorting_fire": {"size_min": 0.7, "size_max": 1.4, "grow": 1.25,
                               "rise_mps": 1.3},
        "globalsorting_smoke": {"size_min": 0.9, "size_max": 1.8, "grow": 2.3,
                                "rise_mps": 0.85},
        "sparks": {"size_min": 0.02, "size_max": 0.06, "grow": 1.0,
                   "streak_stretch": 4.0},
        "meshdebris": {"size_min": 1.0, "size_max": 1.0, "grow": 1.0,
                       "tumble_dps": 320},
    }
    out = {
        "_meta": {
            "purpose": "per-family FX look parameters decoded from BF6 game "
                       "data; consumed by the site player and the Godot "
                       "map-context overlay so both previews match",
            "decoded_fields": ["lifetime_s", "spawn", "drag", "wind_strength",
                               "buoyancy", "gravity", "restitution",
                               "speed_mult", "spawn_speed",
                               "turbulence_strength", "rotation_speed_deg",
                               "spawn_rot_deg", "life_min_mult", "opacity",
                               "opacity_min_mult", "opacity_over_life",
                               "color", "temperature", "intensity",
                               "sheet/cols/rows/frames", "emitter_bbox",
                               "slider_ranges", "mesh_ebx"],
            "assumed_fields": {
                "fps": "frames/lifetime (playback rate is baked into the "
                       "compiled flipbook shader; no authored fps survives "
                       "in EBX)",
                "size_min/size_max/grow/rise_mps": "class fallbacks only: "
                       "BaseSize/SpawnSize/SizeCurve are now decoded where "
                       "authored (per graph and per effect emitter); "
                       "class_defaults apply to emitters without them",
                "emission": "per-effect spawn bounds come from each effect's "
                       "override block in manifest.json (bbox field); the "
                       "graph emitter_bbox here is the template culling box",
            },
            "evidence": {
                "gravity": "PropertyId 0xc46720e3 named via djb2-xor crack, "
                           "value -9.81 in spark graphs",
                "restitution": "PropertyId 0x8906e021, value 0.3 (spark "
                               "ground bounce)",
                "rotation": "SpawnRot/RotationSpeed pids; +-180 spawn-rot "
                            "range pids sit adjacent in the same table",
                "six_way_smoke": "LeftRightTiles atlases carry two lighting "
                                 "bases side by side; exported sheets are "
                                 "cropped to the left base (naive full-sheet "
                                 "playback double-tiles, which is why "
                                 "first-pass editor smoke looked wrong)",
            },
        },
        "class_defaults": CLASS_SIZE,
        "graphs": {},
        "top_aftermath_effects": dict(sorted(top_effects.items(),
                                             key=lambda kv: -kv[1])[:15]),
    }
    # graphs actually used by the Portal catalog, most-referenced families first
    used = {}
    for e in entries:
        for em in e.get("emitters", []):
            used[em["graph"]] = used.get(em["graph"], 0) + 1
    for fam, gl in fam_entries.items():
        for g in gl:
            if g["name"] and (used.get(g["name"]) or
                              fam in ("globalsorting", "sparks", "meshdebris")):
                out["graphs"][g["name"]] = graph_entry(g)
    return out


# ------------------------------------------------------------------ main ----
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", type=str, default="")
    ap.add_argument("--reindex", action="store_true")
    args = ap.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    t0 = time.time()
    print("loading guid index ...")
    gi = load_guid_index()
    print("  %d guid->path entries" % len(gi))
    print("indexing dump ebx names ...")
    name_idx = load_name_index(refresh=args.reindex)
    print("  %d unique basenames" % len(name_idx))
    fx = portal_fx_list()
    print("  %d Portal-placeable FX" % len(fx))
    if args.only:
        want = {w.strip().lower() for w in args.only.split(",")}
        fx = [f for f in fx if f[0].lower() in want]
    if args.limit:
        fx = fx[:args.limit]

    graphs = GraphCache(name_idx, gi)
    atlases = AtlasCache(name_idx, gi)
    meshes = MeshCache(name_idx)
    sounds = SoundMatcher()
    entries, stats = [], {"wrapper": 0, "direct": 0, "fuzzy": 0,
                          "unmatched": 0}
    consistency = [0, 0]
    sound_stats = [0, 0]   # matched configs, total configs
    portal_keys = frozenset(n.lower() for n, _m in fx)

    for i, (name, maps) in enumerate(fx):
        bp, how = resolve_blueprint(name, name_idx, gi, portal_keys)
        stats[how] += 1
        entry = {"name": name, "portal_enum": name, "maps": maps, "match": how}
        if bp:
            rel = bp
            for root in DUMP_ROOTS:
                if bp.startswith(root):
                    rel = os.path.relpath(bp, root)
                    break
            entry["ebx"] = rel.replace("\\", "/")
            try:
                emitters, meta = parse_effect(bp, gi, graphs, atlases, meshes,
                                              name_idx)
            except Exception as ex:
                emitters, meta = [], {"error": "%s: %s" % (type(ex).__name__, ex)}
            entry["emitters"] = emitters
            entry.update({k: v for k, v in meta.items() if v})
            if meta.get("sound_configs"):
                slist = []
                for cfg in meta["sound_configs"]:
                    m = sounds.match(cfg)
                    sound_stats[1] += 1
                    if m:
                        sound_stats[0] += 1
                        slist.append({"config": cfg, "sb_name": m["sb_name"],
                                      "clip": m["clip"], "dur": m["dur"],
                                      "loop": m["loop"]})
                    else:
                        slist.append({"config": cfg})
                entry["sounds_ref"] = slist
            for e in emitters:
                r, l, m = (e["spawn_rate"]["value"], e["lifetime"]["value"],
                           e["max_count"])
                if r and l and m and e["spawn_mode"] == "continuous":
                    consistency[1] += 1
                    if r * l <= m * 1.5:
                        consistency[0] += 1
        else:
            entry["emitters"] = []
        entry["class"] = classify(name, entry["emitters"])
        entry["tier"] = effect_tier(entry["emitters"]) if entry["emitters"] else 3
        real = [e for e in entry["emitters"] if e["family"] != "dummy"]
        if not entry.get("ebx"):
            entry["status"] = "not_in_dumps"
        elif not real:
            entry["status"] = "stub_or_empty"
        elif entry["tier"] == 3:
            entry["status"] = "unsupported_families"
        else:
            entry["status"] = "ok"
        entries.append(entry)
        if (i + 1) % 50 == 0:
            print("  %d/%d ..." % (i + 1, len(fx)))

    tiers = {1: 0, 2: 0, 3: 0, 4: 0}
    classes = {}
    for e in entries:
        tiers[e["tier"]] += 1
        classes[e["class"]] = classes.get(e["class"], 0) + 1

    manifest = {
        "_meta": {
            "generator": "tools/build_manifest.py",
            "built": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source": "BF6 retail EBX dumps (common + %d map superbundles)"
                      % len(DUMP_ROOTS),
            "portal_fx_total": len(entries),
            "match": stats,
            "tiers": {"tier1_flipbook": tiers[1], "tier2_procedural": tiers[2],
                      "tier3_placeholder": tiers[3], "tier4_mesh": tiers[4]},
            "classes": classes,
            "soundboard_url": SOUNDBOARD_URL,
            "sound_configs_matched": "%d/%d" % tuple(sound_stats),
            "evidence": {
                "colors": "per-emitter GpuExposedParameterInput override "
                          "table (EmitterGraphEntityData f_512); proven by "
                          "diffing fx_granite_strike_smoke_marker_"
                          "{red,green,violet,yellow} -- only Color0/Color1 "
                          "(pids 0xA1C184C8/C9) differ, hues match the "
                          "variant names (values are linear RGB)",
                "blend": "draw-config booleans do NOT encode blending (fire "
                         "and smoke graph templates are bit-identical "
                         "there); Emissive vs Lit is an ET_LightingModelGS "
                         "expression baked into compiled shaders. The "
                         "player derives it from the decoded sheet pixels "
                         "(chromatic emissive sheets vs desaturated lit "
                         "bases; sprite.render + sheet_sat evidence).",
                "burst": "SpawnModeBurst templates carry only "
                         "ParticleMaxCount (one-shot; no authored interval "
                         "survives); the player's replay period is "
                         "site-side.",
                "curves": "*OverLife/*Curve params are cubic envelope "
                          "coefficients a*t^3+b*t^2+c*t+d, t=age/life "
                          "(anchored on OpacityOverLife rise-fall shapes); "
                          "interpretation derived, flagged.",
            },
            "assumed": {
                "flipbook_fps": "playback rate is a baked shader constant; "
                                "the player uses frames/lifetime looped",
                "override_semantics": "spawn_rate/lifetime/max_count override "
                                      "fields identified by value anchoring "
                                      "(rate*lifetime<=1.5*max holds for "
                                      "%d/%d looping emitters; burst "
                                      "emitters exceed it by design)"
                                      % tuple(consistency),
                "particle_size": "BaseSize/SpawnSize/SizeCurve pids are now "
                                 "decoded where authored; emitters without "
                                 "them fall back to editor_fx_params.json "
                                 "class_defaults (flagged)",
                "burst_replay": "the site player re-fires burst emitters on "
                                "a repeat timer (max particle life + pad); "
                                "in-game these are event-triggered",
            },
        },
        "fx": entries,
    }
    os.makedirs(SITE, exist_ok=True)
    out = os.path.join(SITE, "manifest.json")
    json.dump(manifest, open(out, "w"), separators=(",", ":"))

    ep = build_editor_params(graphs, atlases, entries)
    epout = os.path.join(SITE, "editor_fx_params.json")
    json.dump(ep, open(epout, "w"), indent=1)

    ntex = len(os.listdir(TEXOUT)) if os.path.isdir(TEXOUT) else 0
    nmesh = len(os.listdir(MESHOUT)) if os.path.isdir(MESHOUT) else 0
    print("\nwrote %s (%.1f KB)" % (out, os.path.getsize(out) / 1024))
    print("wrote %s (%.1f KB)" % (epout, os.path.getsize(epout) / 1024))
    print("match: %(wrapper)d wrapper / %(direct)d direct / %(fuzzy)d fuzzy "
          "/ %(unmatched)d unmatched" % stats)
    print("tiers: t1=%d t2=%d t3=%d mesh=%d   classes: %s" %
          (tiers[1], tiers[2], tiers[3], tiers[4], classes))
    print("override consistency (continuous, rate*life<=1.5*max): %d/%d" % tuple(consistency))
    print("sound configs matched to soundboard: %d/%d" % tuple(sound_stats))
    print("textures: %d   meshes: %d   graphs parsed: %d   atlases: %d" %
          (ntex, nmesh, len(graphs.cache), len(atlases.cache)))
    print("total %.1f s" % (time.time() - t0))


if __name__ == "__main__":
    main()
