import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/*
 * Geometry and data for the landing hero. Cities, routes and metro lights are illustrative: they are not live
 * traffic, users or transactions.
 */

const D2R = Math.PI / 180;
export function latLon(lat: number, lon: number, radius = 1) {
  const phi = (90 - lat) * D2R, theta = (lon + 180) * D2R;
  return new THREE.Vector3(-Math.sin(phi) * Math.cos(theta) * radius, Math.cos(phi) * radius, Math.sin(phi) * Math.sin(theta) * radius);
}
export const hash = (n: number) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/** Radii of the six shields, in globe radii, in layer order (01 innermost). */
export const SHELL_RADII = [1.14, 1.225, 1.31, 1.395, 1.48, 1.57] as const;

// Sixteen illustrative arc endpoints.
export const CITIES: ReadonlyArray<readonly [number, number]> = [
  [40.71, -74.0], [37.77, -122.42], [19.43, -99.13], [-23.55, -46.63], [-34.6, -58.38], [51.5, -.13],
  [47.37, 8.54], [38.72, -9.14], [6.52, 3.38], [-1.29, 36.82], [25.2, 55.27], [19.08, 72.88],
  [1.35, 103.82], [22.32, 114.17], [35.68, 139.69], [-26.2, 28.05],
];
const SURFACE_ROUTES: ReadonlyArray<readonly [number, number]> = [
  [0, 5], [5, 10], [3, 8], [7, 0], [6, 9], [0, 1], [7, 3], [10, 11], [8, 15], [2, 0], [5, 8], [9, 10],
  [4, 3], [5, 6], [15, 9], [11, 12], [0, 6], [9, 8], [3, 15], [7, 5], [1, 2], [10, 6], [12, 13], [13, 14],
  [0, 3], [6, 10], [2, 3], [7, 8], [1, 14], [4, 15],
];
/** Signals that leave the surface and terminate on a shield: [city, last shield index]. */
const SHIELD_ROUTES: ReadonlyArray<readonly [number, number]> = [[5, 5], [8, 4], [0, 5], [9, 3], [6, 5], [3, 5]];

// Metro areas for the night-side city lights: [lat, lon, weight].
const METROS: ReadonlyArray<readonly [number, number, number]> = [
  [40.7, -74, 1], [34.05, -118.24, 1], [41.88, -87.63, .8], [37.77, -122.42, .7], [29.76, -95.37, .6], [32.78, -96.8, .6],
  [33.75, -84.39, .6], [25.76, -80.19, .6], [38.9, -77.04, .7], [42.36, -71.06, .6], [47.61, -122.33, .5], [43.65, -79.38, .7],
  [45.5, -73.57, .5], [19.43, -99.13, .9], [4.71, -74.07, .6], [-12.05, -77.04, .6], [-23.55, -46.63, 1], [-22.91, -43.17, .8],
  [-34.6, -58.38, .8], [-33.45, -70.67, .6], [51.5, -.13, 1], [48.86, 2.35, 1], [40.42, -3.7, .7], [38.72, -9.14, .5],
  [52.52, 13.4, .7], [52.37, 4.9, .6], [50.85, 4.35, .5], [45.46, 9.19, .6], [41.9, 12.5, .6], [47.37, 8.54, .4],
  [48.21, 16.37, .5], [52.23, 21.01, .5], [59.33, 18.07, .4], [55.76, 37.62, .9], [41.01, 28.98, .9], [30.04, 31.24, .9],
  [6.52, 3.38, .8], [-4.44, 15.27, .5], [-1.29, 36.82, .5], [-26.2, 28.05, .7], [-33.92, 18.42, .4], [33.57, -7.59, .5],
  [24.71, 46.68, .6], [25.2, 55.27, .7], [35.69, 51.39, .7], [24.86, 67, .8], [28.61, 77.21, 1], [19.08, 72.88, 1],
  [12.97, 77.59, .7], [22.57, 88.36, .8], [23.81, 90.41, .8], [13.76, 100.5, .8], [1.35, 103.82, .6], [-6.2, 106.85, .9],
  [14.6, 120.98, .8], [22.32, 114.17, .7], [31.23, 121.47, 1], [39.9, 116.4, 1], [37.57, 126.98, .9], [35.68, 139.69, 1],
  [34.69, 135.5, .7], [-33.87, 151.21, .6], [-37.81, 144.96, .5], [31.55, 74.34, .6], [29.56, 106.55, .7], [23.13, 113.26, .9],
];

function valueNoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number) => hash(a * 157 + b * 113 + c * 271);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(h(xi, yi, zi), h(xi + 1, yi, zi), sx), lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), sx), sy),
    lerp(lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), sx), lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), sx), sy), sz);
}

/** Land dots on staggered latitude rows sampled from the land mask, a sparse ocean grid, and clustered city lights. */
export function dotGeometry(mask: ImageData, step: number) {
  const positions: number[] = [], land: number[] = [], random: number[] = [], city: number[] = [], shade: number[] = [];
  const metros = METROS.map(([lat, lon, weight]) => ({ point: latLon(lat, lon), weight }));
  const near = Math.cos(6 * D2R), sigma = 1.5 * D2R, halo = 3.4 * D2R;
  const { data, width, height } = mask;
  let row = 0, count = 0;
  for (let lat = -90 + step / 2; lat < 90; lat += step, row++) {
    const perRow = Math.max(1, Math.round(Math.cos(lat * D2R) * 360 / step));
    const v = Math.min(height - 1, Math.floor((90 - lat) / 180 * height));
    for (let index = 0; index < perRow; index++) {
      const lon = -180 + (index + (row % 2) * .5) * 360 / perRow;
      const u = Math.min(width - 1, Math.floor((lon + 180) / 360 * width));
      const isLand = data[(v * width + u) * 4] > 127;
      if (!isLand && (row % 3 !== 0 || index % 3 !== 0)) continue;
      const point = latLon(lat, lon);
      const r = hash(++count);
      let light = 0;
      if (isLand) {
        let glow = 0;
        for (const metro of metros) {
          const dot = point.dot(metro.point);
          if (dot < near) continue;
          const angle = Math.acos(Math.min(1, dot));
          glow += metro.weight * (Math.exp(-(((angle / sigma)) ** 2)) + .35 * Math.exp(-(((angle / halo)) ** 2)));
        }
        if (glow > .04 && hash(count + .37) < Math.min(.92, glow * 1.6)) light = Math.min(1, .3 + glow * .7) * (.55 + .45 * hash(count + .91));
        else if (hash(count + .53) > .988) light = .22 + .25 * hash(count + .17);
      }
      const n = valueNoise(point.x * 4.2 + 7, point.y * 4.2, point.z * 4.2) * .65 + valueNoise(point.x * 11, point.y * 11 + 3, point.z * 11) * .35;
      positions.push(point.x, point.y, point.z); land.push(isLand ? 1 : 0); random.push(r); city.push(light); shade.push(n);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aLand', new THREE.Float32BufferAttribute(land, 1));
  geometry.setAttribute('aRand', new THREE.Float32BufferAttribute(random, 1));
  geometry.setAttribute('aCity', new THREE.Float32BufferAttribute(city, 1));
  geometry.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  return { geometry, count };
}

/** Background stars on a far sphere. */
export function starGeometry(count: number) {
  const positions: number[] = [], sizes: number[] = [], seeds: number[] = [], tints: number[] = [];
  for (let index = 0; index < count; index++) {
    const u = hash(index * 3 + 1) * 2 - 1, a = hash(index * 3 + 2) * Math.PI * 2, distance = 45 + hash(index * 7 + 5) * 30;
    const s = Math.sqrt(1 - u * u);
    positions.push(Math.cos(a) * s * distance, u * distance, Math.sin(a) * s * distance);
    const size = hash(index * 11 + 3);
    sizes.push(size > .992 ? 2.2 + hash(index) * 1.2 : size > .95 ? 1 + hash(index) * .5 : .3 + Math.pow(hash(index * 5 + 9), 2) * .55);
    seeds.push(hash(index * 13 + 7));
    const warm = hash(index * 17 + 2) > .9;
    tints.push(...(warm ? [1, .88, .74] : [.72, .82, 1]));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setAttribute('aTint', new THREE.Float32BufferAttribute(tints, 3));
  return geometry;
}

/**
 * The MFA shield: a Goldberg (hexagon) lattice, the dual of a geodesic icosphere. Each hexagon is a triangle fan;
 * aEdge is 1 at a cell centre and 0 on its border so the shader can draw anti-aliased cell edges, aCell is the
 * cell id for per-cell flicker.
 */
export function hexShellGeometry(radius: number, detail: number) {
  const source = new THREE.IcosahedronGeometry(1, detail);
  source.deleteAttribute('normal'); source.deleteAttribute('uv');
  const merged = mergeVertices(source, 1e-4);
  source.dispose();
  const position = merged.getAttribute('position') as THREE.BufferAttribute;
  const index = merged.getIndex();
  if (!index) throw new Error('Expected indexed geometry');
  const faces: number[][] = Array.from({ length: position.count }, () => []);
  const centroids: THREE.Vector3[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let face = 0; face < index.count / 3; face++) {
    const ia = index.getX(face * 3), ib = index.getX(face * 3 + 1), ic = index.getX(face * 3 + 2);
    a.fromBufferAttribute(position, ia); b.fromBufferAttribute(position, ib); c.fromBufferAttribute(position, ic);
    centroids.push(a.clone().add(b).add(c).normalize());
    faces[ia].push(face); faces[ib].push(face); faces[ic].push(face);
  }
  const out: number[] = [], edge: number[] = [], cell: number[] = [];
  const center = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3(1, 0, 0);
  for (let vertex = 0; vertex < position.count; vertex++) {
    center.fromBufferAttribute(position, vertex).normalize();
    t1.crossVectors(center, Math.abs(center.y) > .9 ? right : up).normalize();
    t2.crossVectors(center, t1);
    const ring = faces[vertex].map(face => centroids[face]).sort((p, q) =>
      Math.atan2(p.dot(t2), p.dot(t1)) - Math.atan2(q.dot(t2), q.dot(t1)));
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k], q = ring[(k + 1) % ring.length];
      out.push(center.x * radius, center.y * radius, center.z * radius, p.x * radius, p.y * radius, p.z * radius, q.x * radius, q.y * radius, q.z * radius);
      edge.push(1, 0, 0); cell.push(vertex, vertex, vertex);
    }
  }
  merged.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  geometry.setAttribute('aCell', new THREE.Float32BufferAttribute(cell, 1));
  return geometry;
}

/** The Bluetooth shield: sparse device nodes and links that hug the shell. */
export function nodeMeshGeometry(radius: number, count: number) {
  const nodes: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index++) {
    const y = 1 - (index + .5) / count * 2, r = Math.sqrt(1 - y * y), theta = index * golden;
    nodes.push(new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r)
      .add(new THREE.Vector3(hash(index + 1) - .5, hash(index + 2) - .5, hash(index + 3) - .5).multiplyScalar(.22)).normalize());
  }
  const points = new THREE.BufferGeometry();
  points.setAttribute('position', new THREE.Float32BufferAttribute(nodes.flatMap(node => node.clone().multiplyScalar(radius).toArray()), 3));
  points.setAttribute('aSeed', new THREE.Float32BufferAttribute(nodes.map((_, index) => hash(index * 7 + 11)), 1));
  const linkPositions: number[] = [], linkT: number[] = [], linkSeed: number[] = [];
  const seen = new Set<string>();
  const segments = 14;
  nodes.forEach((node, from) => {
    nodes.map((other, to) => ({ to, angle: node.angleTo(other) })).filter(item => item.to !== from && item.angle < .62)
      .sort((p, q) => p.angle - q.angle).slice(0, 2).forEach(({ to }) => {
        const key = from < to ? `${from}-${to}` : `${to}-${from}`;
        if (seen.has(key) || hash(from * 31 + to) < .25) return;
        seen.add(key);
        const seed = hash(seen.size * 19 + 4);
        for (let step = 0; step < segments; step++) {
          for (const k of [step, step + 1]) {
            const point = node.clone().lerp(nodes[to], k / segments).normalize().multiplyScalar(radius);
            linkPositions.push(point.x, point.y, point.z); linkT.push(k / segments); linkSeed.push(seed);
          }
        }
      });
  });
  const links = new THREE.BufferGeometry();
  links.setAttribute('position', new THREE.Float32BufferAttribute(linkPositions, 3));
  links.setAttribute('aT', new THREE.Float32BufferAttribute(linkT, 1));
  links.setAttribute('aSeed', new THREE.Float32BufferAttribute(linkSeed, 1));
  return { points, links };
}

export type Route = {
  samples: THREE.Vector3[];
  phase: number;
  duration: number;
  /** 0 = city to city, 1 = leaves the globe through the shields. */
  kind: 0 | 1;
  /** For shield routes: the route parameter (0..1) where it crosses each shield it reaches. */
  crossings: number[];
};
export const ARC_PERIOD = 10.4;
const SAMPLES = 64;

/** All arcs, launched in an even rhythm across one period; consecutive launches alternate across the map. */
export function buildRoutes(): Route[] {
  const routes: Route[] = [];
  SURFACE_ROUTES.forEach(([from, to]) => {
    const a = latLon(...CITIES[from]), b = latLon(...CITIES[to]);
    const angle = a.angleTo(b);
    const lift = .02 + angle * .15;
    const samples: THREE.Vector3[] = [];
    for (let step = 0; step <= SAMPLES; step++) {
      const t = step / SAMPLES;
      samples.push(new THREE.Vector3().copy(a).lerp(b, t).normalize().multiplyScalar(1.004 + Math.sin(Math.PI * t) * lift));
    }
    routes.push({ samples, phase: 0, duration: 1.35 + angle * .5, kind: 0, crossings: [] });
  });
  SHIELD_ROUTES.forEach(([from, last], route) => {
    const start = latLon(...CITIES[from]);
    const side = new THREE.Vector3().crossVectors(start, new THREE.Vector3(0, 1, 0)).normalize();
    const end = start.clone().addScaledVector(side, route % 2 ? .38 : -.38).addScaledVector(new THREE.Vector3(0, 1, 0), .18).normalize();
    const outer = SHELL_RADII[last] + .002;
    const radiusAt = (t: number) => 1.004 + (outer - 1.004) * Math.pow(Math.sin(t * Math.PI / 2), 1.25);
    const samples: THREE.Vector3[] = [];
    for (let step = 0; step <= SAMPLES; step++) {
      const t = step / SAMPLES;
      samples.push(start.clone().lerp(end, t * t * (3 - 2 * t)).normalize().multiplyScalar(radiusAt(t)));
    }
    const crossings = SHELL_RADII.slice(0, last + 1).map(radius => {
      let low = 0, high = 1;
      for (let iteration = 0; iteration < 24; iteration++) { const mid = (low + high) / 2; if (radiusAt(mid) < radius) low = mid; else high = mid; }
      return high;
    });
    routes.push({ samples, phase: 0, duration: 1.5, kind: 1, crossings });
  });
  // Interleave shield routes evenly among the surface routes, then space launches across the period.
  const surface = routes.filter(route => route.kind === 0), shield = routes.filter(route => route.kind === 1);
  const ordered: Route[] = [];
  const every = Math.floor(surface.length / shield.length);
  surface.forEach((route, index) => { ordered.push(route); if ((index + 1) % every === 0 && shield.length) ordered.push(shield.shift() as Route); });
  ordered.push(...shield);
  ordered.forEach((route, index) => { route.phase = index * ARC_PERIOD / ordered.length; });
  return ordered;
}

/** Screen-space ribbon strips for the arcs: two vertices per sample, expanded in the vertex shader. */
export function ribbonGeometry(routes: Route[]) {
  const positions: number[] = [], next: number[] = [], side: number[] = [], along: number[] = [], timing: number[] = [], indices: number[] = [];
  let base = 0;
  for (const route of routes) {
    const { samples } = route;
    const last = samples.length - 1;
    samples.forEach((point, index) => {
      const ahead = index < last ? samples[index + 1] : point.clone().multiplyScalar(2).sub(samples[index - 1]);
      for (const s of [-1, 1]) {
        positions.push(point.x, point.y, point.z); next.push(ahead.x, ahead.y, ahead.z); side.push(s);
        along.push(index / last); timing.push(route.phase, route.duration, route.kind);
      }
      if (index < last) { const v = base + index * 2; indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    });
    base += samples.length * 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aNext', new THREE.Float32BufferAttribute(next, 3));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  geometry.setAttribute('aT', new THREE.Float32BufferAttribute(along, 1));
  geometry.setAttribute('aTiming', new THREE.Float32BufferAttribute(timing, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Launch and impact flash sprites for every route. */
export function flashGeometry(routes: Route[]) {
  const positions: number[] = [], timing: number[] = [], which: number[] = [];
  for (const route of routes) {
    const first = route.samples[0], last = route.samples[route.samples.length - 1];
    positions.push(first.x, first.y, first.z, last.x, last.y, last.z);
    timing.push(route.phase, route.duration, route.kind, route.phase, route.duration, route.kind);
    which.push(0, 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aTiming', new THREE.Float32BufferAttribute(timing, 3));
  geometry.setAttribute('aWhich', new THREE.Float32BufferAttribute(which, 1));
  return geometry;
}
