// API publique du moteur : `createWorldState` et `stepPhysics`. Le reste est
// expose en lecture pour les outils et le protocole.

export { randomRange, shuffleArray } from './math.js';
export { getShortestDistance } from './geometry.js';
export { steerCap, steerCost, steerDelay, steerGrip, steerPace, steerReach } from './steering.js';
export { deriveCharacterStats, getInitialKartSpeed, getMomentumSpeed, getNewMomentumTarget } from './stats.js';
export { getDistanceToLeader, getKartByRank, updateLeaderboard } from './standings.js';
export { computeItemAxes, getOrbitSpec, isItemEnabled, rollItem } from './items.js';
export { activateItem, destroyOrbitItem, getHoldPosition, getOrbitItemPosition, giveKartItem, removeOrbitItem, spawnLaunchedItem, updateOrbitItems } from './weapons.js';
export { updateAI } from './ai.js';
export { stepPhysics } from './step.js';
export { createWorldState, pickRoster } from './world.js';
