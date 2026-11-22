import { readFileSync } from "node:fs";
import { join } from "node:path";

export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const angle = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
export const wrap = (value) => Math.atan2(Math.sin(value), Math.cos(value));

function inside(x, y, ring) {
  let parity = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    if (
      ring[i + 1] > y !== ring[j + 1] > y &&
      x <
        ((ring[j] - ring[i]) * (y - ring[i + 1])) /
          (ring[j + 1] - ring[i + 1]) +
          ring[i]
    )
      parity = !parity;
  }
  return parity;
}

const neighbors = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];
export class Terrain {
  constructor(dir) {
    const map = JSON.parse(readFileSync(join(dir, "v2/world.json")));
    const terrain = map.terrain;
    const buf = readFileSync(join(dir, "v2", terrain.file));
    this.cell = 5;
    this.x0 = map.bounds.minX;
    this.y0 = map.bounds.minY;
    this.cols = Math.ceil((map.bounds.maxX - this.x0) / this.cell) + 1;
    this.rows = Math.ceil((map.bounds.maxY - this.y0) / this.cell) + 1;
    const count = this.cols * this.rows;
    this.ground = new Float32Array(count);
    this.bottom = new Float32Array(count).fill(Infinity);
    this.roof = new Float32Array(count).fill(-Infinity);
    this.wall = new Uint8Array(count);
    this.clearance = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const [x, y] = this.point(i);
      const col = clamp(
        Math.round((x - terrain.minX) / terrain.step),
        0,
        terrain.nx - 1,
      );
      const row = clamp(
        Math.round((y - terrain.minY) / terrain.step),
        0,
        terrain.ny - 1,
      );
      this.ground[i] =
        buf.readInt16LE(2 * (row * terrain.nx + col)) * terrain.scale;
    }
    for (const { ring, holes, top, base } of map.prisms) {
      const xs = ring.filter((_, i) => !(i % 2)),
        ys = ring.filter((_, i) => i % 2);
      const first = this.key(Math.min(...xs) - 3, Math.min(...ys) - 3);
      const last = this.key(Math.max(...xs) + 3, Math.max(...ys) + 3);
      for (
        let row = Math.floor(first / this.cols);
        row <= Math.floor(last / this.cols);
        row++
      ) {
        for (let col = first % this.cols; col <= last % this.cols; col++) {
          const i = row * this.cols + col,
            [x, y] = this.point(i);
          if (
            ![
              [0, 0],
              [1.8, 0],
              [-1.8, 0],
              [0, 1.8],
              [0, -1.8],
            ].some(
              ([dx, dy]) =>
                inside(x + dx, y + dy, ring) &&
                !(holes || []).some((h) => inside(x + dx, y + dy, h)),
            )
          )
            continue;
          this.roof[i] = Math.max(this.roof[i], top);
          this.bottom[i] = Math.min(this.bottom[i], base);
          if (base < this.ground[i] + 9.3 && top > this.ground[i] + 1.2)
            this.wall[i] = 1;
        }
      }
    }
    for (let i = 0; i < count; i++) {
      if (this.wall[i]) continue;
      this.clearance[i] = neighbors.reduce(
        (n, [x, y]) => n + (this.wall[i + x + y * this.cols] || 0),
        0,
      );
    }
    // Geometry is static. Build the legal steps once, before the first observation.
    this.edges = new Int32Array(count * neighbors.length);
    this.edgeStart = new Int32Array(count + 1);
    this.queue = new Int32Array(count);
    let edge = 0;
    for (let i = 0; i < count; i++) {
      this.edgeStart[i] = edge;
      const col = i % this.cols,
        row = Math.floor(i / this.cols);
      for (const [dx, dy] of neighbors) {
        const x = col + dx,
          y = row + dy;
        if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) continue;
        const next = i + dx + dy * this.cols;
        if (this.wall[next] || Math.abs(this.ground[i] - this.ground[next]) > 6)
          continue;
        if (dx && dy && (this.wall[i + dx] || this.wall[i + dy * this.cols]))
          continue;
        this.edges[edge++] = next;
      }
    }
    this.edgeStart[count] = edge;
    this.routes = new Map();
  }
  key(x, y) {
    const col = clamp(Math.round((x - this.x0) / this.cell), 0, this.cols - 1);
    return (
      col +
      this.cols * clamp(Math.round((y - this.y0) / this.cell), 0, this.rows - 1)
    );
  }
  point(i) {
    return [
      this.x0 + (i % this.cols) * this.cell,
      this.y0 + Math.floor(i / this.cols) * this.cell,
    ];
  }
  visible(from, to) {
    const steps = Math.max(1, Math.ceil(distance(from, to) / 3.5));
    for (let j = 1; j < steps; j++) {
      const f = j / steps,
        i = this.key(
          from[0] + (to[0] - from[0]) * f,
          from[1] + (to[1] - from[1]) * f,
        );
      const z = from[2] + (to[2] - from[2]) * f;
      if (
        this.ground[i] > z + 0.3 ||
        (this.roof[i] > z + 0.2 && this.bottom[i] < z - 0.2)
      )
        return false;
    }
    return true;
  }
  open(pos, yaw, length) {
    const cos = Math.cos(yaw),
      sin = Math.sin(yaw);
    let height = pos[2];
    for (let d = 2; d <= length + 1; d += 3) {
      const x = pos[0] + cos * d,
        y = pos[1] + sin * d,
        i = this.key(x, y),
        snapped = this.point(i);
      if (Math.abs(snapped[0] - x) > 4 || Math.abs(snapped[1] - y) > 4)
        return false;
      let floor = this.ground[i];
      if (this.roof[i] > floor && this.bottom[i] < height + 8.9)
        floor = Math.max(floor, this.roof[i]);
      if (floor > height + 2.6) return false;
      height = Math.max(floor, height - 1.2);
    }
    return true;
  }
  roofApproach(pos, target) {
    const start = this.key(...target),
      top = target[2];
    if (!Number.isFinite(top) || Math.abs(this.roof[start] - top) > 2)
      return null;
    const visited = new Set([start]),
      cells = [start];
    const steps = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    let best = null,
      cost = Infinity;
    // Find a launch point clear of the overhang, beside this particular roof.
    for (let head = 0; head < cells.length && head < 1200; head++) {
      const wall = cells[head],
        col = wall % this.cols,
        row = Math.floor(wall / this.cols);
      for (const [dx, dy] of steps) {
        const x = col + dx,
          y = row + dy;
        if (x < 2 || x >= this.cols - 2 || y < 2 || y >= this.rows - 2)
          continue;
        const near = wall + dx + dy * this.cols;
        if (Math.abs(this.roof[near] - top) <= 2) {
          if (!visited.has(near)) {
            visited.add(near);
            cells.push(near);
          }
          continue;
        }
        const launch = near + dx + dy * this.cols;
        if (
          this.wall[near] ||
          this.wall[launch] ||
          this.bottom[launch] < top + 10 ||
          this.bottom[near] < top + 10 ||
          this.ground[launch] >= top - 1.2
        )
          continue;
        const ground = [...this.point(launch), this.ground[launch]];
        const lip = [...this.point(wall), top];
        const interior = wall - dx - dy * this.cols;
        const land =
          Math.abs(this.roof[interior] - top) <= 2
            ? [...this.point(interior), top]
            : lip;
        const value =
          distance(pos, ground) +
          distance(land, target) * 0.75 +
          Math.max(0, top - ground[2]) * 0.7;
        if (value < cost) {
          cost = value;
          best = { launch: ground, land };
        }
      }
    }
    return best;
  }
  nearestOpen(key) {
    if (!this.wall[key]) return key;
    for (let r = 1; r <= 12; r++) {
      let best = -1,
        cost = Infinity;
      const col = key % this.cols,
        row = Math.floor(key / this.cols);
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++) {
          if (
            Math.max(Math.abs(x), Math.abs(y)) !== r ||
            col + x < 0 ||
            col + x >= this.cols ||
            row + y < 0 ||
            row + y >= this.rows
          )
            continue;
          const i = key + x + y * this.cols;
          if (!this.wall[i] && x * x + y * y < cost) {
            best = i;
            cost = x * x + y * y;
          }
        }
      if (best >= 0) return best;
    }
    return key;
  }
  field(target) {
    const goal = this.nearestOpen(this.key(...target));
    if (this.routes.has(goal)) return this.routes.get(goal);
    const costs = new Int16Array(this.wall.length).fill(-1),
      q = this.queue;
    let head = 0,
      tail = 1;
    q[0] = goal;
    costs[goal] = 0;
    while (head < tail) {
      const i = q[head++];
      for (let e = this.edgeStart[i]; e < this.edgeStart[i + 1]; e++) {
        const next = this.edges[e];
        if (costs[next] >= 0) continue;
        costs[next] = costs[i] + 1;
        q[tail++] = next;
      }
    }
    if (this.routes.size >= 12)
      this.routes.delete(this.routes.keys().next().value);
    this.routes.set(goal, costs);
    return costs;
  }
  heading(pos, target) {
    const direct = angle(pos, target),
      range = distance(pos, target);
    if (this.open(pos, direct, Math.min(range, 20))) return direct;
    const dist = this.field(target),
      start = this.nearestOpen(this.key(...pos));
    let cell = start;
    for (let k = 0; k < 4; k++) {
      let best = cell,
        bestCost = Infinity;
      for (const [dx, dy] of neighbors) {
        const next = cell + dx + dy * this.cols;
        if (
          next < 0 ||
          next >= dist.length ||
          dist[next] < 0 ||
          dist[next] >= dist[cell] ||
          (dx &&
            dy &&
            (this.wall[cell + dx] || this.wall[cell + dy * this.cols]))
        )
          continue;
        const score =
          dist[next] +
          this.clearance[next] * 0.05 +
          distance(this.point(next), target) * 0.0002;
        if (score < bestCost) {
          best = next;
          bestCost = score;
        }
      }
      if (best === cell) break;
      if (
        k > 0 &&
        !this.open(
          pos,
          angle(pos, this.point(best)),
          distance(pos, this.point(best)),
        )
      )
        break;
      cell = best;
    }
    return cell === start ? direct : angle(pos, this.point(cell));
  }
}
