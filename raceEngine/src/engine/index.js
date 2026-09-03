// ── L'API publique du moteur ───────────────────────────────────
//
// Deux fonctions suffisent a faire tourner une course : `createWorldState` et
// `stepPhysics`. Tout le reste n'est expose que pour les OBSERVATEURS — bancs
// d'essai, releve de decision, protocole — qui ont besoin de relire une grandeur
// sans la recalculer. Aucun consommateur externe n'ecrit dans l'etat.

export { randomRange, shuffleArray } from './math.js';
export { getShortestDistance } from './geometry.js';
export { steerCap, steerCost, steerDelay, steerGrip, steerPace, steerReach } from './steering.js';
export { deriveCharacterStats, getInitialKartSpeed, getMomentumSpeed, getNewMomentumTarget } from './stats.js';
export { getDistanceToLeader, getKartByRank, updateLeaderboard } from './standings.js';
export { computeItemAxes, getOrbitSpec, isItemEnabled, rollItem } from './items.js';
export { activateItem, destroyOrbitItem, getHoldPosition, getOrbitItemPosition, giveKartItem, removeOrbitItem, spawnLaunchedItem, updateOrbitItems } from './weapons.js';
export { updateAI } from './ai.js';
export { stepPhysics } from './step.js';
export { createWorldState } from './world.js';
