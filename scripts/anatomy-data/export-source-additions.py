"""Bake only reviewed missing source objects into supplemental GLBs.
Usage: blender --background --disable-autoexec --python export-source-additions.py --
       BLEND INVENTORY DECISIONS_JSON OUTPUT_DIR
Existing production GLBs are not opened or overwritten by this exporter.
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
    inventory = json.loads(inventory_path.read_text())
    inventory_by_name = {o['name']: o for o in inventory['objects']}
    selected = [r for r in decisions['rows'] if r['decision'] == 'restore-confirmed-missing-distinct-source-surface']
    assert len(selected) == 123
    bpy.ops.wm.open_mainfile(filepath=str(blend))
    original = bpy.context.scene
    scene = bpy.data.scenes.new('__SOURCE_ADDITIONS__')
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
    for row in selected:
        name = row['source_id']
        source = inventory_by_name[name]
        assert not source['converter_helper_exclusion']['excluded']
        ev = bpy.data.objects[name].evaluated_get(dg)
        assert ev.is_evaluated
        mesh = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
        assert len(mesh.vertices) > 0 and len(mesh.polygons) > 0
        mesh.materials.clear()
        obj = bpy.data.objects.new('__BAKED_ADDITION__', mesh)
        obj.matrix_world = ev.matrix_world.copy()
        scene.collection.objects.link(obj)
        baked.append((obj, row))
    # Rename only the originals whose exact names the baked selected copies need.
    # All source data edits are memory-only and occur after baking every object.
    for obj, row in baked:
        bpy.data.objects[row['source_id']].name = '__ORIGINAL_SOURCE__' + row['source_id']
        obj.name = row['current_id']
    output.mkdir(parents=True, exist_ok=True)
    reports = []
    for system in ('muscles', 'organs'):
        bpy.ops.object.select_all(action='DESELECT')
        copies = [(obj, row) for obj, row in baked if row['system'] == system]
        assert len(copies) == (119 if system == 'muscles' else 4)
        for obj, row in copies:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = copies[0][0]
        destination = output / f'{system}-additions.glb'
        bpy.ops.export_scene.gltf(filepath=str(destination), export_format='GLB', use_selection=True,
            export_yup=True, export_apply=False, export_materials='NONE', export_extras=True,
            export_animations=False, export_skins=False, export_morph=False)
        reports.append({'system': system, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
            'objects': [{'source_id': row['source_id'], 'current_id': row['current_id'], 'system': system,
                         'vertices': len(obj.data.vertices), 'polygons': len(obj.data.polygons),
                         'source_world_bounds': inventory_by_name[row['source_id']]['evaluated_enabled']['bounds']['world']}
                        for obj, row in copies]})
        print('SOURCE_ADDITIONS_EXPORTED', system, len(copies), flush=True)
    assert hashlib.sha256(blend.read_bytes()).hexdigest() == digest
    report = {'source_sha256': digest, 'decisions_sha256': hashlib.sha256(decisions_path.read_bytes()).hexdigest(),
        'blender_version': bpy.app.version_string,
        'coordinate_policy': 'Enabled evaluated source world matrix, glTF Y-up, no rescale/recenter. No existing geometry rewritten.',
        'systems': reports}
    (output / 'source-additions-export.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
