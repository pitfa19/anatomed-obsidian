"""Export only the audited missing lymphoid surfaces, never save the source blend.
Run: blender --background --disable-autoexec --python export-lymphoid.py --
     /absolute/Startup.blend /absolute/inventory.json /absolute/output-directory
"""
import hashlib
import json
import sys
from pathlib import Path
import bpy

EXISTING = {"Spleen", "Left lobe of thymus", "Right lobe of thymus"}
EXPECTED_SOURCE_SHA256 = "9f08a17ea0115fed80b2a73ecdf0a1bc2ab2f6956f37c593ce23d513ea35afcd"


def main():
    blend, inventory_path, output = map(Path, sys.argv[sys.argv.index("--") + 1:])
    digest = hashlib.sha256(blend.read_bytes()).hexdigest()
    assert digest == EXPECTED_SOURCE_SHA256, "Unexpected source blend"
    inventory = json.loads(inventory_path.read_text())
    eligible = [o for o in inventory["objects"] if "6: Lymphoid organs" in o["collections"]
                and not o["converter_helper_exclusion"]["excluded"]
                and o["evaluated_enabled"].get("faces", 0) > 0]
    assert len(eligible) == 163
    selected = [o for o in eligible if o["name"] not in EXISTING]
    assert len(selected) == 160
    bpy.ops.wm.open_mainfile(filepath=str(blend))
    original = bpy.context.scene
    scene = bpy.data.scenes.new("__LYMPHOID_EVALUATION__")
    scene.frame_set(original.frame_current)
    scene.unit_settings.system = original.unit_settings.system
    scene.unit_settings.scale_length = original.unit_settings.scale_length
    for obj in list(bpy.data.objects):
        scene.collection.objects.link(obj)
        obj.hide_viewport = False
        obj.hide_render = False
    bpy.context.window.scene = scene
    for obj in scene.objects:
        obj.hide_set(False)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    copies = []
    records = []
    for row in selected:
        obj = bpy.data.objects[row["name"]]
        ev = obj.evaluated_get(dg)
        assert ev.is_evaluated, obj.name
        mesh = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
        assert len(mesh.vertices) > 0 and len(mesh.polygons) > 0, obj.name
        mesh.materials.clear()
        copy = bpy.data.objects.new("__BAKED_LYMPHOID__", mesh)
        copy.matrix_world = ev.matrix_world.copy()
        scene.collection.objects.link(copy)
        copies.append((copy, row["name"]))
        records.append({"source_id": row["name"], "current_id": row["name"], "system": "lymphoid",
                        "vertices": len(mesh.vertices), "polygons": len(mesh.polygons),
                        "source_world_bounds": row["evaluated_enabled"]["bounds"]["world"]})
    # Only delete in-memory originals so exported objects reclaim exact source names.
    kept = {obj.as_pointer() for obj, _ in copies}
    for obj in list(bpy.data.objects):
        if obj.as_pointer() not in kept:
            bpy.data.objects.remove(obj, do_unlink=True)
    for obj, name in copies:
        obj.name = name
        obj.select_set(True)
    bpy.context.view_layer.objects.active = copies[0][0]
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output / "lymphoid.glb"), export_format="GLB",
        use_selection=True, export_yup=True, export_apply=False, export_materials="NONE",
        export_extras=True, export_animations=False, export_skins=False, export_morph=False)
    assert hashlib.sha256(blend.read_bytes()).hexdigest() == digest
    report = {"source_sha256": digest, "blender_version": bpy.app.version_string,
              "coordinate_policy": "Evaluated source matrix_world, glTF export_yup=True (x,y,z -> x,z,-y), source metres. No rescale or recenter.",
              "curve_policy": "Original bevel thickness and tessellation preserved. Existing nerves/vessels not rewritten.",
              "eligible": len(eligible), "exported": records,
              "already_in_organs": sorted(EXISTING),
              "glb_sha256": hashlib.sha256((output / "lymphoid.glb").read_bytes()).hexdigest()}
    (output / "lymphoid-export.json").write_text(json.dumps(report, indent=2) + "\n")
    print("LYMPHOID_COMPLETE", len(records), report["glb_sha256"], flush=True)


if __name__ == "__main__":
    main()
