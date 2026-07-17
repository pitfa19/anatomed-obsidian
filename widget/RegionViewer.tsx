import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, useGLTF } from '@react-three/drei';
import type { RegionPart, RegionPayload, RegionSystemMeta } from '../src/shared';
import {
  applyTint,
  computeVisibleUnionBox,
  fitOrthoToBox,
  sanitizeNodeName,
  setVisibleParts,
} from './lib/three-helpers';

interface Props {
  payload: RegionPayload;
  /** Called when the user clicks a structure name (asks Claude about it). */
  onSelect?: (part: RegionPart) => void;
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

export default function RegionViewer({ payload, onSelect }: Props) {
  const systemsById = useMemo(() => {
    const m = new Map<string, RegionSystemMeta>();
    for (const s of payload.systems) m.set(s.id, s);
    return m;
  }, [payload.systems]);

  // Parts grouped by system, in payload order.
  const groups = useMemo(() => {
    const bySys = new Map<string, RegionPart[]>();
    for (const p of payload.parts) {
      const arr = bySys.get(p.system) ?? [];
      arr.push(p);
      bySys.set(p.system, arr);
    }
    return [...bySys.entries()].map(([sysId, parts]) => ({
      system: systemsById.get(sysId)!,
      parts,
    }));
  }, [payload.parts, systemsById]);

  // Visibility: focus parts on by default; context parts on but dimmer.
  const [visible, setVisible] = useState<Set<string>>(
    () => new Set(payload.parts.map((p) => p.id)),
  );
  useEffect(() => {
    setVisible(new Set(payload.parts.map((p) => p.id)));
  }, [payload.parts]);

  const toggle = useCallback((id: string) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setAll = useCallback(
    (on: boolean) => setVisible(on ? new Set(payload.parts.map((p) => p.id)) : new Set()),
    [payload.parts],
  );

  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const onLoaded = useCallback((id: string) => {
    setLoaded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const ready = groups.length > 0 && groups.every((g) => loaded.has(g.system.id));

  const fitKey = useMemo(() => [...visible].sort().join('|'), [visible]);
  const baseUrl = payload.assetBase.replace(/\/+$/, '');

  // Map a GLB node name back to its part, for hover-to-name. Keyed by the
  // sanitized node name (how three exposes it on the mesh / its ancestors).
  const nameByNode = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const p of payload.parts) m.set(sanitizeNodeName(p.id), { id: p.id, name: p.name_en });
    return m;
  }, [payload.parts]);

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

  // On-device scroll diagnostic (triple-tap the legend header). Temporary.
  const [debug, setDebug] = useState(false);

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
        <Suspense fallback={null}>
          {groups.map((g) => (
            <SystemGroup
              key={g.system.id}
              url={`${baseUrl}/${g.system.glb}`}
              tint={g.system.tint}
              systemId={g.system.id}
              parts={g.parts}
              visible={visible}
              onLoaded={onLoaded}
            />
          ))}
        </Suspense>
        <Fit fitKey={`${fitKey}#${refitNonce}`} ready={ready} />
        <PanClamp ready={ready} />
        <CanvasGestureLock />
        <TouchGuard />
        {!coarse && <Hoverer nameByNode={nameByNode} visible={visible} onHover={setHoverName} />}
      </Canvas>

      {!ready && <div className="am-loading">Loading 3D…</div>}

      <button className="am-recenter" onClick={recenter} title="Recenter view" aria-label="Recenter view">
        <RecenterIcon />
      </button>

      {!coarse && hoverName && pointerPos && (
        <div className="am-tooltip" style={{ left: pointerPos.x, top: pointerPos.y }}>
          {hoverName}
        </div>
      )}

      {payload.unmatched.length > 0 && (
        <div className="am-unmatched">Not found: {payload.unmatched.join(', ')}</div>
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
      onDebug={() => setDebug((d) => !d)}
    />

    {debug && <DebugOverlay onClose={() => setDebug(false)} />}
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
  const cloned = useMemo(() => source.clone(true), [source]);

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
  }, [cloned, idsKey, systemId, onLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

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
  onDebug?: () => void;
}

function Legend({ groups, visible, onToggle, onSetAll, onSelect, onDebug }: LegendProps) {
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 560,
  );
  const total = groups.reduce((n, g) => n + g.parts.length, 0);
  const shown = groups.reduce(
    (n, g) => n + g.parts.filter((p) => visible.has(p.id)).length,
    0,
  );

  // iOS won't reliably scroll a list sized only by flex/grid; give the body an
  // explicit measured pixel max-height so it's a definite, scrollable box.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || collapsed) return;
    const legend = body.closest('.am-legend') as HTMLElement | null;
    const viewport = legend?.parentElement;
    if (!legend || !viewport) return;
    const fit = () => {
      const head = (legend.querySelector('.am-legend-head') as HTMLElement | null)?.offsetHeight || 44;
      const actions = (legend.querySelector('.am-legend-actions') as HTMLElement | null)?.offsetHeight || 44;
      const credit = (legend.querySelector('.am-legend-credit') as HTMLElement | null)?.offsetHeight || 0;
      // Base the bound on the VIEWPORT's fixed height (stable), not the legend's
      // animating height — mirrors the CSS cap min(80%, 100% - 1rem) — minus the
      // header + actions + attribution footer. A definite px height is what makes
      // iOS scroll the list.
      const cap = Math.min(viewport.clientHeight * 0.8, viewport.clientHeight - 16);
      const avail = Math.round(cap - head - actions - credit - 10);
      body.style.maxHeight = avail > 96 ? `${avail}px` : '';
    };
    fit();
    // Observe the VIEWPORT (not the legend) so our own body mutations don't
    // re-trigger the observer; catches resize / orientation changes.
    const ro = new ResizeObserver(fit);
    ro.observe(viewport);
    return () => ro.disconnect();
  }, [collapsed, groups]);

  // Triple-tap the header to open the on-device scroll diagnostic.
  const tapsRef = useRef<number[]>([]);
  const onHeadClick = () => {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    tapsRef.current = [...tapsRef.current.filter((t) => now - t < 800), now];
    if (tapsRef.current.length >= 3 && onDebug) {
      tapsRef.current = [];
      setCollapsed(false);
      onDebug();
      return;
    }
    setCollapsed((c) => !c);
  };

  return (
    <div className={`am-legend${collapsed ? ' am-collapsed' : ''}`}>
      <button
        className="am-legend-head"
        onClick={onHeadClick}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand legend' : 'Collapse legend'}
      >
        <ChevronIcon open={!collapsed} />
        <span className="am-legend-title">Legend</span>
        <span className="am-muted">{shown}/{total}</span>
      </button>

      <div className="am-legend-collapse" aria-hidden={collapsed}>
        <div className="am-legend-collapse-inner">
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
                      <button className="am-name" onClick={() => onSelect?.(p)} title="Ask about this structure">
                        <span className="am-name-en">{p.name_en}</span>
                        {p.context && <span className="am-ctx-tag">ctx</span>}
                      </button>
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

/** TEMPORARY on-device scroll diagnostic. Triple-tap the legend header to open.
 *  Reports whether the list is a bounded scroll box (sh>ch) and the touch-action /
 *  backdrop-filter / transform of every ancestor, plus a live touch counter — so a
 *  real iPhone can tell us why the list won't scroll (it scrolls in Chromium). */
function DebugOverlay({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('measuring…');
  const t = useRef({ moves: 0, top: 0, max: 0 });
  useEffect(() => {
    const body = document.querySelector('.am-legend-body') as HTMLElement | null;
    const onMove = () => {
      if (!body) return;
      t.current.moves += 1;
      t.current.top = Math.round(body.scrollTop);
      t.current.max = Math.max(t.current.max, t.current.top);
    };
    body?.addEventListener('touchmove', onMove, { passive: true });
    body?.addEventListener('scroll', onMove, { passive: true });
    const read = () => {
      if (!body) {
        setText('no .am-legend-body in DOM');
        return;
      }
      const cs = getComputedStyle(body);
      const scrollable = body.scrollHeight > body.clientHeight + 1;
      const L: string[] = [];
      // Most important first (never cut off): live scroll + verdict.
      if (body.clientHeight < 24) {
        L.push('⚠ LEGEND IS COLLAPSED — tap the LEGEND pill to expand the list, THEN drag it');
      }
      L.push(`▶ DRAG THE LIST → scrollTop=${Math.round(body.scrollTop)} moves=${t.current.moves} maxTop=${t.current.max}`);
      L.push(`scrollable=${scrollable ? 'YES' : 'NO'}  ch=${body.clientHeight} sh=${body.scrollHeight} maxH=${cs.maxHeight}`);
      L.push(`overflowY=${cs.overflowY} ta=${cs.touchAction} wkScroll=${cs.getPropertyValue('-webkit-overflow-scrolling') || 'n/a'}`);
      let el: HTMLElement | null = body;
      for (let i = 0; el && i < 9; i++) {
        const c = getComputedStyle(el);
        const name = typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : el.tagName;
        const bf = c.getPropertyValue('backdrop-filter') || c.getPropertyValue('-webkit-backdrop-filter');
        const maxH = c.maxHeight === 'none' ? '-' : c.maxHeight;
        L.push(`${name} of=${c.overflow} maxH=${maxH} tf=${c.transform !== 'none' ? 'Y' : 'n'} bf=${bf && bf !== 'none' ? 'Y' : 'n'} ta=${c.touchAction}`);
        if (el.classList?.contains('am-legend')) break;
        el = el.parentElement;
      }
      L.push(`UA ${navigator.userAgent}`);
      setText(L.join('\n'));
    };
    read();
    const id = window.setInterval(read, 350);
    return () => {
      window.clearInterval(id);
      body?.removeEventListener('touchmove', onMove);
      body?.removeEventListener('scroll', onMove);
    };
  }, []);
  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 60, maxHeight: '52%',
        overflow: 'auto', background: 'rgba(0,0,0,0.9)', color: '#3f3',
        font: '11px/1.4 ui-monospace, monospace', padding: '8px 10px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}
    >
      <button
        onClick={onClose}
        style={{ float: 'right', background: '#fff', color: '#000', border: 0, borderRadius: 6, padding: '3px 10px', fontSize: 13, fontFamily: 'sans-serif' }}
      >
        close ✕
      </button>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>scroll diagnostic</div>
      {text}
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
