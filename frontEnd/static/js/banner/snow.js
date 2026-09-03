// La neige, l'hiver seulement. Purement decoratif.

function initSnow() {
    const banner = document.querySelector('.hero.smk-snes-banner');
    if (!banner) return;

    let snowContainer = document.querySelector('.snow-container');
    if (!snowContainer) {
        snowContainer = document.createElement('div');
        snowContainer.className = 'snow-container';
        const gameWrapper = banner.querySelector('.game-content-wrapper');
        if (gameWrapper) {
            gameWrapper.appendChild(snowContainer);
        } else {
            banner.appendChild(snowContainer);
        }
    }

    const snowflakeCount = cachedIsMobile ? 50 : 100;
    const containerHeight = snowContainer.offsetHeight || 360;
    const containerWidth = snowContainer.offsetWidth || 1200;

    for (let i = 0; i < snowflakeCount; i++) {
        createFallingSnowflake(snowContainer, containerHeight, containerWidth);
    }

    const landedCount = cachedIsMobile ? 15 : 30;
    for (let i = 0; i < landedCount; i++) {
        createLandedSnowflake(snowContainer, containerWidth);
    }
}

function createFallingSnowflake(container, containerHeight, containerWidth) {
    const snowflake = document.createElement('div');
    snowflake.className = 'snowflake falling';

    const size = Math.random() * 3 + 2;
    snowflake.style.width = `${size}px`;
    snowflake.style.height = `${size}px`;

    const maxDrift = WORLD.roadPPS * (containerHeight / 80);
    const maxDriftPercent = (maxDrift / containerWidth) * 100;
    const startX = Math.random() * (110 + maxDriftPercent) - 10;
    snowflake.style.left = `${startX}%`;

    // Un flocon s'arrete SUR le bitume, jamais au-dessus : la borne haute de sa
    // chute est le bord haut de la piste, la part de scene occupee par le ciel.
    // Elle etait recopiee a la main (0.65, l'ancien decoupage 65/35) et pointait
    // dans le vide des que le cadre a grandi sans que la piste s'allonge. Elle
    // se mesure maintenant, comme tout le reste de la profondeur.
    const skyPart = (containerHeight > 0 && viewMetrics.groundHeight > 0)
        ? 1 - (viewMetrics.groundHeight / containerHeight)
        : 0.65;
    const fallEndPercent = skyPart + Math.random() * Math.max(0, 0.95 - skyPart);
    const fallHeight = containerHeight * fallEndPercent;

    const fallSpeed = 80 + Math.random() * 70;
    const duration = fallHeight / fallSpeed;
    snowflake.style.animationDuration = `${duration}s`;

    snowflake.style.animationDelay = `${Math.random() * duration}s`;

    const driftDistance = -(WORLD.roadPPS * duration);
    snowflake.style.setProperty('--snow-drift', driftDistance);
    snowflake.style.setProperty('--snow-fall-height', fallHeight);

    container.appendChild(snowflake);
}

function createLandedSnowflake(container, containerWidth) {
    const snowflake = document.createElement('div');
    snowflake.className = 'snowflake landed';

    const size = Math.random() * 1.5 + 1.5;
    snowflake.style.width = `${size}px`;
    snowflake.style.height = `${size}px`;

    // Une PROFONDEUR de piste, comme n'importe quel corps de la scene : le
    // flocon pose est sur le bitume. Ecrite en pourcentage de scene, elle
    // remontait dans le ciel des que le cadre grandissait sans que la piste
    // s'allonge. Elle ne passe pas par `depthToY` parce que l'animation de
    // derive occupe deja la `transform` de l'element.
    const depth = Math.random() * 32 + 1;
    snowflake.style.bottom = `${(depth * depthToWorldPx()).toFixed(1)}px`;

    const zIndex = (GAME_CONFIG.rendering.zIndexBase - depth) | 0;
    snowflake.style.zIndex = zIndex;

    snowflake.style.left = `${80 + Math.random() * 40}%`;

    const driftDistance = -containerWidth * 1.5;
    const driftDuration = (containerWidth * 1.5) / WORLD.roadPPS;

    snowflake.style.setProperty('--drift-distance', driftDistance);
    snowflake.style.animationDuration = `${driftDuration}s`;

    snowflake.style.animationDelay = `${Math.random() * driftDuration}s`;

    snowflake.addEventListener('animationend', () => {
        snowflake.remove();
        createLandedSnowflake(container, containerWidth);
    });

    container.appendChild(snowflake);
}
