// Prechargement des images et choix d'une frame de sprite.

// Promesse tenue quand toutes les images sont decodees (condition de levee du
// rideau). Une image manquante ne bloque pas.
function preloadImages() {
    const waits = [];

    function cache(key, src) {
        const img = new Image();
        img.src = src;
        imageCache[key] = img;
        waits.push(img.decode ? img.decode().catch(() => {})
                              : new Promise(resolve => { img.onload = img.onerror = resolve; }));
        return img;
    }

    for (let i = 1; i <= 3; i++) {
        cache(`greenShell_${i}`, GAME_CONFIG.resources.paths.greenShell(i));
        cache(`redShell_${i}`, GAME_CONFIG.resources.paths.redShell(i));
        cache(`blueShell_${i}`, GAME_CONFIG.resources.paths.blueShell(i));
        cache(`bill_${i}`, GAME_CONFIG.resources.paths.bill(i));
    }

    LAKITU_SPRITES.forEach(([group, frame]) => {
        cache(`lakitu_${group}_${frame}`, GAME_CONFIG.resources.paths.lakitu(group, frame));
    });

// Les huit places.
    for (let n = 1; n <= 8; n++) {
        cache(`position_${n}`, GAME_CONFIG.resources.paths.position(n));
    }

    cache('banana', GAME_CONFIG.resources.paths.banana);
    cache('shroom', GAME_CONFIG.resources.paths.shroom);
    cache('star', GAME_CONFIG.resources.paths.star);

    GAME_CONFIG.resources.characters.forEach(charName => {
        cache(`pp_${charName}`, GAME_CONFIG.resources.paths.pp(charName));

        // Toutes les orientations, pour que le tête-à-queue ne clignote pas.
        GAME_CONFIG.resources.kartDirections.forEach(dir => {
            cache(`kart_${charName}_${dir}`, GAME_CONFIG.resources.paths.charFrame(charName, dir));
        });
    });

    return Promise.all(waits);
}

function getKartFrameSrc(charName, dir) {
    const cached = imageCache[`kart_${charName}_${dir}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths.charFrame(charName, dir);
}
