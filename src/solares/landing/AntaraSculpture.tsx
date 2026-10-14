import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export type NodePosition = { x: number; y: number; visible: boolean };
/** One station's state on the vault planet (docs/UI_ARGUS_PARITY.md 7.1). Mapped from server answers in verification/stationState.ts. */
export type StationVisual = 'unknown' | 'off' | 'on' | 'required' | 'collecting' | 'collected' | 'checking' | 'passed' | 'failed' | 'pending-removal';
type Props = {
  animated: boolean;
  layer: number;
  onSelectLayer?: (index: number) => void;
  onNodePositions?: (positions: NodePosition[]) => void;
  /** Length 6, landing order. When present it overrides the single `layer` highlight. */
  stations?: readonly StationVisual[];
  /** 'landing' (default) keeps rocks, stars and camera; 'vault' hides rocks, dims stars, frames tighter. */
  variant?: 'landing' | 'vault';
  /** Accessible name for the canvas in the vault variant. */
  label?: string;
};

/**
 * Station materials by visual (7.1). Colour is the material colour and its emissive; `core` tints the
 * station's small centre light. A pulse runs only while animated. `failed` is the only non-blue colour.
 */
const STATION_STYLE: Record<StationVisual, { color: number; intensity: number; core: number; pulse?: { amplitude: number; hz: number } }> = {
  unknown: { color: 0x2a3442, intensity: .25, core: 0x2c3540 },
  off: { color: 0x2a3442, intensity: .35, core: 0x3a4452 },
  on: { color: 0x4488d1, intensity: 1.15, core: 0xc1e5ff },
  'pending-removal': { color: 0x4488d1, intensity: .7, core: 0x8aa6c4 },
  required: { color: 0x4488d1, intensity: 1.6, core: 0xc1e5ff, pulse: { amplitude: .25, hz: .8 } },
  collecting: { color: 0x8fbaf0, intensity: 2.6, core: 0xe2f1ff, pulse: { amplitude: .35, hz: 2 } },
  collected: { color: 0x8fbaf0, intensity: 2, core: 0xe2f1ff },
  checking: { color: 0x8fbaf0, intensity: 2, core: 0xe2f1ff },
  passed: { color: 0xc4e5ff, intensity: 3.5, core: 0xf2faff },
  failed: { color: 0xd98a5a, intensity: 2.2, core: 0xf0c2a2 },
};
const VAULT_LABEL = 'ANTARA vault planet with six protection stations. Station status is listed below.';

/** The wallet is the planet. The six physical gate stations represent its layers. */
export default function AntaraSculpture(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const redraw = useRef<() => void>(() => {});
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading');
  current.current = props;
  const stationsKey = props.stations ? props.stations.join(',') : '';
  useEffect(() => { redraw.current(); }, [props.animated, props.layer, stationsKey]);

  useEffect(() => {
    const createScene = () => {
      const container = host.current;
      if (!container) return;
      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
      } catch { setStatus('fallback'); return; }
      let alive = true, frame = 0, elapsed = 0, lastTime = 0;
      // Fixed for the scene's lifetime: the vault planet never turns into the landing planet.
      const isVault = current.current.variant === 'vault';
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, .1, 100);
      camera.position.set(0, .12, 10);
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = .95;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const canvas = renderer.domElement;
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', isVault ? current.current.label || VAULT_LABEL : 'Slowly rotating obsidian Earth surrounded by six protection stations. Drag or use arrow keys to rotate the Earth. Home resets the view.');
      canvas.dataset.geometry = 'obsidian-earth';
      if (isVault) { canvas.dataset.variant = 'vault'; canvas.dataset.motion = 'still'; }
      container.appendChild(canvas);
      const environment = new RoomEnvironment();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTarget = pmrem.fromScene(environment, .04, .1, 100, { size: 128 });
      scene.environment = envTarget.texture;
      environment.dispose(); pmrem.dispose();
      scene.add(new THREE.HemisphereLight(0xb4c7df, 0x030405, .75));
      const key = new THREE.DirectionalLight(0xe5edff, 2.8);
      key.position.set(-3, 5, 4); scene.add(key);
      const rim = new THREE.DirectionalLight(0x488aff, 5.5);
      rim.position.set(3, .6, -3); scene.add(rim);
      const fill = new THREE.DirectionalLight(0x95b8eb, .9);
      fill.position.set(-3, -2, 1); scene.add(fill);

      const world = new THREE.Group(); scene.add(world);
      const earth = new THREE.Group(); world.add(earth);
      earth.rotation.z = -.12;
      const earthMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xb8bec8, metalness: .15, roughness: .88,
        clearcoat: 0, envMapIntensity: .22,
        // Black until the texture arrives: without its emissive map the white emissive lit the whole sphere (a white flash).
        emissive: 0x000000, emissiveIntensity: 1.4, bumpScale: .048,
      });
      earthMaterial.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
          #ifdef USE_EMISSIVEMAP
            vec3 coast = texture2D(emissiveMap, vEmissiveMapUv).rgb;
            float blueEdge = smoothstep(0.025, 0.22, coast.b - max(coast.r, coast.g * 0.75));
            totalEmissiveRadiance *= coast * blueEdge;
          #endif
        `);
      };
      const globe = new THREE.Mesh(new THREE.SphereGeometry(1.79, 96, 64), earthMaterial);
      globe.rotation.y = -.65;
      earth.add(globe);
      const textures: THREE.Texture[] = [];
      new THREE.TextureLoader().load('/antara/planet/earth-obsidian.png', texture => {
        if (!alive) { texture.dispose(); return; }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
        textures.push(texture);
        earthMaterial.map = texture;
        earthMaterial.bumpMap = texture;
        earthMaterial.emissiveMap = texture;
        earthMaterial.emissive.set(0xffffff);
        earthMaterial.needsUpdate = true;
        rockMaterial.bumpMap = texture; rockMaterial.bumpScale = .035; rockMaterial.needsUpdate = true;
        requestRender();
      }, undefined, () => { /* The sculpted sphere remains available offline. */ });
      // A restrained, view-dependent atmospheric edge; no wireframe overlay.
      const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.82, 64, 48), new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { glowColor: { value: new THREE.Color(0x397fd0) } },
        vertexShader: 'varying vec3 n; varying vec3 v; void main(){vec4 p=modelViewMatrix*vec4(position,1.0); n=normalize(normalMatrix*normal); v=normalize(-p.xyz); gl_Position=projectionMatrix*p;}',
        fragmentShader: 'varying vec3 n; varying vec3 v; uniform vec3 glowColor; void main(){float f=pow(1.0-max(dot(normalize(n),normalize(v)),0.0),4.0); gl_FragColor=vec4(glowColor,f*.48);}',
      }));
      world.add(atmosphere);

      const gate = new THREE.Group();
      gate.rotation.set(-.92, .04, -.17);
      world.add(gate);
      const metal = new THREE.MeshStandardMaterial({ color: 0x69717c, metalness: .8, roughness: .46, envMapIntensity: .9 });
      const darkMetal = new THREE.MeshStandardMaterial({ color: 0x161b23, metalness: .85, roughness: .44 });
      const blue = new THREE.MeshBasicMaterial({ color: 0x438bf8, toneMapped: false });
      const pale = new THREE.MeshBasicMaterial({ color: 0xc1e5ff, toneMapped: false });
      const torus = (radius: number, tube: number, material: THREE.Material, z = 0) => {
        const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 160), material);
        mesh.position.z = z; gate.add(mesh); return mesh;
      };
      const annulus = new THREE.Shape();
      annulus.absarc(0, 0, 2.58, 0, Math.PI * 2, false);
      const aperture = new THREE.Path();
      aperture.absarc(0, 0, 2.38, 0, Math.PI * 2, true);
      annulus.holes.push(aperture);
      const gateBody = new THREE.Mesh(new THREE.ExtrudeGeometry(annulus, {
        depth: .12, bevelEnabled: true, bevelSegments: 2, bevelSize: .012,
        bevelThickness: .01, curveSegments: 96, steps: 1,
      }), darkMetal);
      gateBody.position.z = -.07; gate.add(gateBody);
      torus(2.38, .024, metal, .025);
      torus(2.58, .037, metal, .025);
      torus(2.38, .014, metal, -.067);
      torus(2.58, .016, metal, -.067);
      const bandMesh = torus(2.51, .009, blue, .073);
      // Vault only: the band's own colour, and an indeterminate shimmer (no fraction) while ANTARA checks.
      const band = isVault ? blue.clone() : blue;
      bandMesh.material = band;
      let shimmer: THREE.Mesh | null = null;
      if (isVault) {
        shimmer = new THREE.Mesh(new THREE.TorusGeometry(2.51, .022, 8, 48, .6),
          new THREE.MeshBasicMaterial({ color: 0xc4e5ff, toneMapped: false, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false }));
        shimmer.position.z = .08; shimmer.visible = false;
        gate.add(shimmer);
      }
      const panelGeometry = new THREE.BoxGeometry(.12, .145, .014);
      const ribGeometry = new THREE.BoxGeometry(.018, .19, .018);
      const rivetGeometry = new THREE.SphereGeometry(.014, 5, 4);
      for (let i = 0; i < 100; i++) {
        const angle = i / 100 * Math.PI * 2;
        const panel = new THREE.Mesh(panelGeometry, i % 8 === 0 ? metal : darkMetal);
        panel.position.set(Math.cos(angle) * 2.48, Math.sin(angle) * 2.48, .04);
        panel.rotation.z = angle - Math.PI / 2;
        gate.add(panel);
        const rib = new THREE.Mesh(ribGeometry, darkMetal);
        rib.position.copy(panel.position); rib.position.z = .075;
        rib.rotation.z = panel.rotation.z; gate.add(rib);
        if (i % 5 === 0) {
          const rivet = new THREE.Mesh(rivetGeometry, metal);
          rivet.position.set(Math.cos(angle) * 2.56, Math.sin(angle) * 2.56, .089);
          gate.add(rivet);
        }
      }
      const nodeAngles = [2.45, .65, 3.12, -.05, 5.35, 4.05];
      const nodeMaterials: THREE.MeshStandardMaterial[] = [];
      const coreMaterials: THREE.MeshBasicMaterial[] = [];
      const nodeTargets: THREE.Object3D[] = [];
      const nodeHits: THREE.Object3D[] = [];
      nodeAngles.forEach((angle, index) => {
        const station = new THREE.Group();
        station.position.set(Math.cos(angle) * 2.49, Math.sin(angle) * 2.49, .075);
        gate.add(station);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(.205, .245, .145, 32), metal);
        base.rotation.x = Math.PI / 2;
        station.add(base);
        const housing = new THREE.Mesh(new THREE.CylinderGeometry(.173, .2, .048, 32), darkMetal);
        housing.rotation.x = Math.PI / 2; housing.position.z = .091;
        station.add(housing);
        const glowMaterial = new THREE.MeshStandardMaterial({ color: 0x4c9aff, emissive: 0x3987ff, emissiveIntensity: 2, metalness: .4, roughness: .22 });
        nodeMaterials.push(glowMaterial);
        const halo = new THREE.Mesh(new THREE.TorusGeometry(.143, .016, 8, 40), glowMaterial);
        halo.position.z = .124; station.add(halo);
        // The vault planet tints each station's centre light by its state; the landing keeps one shared material.
        const coreMaterial = isVault ? pale.clone() : pale;
        coreMaterials.push(coreMaterial);
        const core = new THREE.Mesh(new THREE.SphereGeometry(.052, 16, 12), coreMaterial);
        core.scale.z = .35; core.position.z = .137;
        station.add(core);
        for (let bolt = 0; bolt < 4; bolt++) {
          const a = bolt * Math.PI / 2 + Math.PI / 4;
          const screw = new THREE.Mesh(rivetGeometry, metal);
          screw.position.set(Math.cos(a) * .185, Math.sin(a) * .185, .115);
          station.add(screw);
        }
        const target = new THREE.Object3D(); target.position.z = .15; station.add(target);
        nodeTargets.push(target);
        base.userData.layer = index; nodeHits.push(base);
      });

      // Deterministic irregular rocks, grouped at the lower edges of the frame.
      const rocks: { mesh: THREE.Mesh; y: number; phase: number }[] = [];
      const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x070a10, roughness: .78, metalness: .38, envMapIntensity: .18, flatShading: false });
      for (let i = 0; i < 25; i++) {
        const geometry = new THREE.IcosahedronGeometry(1, 2);
        const positions = geometry.getAttribute('position');
        for (let j = 0; j < positions.count; j++) {
          const x = positions.getX(j), y = positions.getY(j), z = positions.getZ(j);
          // Equal positions must get equal displacement: non-indexed triangle
          // corners otherwise split apart into the visible cracks of a mesh.
          const noise = Math.sin(x * 4.3 + i) * Math.cos(y * 5.1 - i) * Math.sin(z * 3.8 + 1.2);
          const scale = 1 + noise * .23 + Math.sin(x * 11 + y * 7 + z * 9) * .055;
          positions.setXYZ(j, x * scale, y * scale, z * scale);
        }
        geometry.deleteAttribute('normal');
        const smoothGeometry = mergeVertices(geometry, .0001);
        smoothGeometry.computeVertexNormals(); geometry.dispose();
        const mesh = new THREE.Mesh(smoothGeometry, rockMaterial);
        const side = i % 2 ? 1 : -1;
        const size = .055 + ((i * 13) % 17) / 17 * .21;
        mesh.scale.set(size * 1.4, size, size * .85);
        mesh.position.set(side * (1.6 + ((i * 7) % 19) / 19 * 2.2), -1.5 - ((i * 11) % 17) / 17 * 1.2, -.2 + (i % 5) * .4);
        mesh.rotation.set(i * 1.7, i * .9, i * .4);
        if (isVault) mesh.visible = false;
        scene.add(mesh); rocks.push({ mesh, y: mesh.position.y, phase: i * 1.67 });
      }
      const starsGeometry = new THREE.BufferGeometry();
      const stars: number[] = [];
      for (let i = 0; i < 340; i++) {
        stars.push(Math.sin(i * 127.1) * 17, Math.sin(i * 311.7) * 9, -5 - (i % 13) * .5);
      }
      starsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
      const starsMaterial = new THREE.PointsMaterial({ color: 0xa6bedb, size: .018, sizeAttenuation: true, transparent: true, opacity: .65, depthWrite: false });
      const starField = new THREE.Points(starsGeometry, starsMaterial); scene.add(starField);
      let manualY = 0, manualX = 0, publishPositions = true;
      let drag: { x: number; y: number; originX: number; originY: number } | null = null;
      const render = (time = 0) => {
        frame = 0;
        if (!alive || document.hidden) return;
        const { animated, layer, stations } = current.current;
        const delta = lastTime ? Math.min((time - lastTime) / 1000, .05) : 0;
        lastTime = time;
        if (animated) elapsed += delta;
        globe.rotation.y = -.65 + manualY + elapsed * .035;
        earth.rotation.x = manualX;
        if (stations) {
          // Per-station state from the server (7.1); the single landing highlight does not apply.
          nodeMaterials.forEach((material, index) => {
            const style = STATION_STYLE[stations[index] ?? 'unknown'] ?? STATION_STYLE.unknown;
            const pulse = animated && style.pulse ? Math.sin(elapsed * Math.PI * 2 * style.pulse.hz) * style.pulse.amplitude : 0;
            material.color.setHex(style.color); material.emissive.setHex(style.color);
            material.emissiveIntensity = style.intensity + pulse;
            if (isVault) coreMaterials[index].color.setHex(style.core);
          });
          const checking = stations.includes('checking');
          // Animated: a constant-speed shimmer along the band. Still: a steady glow.
          if (shimmer) { shimmer.visible = checking && animated; shimmer.rotation.z = -elapsed * 1.1; }
          if (band !== blue) band.color.setHex(checking && !animated ? 0x8fbaf0 : 0x438bf8);
        } else {
          nodeMaterials.forEach((material, index) => {
            material.emissiveIntensity = index === layer ? 3.5 + (animated ? Math.sin(elapsed * 2) * .3 : 0) : 1.15;
            material.color.setHex(index === layer ? 0xc4e5ff : 0x4488d1);
          });
        }
        rocks.forEach(({ mesh, y, phase }, index) => {
          mesh.position.y = y + Math.sin(elapsed * .42 + phase) * .085;
          mesh.rotation.z = index * .4 + Math.sin(elapsed * .16 + phase) * .09;
        });
        starField.rotation.z = elapsed * .0015;
        starsMaterial.opacity = (.6 + Math.sin(elapsed * .4) * .1) * (isVault ? .45 : 1);
        canvas.dataset.rotation = globe.rotation.y.toFixed(4);
        if (isVault) canvas.dataset.motion = animated ? 'running' : 'still';
        renderer.render(scene, camera);
        if (publishPositions) {
          publishPositions = false;
          current.current.onNodePositions?.(nodeTargets.map(node => {
            const point = node.getWorldPosition(new THREE.Vector3()).project(camera);
            return { x: (point.x + 1) / 2, y: (1 - point.y) / 2, visible: point.z > -1 && point.z < 1 };
          }));
        }
        if (animated) frame = requestAnimationFrame(render);
      };
      function requestRender() { if (alive && !frame) frame = requestAnimationFrame(render); }
      redraw.current = requestRender;
      const resize = () => {
        const { width, height } = container.getBoundingClientRect();
        if (width < 1 || height < 1) return;
        camera.aspect = width / height;
        // The vault planet keeps the whole ring in frame at any stage shape (no rocks, no headline space); the landing keeps its framing.
        camera.position.z = isVault ? Math.max(9.4, 8.9 / camera.aspect) : Math.max(8.3, 6.3 / camera.aspect);
        camera.updateProjectionMatrix(); renderer.setSize(width, height);
        publishPositions = true; requestRender();
      };
      const observer = new ResizeObserver(resize); observer.observe(container); resize();
      const publishPose = () => { canvas.dataset.pose = `${manualX.toFixed(2)},${manualY.toFixed(2)}`; requestRender(); };
      const pointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        drag = { x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY };
        canvas.setPointerCapture(event.pointerId); canvas.classList.add('is-dragging');
      };
      const pointerMove = (event: PointerEvent) => {
        if (!drag) return;
        manualY += (event.clientX - drag.x) * .007;
        manualX = THREE.MathUtils.clamp(manualX + (event.clientY - drag.y) * .005, -.5, .5);
        drag.x = event.clientX; drag.y = event.clientY; publishPose();
      };
      const pointerUp = (event: PointerEvent) => {
        if (drag && Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) < 6) {
          const bounds = canvas.getBoundingClientRect();
          const ray = new THREE.Raycaster();
          ray.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2), camera);
          const hit = ray.intersectObjects(nodeHits)[0];
          if (hit) current.current.onSelectLayer?.(hit.object.userData.layer as number);
        }
        drag = null; canvas.classList.remove('is-dragging');
      };
      const pointerCancel = () => { drag = null; canvas.classList.remove('is-dragging'); };
      const keyboard = (event: KeyboardEvent) => {
        if (event.key === 'ArrowLeft') manualY -= .25;
        else if (event.key === 'ArrowRight') manualY += .25;
        else if (event.key === 'ArrowUp') manualX = Math.max(-.5, manualX - .1);
        else if (event.key === 'ArrowDown') manualX = Math.min(.5, manualX + .1);
        else if (event.key === 'Home') { manualX = 0; manualY = 0; }
        else return;
        event.preventDefault(); publishPose();
      };
      const visibility = () => {
        lastTime = 0;
        if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
        else requestRender();
      };
      const contextLost = (event: Event) => { event.preventDefault(); alive = false; cancelAnimationFrame(frame); setStatus('fallback'); };
      canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove);
      canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', pointerCancel);
      canvas.addEventListener('keydown', keyboard); canvas.addEventListener('webglcontextlost', contextLost);
      document.addEventListener('visibilitychange', visibility);
      canvas.dataset.pose = '0.00,0.00';
      setStatus('ready');
      return () => {
        alive = false; cancelAnimationFrame(frame); redraw.current = () => {}; observer.disconnect();
        canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove);
        canvas.removeEventListener('pointerup', pointerUp); canvas.removeEventListener('pointercancel', pointerCancel);
        canvas.removeEventListener('keydown', keyboard); canvas.removeEventListener('webglcontextlost', contextLost);
        document.removeEventListener('visibilitychange', visibility);
        const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
        scene.traverse(object => {
          if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
            geometries.add(object.geometry);
            (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
          }
        });
        geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
        textures.forEach(texture => texture.dispose()); envTarget.dispose();
        renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
      };
    };
    let disposeScene: (() => void) | undefined;
    const initialize = requestAnimationFrame(() => { disposeScene = createScene(); });
    return () => { cancelAnimationFrame(initialize); disposeScene?.(); };
  }, []);

  if (props.variant === 'vault') {
    // A still frame of this scene with no text (public/antara/planet/vault-still.webp); the station list carries the states.
    return <div className="landing-sculpture" ref={host} data-renderer={status} data-variant="vault">
      {status !== 'ready' && <img className="landing-emblem-fallback" src="/antara/planet/vault-still.webp" onError={event => { event.currentTarget.hidden = true; }} alt={props.label || VAULT_LABEL} />}
    </div>;
  }
  return <div className="landing-sculpture" ref={host} data-renderer={status}>
    {status !== 'ready' && <img className="landing-emblem-fallback" src="/antara/planet/fallback.png" onError={event => { if (!event.currentTarget.src.endsWith('/antara/emblem.png')) event.currentTarget.src = '/antara/emblem.png'; }} alt="ANTARA vault planet and protection ring" />}
  </div>;
}
