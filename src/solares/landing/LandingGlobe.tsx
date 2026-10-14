import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CITIES, dotGeometry, latLon } from './landingGeometry';

export type IntroState = 'pending' | 'playing' | 'done';
export type ShieldTag = { readonly index: string; readonly name: string };
type Props = {
  animated: boolean;
  /** 0 Overview, 1 Protection (layer focus), 2 Networks (arcs emphasised). */
  chapter: number;
  /** Layer whose ring is highlighted, or -1. */
  focus: number;
  intro: IntroState;
  tags: readonly ShieldTag[];
  onSelectLayer?: (index: number) => void;
  onHoverLayer?: (index: number) => void;
  onIntro?: (state: IntroState) => void;
};
/** Where the globe sits in the host, read from CSS custom properties so media queries own the composition. */
export type GlobeFrame = { width: number; height: number; cx: number; cy: number; radius: number; tagAngle: number; safeTop: number; safeBottom: number; safeSide: number };

export const GLOBE_STILL = '/antara/planet/landing-globe-still.webp';
export const GLOBE_STILL_ALT = 'ANTARA globe with six protection layers around one vault';
const LABEL = 'Dotted Earth inside six orbital rings, one for each vault protection layer, with illustrative network arcs. Drag or use the arrow keys to turn the globe; keys 1 to 6 select a layer.';
const FOV = 26;
const D2R = Math.PI / 180;
const TILT = .32;

/*
 * The six layer rings, innermost first (01 Biometrics … 06 Limits). Each is a thin dashed orbit with one node,
 * tilted on its own axis and turning slowly. Purely illustrative: a ring is not a live protection state.
 */
const RINGS = [
  { radius: 1.17, tiltX: 74, tiltZ: 16, node: .4, speed: .05 },
  { radius: 1.25, tiltX: 58, tiltZ: -34, node: 2.2, speed: -.04 },
  { radius: 1.33, tiltX: 86, tiltZ: 52, node: 4.1, speed: .032 },
  { radius: 1.41, tiltX: 46, tiltZ: -64, node: 1.1, speed: -.026 },
  { radius: 1.49, tiltX: 98, tiltZ: 6, node: 5.3, speed: .021 },
  { radius: 1.57, tiltX: 64, tiltZ: 38, node: 3.2, speed: -.017 },
] as const;
const ROUTES: ReadonlyArray<readonly [number, number]> = [[0, 5], [5, 10], [3, 8], [7, 0], [6, 9], [11, 12], [13, 14], [2, 3], [10, 11], [15, 9], [1, 14], [4, 15]];
const INTRO = { globe: 1.1, ringStart: .45, ringStep: .14, ringDuration: .8, arcs: 1.6, end: 2.6 };

function cssNumber(style: CSSStyleDeclaration, name: string, fallback: number) {
  const value = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}
export function readFrame(element: HTMLElement): GlobeFrame | null {
  const { width, height } = element.getBoundingClientRect();
  if (width < 2 || height < 2) return null;
  const style = getComputedStyle(element);
  return {
    width, height,
    radius: Math.min(height * cssNumber(style, '--globe-rh', .36), width * cssNumber(style, '--globe-rw', .26)),
    cx: width * cssNumber(style, '--globe-x', .7), cy: height * cssNumber(style, '--globe-y', .48),
    tagAngle: cssNumber(style, '--tag-angle', 140),
    safeTop: cssNumber(style, '--tag-top', 70), safeBottom: cssNumber(style, '--tag-bottom', 140), safeSide: cssNumber(style, '--tag-side', 40),
  };
}
const smooth = (a: number, b: number, x: number) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const DOTS_VERTEX = /* glsl */`
  attribute float aLand; attribute float aRand; attribute float aCity;
  uniform float uSize; uniform float uPixelRatio; uniform float uTime;
  varying float vAlpha; varying float vLight;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * position);
    float facing = clamp(n.z, 0.0, 1.0);
    float sun = clamp(dot(n, normalize(vec3(-.55, .45, .7))), 0.0, 1.0);
    float twinkle = aCity > 0.0 ? .7 + .3 * sin(uTime * 1.6 + aRand * 40.0) : 1.0;
    vLight = aLand > .5 ? .32 + .55 * sun + .6 * aCity * twinkle : .25;
    vAlpha = (aLand > .5 ? .9 : .16) * smoothstep(.02, .38, facing);
    gl_PointSize = uSize * uPixelRatio * (aLand > .5 ? .85 + .3 * aRand + .5 * aCity : .7);
    gl_Position = projectionMatrix * mv;
  }`;
const DOTS_FRAGMENT = /* glsl */`
  uniform float uFade; varying float vAlpha; varying float vLight;
  void main() {
    float d = length(gl_PointCoord - .5);
    float a = smoothstep(.5, .18, d) * vAlpha * uFade;
    if (a < .01) discard;
    vec3 color = mix(vec3(.36, .47, .66), vec3(.86, .93, 1.0), clamp(vLight, 0.0, 1.0));
    gl_FragColor = vec4(color * a, a);
  }`;
const ATMOS_VERTEX = /* glsl */`
  varying vec3 vNormal;
  void main() { vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ATMOS_FRAGMENT = /* glsl */`
  uniform float uFade; varying vec3 vNormal;
  void main() {
    float rim = pow(clamp(.64 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 4.2);
    vec3 color = vec3(.42, .6, 1.0) * rim * .7 * uFade;
    gl_FragColor = vec4(color, rim * uFade);
  }`;
const LINE_VERTEX = /* glsl */`
  attribute float aT; varying float vT;
  void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FRAGMENT = /* glsl */`
  uniform float uReveal; uniform float uLevel; uniform float uTime; uniform float uSpeed; varying float vT;
  void main() {
    if (vT > uReveal) discard;
    float dash = step(.42, fract(vT * 180.0));
    float sweep = pow(fract(vT - uTime * uSpeed * .35), 18.0);
    float a = (.3 + .26 * dash + .85 * sweep) * uLevel;
    vec3 color = mix(vec3(.45, .6, .9), vec3(.82, .9, 1.0), sweep);
    gl_FragColor = vec4(color * a, a);
  }`;
const ARC_FRAGMENT = /* glsl */`
  uniform float uHead; uniform float uLevel; varying float vT;
  void main() {
    float behind = uHead - vT;
    float tail = behind >= 0.0 ? pow(clamp(1.0 - behind / .32, 0.0, 1.0), 2.2) : 0.0;
    float head = smoothstep(.035, 0.0, abs(behind));
    float a = (.05 + .75 * tail + .9 * head) * uLevel;
    vec3 color = mix(vec3(.4, .58, 1.0), vec3(.92, .96, 1.0), clamp(tail * .6 + head, 0.0, 1.0));
    gl_FragColor = vec4(color * a, a);
  }`;
const NODE_VERTEX = /* glsl */`
  uniform float uSize; uniform float uPixelRatio;
  void main() { gl_PointSize = uSize * uPixelRatio; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const NODE_FRAGMENT = /* glsl */`
  uniform float uLevel;
  void main() {
    float d = length(gl_PointCoord - .5);
    float core = smoothstep(.16, .08, d), halo = smoothstep(.5, .1, d) * .35;
    float a = (core + halo) * uLevel;
    if (a < .01) discard;
    gl_FragColor = vec4(vec3(.86, .93, 1.0) * a, a);
  }`;

function lineGeometry(points: THREE.Vector3[]) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  geometry.setAttribute('aT', new THREE.Float32BufferAttribute(points.map((_, index) => index / (points.length - 1)), 1));
  return geometry;
}
function arcPoints(from: THREE.Vector3, to: THREE.Vector3) {
  const angle = from.angleTo(to), lift = .06 + .22 * angle / Math.PI, points: THREE.Vector3[] = [];
  for (let step = 0; step <= 72; step++) {
    const t = step / 72, s = Math.sin(angle);
    const a = Math.sin((1 - t) * angle) / s, b = Math.sin(t * angle) / s;
    points.push(from.clone().multiplyScalar(a).add(to.clone().multiplyScalar(b)).normalize().multiplyScalar(1.003 + lift * Math.sin(Math.PI * t)));
  }
  return points;
}

type Scene = { resize: (frame: GlobeFrame) => void; redraw: () => void; dispose: () => void };

function createScene(container: HTMLDivElement, props: { current: Props }, tags: ReadonlyArray<HTMLElement | null>, onLost: () => void, mask: ImageData): Scene {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = 'landing-globe-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', LABEL);
  container.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, .1, 100);
  const pixelRatio = { value: Math.min(window.devicePixelRatio || 1, 2) };
  const time = { value: 0 }, fade = { value: 1 };

  const world = new THREE.Group();
  world.rotation.x = TILT;
  scene.add(world);
  const spin = new THREE.Group();
  world.add(spin);

  // A dark core writes depth so dots, arcs and ring segments behind the globe stay hidden.
  const core = new THREE.Mesh(new THREE.SphereGeometry(.994, 96, 64), new THREE.MeshBasicMaterial({ color: 0x03050a }));
  spin.add(core);
  const { geometry: dots, count: dotCount } = dotGeometry(mask, 1.05);
  canvas.dataset.geometry = 'dotted-earth'; canvas.dataset.dots = String(dotCount); canvas.dataset.rings = String(RINGS.length);
  spin.add(new THREE.Points(dots, new THREE.ShaderMaterial({
    vertexShader: DOTS_VERTEX, fragmentShader: DOTS_FRAGMENT, transparent: true, depthWrite: false,
    uniforms: { uSize: { value: 2.1 }, uPixelRatio: pixelRatio, uTime: time, uFade: fade },
  })));
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.055, 96, 64), new THREE.ShaderMaterial({
    vertexShader: ATMOS_VERTEX, fragmentShader: ATMOS_FRAGMENT, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uFade: fade },
  }));
  world.add(atmosphere);
  // A soft deep-blue halo behind the globe for depth; additive, faint, never a hard edge.
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6), new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform float uFade; varying vec2 vUv; void main(){ float d = length(vUv - .5) * 2.0; float a = smoothstep(1.0, .42, d) * .2 * uFade; gl_FragColor = vec4(vec3(.16, .3, .75) * a, a); }',
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, uniforms: { uFade: fade },
  }));
  halo.position.z = -1.6; halo.renderOrder = -1;
  scene.add(halo);

  const arcs = ROUTES.map(([a, b], index) => {
    const from = latLon(CITIES[a][0], CITIES[a][1]), to = latLon(CITIES[b][0], CITIES[b][1]);
    const material = new THREE.ShaderMaterial({
      vertexShader: LINE_VERTEX, fragmentShader: ARC_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uHead: { value: -1 }, uLevel: { value: 0 } },
    });
    spin.add(new THREE.Line(lineGeometry(arcPoints(from, to)), material));
    return { material, offset: index * .83, period: 5.2 + (index % 4) * .9 };
  });

  const rings = RINGS.map(spec => {
    const holder = new THREE.Group();
    holder.rotation.set(spec.tiltX * D2R, 0, spec.tiltZ * D2R);
    const turn = new THREE.Group();
    holder.add(turn);
    const points: THREE.Vector3[] = [];
    for (let step = 0; step <= 360; step++) { const angle = step / 360 * Math.PI * 2; points.push(new THREE.Vector3(Math.cos(angle) * spec.radius, 0, Math.sin(angle) * spec.radius)); }
    const material = new THREE.ShaderMaterial({
      vertexShader: LINE_VERTEX, fragmentShader: RING_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uReveal: { value: 1 }, uLevel: { value: 1 }, uTime: time, uSpeed: { value: spec.speed } },
    });
    turn.add(new THREE.Line(lineGeometry(points), material));
    const node = new THREE.Vector3(Math.cos(spec.node) * spec.radius, 0, Math.sin(spec.node) * spec.radius);
    const nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: NODE_VERTEX, fragmentShader: NODE_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uSize: { value: 16 }, uPixelRatio: pixelRatio, uLevel: { value: 1 } },
    });
    turn.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints([node]), nodeMaterial));
    world.add(holder);
    return { spec, turn, node, material, nodeMaterial, level: 1 };
  });

  let frame: GlobeFrame | null = null;
  let manualX = 0, manualY = 0, drag: { x: number; y: number; mx: number; my: number } | null = null;
  let raf = 0, last = 0, alive = true, inView = true, elapsed = 0;
  let introT = props.current.intro === 'pending' && props.current.animated ? 0 : -1;
  if (introT === 0) props.current.onIntro?.('playing');
  const finishIntro = () => { if (introT < 0) return; introT = -1; props.current.onIntro?.('done'); };
  if (introT < 0 && props.current.intro !== 'done') props.current.onIntro?.('done');
  const projected = new THREE.Vector3(), worldPos = new THREE.Vector3(), cameraSpace = new THREE.Vector3();

  function placeTags() {
    if (!frame) return;
    rings.forEach((ring, index) => {
      const element = tags[index];
      if (!element) return;
      ring.turn.localToWorld(worldPos.copy(ring.node));
      cameraSpace.copy(worldPos).applyMatrix4(camera.matrixWorldInverse);
      projected.copy(worldPos).project(camera);
      const x = (projected.x + 1) / 2 * frame!.width, y = (1 - projected.y) / 2 * frame!.height;
      // Hidden when the node passes behind the globe, or would leave the safe area.
      const behind = worldPos.z < 0 && Math.hypot(worldPos.x, worldPos.y) < 1.02;
      const inside = x > frame!.safeSide && x < frame!.width - frame!.safeSide && y > frame!.safeTop && y < frame!.height - frame!.safeBottom;
      element.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      element.dataset.side = x < frame!.cx ? 'left' : 'right';
      element.dataset.visible = String(inside && !behind);
      element.dataset.x = x.toFixed(1); element.dataset.y = y.toFixed(1);
    });
  }

  function render(dt: number) {
    const { animated, focus, chapter } = props.current;
    if (animated) elapsed += dt;
    time.value = animated ? elapsed : 4.2;
    if (introT >= 0) {
      if (!animated || props.current.intro === 'done') finishIntro();
      else { introT += dt; if (introT >= INTRO.end) finishIntro(); }
    }
    const intro = introT >= 0 ? introT : 99;
    fade.value = smooth(0, INTRO.globe, intro);
    const scale = .94 + .06 * smooth(0, INTRO.globe, intro);
    world.scale.setScalar(scale);
    spin.rotation.y = -1.25 + (animated ? elapsed * .045 : 0) + manualY;
    world.rotation.x = TILT + manualX;
    const ringBase = chapter === 1 ? 1.25 : chapter === 2 ? .55 : 1;
    rings.forEach((ring, index) => {
      ring.turn.rotation.y = (animated ? elapsed : 4.2) * ring.spec.speed + ring.spec.node * 0;
      const target = focus < 0 ? ringBase : focus === index ? 1.9 : .3;
      ring.level += (target - ring.level) * Math.min(1, dt * 6 || 1);
      ring.material.uniforms.uLevel.value = ring.level;
      ring.nodeMaterial.uniforms.uLevel.value = Math.min(1.4, ring.level * (focus === index ? 1.2 : .9));
      ring.material.uniforms.uReveal.value = smooth(INTRO.ringStart + index * INTRO.ringStep, INTRO.ringStart + index * INTRO.ringStep + INTRO.ringDuration, intro);
    });
    const arcLevel = (chapter === 2 ? 1.7 : chapter === 1 ? .55 : 1.25) * smooth(INTRO.arcs, INTRO.arcs + .6, intro);
    arcs.forEach(arc => {
      const t = ((animated ? elapsed : 3.1) + arc.offset) / arc.period;
      arc.material.uniforms.uHead.value = (t - Math.floor(t)) * 1.5 - .1;
      arc.material.uniforms.uLevel.value = arcLevel;
    });
    renderer.render(scene, camera);
    placeTags();
  }

  function loop(now: number) {
    raf = 0;
    if (!alive) return;
    const dt = last ? Math.min((now - last) / 1000, .05) : 0;
    last = now;
    render(dt);
    if (props.current.animated && inView && !document.hidden) raf = requestAnimationFrame(loop);
  }
  function redraw() { if (!alive || raf) return; last = 0; raf = requestAnimationFrame(loop); }

  function resize(next: GlobeFrame) {
    frame = next;
    renderer.setPixelRatio(pixelRatio.value);
    renderer.setSize(next.width, next.height, false);
    canvas.style.width = `${next.width}px`; canvas.style.height = `${next.height}px`;
    camera.aspect = next.width / next.height;
    const distance = 1 / Math.sin(Math.atan(next.radius * Math.tan(FOV * D2R / 2) / (next.height / 2)));
    camera.position.set(0, 0, distance);
    camera.setViewOffset(next.width, next.height, next.width / 2 - next.cx, next.height / 2 - next.cy, next.width, next.height);
    camera.updateProjectionMatrix();
    redraw();
  }

  const publishPose = () => { canvas.dataset.pose = `${manualX.toFixed(2)},${manualY.toFixed(2)}`; };
  publishPose();
  // A short click near a ring's node selects that layer (the same as its button below the hero).
  const pickNode = (clientX: number, clientY: number) => {
    const box = canvas.getBoundingClientRect();
    let best = -1, bestDistance = 24;
    tags.forEach((element, index) => {
      if (!element || element.dataset.visible !== 'true') return;
      const distance = Math.hypot(clientX - box.left - Number(element.dataset.x), clientY - box.top - Number(element.dataset.y));
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    });
    if (best >= 0) props.current.onSelectLayer?.(best);
  };
  const pointerDown = (event: PointerEvent) => { drag = { x: event.clientX, y: event.clientY, mx: manualX, my: manualY }; canvas.setPointerCapture(event.pointerId); canvas.style.cursor = 'grabbing'; };
  const pointerMove = (event: PointerEvent) => {
    if (!drag) return;
    manualY = drag.my + (event.clientX - drag.x) * .006;
    manualX = THREE.MathUtils.clamp(drag.mx + (event.clientY - drag.y) * .004, -.45, .45);
    publishPose(); redraw();
  };
  const pointerUp = (event: PointerEvent) => {
    if (drag && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) pickNode(event.clientX, event.clientY);
    drag = null; canvas.style.cursor = '';
  };
  const pointerCancel = () => { drag = null; canvas.style.cursor = ''; };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') manualY -= .25;
    else if (event.key === 'ArrowRight') manualY += .25;
    else if (event.key === 'ArrowUp') manualX = Math.max(-.45, manualX - .1);
    else if (event.key === 'ArrowDown') manualX = Math.min(.45, manualX + .1);
    else if (event.key === 'Home') { manualX = 0; manualY = 0; }
    else if (/^[1-6]$/.test(event.key)) { event.preventDefault(); props.current.onSelectLayer?.(Number(event.key) - 1); return; }
    else return;
    event.preventDefault(); publishPose(); redraw();
  };
  const visibility = () => { last = 0; if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else redraw(); };
  const contextLost = (event: Event) => { event.preventDefault(); alive = false; cancelAnimationFrame(raf); raf = 0; onLost(); };
  const observer = new IntersectionObserver(entries => { inView = entries.some(entry => entry.isIntersecting); redraw(); });
  observer.observe(container);
  canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerCancel);
  canvas.addEventListener('keydown', keyboard); canvas.addEventListener('webglcontextlost', contextLost);
  document.addEventListener('visibilitychange', visibility);

  return {
    resize, redraw,
    dispose: () => {
      alive = false; cancelAnimationFrame(raf); observer.disconnect();
      canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp); canvas.removeEventListener('pointercancel', pointerCancel);
      canvas.removeEventListener('keydown', keyboard); canvas.removeEventListener('webglcontextlost', contextLost);
      document.removeEventListener('visibilitychange', visibility);
      scene.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
          object.geometry.dispose();
          (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => material.dispose());
        }
      });
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    },
  };
}

function loadMask(): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) { reject(new Error('No 2D context')); return; }
      context.drawImage(image, 0, 0);
      resolve(context.getImageData(0, 0, canvas.width, canvas.height));
    };
    image.onerror = () => reject(new Error('Land mask unavailable'));
    image.src = '/antara/planet/land-mask.png';
  });
}

/** The landing hero: a dotted Earth inside six thin orbital rings, one per vault layer, with illustrative network arcs. */
export default function LandingGlobe(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const scene = useRef<Scene | null>(null);
  const tagElements = useRef<Array<HTMLSpanElement | null>>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading');
  current.current = props;
  useEffect(() => { scene.current?.redraw(); }, [props.animated, props.focus, props.chapter, props.intro]);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let disposed = false;
    const layout = () => { const frame = readFrame(container); if (frame && scene.current) scene.current.resize(frame); };
    const observer = new ResizeObserver(layout); observer.observe(container);
    const fail = () => {
      if (disposed) return;
      setStatus('fallback');
      tagElements.current.forEach(tag => { if (tag) tag.dataset.visible = 'false'; });
      if (current.current.intro !== 'done') current.current.onIntro?.('done');
    };
    loadMask().then(mask => {
      if (disposed) return;
      try {
        scene.current = createScene(container, current, tagElements.current, () => { const lost = scene.current; scene.current = null; lost?.dispose(); fail(); }, mask);
      } catch { fail(); return; }
      layout(); setStatus('ready');
    }, fail);
    return () => { disposed = true; observer.disconnect(); scene.current?.dispose(); scene.current = null; };
  }, []);
  // Chapters move the globe through CSS; re-read the composition after the attribute lands.
  useEffect(() => { const container = host.current; const frame = container && readFrame(container); if (frame) scene.current?.resize(frame); }, [props.chapter]);

  return <div className="landing-globe" ref={host} data-renderer={status}>
    {status !== 'ready' && <img className="landing-globe-still" src={GLOBE_STILL} alt={GLOBE_STILL_ALT} onError={event => { event.currentTarget.hidden = true; }} />}
    <div className="landing-tags" aria-hidden="true">
      {props.tags.map((tag, index) => <span className="landing-tag" key={tag.index} ref={element => { tagElements.current[index] = element; }} data-on={props.focus === index} data-deployed={props.intro === 'done' ? 'true' : 'false'} data-visible="false">
        <i /><span className="landing-tag-label"><b>{tag.index}</b><span>{tag.name}</span></span>
      </span>)}
    </div>
  </div>;
}
