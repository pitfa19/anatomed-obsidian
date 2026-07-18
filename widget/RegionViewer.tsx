import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, useGLTF } from '@react-three/drei';
import type { RegionDetail, RegionPart, RegionPayload, RegionSystemMeta } from '../src/shared';
import type { PartsCatalog } from '../src/vendor/types';
import { assembleRegion, cleanName, MAX_REGION_PARTS } from '../src/region';
import { primeNeighbors } from '../src/neighbors';
import { resolveQueryToParts, groupAliasSuggestions } from '../src/vendor/resolveParts';
import { fuzzyMatchScored } from '../src/vendor/fuzzy';
import {
  applyTint,
  computeVisibleUnionBox,
  fitOrthoToBox,
  sanitizeNodeName,
  setVisibleParts,
} from './lib/three-helpers';

/** New structure-list + detail spec, emitted when the user edits the view (add /
 *  remove / change detail) so a host can persist it (Obsidian rewrites the block;
 *  Claude/MCP leaves onChange undefined = view-only). */
export interface RegionChange {
  parts: string[];
  detail: RegionDetail;
}

interface Props {
  payload: RegionPayload;
  /** Called when the user clicks a structure name (asks Claude about it). */
  onSelect?: (part: RegionPart) => void;
  /** Tooltip on a structure name — host-specific (Claude asks; Obsidian opens a note). */
  selectHint?: string;
  /** Called when the user changes the structure list / detail level (persistence). */
  onChange?: (spec: RegionChange) => void;
  /** Injected catalog (Obsidian bundles it); when omitted the widget fetches
   *  `${assetBase}/parts-catalog.json` itself. Enables the in-widget controls. */
  catalog?: PartsCatalog;
  /** Injected neighbour-prime (Obsidian uses requestUrl); when omitted the widget
   *  fetches `${assetBase}/parts-neighbors.json` and primes it. Must be idempotent. */
  ensureNeighbors?: () => Promise<void>;
}

// Static control mappings, hoisted so they keep a stable identity across
// renders — otherwise R3F re-applies them to the controls on every re-render.
// Left-drag rotates, right-drag pans, wheel zooms. On touch: one finger
// rotates, two fingers pinch-zoom + pan.
const MOUSE_BUTTONS = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
const TOUCHES = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

const DETAIL_LEVELS: { id: RegionDetail; label: string; hint: string }[] = [
  { id: 'isolated', label: 'Isolated', hint: 'Only the named structures' },
  { id: 'related', label: 'Related', hint: 'Add nearest neighbours (translucent)' },
  { id: 'regional', label: 'Regional', hint: 'Add a wider surrounding context' },
];

interface Candidate {
  term: string;
  note: string;
}

/** Build the add-structure suggestion index once from the catalog: every unique
 *  English name + Latin synonym + the region-group aliases. Every term resolves
 *  through resolveQueryToParts, so an inserted suggestion always renders.
 *  (Ported from the Obsidian plugin's suggest.ts, minus the editor bits.) */
function buildCandidates(catalog: PartsCatalog): { terms: string[]; byTerm: Map<string, Candidate> } {
  const sysLabel = new Map(catalog.systems.map((s) => [s.id, s.label_en]));
  const byTerm = new Map<string, Candidate>(); // key = lowercased term (dedupe)
  const add = (raw: string, cand: Candidate) => {
    const term = raw.trim();
    if (!term) return;
    const key = term.toLowerCase();
    if (!byTerm.has(key)) byTerm.set(key, cand);
  };
  for (const p of catalog.parts) {
    const en = cleanName(p.name_en);
    const lat = cleanName(p.name_lat);
    const sys = sysLabel.get(p.system) ?? p.system;
    add(en, { term: en, note: lat && lat !== en ? `${lat} · ${sys}` : sys });
    if (lat && lat !== en) add(lat, { term: lat, note: `${en} · ${sys}` });
  }
  for (const alias of groupAliasSuggestions()) add(alias, { term: alias, note: 'region group' });
  const terms = [...byTerm.values()].map((c) => c.term);
  return { terms, byTerm };
}

const focusOf = (payload: RegionPayload): RegionPart[] => payload.parts.filter((p) => !p.context);

export default function RegionViewer({ payload, onSelect, selectHint = 'Ask about this structure', onChange, catalog: catalogProp, ensureNeighbors: ensureNeighborsProp }: Props) {
  const baseUrl = useMemo(() => payload.assetBase.replace(/\/+$/, ''), [payload.assetBase]);

  // --- Editable view state (seeded from the payload, reset on host push) ---
  const [focusParts, setFocusParts] = useState<RegionPart[]>(() => focusOf(payload));
  const [detail, setDetail] = useState<RegionDetail>(payload.detail);
  const [visible, setVisible] = useState<Set<string>>(() => new Set(payload.parts.map((p) => p.id)));

  // Catalog: injected (Obsidian) or self-fetched (MCP). Enables the controls.
  const [fetchedCatalog, setFetchedCatalog] = useState<PartsCatalog | null>(null);
  const catalog = catalogProp ?? fetchedCatalog;
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [neighborsReady, setNeighborsReady] = useState(false);

  // Refs so async handlers read the latest without re-subscribing.
  const focusRef = useRef(focusParts);
  focusRef.current = focusParts;
  const detailRef = useRef(detail);
  detailRef.current = detail;

  // Reset internal state when the payload PROP identity changes (host pushed a new
  // region). Adjust-state-during-render pattern: synchronous, no intermediate frame.
  const prevPayloadRef = useRef(payload);
  const prevActiveIdsRef = useRef<string[]>(payload.parts.map((p) => p.id));
  if (prevPayloadRef.current !== payload) {
    prevPayloadRef.current = payload;
    const nf = focusOf(payload);
    setFocusParts(nf);
    setDetail(payload.detail);
    setNeighborsReady(false);
    setVisible(new Set(payload.parts.map((p) => p.id)));
    prevActiveIdsRef.current = payload.parts.map((p) => p.id);
  }

  // Fetch the catalog once (unless injected) so the controls can recompute regions.
  useEffect(() => {
    if (catalogProp) return;
    let cancelled = false;
    fetch(`${baseUrl}/parts-catalog.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: PartsCatalog) => {
        if (cancelled) return;
        data.parts = data.parts.filter((p) => !p.id.endsWith('.g')); // drop group containers
        setFetchedCatalog(data);
      })
      .catch(() => {
        if (!cancelled) setCatalogFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogProp, baseUrl]);

  // Ensure the neighbour map is primed (once) — injected or self-fetched. A single
  // shared promise dedupes concurrent detail switches (last-write-wins downstream).
  const neighborsPromiseRef = useRef<Promise<void> | null>(null);
  const ensureNeighbors = useCallback((): Promise<void> => {
    if (ensureNeighborsProp) return ensureNeighborsProp();
    if (neighborsPromiseRef.current) return neighborsPromiseRef.current;
    const pr = fetch(`${baseUrl}/parts-neighbors.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((map) => {
        primeNeighbors(map);
      })
      .catch((err) => {
        neighborsPromiseRef.current = null; // allow retry
        throw err;
      });
    neighborsPromiseRef.current = pr;
    return pr;
  }, [ensureNeighborsProp, baseUrl]);

  // The payload actually rendered: recomputed client-side once the catalog is
  // available (and neighbours are primed for related/regional); otherwise the
  // server-built payload, so there is zero flicker before the data loads.
  const activePayload = useMemo<RegionPayload>(() => {
    if (catalog && (detail === 'isolated' || neighborsReady)) {
      return assembleRegion(catalog, focusParts, baseUrl, {
        detail,
        title: payload.title,
        unmatched: payload.unmatched,
      });
    }
    return payload;
  }, [catalog, detail, neighborsReady, focusParts, payload, baseUrl]);

  const emitChange = useCallback(
    (parts: RegionPart[], d: RegionDetail) => {
      onChange?.({ parts: parts.map((p) => p.name_en), detail: d });
    },
    [onChange],
  );

  // --- Detail switch -------------------------------------------------------
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const detailTokenRef = useRef(0);
  const changeDetail = useCallback(
    (next: RegionDetail) => {
      if (next === detailRef.current) return;
      setDetailError(false);
      const token = ++detailTokenRef.current;
      if (next === 'isolated' || neighborsReady) {
        setDetail(next);
        emitChange(focusRef.current, next);
        return;
      }
      setDetailBusy(true);
      ensureNeighbors()
        .then(() => {
          if (token !== detailTokenRef.current) return; // superseded
          setNeighborsReady(true);
          setDetail(next);
          setDetailBusy(false);
          emitChange(focusRef.current, next);
        })
        .catch(() => {
          if (token !== detailTokenRef.current) return;
          setDetailBusy(false);
          setDetailError(true); // keep current detail
        });
    },
    [neighborsReady, ensureNeighbors, emitChange],
  );

  // --- Add / remove focus structures --------------------------------------
  const candidates = useMemo(() => (catalog ? buildCandidates(catalog) : null), [catalog]);
  const searchStructures = useCallback(
    (q: string): Candidate[] => {
      if (!candidates || !q.trim()) return [];
      const out: Candidate[] = [];
      for (const m of fuzzyMatchScored(q, candidates.terms, 8)) {
        const c = candidates.byTerm.get(m.term.toLowerCase());
        if (c) out.push(c);
      }
      return out;
    },
    [candidates],
  );
  const addStructure = useCallback(
    (term: string) => {
      if (!catalog) return;
      const resolved = resolveQueryToParts(catalog, term);
      if (!resolved) return;
      const prev = focusRef.current;
      const seen = new Set(prev.map((p) => p.id));
      const next = [...prev];
      for (const p of resolved.parts) {
        if (seen.has(p.id)) continue;
        if (next.length >= MAX_REGION_PARTS) break;
        seen.add(p.id);
        next.push({
          id: p.id,
          name_en: cleanName(p.name_en),
          name_lat: cleanName(p.name_lat),
          system: p.system,
          side: p.side,
        });
      }
      if (next.length === prev.length) return; // nothing new
      setFocusParts(next);
      emitChange(next, detailRef.current);
    },
    [catalog, emitChange],
  );
  const removeStructure = useCallback(
    (id: string) => {
      const prev = focusRef.current;
      const next = prev.filter((p) => p.id !== id);
      if (next.length === prev.length) return;
      setFocusParts(next);
      emitChange(next, detailRef.current);
    },
    [emitChange],
  );
  const focusIdSet = useMemo(() => new Set(focusParts.map((p) => p.id)), [focusParts]);

  // --- Derived render data (from activePayload) ---------------------------
  const systemsById = useMemo(() => {
    const m = new Map<string, RegionSystemMeta>();
    for (const s of activePayload.systems) m.set(s.id, s);
    return m;
  }, [activePayload.systems]);

  const groups = useMemo(() => {
    const bySys = new Map<string, RegionPart[]>();
    for (const p of activePayload.parts) {
      const arr = bySys.get(p.system) ?? [];
      arr.push(p);
      bySys.set(p.system, arr);
    }
    return [...bySys.entries()].map(([sysId, parts]) => ({
      system: systemsById.get(sysId)!,
      parts,
    }));
  }, [activePayload.parts, systemsById]);

  // Merge visibility across recomputes: keep prior on/off for retained ids,
  // default-ON new ids, drop removed ids. The host-push hard reset (all-on) is
  // handled synchronously in the payload-identity block above.
  const activeIds = useMemo(() => activePayload.parts.map((p) => p.id), [activePayload]);
  const activeIdsKey = activeIds.join('|');
  useEffect(() => {
    const prev = prevActiveIdsRef.current;
    if (prev.join('|') === activeIdsKey) return; // unchanged (incl. right after a reset)
    const prevSet = new Set(prev);
    setVisible((cur) => {
      const merged = new Set<string>();
      for (const id of activeIds) {
        if (!prevSet.has(id)) merged.add(id); // new → on
        else if (cur.has(id)) merged.add(id); // retained & was on → on
      }
      return merged;
    });
    prevActiveIdsRef.current = activeIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeIdsKey is the stable string proxy for activeIds
  }, [activeIdsKey]);

  const toggle = useCallback((id: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setAll = useCallback(
    (on: boolean) => setVisible(on ? new Set(activeIds) : new Set()),
    [activeIds],
  );

  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const onLoaded = useCallback((id: string) => {
    setLoaded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const ready = groups.length > 0 && groups.every((g) => loaded.has(g.system.id));
  // Once the first full load completes, keep the model up: don't flash the
  // "Loading 3D…" overlay again when the user adds a not-yet-loaded system.
  const [everReady, setEverReady] = useState(false);
  useEffect(() => {
    if (ready) setEverReady(true);
  }, [ready]);

  const fitKey = useMemo(() => [...visible].sort().join('|'), [visible]);

  // Map a GLB node name back to its part, for hover-to-name. Keyed by the
  // sanitized node name (how three exposes it on the mesh / its ancestors).
  const nameByNode = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const p of activePayload.parts) m.set(sanitizeNodeName(p.id), { id: p.id, name: p.name_en });
    return m;
  }, [activePayload.parts]);

  // Touch devices have no hover, so the follow-cursor tooltip + per-move
  // pointer tracking are pointless there — and that per-move setState re-renders
  // the whole viewer (incl. OrbitControls) during a drag. Skip it on touch.
  const [coarse] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches,
  );
  const [hoverName, setHoverName] = useState<string | null>(null);
  const [pointerPos, setPointerPos] = useState<{ x: number; y: number } | null>(null);

  // Bumping this re-keys <Fit>, which re-frames the model — undoing any pan/zoom.
  const [refitNonce, setRefitNonce] = useState(0);
  const recenter = useCallback(() => setRefitNonce((n) => n + 1), []);

  const canEdit = !!catalog;

  return (
    <div className="am-viewport">
    <div
      className="am-stage"
      onPointerMove={
        coarse
          ? undefined
          : (e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPointerPos({ x: e.clientX - r.left, y: e.clientY - r.top });
            }
      }
      onPointerLeave={coarse ? undefined : () => setPointerPos(null)}
    >
      <Canvas
        className="am-canvas"
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        frameloop="always"
      >
        <ambientLight intensity={0.75} />
        <directionalLight position={[5, 10, 5]} intensity={0.85} />
        <directionalLight position={[-5, -3, -5]} intensity={0.3} />
        <OrthographicCamera makeDefault position={[0, 1.2, 7]} near={0.01} far={2000} />
        <OrbitControls
          makeDefault
          enableDamping
          enablePan
          enableZoom
          minZoom={0.3}
          maxZoom={16}
          // enableRotate is intentionally omitted (defaults true) — TouchGuard
          // toggles it imperatively to stabilize multi-touch gestures.
          mouseButtons={MOUSE_BUTTONS}
          touches={TOUCHES}
        />
        {groups.map((g) => (
          // Per-system Suspense so adding a not-yet-loaded system doesn't blank
          // the already-rendered ones while its GLB loads.
          <Suspense key={g.system.id} fallback={null}>
            <SystemGroup
              url={`${baseUrl}/${g.system.glb}`}
              tint={g.system.tint}
              systemId={g.system.id}
              parts={g.parts}
              visible={visible}
              onLoaded={onLoaded}
            />
          </Suspense>
        ))}
        <Fit fitKey={`${fitKey}#${refitNonce}`} ready={ready} />
        <PanClamp ready={ready} />
        <CanvasGestureLock />
        <TouchGuard />
        {!coarse && <Hoverer nameByNode={nameByNode} visible={visible} onHover={setHoverName} />}
      </Canvas>

      {!everReady && <div className="am-loading">Loading 3D…</div>}

      <button className="am-recenter" onClick={recenter} title="Recenter view" aria-label="Recenter view">
        <RecenterIcon />
      </button>

      {!coarse && hoverName && pointerPos && (
        <div className="am-tooltip" style={{ left: pointerPos.x, top: pointerPos.y }}>
          {hoverName}
        </div>
      )}

      {activePayload.unmatched.length > 0 && (
        <div className="am-unmatched">Not found: {activePayload.unmatched.join(', ')}</div>
      )}
    </div>

    {/* Legend lives OUTSIDE .am-stage: the R3F canvas sets touch-action:none on
        its full-bleed wrapper, and Chromium suppresses touch-scrolling for every
        element inside that stage subtree. As a sibling of the stage it scrolls. */}
    <Legend
      groups={groups}
      visible={visible}
      onToggle={toggle}
      onSetAll={setAll}
      onSelect={onSelect}
      selectHint={selectHint}
      detail={detail}
      onDetail={changeDetail}
      detailBusy={detailBusy}
      detailError={detailError}
      canEdit={canEdit}
      catalogFailed={catalogFailed}
      onSearch={searchStructures}
      onAdd={addStructure}
      onRemove={removeStructure}
      focusIds={focusIdSet}
    />
    </div>
  );
}

interface SystemGroupProps {
  url: string;
  tint: string;
  systemId: RegionSystemMeta['id'];
  parts: RegionPart[];
  visible: Set<string>;
  onLoaded: (id: string) => void;
}

function SystemGroup({ url, tint, systemId, parts, visible, onLoaded }: SystemGroupProps) {
  const { scene: source } = useGLTF(url);

  // Re-clone when the focus/context partition changes (a part added, removed, or
  // flipped focus<->context). applyTint's __tinted/__ctxTinted guards never revert
  // a mesh, so a stale clone would keep a promoted context part translucent — a
  // fresh clone clears the flags and re-tints correctly.
  const partitionKey = useMemo(
    () => parts.map((p) => `${p.id}${p.context ? 'c' : 'f'}`).sort().join('|'),
    [parts],
  );
  const cloned = useMemo(() => source.clone(true), [source, partitionKey]);

  const visibleIds = useMemo(
    () => parts.filter((p) => visible.has(p.id)).map((p) => p.id),
    [parts, visible],
  );
  const contextIds = useMemo(
    () => parts.filter((p) => p.context).map((p) => p.id),
    [parts],
  );
  const idsKey = useMemo(() => [...visibleIds].sort().join('|'), [visibleIds]);

  useEffect(() => {
    applyTint(cloned, tint, systemId, contextIds);
  }, [cloned, tint, systemId, contextIds]);

  useEffect(() => {
    setVisibleParts(cloned, visibleIds);
    onLoaded(systemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey is the stable string proxy for visibleIds
  }, [cloned, idsKey, systemId, onLoaded]);

  return <primitive object={cloned} />;
}

/** Re-fits the orthographic camera whenever the visible set OR the viewport
 *  size changes (the ortho frustum is aspect-dependent — without the size
 *  trigger the model vanishes on resize). Retries for 8 successful frames
 *  after each change to beat OrbitControls' first-frame drift. */
function Fit({ fitKey, ready }: { fitKey: string; ready: boolean }) {
  const { camera, size, scene, controls } = useThree();
  const frames = useRef(0);
  const keyRef = useRef<string | null>(null);

  useFrame(() => {
    if (!ready) return;
    const key = `${fitKey}@${Math.round(size.width)}x${Math.round(size.height)}`;
    if (keyRef.current !== key) {
      keyRef.current = key;
      frames.current = 0;
    }
    if (frames.current >= 8) return;
    const box = computeVisibleUnionBox([scene]);
    const ok = fitOrthoToBox(camera, controls, box, { width: size.width, height: size.height });
    if (ok) frames.current += 1;
  });

  return null;
}

/** Keeps panning bounded: clamps the orbit target to the model's bounding box
 *  every frame, so the structure can never be dragged off-screen. Camera follows
 *  the clamped target (offset preserved) so the view direction is unchanged. */
function PanClamp({ ready }: { ready: boolean }) {
  const { camera, scene, controls } = useThree();
  useFrame(() => {
    if (!ready) return;
    const c = controls as { target?: THREE.Vector3; update?: () => void } | null;
    const target = c?.target;
    if (!target) return;
    const box = computeVisibleUnionBox([scene]);
    if (box.isEmpty()) return;
    const cx = THREE.MathUtils.clamp(target.x, box.min.x, box.max.x);
    const cy = THREE.MathUtils.clamp(target.y, box.min.y, box.max.y);
    const cz = THREE.MathUtils.clamp(target.z, box.min.z, box.max.z);
    if (cx === target.x && cy === target.y && cz === target.z) return;
    camera.position.x += cx - target.x;
    camera.position.y += cy - target.y;
    camera.position.z += cz - target.z;
    target.set(cx, cy, cz);
    c.update?.();
  });
  return null;
}

/** iOS/WKWebView ignores `touch-action:none` inside a sandboxed iframe, so a
 *  finger-drag on the 3D canvas scrolls the surrounding Claude chat instead of
 *  rotating. A NON-PASSIVE `touchmove` listener that calls preventDefault claims
 *  the gesture (OrbitControls reads pointer events, which still fire) and stops
 *  the chat from scrolling. Scoped to the canvas, so the legend list still scrolls. */
function CanvasGestureLock() {
  const el = useThree((s) => s.gl.domElement);
  useEffect(() => {
    const stop = (e: TouchEvent) => e.preventDefault();
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, [el]);
  return null;
}

/** Stabilizes multi-touch on mobile. OrbitControls switches gesture mode on the
 *  instantaneous finger count with no hysteresis: a transient 2nd touch flips a
 *  one-finger rotate into a pinch-zoom, and lifting one finger out of a pinch
 *  re-bases to rotate (so the model spins on release). This counts active touch
 *  pointers (capture phase, ahead of OrbitControls) and, once a gesture involves
 *  2+ fingers, holds enableRotate=false until ALL fingers lift — so a two-finger
 *  gesture stays pure zoom/pan. A fresh single-finger gesture resets to rotate. */
function TouchGuard() {
  const controls = useThree((s) => s.controls) as { enableRotate?: boolean } | null;
  const domElement = useThree((s) => s.gl.domElement);
  useEffect(() => {
    if (!controls) return;
    const active = new Set<number>();
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      active.add(e.pointerId);
      // First finger of a fresh gesture: allow rotate. 2nd+ finger: lock it off.
      controls.enableRotate = active.size < 2;
    };
    const up = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      active.delete(e.pointerId);
      if (active.size === 0) controls.enableRotate = true; // gesture over, re-arm
    };
    const opts = { capture: true, passive: true } as const;
    domElement.addEventListener('pointerdown', down, opts);
    domElement.addEventListener('pointerup', up, opts);
    domElement.addEventListener('pointercancel', up, opts);
    return () => {
      domElement.removeEventListener('pointerdown', down, opts);
      domElement.removeEventListener('pointerup', up, opts);
      domElement.removeEventListener('pointercancel', up, opts);
      controls.enableRotate = true;
    };
  }, [controls, domElement]);
  return null;
}

/** Raycasts on pointer move and reports the name of the visible structure under
 *  the cursor (null when over empty space). Walks up from the hit mesh to the
 *  owning part node; skips connector/line meshes and hidden parts (so a hidden
 *  part in front can't mask a visible one behind it). */
function Hoverer({
  nameByNode,
  visible,
  onHover,
}: {
  nameByNode: Map<string, { id: string; name: string }>;
  visible: Set<string>;
  onHover: (name: string | null) => void;
}) {
  const { raycaster, camera, scene, pointer } = useThree();
  // Refs so useFrame always sees the latest props without re-subscribing.
  const mapRef = useRef(nameByNode);
  mapRef.current = nameByNode;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const lastName = useRef<string | null>(null);

  useFrame(() => {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(scene.children, true);
    let found: string | null = null;
    for (const h of hits) {
      const obj = h.object;
      if (!obj.visible) continue;
      if (obj.name.includes('-line') || obj.name.includes('-lin')) continue;
      for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
        const part = mapRef.current.get(o.name);
        if (part) {
          if (visibleRef.current.has(part.id)) found = part.name;
          break; // this mesh belongs to `part`; stop walking ancestors
        }
      }
      if (found) break;
    }
    if (found !== lastName.current) {
      lastName.current = found;
      onHover(found);
    }
  });

  return null;
}

interface LegendProps {
  groups: { system: RegionSystemMeta; parts: RegionPart[] }[];
  visible: Set<string>;
  onToggle: (id: string) => void;
  onSetAll: (on: boolean) => void;
  onSelect?: (part: RegionPart) => void;
  selectHint: string;
  detail: RegionDetail;
  onDetail: (d: RegionDetail) => void;
  detailBusy: boolean;
  detailError: boolean;
  canEdit: boolean;
  catalogFailed: boolean;
  onSearch: (q: string) => Candidate[];
  onAdd: (term: string) => void;
  onRemove: (id: string) => void;
  focusIds: Set<string>;
}

function Legend({
  groups,
  visible,
  onToggle,
  onSetAll,
  onSelect,
  selectHint,
  detail,
  onDetail,
  detailBusy,
  detailError,
  canEdit,
  catalogFailed,
  onSearch,
  onAdd,
  onRemove,
  focusIds,
}: LegendProps) {
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 560,
  );
  // Horizontal (pill) state lags the vertical one so the fold reads as two beats —
  // close: shrink height, THEN width; open: widen, THEN unfold. (Width
  // auto<->max-content can't be tweened or reliably deferred in CSS, so the
  // ordering is timed here rather than via transition-delay.)
  const [narrowed, setNarrowed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 560,
  );
  const foldTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(foldTimer.current), []);
  const toggleFold = useCallback(() => {
    clearTimeout(foldTimer.current);
    if (!collapsed) {
      setCollapsed(true);                                            // close height now
      foldTimer.current = setTimeout(() => setNarrowed(true), 280);  // then width
    } else {
      setNarrowed(false);                                            // open width now
      foldTimer.current = setTimeout(() => setCollapsed(false), 280); // then height
    }
  }, [collapsed]);
  const total = groups.reduce((n, g) => n + g.parts.length, 0);
  const shown = groups.reduce(
    (n, g) => n + g.parts.filter((p) => visible.has(p.id)).length,
    0,
  );

  // Add-structure search box (results as an absolute overlay so its height never
  // perturbs the measured legend-body cap below).
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const results = useMemo(() => (addOpen ? onSearch(query) : []), [addOpen, query, onSearch]);
  const pick = (term: string) => {
    onAdd(term);
    setQuery('');
  };

  // iOS won't reliably scroll a list sized only by flex/grid; give the body an
  // explicit measured pixel max-height so it's a definite, scrollable box.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || collapsed) return;
    const legendNode = body.closest('.am-legend');
    const legend = legendNode instanceof HTMLElement ? legendNode : null;
    const viewport = legend?.parentElement;
    if (!legend || !viewport) return;
    const px = (root: ParentNode, sel: string, fb: number) => {
      const el = root.querySelector(sel);
      return el instanceof HTMLElement ? el.offsetHeight : fb;
    };
    const fit = () => {
      const head = px(legend, '.am-legend-head', 44);
      const controls = px(legend, '.am-legend-controls', 0);
      const actions = px(legend, '.am-legend-actions', 44);
      const credit = px(legend, '.am-legend-credit', 0);
      // Base the bound on the VIEWPORT's fixed height (stable), not the legend's
      // animating height — mirrors the CSS cap min(80%, 100% - 1rem) — minus the
      // header + controls + actions + attribution footer. A definite px height is
      // what makes iOS scroll the list.
      const cap = Math.min(viewport.clientHeight * 0.8, viewport.clientHeight - 16);
      const avail = Math.round(cap - head - controls - actions - credit - 10);
      body.style.maxHeight = avail > 96 ? `${avail}px` : '';
    };
    fit();
    // Observe the VIEWPORT (not the legend) so our own body mutations don't
    // re-trigger the observer; catches resize / orientation changes.
    const ro = new ResizeObserver(fit);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [collapsed, groups, addOpen]);

  return (
    <div className={`am-legend${collapsed ? ' am-collapsed' : ''}${narrowed ? ' am-narrow' : ''}${addOpen && canEdit ? ' am-adding' : ''}`}>
      <button
        className="am-legend-head"
        onClick={toggleFold}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand legend' : 'Collapse legend'}
      >
        <ChevronIcon open={!collapsed} />
        <span className="am-legend-title">Legend</span>
        <span className="am-muted">{shown}/{total}</span>
      </button>

      <div className="am-legend-collapse" aria-hidden={collapsed}>
        <div className="am-legend-collapse-inner">
          <div className="am-legend-controls">
            <div className="am-detail" role="group" aria-label="Detail level">
              {DETAIL_LEVELS.map((d) => (
                <button
                  key={d.id}
                  className={`am-seg${detail === d.id ? ' am-seg-on' : ''}`}
                  onClick={() => onDetail(d.id)}
                  disabled={!canEdit || detailBusy}
                  title={d.hint}
                  aria-pressed={detail === d.id}
                >
                  {d.label}
                </button>
              ))}
            </div>
            {detailBusy && <div className="am-control-note">Loading context…</div>}
            {detailError && <div className="am-control-note am-control-err">Context data unavailable.</div>}

            <div className="am-add">
              <button
                className="am-add-toggle"
                onClick={() => setAddOpen((o) => !o)}
                disabled={!canEdit}
                title={canEdit ? 'Add a structure' : catalogFailed ? 'Structure list unavailable' : 'Loading structures…'}
                aria-expanded={addOpen}
              >
                <PlusIcon /> Add structure
              </button>
              {addOpen && canEdit && (
                <div className="am-add-field">
                  <input
                    className="am-add-input"
                    type="text"
                    value={query}
                    autoFocus
                    placeholder="Search structures…"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && results[0]) pick(results[0].term);
                      else if (e.key === 'Escape') setAddOpen(false);
                    }}
                  />
                  {results.length > 0 && (
                    <ul className="am-add-results">
                      {results.map((r) => (
                        <li key={r.term}>
                          <button className="am-add-result" onClick={() => pick(r.term)}>
                            <span className="am-add-term">{r.term}</span>
                            {r.note && <span className="am-add-note">{r.note}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="am-legend-actions">
            <button className="am-btn" onClick={() => onSetAll(true)}>Show all</button>
            <button className="am-btn" onClick={() => onSetAll(false)}>Hide all</button>
          </div>
          <div className="am-legend-body" ref={bodyRef}>
            {groups.map((g) => (
              <div key={g.system.id} className="am-sys">
                {groups.length > 1 && <div className="am-sys-head">{g.system.label_en}</div>}
                {g.parts.map((p) => {
                  const on = visible.has(p.id);
                  const removable = focusIds.has(p.id);
                  return (
                    <div key={p.id} className={`am-row${on ? '' : ' am-off'}${p.context ? ' am-ctx' : ''}`}>
                      <button
                        className="am-eye"
                        title={on ? 'Hide' : 'Show'}
                        aria-label={on ? 'Hide' : 'Show'}
                        onClick={() => onToggle(p.id)}
                      >
                        <span className="am-swatch" style={{ background: g.system.tint }} />
                        {on ? <EyeIcon /> : <EyeOffIcon />}
                      </button>
                      <button className="am-name" onClick={() => onSelect?.(p)} title={selectHint}>
                        <span className="am-name-en">{p.name_en}</span>
                        {p.context && <span className="am-ctx-tag">ctx</span>}
                      </button>
                      {removable && (
                        <button
                          className="am-remove"
                          title="Remove from view"
                          onClick={() => onRemove(p.id)}
                        >
                          <XIcon />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="am-legend-credit">
            3D models:{' '}
            <a href="https://www.z-anatomy.com/" target="_blank" rel="noopener noreferrer">Z-Anatomy</a>{' '}
            (<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>),
            {' '}via BodyParts3D / DBCLS
          </div>
        </div>
      </div>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className={`am-chev${open ? ' am-chev-open' : ''}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
function RecenterIcon() {
  // Crosshair-in-a-frame: "fit / recenter".
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M9 21H5a2 2 0 0 1-2-2v-4" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
      <path d="M6 6 L18 18 M18 6 L6 18" />
    </svg>
  );
}
