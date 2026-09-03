// Le prechargement des images et le choix d'une frame de sprite.

// Rend une promesse tenue quand toutes les images sont decodees : c'est l'une
// des conditions de levee du rideau (§ bannerLink). Une image qui manque ne doit
// pas bloquer le banner, d'ou le catch — au pire elle apparaitra en retard.
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

    // Lakitu : feux de depart, panneaux de tour, drapeau a damier.
    LAKITU_SPRITES.forEach(([group, frame]) => {
        cache(`lakitu_${group}_${frame}`, GAME_CONFIG.resources.paths.lakitu(group, frame));
    });

    cache('banana', GAME_CONFIG.resources.paths.banana);
    cache('shroom', GAME_CONFIG.resources.paths.shroom);
    cache('star', GAME_CONFIG.resources.paths.star);

    GAME_CONFIG.resources.characters.forEach(charName => {
        cache(`pp_${charName}`, GAME_CONFIG.resources.paths.pp(charName));

        // Toutes les orientations, sinon le premier tête-à-queue clignote
        // le temps que les frames se téléchargent.
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
