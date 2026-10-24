"""Compare 125 source-only candidates with real decoded production triangle surfaces.
Usage: blender --background --disable-autoexec --python compare-source-surfaces.py --
       BLEND INVENTORY SPATIAL_RECONCILIATION PREPARED_SURFACE_DIR
No production assets are written and the source blend is never saved.
"""
import array
import bisect
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def main():
    blend, inventory_path, spatial_path, output = map(Path, sys.argv[sys.argv.index('--') + 1:])
    digest = hashlib.sha256(blend.read_bytes()).hexdigest()
    assert digest == '9f08a17ea0115fed80b2a73ecdf0a1bc2ab2f6956f37c593ce23d513ea35afcd'
    inventory = json.loads(inventory_path.read_text())
    by_name = {o['name']: o for o in inventory['objects']}
    spatial = json.loads(spatial_path.read_text())
    candidates = [o for o in spatial['rows'] if o['system'] in ('muscles', 'organs') and o['status'] == 'no-close-intermediate-candidate']
    assert len(candidates) == 125
    surfaces = {}
    for system in ('muscles', 'organs'):
        meta = json.loads((output / f'{system}-triangles.json').read_text())
        data = array.array('f')
        data.frombytes((output / f'{system}-triangles.bin').read_bytes())
        if sys.byteorder != 'little':
            data.byteswap()
        vertices = [tuple(data[i:i+3]) for i in range(0, len(data), 3)]
        triangles = [(i, i+1, i+2) for i in range(0, len(vertices), 3)]
        surfaces[system] = (BVHTree.FromPolygons(vertices, triangles, all_triangles=True), meta,
                            [r['triangle_start'] for r in meta['ranges']])
        print('BVH_READY', system, len(triangles), flush=True)
    bpy.ops.wm.open_mainfile(filepath=str(blend))
    original = bpy.context.scene
    scene = bpy.data.scenes.new('__SOURCE_SURFACE_EVIDENCE__')
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
    rows = []
    for candidate in candidates:
        name, system = candidate['source'], candidate['system']
        obj = bpy.data.objects[name]
        ev = obj.evaluated_get(dg)
        assert ev.is_evaluated
        mesh = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
        mesh.calc_loop_triangles()
        assert len(mesh.polygons) > 0
        verts = []
        for vertex in mesh.vertices:
            v = ev.matrix_world @ vertex.co
            verts.append(Vector((v.x, v.z, -v.y)))
        samples = list(verts)
        for triangle in mesh.loop_triangles:
            samples.append(sum((verts[i] for i in triangle.vertices), Vector()) / 3)
        tree, meta, starts = surfaces[system]
        distances, nearest_names = [], Counter()
        for sample in samples:
            position, normal, index, distance = tree.find_nearest(sample)
            assert distance is not None
            distances.append(float(distance))
            nearest_names[meta['ranges'][bisect.bisect_right(starts, index)-1]['name']] += 1
        distances.sort()
        n = len(distances)
        fractions = {str(mm): sum(d <= mm/1000 for d in distances)/n for mm in (0.05, 0.1, 0.3, 0.5, 1, 2, 5)}
        row = {'source_id': name, 'system': system, 'collections': by_name[name]['collections'],
               'source_vertices': len(mesh.vertices), 'source_triangles': len(mesh.loop_triangles), 'samples': n,
               'nearest_surface_distance_metres': {'min': distances[0], 'median': distances[n//2],
                   'p95': distances[min(n-1, int(n*0.95))], 'max': distances[-1]},
               'fraction_within_mm': fractions,
               'nearest_existing_meshes': [{'id': k, 'sample_count': v} for k, v in nearest_names.most_common(8)],
               'assessment': 'unreviewed-surface-distance-evidence-not-anatomical-equivalence'}
        rows.append(row)
        print('SOURCE_EVIDENCE', name, 'p95mm', round(row['nearest_surface_distance_metres']['p95']*1000, 4),
              'within0.3mm', round(fractions['0.3'], 4), 'nearest', nearest_names.most_common(2), flush=True)
        bpy.data.meshes.remove(mesh)
    report = {'schema_version': 1, 'source_sha256': digest,
              'method': 'Every enabled source vertex and every source triangle centroid compared with nearest actual decoded nonhelper target-system triangle. World metres, glTF Y-up. BVH distance is geometry evidence, not proof of anatomical identity. Production geometry untouched.',
              'target_files': {s: surfaces[s][1]['sha256'] for s in surfaces}, 'rows': rows}
    assert hashlib.sha256(blend.read_bytes()).hexdigest() == digest
    (output / 'source-surface-evidence.json').write_text(json.dumps(report, indent=2) + '\n')
    print('SOURCE_EVIDENCE_COMPLETE', len(rows), flush=True)


if __name__ == '__main__':
    main()
