import { clamp, distance, angle, wrap } from "./terrain.mjs";

import { Field } from "./field.mjs";

const gearRank = { laser: 4, lightning: 2, gun: 3, mortar: 1 };
const up = (pos, height) => [pos[0], pos[1], pos[2] + height];
export class Tactics {
  constructor(hello, terrain) {
    this.config = hello.config;
    this.map = terrain;
    this.field = new Field(hello.config, hello.slot);
    this.slot = hello.slot;
    this.seed = hello.seed >>> 0;
    this.items = new Map();
    this.aggressors = new Map();
    this.lock = null;
    this.patrol = null;
  }
  remember(o) {
    this.field.observe(o, this.map);
    this.beamTimes ??= new Map();
    for (const beam of o.beams || [])
      if (beam.kind === "laser" && beam.by != null)
        this.beamTimes.set(beam.by, o.t - (beam.age ?? 0));
    for (const event of o.events || [])
      if (
        event.type === "damaged" &&
        event.weapon === "laser" &&
        event.by != null
      )
        this.beamTimes.set(event.by, o.t);
    let strongestHit = null;
    for (const event of o.events || []) {
      if (event.type !== "damaged") continue;
      if (event.by != null) this.aggressors.set(event.by, o.t);
      if (
        event.weapon !== "npc" &&
        Number.isFinite(event.bearing) &&
        (!strongestHit || event.amount > strongestHit.amount)
      )
        strongestHit = event;
    }
    if (strongestHit)
      this.warning = { yaw: strongestHit.bearing, until: o.t + 1.15 };
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
    const armed = beam || me.weapons.some((w) => w?.kind === "lightning");
    // When most of the field survives the opening, the next pursuer matters more than distant loot.
    const squadOpening =
      !this.field.ffa &&
      o.t >= 14 &&
      o.alive >= 13 &&
      (this.field.watchers.some(
        (a) => this.aggressors.has(a.id) && o.t - this.aggressors.get(a.id) < 3,
      ) ||
        (o.t >= 23 && (armed || me.cubes >= 1 || o.t >= 36)));
    if (squadOpening || o.t > 65 || (me.cubes >= 3 && beam) || o.alive < 9)
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
    const duel = o.alive === 2;
    const ffa = this.field.ffa && !duel;
    const low = me.hp < me.max_hp * 0.67;
    for (const a of actors) {
      const d = distance(pos, a.pos);
      if (d > range + 8) continue;
      const mech = a.kind === "mech";
      const height = mech
        ? this.config.mech.height *
          (1 + (a.cubes ?? 0) * this.config.cubes.size_per_cube)
        : a.kind === "npc"
          ? 3.8
          : 2.5;
      let z = height * 0.5;
      if (!this.map.visible(muzzle, up(a.pos, z))) {
        z = height * 0.84;
        if (!mech || !this.map.visible(muzzle, up(a.pos, z))) continue;
      }
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
      const distracted = mech && ffa && this.field.distracted(o, a);
      const urgent =
        mech && (engaged || d < 55 || (a.charging && attention < 0.36));
      const sideShot = mech && attention > 1.65;
      const flimsy = a.hp < me.hp * (sideShot ? 0.78 : 0.55);
      const freeShot =
        (distracted && (wounded > 0.23 || hasBeam)) ||
        (flimsy && (hasBeam || d < 125)) ||
        (sideShot &&
          hasBeam &&
          !a.weapons?.includes("laser") &&
          d > 95 &&
          !low);
      if (ffa && mech && !urgent && !freeShot) continue;
      const healing =
        me.hp < me.max_hp * 0.64 && o.t - this.field.lastDamage < 22;
      const pest = this.field.pest;
      if (
        !duel &&
        !mech &&
        healing &&
        !this.field.visible.length &&
        !(a.kind === "npc" && pest?.id === a.id && o.t - pest.t < 4)
      )
        continue;
      if (
        ffa &&
        !mech &&
        (this.field.lastDanger > o.t - 2 ||
          (low && o.t - this.field.lastDamage < 20 && a.kind !== "npc"))
      )
        continue;
      if (!duel && !ffa && preparing && a.kind === "mech") {
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
      const soloHunt =
        !preparing &&
        !ffa &&
        !duel &&
        d < (hasBeam ? 170 : 135) &&
        me.hp >= me.max_hp * 0.73 &&
        this.field.visible.length <= 2 &&
        (attention > 0.8 ||
          (a.hp ?? Infinity) < me.hp ||
          !a.weapons?.includes("laser"));
      if (
        a.kind === "mech" &&
        !soloHunt &&
        !duel &&
        !ffa &&
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
      if (mech && duel) score += 1000;
      if (mech && ffa)
        score +=
          (distracted ? 24 : 0) +
          (freeShot ? 12 : 0) +
          (urgent && d < 60 ? 24 : 0);
      if (score > high) {
        high = score;
        chosen = { a, d, z, engaged };
      }
    }
    if (
      chosen?.a.kind !== "mech" &&
      this.warning?.until > o.t &&
      Math.abs(wrap(this.warning.yaw - me.aim[0])) > 0.7
    )
      return null;
    if (chosen) this.lock = chosen.a.id;
    if (chosen?.a.kind === "mech")
      this.contact = { id: chosen.a.id, pos: [...chosen.a.pos], t: o.t };
    return chosen;
  }
  offense(o, target, action) {
    const me = o.self,
      yaw = me.aim[0];
    if (!target) {
      const watch =
        this.field.watchers[0] ??
        (this.field.ffa ? this.field.visible[0] : null);
      action.aim =
        this.warning?.until > o.t
          ? [this.warning.yaw, 0]
          : watch
            ? [angle(me.pos, watch.pos), 0]
            : [wrap(yaw + 0.52), 0];
      action.reload = me.weapons.some(
        (w) =>
          w?.kind === "gun" &&
          w.reload <= 0 &&
          (w.ammo === 0 ||
            (o.t - this.field.lastContact > 1 &&
              w.ammo <= w.stats.mag * (this.field.ffa ? 0.32 : 0.65))),
      );
      return;
    }
    const { a, d, z } = target;
    const laser = me.weapons.find((w) => w?.kind === "laser"),
      gun = me.weapons.find((w) => w?.kind === "gun");
    // Charging slows movement, so only use the laser on a drone we can safely collect.
    const allowBeam =
      a.kind !== "npc" ||
      (d <= 55 &&
        me.hp > 0.75 * me.max_hp &&
        !(o.mechs || []).some(
          (other) => other.kind === "mech" && distance(me.pos, other.pos) < 110,
        ));
    const tickTime = 1 / Math.max(1, this.config.match.tick_hz);
    const vx = a.vel?.[0] ?? 0,
      vy = a.vel?.[1] ?? 0,
      vz = a.vel?.[2] ?? 0;
    const muzzle = up(me.pos, me.stats.muzzle_height);
    const aimAfter = (delay) => {
      const x = a.pos[0] + vx * delay - (muzzle[0] + me.vel[0] * tickTime);
      const y = a.pos[1] + vy * delay - (muzzle[1] + me.vel[1] * tickTime);
      const vertical = vz * Math.min(delay, 0.25);
      const dz = a.pos[2] + z + vertical - muzzle[2] - me.vel[2] * tickTime;
      return [
        Math.atan2(y, x),
        clamp(
          Math.atan2(dz, Math.hypot(x, y)),
          me.stats.min_pitch,
          me.stats.max_pitch,
        ),
      ];
    };
    const beamAim = aimAfter(tickTime),
      gunAim = (() => {
        const rx = a.pos[0] - muzzle[0] + (vx - me.vel[0]) * tickTime;
        const ry = a.pos[1] - muzzle[1] + (vy - me.vel[1]) * tickTime;
        const speed = gun?.stats.speed ?? 252;
        const approach = rx * vx + ry * vy,
          closing = speed * speed - vx * vx - vy * vy;
        const flight =
          closing > 1
            ? (approach +
                Math.sqrt(
                  approach * approach + closing * (rx * rx + ry * ry),
                )) /
              closing
            : d / speed;
        return aimAfter(tickTime + Math.min(1.1, flight));
      })();
    const full = laser && laser.charge >= laser.stats.charge - 0.055;
    const cubeBonus =
      this.config.cubes.damage_per_cube *
      Math.min(me.cubes, this.config.cubes.stat_cap);
    let enoughToFinish = false;
    if (
      laser &&
      a.kind === "mech" &&
      a.hp != null &&
      laser.charge >= laser.stats.min_charge
    ) {
      const chargeFraction = Math.min(1, laser.charge / laser.stats.charge);
      const damageFraction =
        laser.stats.min_frac + (1 - laser.stats.min_frac) * chargeFraction;
      enoughToFinish =
        a.hp <= 0.8 * laser.stats.damage * (1 + cubeBonus) * damageFraction;
    }
    const lineUp =
      allowBeam &&
      laser &&
      laser.cooldown <= tickTime &&
      d <= laser.stats.range &&
      (laser.charge >= laser.stats.charge * 0.55 || !gun || enoughToFinish);
    action.aim = lineUp ? beamAim : gunAim;
    // Each slot shares one torso. Check where it can actually point on the next physics tick.
    const nextYaw =
      yaw +
      clamp(
        wrap(action.aim[0] - yaw),
        -me.stats.turn_rate * tickTime,
        me.stats.turn_rate * tickTime,
      );
    const nextPitch =
      me.aim[1] +
      clamp(
        action.aim[1] - me.aim[1],
        -me.stats.pitch_rate * tickTime,
        me.stats.pitch_rate * tickTime,
      );
    const radius =
      a.kind === "mech"
        ? this.config.mech.radius *
          (1 + (a.cubes ?? 0) * this.config.cubes.size_per_cube)
        : a.kind === "npc"
          ? this.config.npc.radius
          : this.config.crates.radius;
    const tolerance = Math.atan2(radius, Math.max(d, 1));
    const aligned = (angles, slack) =>
      Math.abs(wrap(nextYaw - angles[0])) < tolerance * slack &&
      Math.abs(nextPitch - angles[1]) <
        Math.max(tolerance, Math.atan2(z, d)) * slack;
    for (let i = 0; i < me.weapons.length; i++) {
      const w = me.weapons[i];
      if (!w) continue;
      if (w.kind === "gun")
        action.fire[i] = d <= w.stats.range && aligned(gunAim, 1.4);
      if (
        w.kind === "laser" &&
        allowBeam &&
        d <= w.stats.range &&
        w.cooldown <= 0.1
      )
        action.fire[i] = !((full || enoughToFinish) && aligned(beamAim, 1));
      if (w.kind === "lightning")
        action.fire[i] =
          d < w.stats.range &&
          me.energy >= w.stats.energy &&
          Math.abs(wrap(nextYaw - beamAim[0])) <
            (w.stats.cone_deg * Math.PI) / 180;
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
    const duel = o.alive === 2;
    if (duel && target?.a.kind === "mech")
      return { opponent: true, pos: target.a.pos };
    const hasBeam = me.weapons.some((w) => w?.kind === "laser");
    const field = this.field;
    const weak = me.hp < me.max_hp * 0.64;
    const snap = field.pressing.filter((a) => a.charging);
    const thirdParty = field.ffa && field.watchers.length > 1;
    const recover = weak && o.t - field.lastDamage < 22;
    const cleanFinish =
      target?.a.kind === "mech" && target.a.hp < (hasBeam ? 230 : 105);
    if (
      !duel &&
      !cleanFinish &&
      (thirdParty ||
        snap.length ||
        (recover && field.visible.length) ||
        (field.ffa && !target && field.watchers.length))
    ) {
      const threats = thirdParty || !snap.length ? field.visible : snap;
      const goal = field.shelter(o, this.map, z, threats);
      if (goal) {
        this.refuge = { ...goal, until: o.t + (weak ? 2.4 : 0.65) };
        return goal;
      }
    }
    if (
      !duel &&
      !field.visible.length &&
      this.refuge?.until > o.t &&
      distance(this.refuge.pos, z) < radius - 4
    )
      return this.refuge;
    if (!duel && recover && !target && !field.visible.length && me.in_zone)
      return { pos: p, rest: true };
    if (
      field.ffa &&
      o.alive > 2 &&
      o.t > 54 &&
      hasBeam &&
      me.cubes >= 5 &&
      target?.a.kind !== "mech" &&
      !field.watchers.length &&
      !field.visible.some((a) => distance(a.pos, p) < 110) &&
      o.t - field.lastDamage > 3 &&
      !(o.projectiles || []).some((q) => distance(p, q.pos) < 30)
    ) {
      const forecast = this.zone(o, 22);
      if (distance(p, forecast) < forecast[2] - 14) {
        const here = this.map.key(...p),
          top = this.map.roof[here];
        if (
          me.grounded &&
          Math.abs(p[2] - top) < 1.5 &&
          top - this.map.ground[here] >= 10
        )
          return { pos: p, rest: true, perched: true };
        if (this.lookout && o.t >= this.lookout.until) {
          this.avoidedRoof = { pos: this.lookout.goal.pos, until: o.t + 32 };
          this.lookout = null;
          this.nextLookout = o.t + 8;
        }
        if (!this.lookout && o.t >= (this.nextLookout ?? 0)) {
          const goal = this.map.lookout(
            p,
            forecast,
            me.energy,
            me.stats,
            this.avoidedRoof?.until > o.t ? this.avoidedRoof.pos : null,
          );
          this.nextLookout = o.t + 4;
          if (goal) this.lookout = { goal, until: o.t + 14 };
        }
        if (
          this.lookout &&
          distance(this.lookout.goal.pos, forecast) < forecast[2] - 14
        )
          return this.lookout.goal;
      }
    }
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
      if (
        field.ffa &&
        (d > (item.kind === "laser" ? 155 : 94) ||
          (item.type === "cubes" && me.cubes >= this.config.cubes.stat_cap))
      )
        continue;
      const risk = field.ffa ? field.lootRisk(item.pos) : 0;
      if (risk > 0.9 && d > 12) continue;
      const utility =
        (benefit * (unsafe ? 0.44 : 1)) /
        (1 + 3 * risk) /
        (16 + d + Math.max(0, height) * 2.6);
      if (utility > value) {
        best = item;
        value = utility;
      }
    }
    for (const drop of o.drops || []) {
      const d = distance(p, drop.pos);
      const occupied = drop.holder != null && drop.holder !== this.slot;
      if (
        (occupied && target?.a.kind === "mech") ||
        (!field.ffa &&
          target?.a.kind === "mech" &&
          (cleanFinish || (target.d < 110 && d > 48)))
      )
        continue;
      if (field.ffa && (d > 100 || occupied || field.lootRisk(drop.pos) > 0.45))
        continue;
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
        (best.type === "cubes" &&
          distance(p, best.pos) <
            (me.cubes < 10 && (target.d > 85 || target.a.hp > 250)
              ? 62
              : 24)) ||
        best.capture)
    )
      return best;
    if (target && target.a.kind === "mech")
      return { opponent: true, pos: target.a.pos };
    if (
      !target &&
      !field.ffa &&
      (duel || !preparing) &&
      this.contact &&
      !field.ownKills.has(this.contact.id) &&
      o.t - this.contact.t < 3.5 &&
      distance(p, this.contact.pos) > 22 &&
      distance(this.contact.pos, z) < radius - 8 &&
      (duel || me.hp > me.max_hp * 0.72)
    )
      return { pos: this.contact.pos };
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
    if (!["pickups", "cubes", "crates", "lookout"].includes(goal.type))
      return goal;
    const top = goal.pos[2],
      cell = this.map.key(...goal.pos);
    if (Math.abs(this.map.roof[cell] - top) > 2 || !Number.isFinite(top))
      return goal;
    const altitude = top - p[2];
    if (altitude < 1.2 && !this.ascent?.active) return goal;
    if (this.ascent?.id !== goal.id) {
      this.ascent = {
        id: goal.id,
        edge: goal.edge ?? this.map.roofApproach(p, goal.pos),
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
    if (
      goal.rest ||
      (goal.shelter &&
        distance(p, goal.pos) < 3 &&
        !threat &&
        !(o.projectiles || []).length)
    ) {
      action.move = [0, 0];
      return;
    }
    if (
      goal.capture &&
      distance(p, goal.pos) < goal.radius * 0.62 &&
      !goal.lands_in &&
      !this.field.pressing.some((a) => distance(a.pos, p) < 65) &&
      !(o.projectiles || []).some((shot) => distance(shot.pos, p) < 27)
    ) {
      action.move = [0, 0];
      return;
    }
    if (goal.opponent) {
      const base = angle(target.a.pos, p),
        side = Math.sin((this.seed % 20) + o.t * 0.92) > 0 ? 1 : -1;
      const beam = me.weapons.some((w) => w?.kind === "laser");
      const arc = me.weapons.find((w) => w?.kind === "lightning");
      const enemyArc = target.a.weapons?.includes("lightning");
      // A gun needs a shorter flight against a moving pilot. With a laser
      // advantage we can instead trade from beyond an accurate gun burst.
      let optimal = beam
        ? target.a.weapons?.includes("laser")
          ? 152
          : 188
        : target.a.weapons?.includes("laser")
          ? 82
          : 108;
      if (arc && !beam && !enemyArc && target.a.hp < me.hp * 0.85)
        optimal = arc.stats.range * 0.83;
      if (enemyArc)
        optimal = Math.max(optimal, this.config.weapons.lightning.range + 19);
      const recentlyFired =
        o.t - (this.beamTimes.get(target.a.id) ?? -100) < 0.9;
      const safeToClose =
        recentlyFired &&
        d > 104 &&
        me.hp > me.max_hp * 0.52 &&
        !(o.mechs || []).some(
          (a) =>
            a.kind === "mech" &&
            a.id !== target.a.id &&
            distance(p, a.pos) < 105,
        );
      const preferred = safeToClose ? Math.min(optimal, 135) : optimal;
      const radial = clamp((preferred - d) / 24, beam ? -0.8 : -1.6, 3.4),
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
    let crossing = null;
    if (
      threat &&
      target.a.charging &&
      Math.abs(wrap(angle(target.a.pos, p) - target.a.aim[0])) < 0.32
    ) {
      if (
        this.chargeTrack?.id !== target.a.id ||
        o.t - this.chargeTrack.seen > 0.22
      ) {
        const yaw = angle(target.a.pos, p),
          lateral = -Math.sin(yaw) * me.vel[0] + Math.cos(yaw) * me.vel[1];
        const side =
          Math.abs(lateral) > 1
            ? Math.sign(lateral)
            : Math.sin(desired - yaw) >= 0
              ? 1
              : -1;
        this.chargeTrack = { id: target.a.id, start: o.t, side };
      }
      this.chargeTrack.seen = o.t;
      if (o.t - this.chargeTrack.start >= 0.28 && d < 205 && me.energy > 18) {
        crossing =
          angle(target.a.pos, p) + (this.chargeTrack.side * Math.PI) / 2;
        boost = true;
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
      if (crossing !== null && !goal.urgent && !goal.shelter)
        utility += 3.2 * Math.cos(dir - crossing);
      if (threat && target.a.charging)
        utility += 0.8 * Math.abs(Math.sin(dir - angle(p, target.a.pos)));
      if (utility > high) {
        high = utility;
        best = dir;
      }
    }
    const quiet =
      this.field.ffa &&
      !goal.urgent &&
      !goal.opponent &&
      !goal.shelter &&
      o.alive > 2 &&
      !threat &&
      !nearMisses.length &&
      this.field.pressing.length === 0 &&
      o.t - this.field.lastDamage > 3 &&
      this.field.visible.length > 0 &&
      me.grounded &&
      !action.jump &&
      distance(p, goal.pos) < 30;
    const speed = quiet
      ? Math.min(1, (0.92 * this.config.sound.step_speed) / me.stats.walk_speed)
      : 1;
    action.move = [Math.cos(best) * speed, Math.sin(best) * speed];
    action.boost = quiet ? false : boost;
    if (
      crossing !== null &&
      o.t - this.chargeTrack.start > 0.48 &&
      d < 170 &&
      me.grounded &&
      me.energy > 40
    )
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
    const goal = this.destination(o, target);
    const overlook = goal.perched || goal.type === "lookout";
    this.offense(
      o,
      overlook && target?.a.kind !== "mech" ? null : target,
      action,
    );
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
