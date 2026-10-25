"""Bake the reviewed 0.1.9 source additions into one supplemental GLB per target system.
Usage: blender --background --disable-autoexec --python export-v3-additions.py --
       BLEND INVENTORY V3_DECISIONS_JSON OUTPUT_DIR
Same coordinate policy as export-source-additions.py. Production GLBs are never opened.
"""
import hashlib
import json
from pathlib import Path
import sys
import bpy


def main():
    blend, inventory_path, decisions_path, output = map(Path, sys.argv[sys.argv.index('--') + 1:])
    decisions = json.loads(decisions_path.read_text())
    digest = hashlib.sha256(blend.read_bytes()).hexdigest()
    assert digest == decisions['source_sha256']
    inventory = {o['name']: o for o in json.loads(inventory_path.read_text())['objects']}
    rows = decisions['additions']
    assert len(rows) == 19 and len({r['current_id'] for r in rows}) == 19
    bpy.ops.wm.open_mainfile(filepath=str(blend))
    original = bpy.context.scene
    scene = bpy.data.scenes.new('__V3_ADDITIONS__')
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
    baked = []
    for row in rows:
        source = inventory[row['source_id']]
        assert not source['converter_helper_exclusion']['excluded'], row['source_id']
        ev = bpy.data.objects[row['source_id']].evaluated_get(dg)
        assert ev.is_evaluated
        mesh = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
        assert len(mesh.vertices) > 0 and len(mesh.polygons) > 0, row['source_id']
        mesh.materials.clear()
        obj = bpy.data.objects.new('__BAKED_V3__', mesh)
        obj.matrix_world = ev.matrix_world.copy()
        scene.collection.objects.link(obj)
        baked.append((obj, row))
    # Free every target name in memory only, then give baked copies their final IDs.
    for obj, row in baked:
        for name in (row['source_id'], row['current_id']):
            existing = bpy.data.objects.get(name)
            if existing is not None and existing is not obj:
                existing.name = '__ORIGINAL_SOURCE__' + name
    for obj, row in baked:
        obj.name = row['current_id']
        assert obj.name == row['current_id'], f"name collision {row['current_id']} -> {obj.name}"
    output.mkdir(parents=True, exist_ok=True)
    reports = []
    for system in sorted({r['system'] for r in rows}):
        bpy.ops.object.select_all(action='DESELECT')
        copies = [(obj, row) for obj, row in baked if row['system'] == system]
        for obj, _ in copies:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = copies[0][0]
        destination = output / f'{system}-v3-additions.glb'
        bpy.ops.export_scene.gltf(filepath=str(destination), export_format='GLB', use_selection=True,
            export_yup=True, export_apply=False, export_materials='NONE', export_extras=True,
            export_animations=False, export_skins=False, export_morph=False)
        reports.append({'system': system, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
            'objects': [{'source_id': row['source_id'], 'current_id': row['current_id'], 'system': system,
                         'replaces_wrong_side_node': bool(row.get('replaces_wrong_side_node')),
                         'vertices': len(obj.data.vertices), 'polygons': len(obj.data.polygons),
                         'source_world_bounds': inventory[row['source_id']]['evaluated_enabled']['bounds']['world']}
                        for obj, row in copies]})
        print('V3_ADDITIONS_EXPORTED', system, len(copies), flush=True)
    assert hashlib.sha256(blend.read_bytes()).hexdigest() == digest
    report = {'source_sha256': digest, 'decisions_sha256': hashlib.sha256(decisions_path.read_bytes()).hexdigest(),
        'blender_version': bpy.app.version_string,
        'coordinate_policy': 'Enabled evaluated source world matrix, glTF Y-up, no rescale/recenter. No existing geometry rewritten.',
        'systems': reports}
    (output / 'v3-additions-export.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
