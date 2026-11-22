import { angle, clamp, distance, wrap } from "./terrain.mjs";

const lift = (p, h) => [p[0], p[1], p[2] + h];

// The protocol exposes the population and combat observations, but no lobby type.
export class Field {
  constructor(config, slot) {
    this.config = config;
    this.slot = slot;
    this.previous = new Map();
    this.duels = new Map();
    this.ownKills = new Set();
    this.ffa = false;
    this.lastContact = -Infinity;
    this.lastDamage = -Infinity;
    this.lastDanger = -Infinity;
    this.visible = [];
  }

  observe(o, map) {
    const rivals = o.mechs.filter((a) => a.kind === "mech");
    const ownHits = new Set();
    for (const e of o.events) {
      if (e.type === "hit") ownHits.add(e.target);
      if (e.type === "kill") this.ownKills.add(e.target);
      if (e.type === "damaged" && e.weapon !== "zone") {
        this.lastDamage = o.t;
        if (e.weapon === "npc") this.pest = { id: e.by, t: o.t };
      }
    }
    // In a wide opening circle, several uncredited eliminations also identify
    // fights happening elsewhere, including gun-only fights outside our vision.
    if (this.openingAlive === undefined) this.openingAlive = o.alive;
    if (
      o.t < 75 &&
      o.zone.radius >= 0.85 * this.config.zone.start_radius &&
      this.openingAlive - o.alive - this.ownKills.size >= 3
    )
      this.ffa = true;

    // Outside the opening a single unexplained death can be the storm.
    // Several while the zone is still wide provide a secondary signal for
    // gun-only lobbies where we never see a beam.
    if (
      o.t < 150 &&
      o.zone.radius > this.config.zone.start_radius * 0.62 &&
      this.openingAlive - o.alive - this.ownKills.size >= 5
    )
      this.ffa = true;
    for (const beam of o.beams) {
      if (
        beam.by === this.slot ||
        !Number.isInteger(beam.by) ||
        beam.by < 0 ||
        beam.by >= this.config.match.mechs
      )
        continue;
      for (const a of rivals) {
        if (beam.by === a.id || ownHits.has(a.id)) continue;
        const prev = this.previous.get(a.id);
        if (!prev || o.t - prev.t > 0.36 || !(prev.hp - a.hp > 8)) continue;
        // Compare the impact to the moving target at the time the shot landed.
        // A ray merely passing nearby is common when the squad aims at us.
        const scale = 1 + (a.cubes || 0) * this.config.cubes.size_per_cube;
        const age = clamp(beam.age || 0, 0, 0.25);
        const x = a.pos[0] - a.vel[0] * age,
          y = a.pos[1] - a.vel[1] * age;
        const z = a.pos[2] - a.vel[2] * age;
        if (
          beam.path
            .slice(1)
            .some(
              (p) =>
                Math.hypot(p[0] - x, p[1] - y) <
                  this.config.mech.radius * scale + 1.2 &&
                p[2] >= z - 1 &&
                p[2] <= z + this.config.mech.height * scale + 1,
            )
        ) {
          this.ffa = true;
          this.duels.set(beam.by, o.t);
          this.duels.set(a.id, o.t);
        }
      }
    }
    // The server omits our bullets and labels NPC fire separately. Track
    // disappearing gun rounds only when another pilot lost HP that frame.
    const dt = o.t - (this.bulletTime ?? -Infinity);
    if (dt > 0 && dt < 0.32 && this.bullets.length) {
      const stillFlying = new Set(o.projectiles.map((p) => p.id));
      const spent = new Set();
      for (const a of rivals) {
        const old = this.previous.get(a.id);
        if (
          !old ||
          o.t - old.t > dt + 0.01 ||
          old.hp - a.hp < 11 ||
          ownHits.has(a.id)
        )
          continue;
        for (const shot of this.bullets) {
          if (stillFlying.has(shot.id) || spent.has(shot.id)) continue;
          const x = a.pos[0] - a.vel[0] * dt - shot.pos[0],
            y = a.pos[1] - a.vel[1] * dt - shot.pos[1];
          const vx = shot.vel[0] - a.vel[0],
            vy = shot.vel[1] - a.vel[1];
          const hitTime = clamp(
            (x * vx + y * vy) / Math.max(1, vx * vx + vy * vy),
            0,
            dt,
          );
          const scale = 1 + (a.cubes || 0) * this.config.cubes.size_per_cube;
          const dz =
            shot.pos[2] +
            hitTime * shot.vel[2] -
            (a.pos[2] - (dt - hitTime) * a.vel[2]);
          if (
            dz < -0.3 ||
            dz > this.config.mech.height * scale + 0.3 ||
            Math.hypot(x - vx * hitTime, y - vy * hitTime) >
              this.config.mech.radius * scale + 0.45
          )
            continue;
          if (o.t - (this.foreignImpact ?? -Infinity) < 5) this.ffa = true;
          this.foreignImpact = o.t;
          this.duels.set(a.id, o.t);
          spent.add(shot.id);
          break;
        }
      }
    }
    this.bullets = o.projectiles.filter((p) => p.kind === "gun");
    this.bulletTime = o.t;
    for (const a of rivals) this.previous.set(a.id, { t: o.t, hp: a.hp });
    const eye = lift(o.self.pos, o.self.stats.eye_height);
    this.visible = rivals.filter((a) => {
      const h =
        this.config.mech.height *
        (1 + (a.cubes || 0) * this.config.cubes.size_per_cube);
      return (
        map.visible(eye, lift(a.pos, h * 0.78)) ||
        map.visible(eye, lift(a.pos, h * 0.45))
      );
    });
    if (this.visible.length) this.lastContact = o.t;
    this.watchers = this.visible.filter(
      (a) =>
        distance(a.pos, o.self.pos) < 235 &&
        Math.abs(wrap(angle(a.pos, o.self.pos) - a.aim[0])) <
          (a.charging ? 0.4 : 0.27),
    );
    if (this.watchers.length) this.lastDanger = o.t;
    this.pressing = this.watchers.filter(
      (a) => a.charging || distance(a.pos, o.self.pos) < 88,
    );
  }

  distracted(o, a) {
    return (
      o.t - (this.duels.get(a.id) ?? -Infinity) < 3 &&
      Math.abs(wrap(angle(a.pos, o.self.pos) - a.aim[0])) > 0.65
    );
  }

  lootRisk(pos) {
    let risk = 0;
    for (const a of this.visible)
      risk += clamp(1 - distance(a.pos, pos) / 82, 0, 1);
    return risk;
  }

  // Sample connected ground cells near the pilot. The parent graph excludes
  // walls and diagonal corner cuts; the step count prices walking around them.
  shelter(o, map, zone, sources) {
    if (!sources.length) return null;
    const origin = o.self.pos;
    const start = map.key(...origin);
    // A rooftop can provide cover by itself; a ground route below it is misleading.
    if (map.wall[start] || origin[2] - map.ground[start] > 5) return null;
    const ranked = sources
      .slice()
      .sort(
        (a, b) =>
          Number(b.charging) - Number(a.charging) ||
          distance(origin, a.pos) - distance(origin, b.pos),
      )
      .slice(0, 3);
    const tag = ranked.map((a) => a.id).join(",");
    if (
      this.cover &&
      this.cover.tag === tag &&
      o.t < this.cover.until &&
      distance(origin, this.cover.origin) < 10
    )
      return this.cover.goal;
    const threats = ranked.map((a) =>
      lift(
        a.pos,
        this.config.mech.muzzle_height *
          (1 + (a.cubes || 0) * this.config.cubes.size_per_cube),
      ),
    );
    const seen = new Set([start]),
      queue = [[start, 0]];
    const h = o.self.stats.height;
    let highest = -Infinity,
      goal = null;
    for (let i = 0; i < queue.length && i < 225; i++) {
      const [cell, steps] = queue[i];
      // Check the current position and cells adjacent to a structure. These
      // are cheap to enumerate and can take us around a blind corner.
      if (i === 0 || map.clearance[cell]) {
        const point = i === 0 ? origin : [...map.point(cell), map.ground[cell]];
        if (distance(point, zone) < zone[2] - Math.min(5, zone[2] * 0.12)) {
          const upper = lift(point, h * 0.86),
            middle = lift(point, h * 0.47);
          let blocked = 0;
          for (let j = 0; j < threats.length; j++) {
            const source = threats[j];
            if (!map.visible(source, upper) && !map.visible(source, middle))
              blocked += ranked[j].charging ? 2 : 1;
          }
          const gain =
            60 * blocked -
            steps * 2.8 -
            Math.max(0, 28 - distance(point, ranked[0].pos));
          if (blocked && gain > highest) {
            highest = gain;
            goal = { pos: point, shelter: true };
          }
        }
      }
      if (steps === 8) continue;
      for (let e = map.edgeStart[cell]; e < map.edgeStart[cell + 1]; e++) {
        const next = map.edges[e];
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push([next, steps + 1]);
      }
    }
    this.cover = { tag, origin: [...origin], until: o.t + 0.65, goal };
    return goal;
  }
}
