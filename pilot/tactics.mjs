import { clamp, distance, angle, wrap } from "./terrain.mjs";

const gearRank = { laser: 4, lightning: 2, gun: 3, mortar: 1 };
const up = (pos, height) => [pos[0], pos[1], pos[2] + height];
export class Tactics {
  constructor(hello, terrain) {
    this.config = hello.config;
    this.map = terrain;
    this.slot = hello.slot;
    this.seed = hello.seed >>> 0;
    this.items = new Map();
    this.aggressors = new Map();
    this.lock = null;
    this.patrol = null;
  }
  remember(o) {
    for (const hit of o.events || [])
      if (hit.type === "damaged" && hit.by != null)
        this.aggressors.set(hit.by, o.t);
    for (const type of ["pickups", "cubes", "crates"])
      for (const obj of o[type] || [])
        this.items.set(obj.id, { ...obj, type, time: o.t });
    const here = o.self.pos;
    for (const [id, item] of this.items) {
      if (
        o.t - item.time > 40 ||
        (o.t > item.time &&
          distance(here, item.pos) < 12 &&
          Math.abs(here[2] - item.pos[2]) < 4)
      )
        this.items.delete(id);
    }
  }
  // Build up on nearby loot while the first pursuer is still manageable.
  preparing(o) {
    const me = o.self;
    if (this.equipped) return false;
    const beam = me.weapons.some((w) => w?.kind === "laser");
    if (o.t > 65 || (me.cubes >= 3 && beam) || o.alive < 9)
      this.equipped = true;
    return !this.equipped;
  }
  chooseTarget(o) {
    const me = o.self,
      pos = me.pos,
      muzzle = up(pos, me.stats.muzzle_height);
    const beam = me.weapons.find((w) => w?.kind === "laser");
    const gun = me.weapons.find((w) => w?.kind === "gun");
    const hasBeam = Boolean(beam);
    const hasArc = me.weapons.some((w) => w?.kind === "lightning");
    const range = Math.max(...me.weapons.map((w) => w?.stats.range || 0));
    const damageScale = 1 + Math.min(me.cubes, 10) * 0.04;
    const actors = [
      ...(o.mechs || []),
      ...(o.crates || []).map((c) => ({ ...c, kind: "crate" })),
    ];
    let chosen = null,
      high = -Infinity;
    const preparing = this.preparing(o);
    for (const a of actors) {
      const d = distance(pos, a.pos);
      if (d > range + 8) continue;
      const z = a.kind === "mech" ? 4.6 : a.kind === "npc" ? 1.9 : 1.25,
        center = up(a.pos, z);
      if (!this.map.visible(muzzle, center)) continue;
      const wounded =
        a.kind === "mech"
          ? 1 - clamp((a.hp ?? 1400) / (a.max_hp || 1400), 0, 1)
          : 0;
      const attention = Math.abs(wrap(angle(a.pos, pos) - (a.aim?.[0] ?? 0)));
      const engaged = o.t - (this.aggressors.get(a.id) ?? -100) < 6;
      const toward = a.vel
        ? -((a.pos[0] - pos[0]) * a.vel[0] + (a.pos[1] - pos[1]) * a.vel[1]) /
          Math.max(1, d)
        : 0;
      if (preparing && a.kind === "mech") {
        // While gathering gear, take a quick elimination or answer a gunner that is already hitting us.
        const canFinish = (hasBeam && wounded > 0.56) || wounded > 0.77;
        const underGunfire =
          engaged &&
          d < 170 &&
          !a.weapons?.includes("laser") &&
          (me.hp < me.max_hp * 0.75 || (attention < 0.22 && d < 96));
        const shouldEngage =
          d < 48 || (d < 92 && a.charging) || canFinish || underGunfire;
        if (
          !shouldEngage &&
          !(
            engaged &&
            (me.hp < me.max_hp * 0.57 || a.weapons?.includes("laser"))
          )
        )
          continue;
      }
      const hunting =
        engaged || a.charging || (attention < 0.42 && (toward > 1.5 || d < 75));
      if (
        a.kind === "mech" &&
        !hunting &&
        wounded < 0.38 &&
        o.alive > 4 &&
        (d < 80 || !hasBeam)
      )
        continue;
      let score;
      if (a.kind === "mech") {
        // Estimate the time to finish the target with the weapons currently in range.
        const flank = attention > Math.PI / 2 ? 1.5 : 1;
        const hasMortar = a.weapons?.includes("mortar");
        const beamDamagePerSecond =
          beam && d < beam.stats.range
            ? (beam.stats.damage * (hasMortar ? 1 + beam.stats.cookoff : 1)) /
              (beam.stats.charge + beam.stats.cooldown)
            : 0;
        const sidewaysSpeed = a.vel
          ? Math.abs(
              (a.pos[0] - pos[0]) * a.vel[1] - (a.pos[1] - pos[1]) * a.vel[0],
            ) / Math.max(1, d)
          : 0;
        const gunAccuracy = clamp(
          1.05 - d * 0.0018 - sidewaysSpeed * 0.012,
          0.3,
          0.95,
        );
        const gunDamagePerSecond =
          gun && d <= gun.stats.range
            ? (gun.stats.damage * gunAccuracy) /
              (gun.stats.cooldown + gun.stats.reload / gun.stats.mag)
            : 0;
        const arcDamagePerSecond = d < 42 && hasArc ? 130 : 0;
        const secondsToFinish =
          (a.hp ?? 1200) /
          Math.max(
            18,
            (gunDamagePerSecond + beamDamagePerSecond + arcDamagePerSecond) *
              flank *
              damageScale,
          );
        const dangerous = engaged || (a.charging && attention < 0.35);
        score =
          70 -
          clamp(secondsToFinish, 0, 18) * 3.4 +
          (dangerous ? 16 : 0) +
          (this.lock === a.id ? 10 : 0) +
          wounded * 24 +
          (d < 55 && dangerous ? 12 : 0);
      } else if (a.kind === "npc") {
        score = me.cubes < 6 ? 20 : 4;
        score -= d * 0.08;
      } else {
        score = (hasBeam ? 10 : 25) - d * 0.11;
        if (me.cubes >= 10) score -= 20;
      }
      if (score > high) {
        high = score;
        chosen = { a, d, z, engaged };
      }
    }
    if (chosen) this.lock = chosen.a.id;
    return chosen;
  }
  offense(o, target, action) {
    const me = o.self,
      yaw = me.aim[0];
    if (!target) {
      action.aim = [wrap(yaw + 0.52), 0];
      action.reload = me.weapons.some(
        (w) => w?.kind === "gun" && w.ammo < w.stats.mag * 0.8,
      );
      return;
    }
    const { a, d, z } = target;
    const laser = me.weapons.find((w) => w?.kind === "laser"),
      gun = me.weapons.find((w) => w?.kind === "gun");
    const beamDue =
      laser &&
      d <= laser.stats.range &&
      laser.cooldown <= 0.1 &&
      (laser.charge >= laser.stats.charge - 0.16 || !gun);
    const flight = beamDue
      ? 0.035
      : Math.min(0.95, d / (gun?.stats.speed || 252)) + 0.035;
    const aimPos = [
      a.pos[0] + (a.vel?.[0] || 0) * flight,
      a.pos[1] + (a.vel?.[1] || 0) * flight,
    ];
    const bearing = angle(me.pos, aimPos),
      range = Math.max(1, distance(me.pos, aimPos));
    const pitch = Math.atan2(
      a.pos[2] +
        z +
        (a.vel?.[2] || 0) * Math.min(flight, 0.22) -
        me.pos[2] -
        me.stats.muzzle_height,
      range,
    );
    action.aim = [
      bearing,
      clamp(pitch, me.stats.min_pitch, me.stats.max_pitch),
    ];
    const yawError = Math.abs(wrap(yaw - bearing)),
      pitchError = Math.abs(pitch - me.aim[1]);
    for (let i = 0; i < 2; i++) {
      const w = me.weapons[i];
      if (!w) continue;
      const tolerance = clamp(
        (a.kind === "crate" ? 1.4 : 2.7) / Math.max(5, d),
        0.015,
        0.22,
      );
      const onTarget =
        yawError <= tolerance + 0.07 && pitchError <= tolerance + 0.045;
      if (w.kind === "gun") action.fire[i] = onTarget && d <= w.stats.range;
      if (w.kind === "laser")
        action.fire[i] =
          d <= w.stats.range &&
          w.cooldown <= 0.1 &&
          !(w.charge >= w.stats.charge - 0.055 && onTarget);
      if (w.kind === "lightning")
        action.fire[i] =
          d < w.stats.range && yawError < (w.stats.cone_deg * Math.PI) / 180;
    }
    if (
      gun &&
      gun.ammo <= 2 &&
      (!action.fire[me.weapons.indexOf(gun)] || d > 180)
    )
      action.reload = true;
  }
  zone(o, ahead) {
    const zone = o.zone;
    const frac = clamp(
      (o.t + ahead - zone.shrink_start) /
        Math.max(0.1, zone.shrink_end - zone.shrink_start),
      0,
      1,
    );
    return [
      zone.center[0] + frac * (zone.next_center[0] - zone.center[0]),
      zone.center[1] + frac * (zone.next_center[1] - zone.center[1]),
      zone.radius + frac * (zone.next_radius - zone.radius),
    ];
  }
  destination(o, target) {
    const me = o.self,
      p = me.pos,
      z = this.zone(o, 12),
      radius = Math.max(1, z[2]);
    if (distance(p, z) > Math.max(radius - 10, radius * 0.85))
      return { pos: z.slice(0, 2), urgent: true };
    const hasBeam = me.weapons.some((w) => w?.kind === "laser");
    const preparing = this.preparing(o);
    let best = null,
      value = 0;
    for (const item of this.items.values()) {
      const d = distance(p, item.pos),
        height = item.pos[2] - p[2];
      if (height > 35 || distance(item.pos, z) > radius + 3) continue;
      let benefit = 0;
      if (
        item.type === "pickups" &&
        !me.weapons.some((w) => w?.kind === item.kind)
      ) {
        benefit =
          item.kind === "laser"
            ? preparing
              ? 340
              : 220
            : item.kind === "lightning" && !hasBeam
              ? 65
              : 0;
      } else if (item.type === "cubes") benefit = me.cubes < 10 ? 95 : 27;
      else if (item.type === "crates" && (preparing || !target))
        benefit = preparing ? 64 : hasBeam ? 22 : 40;
      if (!benefit) continue;
      const unsafe =
        preparing &&
        (o.mechs || []).some(
          (a) => a.kind === "mech" && distance(a.pos, item.pos) < 50,
        );
      const utility =
        (benefit * (unsafe ? 0.44 : 1)) / (16 + d + Math.max(0, height) * 2.6);
      if (utility > value) {
        best = item;
        value = utility;
      }
    }
    for (const drop of o.drops || []) {
      const d = distance(p, drop.pos);
      const utility =
        (me.hp < me.max_hp * 0.75 ? 190 : 85) /
        (20 + d + Math.max(0, drop.lands_in - d / 12) * 5);
      if (utility > value && distance(drop.pos, z) < radius) {
        best = { ...drop, capture: true };
        value = utility;
      }
    }
    if (
      best &&
      (!target ||
        target.a.kind !== "mech" ||
        (preparing && target.d > 60 && best.type !== "crates") ||
        (best.kind === "laser" &&
          (!target.engaged || distance(p, best.pos) < 65)) ||
        (best.type === "cubes" && distance(p, best.pos) < 24) ||
        best.capture)
    )
      return best;
    if (target && target.a.kind === "mech")
      return { opponent: true, pos: target.a.pos };
    if (hasBeam && !target && me.in_zone && me.hp < me.max_hp * 0.84)
      return { pos: p, rest: true };
    if (
      !this.patrol ||
      o.t > this.patrol.until ||
      distance(p, this.patrol.pos) < 12
    ) {
      const phase = (this.seed % 97) * 0.16 + Math.floor(o.t / 8) * 2.39996;
      const r = Math.min(radius * 0.58, 165);
      this.patrol = {
        pos: [z[0] + Math.cos(phase) * r, z[1] + Math.sin(phase) * r, p[2]],
        until: o.t + 12,
      };
    }
    return this.patrol;
  }
  approachLoot(o, goal, action) {
    // A roof needs clear air for takeoff. Charging into its wall can trap the mech under an eave.
    const me = o.self,
      p = me.pos;
    if (!["pickups", "cubes", "crates"].includes(goal.type)) return goal;
    const top = goal.pos[2],
      cell = this.map.key(...goal.pos);
    if (Math.abs(this.map.roof[cell] - top) > 2 || !Number.isFinite(top))
      return goal;
    const altitude = top - p[2];
    if (altitude < 1.2 && !this.ascent?.active) return goal;
    if (this.ascent?.id !== goal.id) {
      this.ascent = {
        id: goal.id,
        edge: this.map.roofApproach(p, goal.pos),
        active: false,
      };
    }
    const route = this.ascent.edge;
    if (!route) return goal;
    const { launch, land } = route;
    if (me.grounded && altitude < 1.2) {
      this.ascent.active = false;
      return goal;
    }
    if (me.grounded && distance(p, launch) > 4.5) this.ascent.active = false;
    if (!this.ascent.active && distance(p, launch) > 4.5)
      return { pos: launch };
    if (!this.ascent.active) {
      const required =
        12 +
        (Math.max(0, altitude) * me.stats.jet_drain) /
          Math.max(1, me.stats.max_rise_speed);
      if (me.energy < Math.min(me.max_energy, required)) {
        action.move = [0, 0];
        action.boost = false;
        return null;
      }
      this.ascent.active = true;
    }
    action.jump = me.grounded;
    action.boost = altitude > 1.2 || (altitude > -2.5 && me.vel[2] < 3);
    // Clear the lip before crossing. Under the lip, jumping straight into the wall wastes fuel.
    if (altitude > 1.2 && distance(p, launch) < 4.5) action.move = [0, 0];
    else {
      const yaw = angle(p, land);
      action.move = [Math.cos(yaw), Math.sin(yaw)];
    }
    return null;
  }
  move(o, target, goal, action) {
    goal = this.approachLoot(o, goal, action);
    if (!goal) return;
    const me = o.self,
      p = me.pos,
      threat = target?.a.kind === "mech",
      d = target?.d ?? 999;
    let desired,
      boost = false;
    if (goal.rest) {
      action.move = [0, 0];
      return;
    }
    if (
      goal.capture &&
      distance(p, goal.pos) < goal.radius * 0.62 &&
      !goal.lands_in
    ) {
      action.move = [0, 0];
      return;
    }
    if (goal.opponent) {
      const base = angle(target.a.pos, p),
        side = Math.sin((this.seed % 20) + o.t * 0.92) > 0 ? 1 : -1;
      const optimal = me.weapons.some((w) => w?.kind === "laser") ? 205 : 162;
      const radial = clamp((optimal - d) / 22, -0.5, 3.4),
        offset = Math.atan2(side, radial);
      desired = base + offset;
      boost =
        me.energy > 22 &&
        (d < optimal - 20 || target.a.charging || me.energy > 72);
    } else {
      const range = distance(p, goal.pos);
      desired = this.map.heading(p, goal.pos);
      boost = me.energy > (goal.urgent ? 16 : 40) && range > 12;
      if (
        goal.pos.length >= 3 &&
        goal.pos[2] - p[2] > 3 &&
        range < 24 &&
        me.energy > 16
      ) {
        action.jump = true;
        boost = true;
        desired = angle(p, goal.pos);
      }
    }
    const guard = this.zone(o, 2);
    const nearMisses = [];
    for (const shot of o.projectiles || []) {
      const rx = shot.pos[0] - p[0],
        ry = shot.pos[1] - p[1],
        vx = shot.vel[0] - me.vel[0],
        vy = shot.vel[1] - me.vel[1];
      const time = -(rx * vx + ry * vy) / Math.max(1, vx * vx + vy * vy);
      if (time < 0.08 || time > 0.85) continue;
      const x = rx + time * vx,
        y = ry + time * vy,
        z = shot.pos[2] + shot.vel[2] * time - p[2] - me.vel[2] * time;
      if (Math.hypot(x, y) > 12 || z < -2 || z > me.stats.height + 2) continue;
      nearMisses.push([x, y, time]);
    }
    if (nearMisses.length && me.energy > 25) boost = true;
    const travel = boost ? 13 : 9;
    let best = desired,
      high = -Infinity;
    for (const offset of [
      0,
      0.38,
      -0.38,
      0.8,
      -0.8,
      1.25,
      -1.25,
      1.65,
      -1.65,
      2.3,
      -2.3,
      Math.PI,
    ]) {
      const dir = desired + offset,
        end = [p[0] + Math.cos(dir) * travel, p[1] + Math.sin(dir) * travel];
      const clear = this.map.open(p, dir, travel),
        soon = this.map.open(p, dir, 3.5);
      let utility =
        Math.cos(offset) * 4 -
        (clear ? 0 : 6) -
        (soon ? 0 : 6) -
        Math.max(0, distance(end, guard) - guard[2]) * 0.45;
      for (const [missX, missY, time] of nearMisses) {
        const speed = boost ? me.stats.boost_speed : me.stats.walk_speed;
        const slide = Math.min(time * 0.6, 0.3);
        const miss = Math.hypot(
          missX - (Math.cos(dir) * speed - me.vel[0]) * slide,
          missY - (Math.sin(dir) * speed - me.vel[1]) * slide,
        );
        utility -= Math.max(0, 5 - miss) * clamp(1.5 - time, 0.5, 1.5);
      }
      if (threat && target.a.charging)
        utility += 0.8 * Math.abs(Math.sin(dir - angle(p, target.a.pos)));
      if (utility > high) {
        high = utility;
        best = dir;
      }
    }
    action.move = [Math.cos(best), Math.sin(best)];
    action.boost = boost;
    if (threat && target.a.charging && d < 190 && me.grounded && me.energy > 30)
      action.jump = true;
    if (!this.map.open(p, best, 3.5) && me.energy > 50) {
      action.jump = true;
      action.boost = true;
    }
  }
  act(o) {
    this.remember(o);
    const action = { tick: o.tick, fire: [false, false] },
      target = this.chooseTarget(o);
    this.offense(o, target, action);
    const goal = this.destination(o, target);
    this.move(o, target, goal, action);
    if (
      this.preparing(o) &&
      goal.type === "crates" &&
      distance(o.self.pos, goal.pos) < 9 &&
      Math.abs(o.self.pos[2] - goal.pos[2]) < 2.5 &&
      !(o.mechs || []).some(
        (a) => a.kind === "mech" && distance(a.pos, o.self.pos) < 95,
      )
    ) {
      action.move = [0, 0];
      action.boost = false;
    }
    const me = o.self;
    for (const item of o.pickups || []) {
      if (
        distance(me.pos, item.pos) >= this.config.loot.pickup_radius ||
        Math.abs(me.pos[2] - item.pos[2]) >= 4 ||
        me.weapons.some((w) => w?.kind === item.kind) ||
        (gearRank[item.kind] ?? 0) < 2
      )
        continue;
      const slot = me.weapons.findIndex((w) => !w);
      if (slot < 0) {
        const worst =
          gearRank[me.weapons[0].kind] <= gearRank[me.weapons[1].kind] ? 0 : 1;
        if (
          gearRank[item.kind] <= gearRank[me.weapons[worst].kind] ||
          me.weapons[worst].charge > 0
        )
          continue;
        action.drop = worst;
      }
      action.take = item.id;
      break;
    }
    if (o.offer) {
      const ranks = [
        "plating",
        "armor",
        "laser_damage",
        "nanites",
        "gun_damage",
        "gun_rate",
        "laser_charge",
        "servos",
        "jets",
        "reactor",
        "lightning_range",
        "capacitor",
        "gun_mag",
        "gun_velocity",
        "gyros",
        "sensors",
      ];
      let best = 999,
        index = 0;
      o.offer.choices.forEach((v, i) => {
        const j = ranks.indexOf(v.id);
        if (j >= 0 && j < best) {
          index = i;
          best = j;
        }
      });
      action.pick = index;
    }
    return action;
  }
}
