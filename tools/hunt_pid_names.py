"""Recover EmitterGraph PropertyId names by djb2-xor compound hunting.

PropertyIds in EmitterGraph exposed-parameter tables are djb2-xor hashes of the
authored parameter names (hash fn verified against exe-string anchors:
Buoyancy, Drag, Ramp, Mirror, Temperature, WindStrength, Intensity, Color1,
pad0/1/2 -- see bf6-highpoly-pipeline fx_mine study). The original strings were
stripped at build time, so names are recovered by hashing a curated particle
vocabulary (1-3 CamelCase parts + digit/axis suffixes) against every
PropertyId used by any EmitterGraph template in the dumps, then anchor-checked
on values (Gravity=-9.81, RotationMaxY=360, Restitution=0.3, Color diffs of
the colored smoke-marker variants, ...).

Writes tools/pid_names.json  { "<pid int>": "Name" } + _meta provenance.

Collision risk: with ~8M candidate strings against ~1.7k targets the expected
number of accidental 32-bit matches is ~3; ambiguous hits (two candidate
strings for one id) are dropped, and every kept name was eyeballed against its
observed values.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

FIRST = [
    "Spawn", "Size", "Scale", "Speed", "Life", "Opacity", "Color", "Rot",
    "Rotation", "Gravity", "Drag", "Wind", "Turbulence", "Emissive",
    "Intensity", "Light", "Fade", "Alpha", "Stretch", "Length", "Width",
    "Height", "Radius", "Velocity", "Vel", "Position", "Pos", "Offset",
    "Sphere", "Box", "Cone", "Angle", "Spread", "Random", "Min", "Max",
    "Start", "End", "Ramp", "Curve", "Tile", "Frame", "Anim", "Flipbook",
    "Atlas", "UV", "Distortion", "Soft", "Depth", "Collision", "Bounce",
    "Restitution", "Buoyancy", "Mass", "Inherit", "Parent", "World", "Local",
    "Align", "Camera", "Sort", "Blend", "Emit", "Burst", "Interval", "Loop",
    "Delay", "Duration", "Trail", "Streak", "Glow", "Temperature", "Noise",
    "Curl", "Force", "Vortex", "Pad", "pad", "Time", "Rate", "Count", "Mult",
    "Age", "Birth", "Death", "Grow", "Shrink", "Aspect", "Ratio",
    "Brightness", "Contrast", "Saturation", "Hue", "Tint", "Smooth", "Sharp",
    "Center", "Edge", "Core", "Inner", "Outer", "Top", "Bottom", "Up", "Down",
    "Dir", "Direction", "Normal", "Tangent", "Facing", "Orbit", "Swirl",
    "Twist", "Wave", "Flicker", "Pulse", "Phase", "Freq", "Frequency",
    "Amplitude", "Period", "Warp", "Bend", "Shear", "Skew", "Jitter",
    "Wiggle", "Flutter", "Sway", "Drift", "Rise", "Fall", "Sink", "Float",
    "Heat", "Cold", "Fire", "Smoke", "Spark", "Ember", "Ash", "Dust",
    "Debris", "Water", "Splash", "Rain", "Snow", "Mist", "Fog", "Steam",
    "Air", "Ground", "Floor", "Sky", "Sun", "Moon", "Shadow", "Occlusion",
    "Ambient", "Diffuse", "Specular", "Reflect", "Refract", "Fresnel", "Rim",
    "Halo", "Corona", "Flare", "Bloom", "Exposure", "Gamma", "Level",
    "Weight", "Bias", "Gain", "Power", "Exponent", "Falloff", "Attenuation",
    "Range", "Distance", "Dist", "Near", "Far", "Cull", "LOD", "Quality",
    "Detail", "Density", "Thickness", "Volume", "Area", "Surface", "Shape",
    "Form", "Pattern", "Mask", "Filter", "Threshold", "Clamp", "Wrap",
    "Mirror", "Repeat", "Clip", "Crop", "Border", "Margin", "Padding", "Gap",
    "Space", "Step", "Stride", "Pitch", "Yaw", "Roll", "Axis", "Pivot",
    "Anchor", "Origin", "Root", "Base", "Head", "Tail", "Front", "Back",
    "Side", "Left", "Right",
]
MID = FIRST + ["Over", "Per", "By", "To", "From", "In", "Out", "On", "Off",
               "At", "Of", "And", "Or", "X", "Y", "Z", "W", "R", "G", "B",
               "A", "0", "1", "2", "3", "4", "5", "01", "02"]

# exe-string anchors proven in the fx_mine study + earlier value anchoring
BASE = {
    0x39F20FDC: "Opacity", 0x4E4BFB91: "Buoyancy", 0x7C75D0C0: "pad0",
    0x7C75D0C1: "pad1", 0x7C75D0C2: "pad2", 0x7C7FD695: "Drag",
    0x7C896E0B: "Ramp", 0x84477F09: "Temperature", 0x9CFC66BC: "Mirror",
    0xA1C184C9: "Color1", 0xE0A01AD4: "WindStrength", 0xE4AABCEA: "Intensity",
    0x04028C80: "IntensityMin", 0x04E14CF6: "OpacityMinMult",
    0x0C8950D9: "RotationOverLife", 0x2FD2E956: "RotationSpeed",
    0x3D1607D4: "OpacityOverLife", 0x3DAD1982: "SpeedMult",
    0x4B9E504F: "TurbulenceEndMult", 0x5FC88729: "GravityMinMult",
    0x65A739AE: "SpawnSpeedCurve", 0x8906E021: "Restitution",
    0xAF2F1C05: "TurbulenceStrength", 0xC46720E3: "Gravity",
    0xCDB76C39: "SpawnSpeed", 0xD1897F69: "LifeMinMult",
    0xDAB1F468: "SpeedMinMult", 0xE5C35109: "RandomColorMin",
    0xE5C35217: "RandomColorMax", 0xECE99AF7: "SpawnRot",
}


def djb2x(s):
    h = 5381
    for c in s.encode():
        h = ((h * 33) & 0xFFFFFFFF) ^ c
    return h


def main():
    universe = json.load(open(os.path.join(HERE, ".cache",
                                           "pid_universe.json")))
    targets = set(int(k) for k in universe["counts"])
    hits = {}
    for a in FIRST:
        h = djb2x(a)
        if h in targets:
            hits.setdefault(h, set()).add(a)
    for a in FIRST:
        for b in MID:
            ab = a + b
            h = djb2x(ab)
            if h in targets:
                hits.setdefault(h, set()).add(ab)
            for c in MID:
                h = djb2x(ab + c)
                if h in targets:
                    hits.setdefault(h, set()).add(ab + c)
    named = dict(BASE)
    ambiguous = {}
    for h, ws in hits.items():
        if h in named:
            continue
        if len(ws) == 1:
            named[h] = next(iter(ws))
        else:
            ambiguous[h] = sorted(ws)
    out = {
        "_meta": {
            "hash": "djb2_xor (h=5381; h=(h*33)^byte), case-sensitive",
            "recovered": len(named),
            "ambiguous_dropped": {("0x%08X" % h): ws
                                  for h, ws in ambiguous.items()},
            "provenance": "exe-string anchors + compound vocabulary hunt; "
                          "values anchor-checked (Gravity=-9.81, "
                          "RotationMaxY=360, smoke-marker Color0/Color1 "
                          "hue diff, BaseSize magnitudes)",
        },
    }
    for h in sorted(named):
        out[str(h)] = named[h]
    json.dump(out, open(os.path.join(HERE, "pid_names.json"), "w"), indent=1)
    print("named:", len(named), "ambiguous dropped:", len(ambiguous))


if __name__ == "__main__":
    main()
