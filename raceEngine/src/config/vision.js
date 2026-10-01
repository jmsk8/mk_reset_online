// Vision : portee du regard, occlusion et memoire.

export default {
    // Un kart ne reagit qu'a ce qu'il voit, d'un cote a la fois, et un corps
    // solide lui bouche la vue (reactions : voir `ai`).
    vision: {
        // Portee du regard en px de monde, identique pour tous ; l'avant vaut
        // `pipe.seeDistance`.
        range: { front: 1400, back: 1000 },

        // Bande de profondeur ou un objet est surveille (plus large que le
        // degagement).
        threatLane: 12,

        // Periode du balayage, decalee par `kart.id` (le pilotage reste a
        // cadence pleine).
        scanIntervalMs: 80,

        // Occlusion vue depuis la camera de poursuite : un corps de hauteur Hk,
        // vu d'un oeil a hauteur H et distance D, porte son ombre sur
        // `D * Hk / (H - Hk)`.
        eye: {
            // Recul de la camera derriere le kart, en px monde (echelle de
            // l'occlusion).
            back: 125,

            // Longueur de l'ombre en fraction de la distance a l'oeil
            // (`H / Hk = 1 + 1/run`) :
            //     0     vue de dessus, plus rien ne masque
            //     0.35  camera a environ quatre hauteurs de kart
            //     1     deux hauteurs
            run: 0.35
        },

        // Multiplicateur de la demi-profondeur du corps pour son ombre.
        shadowGain: 1.0,

        // Une rouge reste visible meme masquee (comme le son dans le jeu d'origine).
        seeHomingThroughCover: true,

        // Regarder derriere remplace la vue avant (les tuyaux restent connus).
        // Cadence a laquelle il se demande s'il regarde derriere.
        glanceIntervalMs: 1150,

        // Duree du coup d'oeil, tiree au sort.
        glanceDurationMin: 500,
        glanceDurationMax: 1200,

        // Probabilite de tourner la tete, par place.
        backChance: { leader: 0.30, pack: 0.10, last: 0.04 },

        // Apres une zone de boites (remplace `backChance` si plus haute).
        backChanceBox: { leader: 0.50, pack: 0.30, last: 0.10 },
        boxGlanceMs: 4000,

        // Apres avoir vu un danger, tant que le souvenir est frais.
        backChanceDanger: { leader: 0.70, pack: 0.65, last: 0.65 },

        // Etoile ou bill qui arrive derriere (entendu, voir `hear`).
        backChanceRam: { leader: 0.85, pack: 0.85, last: 0.85 },

        // Ouie (`hear`) : quoi arrive et si c'est pour lui, jamais ou. Chaque
        // alerte a son interrupteur (compare par `tools/alerts.js`).
        alerts: {
            // Etoile et bill : sursaut et suivi du regard.
            //   leadMs   delai avant contact ou il se retourne
            //   quietMs  silence apres lequel un bruit est nouveau
            ram: { enabled: true, leadMs: 2500, quietMs: 2000 },

            // Rouge qui le vise : il se couvre (sans se retourner).
            //   miss  part des rouges qu'il n'entend pas venir
            red: { enabled: true, miss: 0.1 },

            // Bleue (premier, puis sa cible) : se proteger, sinon ceder la tete.
            //   miss         part des bleues non entendues
            //   etaError     erreur maximale sur l'echeance, tiree par bleue
            //   glance       chance de se retourner pour voir qui le suit
            //   yieldChance  part des premiers qui ont le reflexe de ceder
            //   yieldRange   distance maximale du suiveur
            //   closeTol     recul maximal du suiveur, en px/s
            //   brakeFactor  frein pour ceder
            //   passPx       distance a prendre par le suiveur en plus de l'ecart
            //   slackMs      marge sur le moment de lever le pied
            //   maxYieldMs   au-dela, il renonce
            //   clearPx      ecart laisse avec celui qui l'a double (souffle)
            //   hesitateMs   delai aleatoire supplementaire pour sortir le champignon
            blue: {
                enabled: true,
                miss: 0.1,
                etaError: 0.25,
                glance: 0.85,
                yieldChance: 0.6,
                yieldRange: 350,
                closeTol: 20,
                brakeFactor: 0.55,
                passPx: 60,
                slackMs: 400,
                maxYieldMs: 4000,
                clearPx: 340,
                hesitateMs: 300
            }
        },

        // Danger latent : un kart qui peut vous atteindre sans avoir rien lance
        // (`isArmedForward` derriere, `isTrailable` devant). Seulement se ranger
        // hors de l'axe. Distance maximale de la ligne de tir partagee.
        pressureRange: 700,

        // Duree de vie du souvenir d'un danger (et duree de garde en bouclier),
        // au-dessus de `glanceIntervalMs / backChanceDanger`.
        pressureMemoryMs: 3500,

        // Cadence de coup d'oeil quand on prepare un tir arriere.
        aimGlanceGain: 2.0,

        // Duree de vie du releve de visee (sous `ai.aimLeadMs`).
        aimMemoryMs: 900,

        // Precaution face au danger latent (dosage du jeu d'objets) :
        //   retryMs  delai avant de retenter apres un refus
        //   holdMs   duree du decalage
        //   speed    douceur du geste (sous `ai.dodgeIntensityMin`)
        safety: {
            chance: 0.5,
            retryMs: 900,
            holdMs: 2000,
            speed: 14
        },

        // Laisser passer une rouge qui suit (vue en regardant derriere) :
        // `chance` pour une rouge, `chanceRival` s'il y en a deux, `range`
        // distance maximale, `brakeFactor` frein doux.
        giveWay: {
            chance: 0.35,
            chanceRival: 0.10,
            range: 450,
            retryMs: 900,
            holdMs: 1600,
            speed: 14,
            brakeMs: 900,
            brakeFactor: 0.90
        },

        // Porteur derriere dont on se souvient : a chaque `safety.retryMs`,
        // `passChance` de le laisser passer s'il est a moins de `passRange` px
        // (sans objet de riposte), sinon `safety.chance` de se ranger.
        carrierBehind: {
            passRange: 300,
            passChance: 0.30
        },

        // Temps ajoute au temps avant impact pour l'echeance d'un plan.
        holdAfterMs: 500,

        // Intervalle de revision de trajectoire.
        reviewIntervalMs: 400,
        reviewChance: 0.5,

        // Variation aleatoire de cet intervalle (1 / 1 : cadence fixe).
        reviewJitterMin: 0.6, reviewJitterMax: 1.6,

        // Cout d'un choc en ms perdues (arbitrage `cout / temps restant`) :
        //     spin  pire coup de `hits` (bleue, 2 s)
        //     pipe  choc et recul d'un tuyau
        //     kart  bousculade
        //     edge  frolement de mur
        // L'ordre spin > pipe > kart > edge compte plus que les valeurs.
        cost: { spin: 2000, pipe: 850, kart: 300, edge: 80 },

        // Encombrement d'un couloir : `distance` jusqu'ou un kart devant occupe
        // le passage, `cost` par kart (cumule).
        crowd: { distance: 560, cost: 200 },

        // Placement en profondeur (voir `laneRisk` / `chooseLane`).
        place: {
            // Poids d'un detour face a un risque.
            detour: 1.0,

            // Chance de retenir chaque option du classement (1 : parfait).
            chance: 0.75,

            // Marge de confort autour de chaque corps (l'entamer coute).
            margin: { pipe: 1.5, item: 2, kart: 1 },

            // Imprecision par unite de volant (`laneSlop`) : ~0.8 pour koopa,
            // ~1.6 pour bowser.
            slop: 8,

            // Valeur d'une boite en ms gagnees (seul terme negatif).
            boxBonus: 400,

            // Gain minimal pour changer de couloir.
            commit: 150,

            // Cout de l'entame complete du confort, en fraction du cout de contact.
            graze: 0.35,

            // Poids d'un deplacement reporte (murs suivants) face au meme
            // deplacement immediat.
            debt: 2
        },

        // Nombre de menaces jugees gardees en memoire.
        memorySlots: 4,

        // Duree de vie d'un verdict depuis la derniere observation.
        memoryMs: 1500
    },
};
