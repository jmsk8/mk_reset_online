// Loupe sur les graphiques Chart.js : le graphique s'etire (x1 a x4) et se
// parcourt comme une carte, sans recadrer les axes.
//
// Gestes : Ctrl + molette ou pincement pour zoomer, glisser pour se deplacer,
// double-clic (souris) ou bouton ⟲ pour revenir.
//
// Usage :
//   ChartZoom.brancher(chart, {
//       glisserPermis: (clientX, clientY) => bool, // false : l'appui reste a la page
//       touchActionAuRepos: 'none',   // defaut 'pan-x pan-y'
//       surChangement: () => {},      // apres chaque zoom, deplacement, redessin
//   });
//   ChartZoom.versVue(chart, x, y)                  point du graphique -> position dans le parent
//   ChartZoom.depuisEcran(chart, clientX, clientY)  position ecran -> point du graphique
//
// Pendant le geste, le canvas est agrandi par un scale CSS ; 200 ms apres,
// Chart.js le redessine a la taille zoomee. Le parent doit etre en position
// relative et avoir sa propre hauteur.

(function () {
    const ZOOM_MAX = 4;
    // Pixels max du canvas zoome (iOS refuse au-dela de ~16,7 M) : au-dela, la
    // densite de pixels baisse.
    const PIXELS_MAX = 12e6;
    const SEUIL_GLISSER_PX = 6;
    const DELAI_REDESSIN_MS = 200;
    // Un clic juste apres un glisser en est le relachement.
    const DELAI_CLIC_APRES_GLISSER_MS = 300;
    // Rayon des points x zoom^0,5.
    const EXPOSANT_POINTS = 0.5;
    // Zone de toucher ajoutee au rayon des points, pour le doigt.
    const MARGE_TOUCHER_DOIGT_PX = 12;
    const MARGE_TOUCHER_SOURIS_PX = 1;
    const RAYON_TYPE_PX = 5;
    const auDoigt = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    let stylesInjectes = false;

    function injecterStyles() {
        if (stylesInjectes) return;
        stylesInjectes = true;
        const style = document.createElement('style');
        style.textContent = `
            .chart-zoom-vue { overflow: hidden; }
            .chart-zoom-vue.est-zoome { cursor: grab; }
            .chart-zoom-vue.glisse { cursor: grabbing; }
            .chart-zoom-reset {
                position: absolute; top: 6px; right: 6px; z-index: 5;
                display: none; padding: 2px 9px; border-radius: 6px;
                border: 1px solid rgba(255,255,255,0.25);
                background: rgba(15,23,42,0.85); color: #e6edf3;
                font-size: 0.85rem; line-height: 1.6; cursor: pointer;
            }
            .chart-zoom-reset.is-visible { display: block; }
            .chart-zoom-reset:hover { border-color: #3b82f6; color: #fff; }
            .chart-zoom-hint {
                position: absolute; inset: 0; z-index: 4;
                display: flex; align-items: center; justify-content: center;
                background: rgba(0,0,0,0.45); color: #fff; font-size: 0.95rem;
                pointer-events: none; opacity: 0; transition: opacity 0.2s;
            }
            .chart-zoom-hint.is-visible { opacity: 1; }
        `;
        document.head.appendChild(style);
    }

    // Position ecran -> point du graphique.
    function depuisEcran(chart, clientX, clientY) {
        const rect = chart.canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left) * chart.width / (rect.width || 1),
            y: (clientY - rect.top) * chart.height / (rect.height || 1)
        };
    }

    function versVue(chart, x, y) {
        const z = chart && chart.$chartZoom;
        return z ? z.versVue(x, y) : { x, y };
    }

    const pluginLoupe = {
        id: 'chartZoomLoupe',
        // Pendant un geste, recalcule la position du pointeur depuis le
        // rectangle reel du canvas.
        beforeEvent(chart, args) {
            const z = chart.$chartZoom;
            if (!z || z.echelle() === 1) return;
            const e = args.event;
            const n = e.native;
            if (!n) return;
            const p = (n.touches && n.touches[0]) || (n.changedTouches && n.changedTouches[0]) || n;
            if (p.clientX == null) return;
            const pos = depuisEcran(chart, p.clientX, p.clientY);
            e.x = pos.x;
            e.y = pos.y;
            const a = chart.chartArea;
            args.inChartArea = e.x >= a.left && e.x <= a.right && e.y >= a.top && e.y <= a.bottom;
        },
        // Meme periode : la bulle d'info est reduite d'autant.
        beforeTooltipDraw(chart, args) {
            const z = chart.$chartZoom;
            if (!z || z.echelle() === 1) return;
            const f = z.echelle();
            const { caretX, caretY } = args.tooltip;
            const ctx = chart.ctx;
            ctx.save();
            ctx.translate(caretX, caretY);
            ctx.scale(1 / f, 1 / f);
            ctx.translate(-caretX, -caretY);
        },
        afterTooltipDraw(chart) {
            const z = chart.$chartZoom;
            if (!z || z.echelle() === 1) return;
            chart.ctx.restore();
        },
        // Grossissement des points le temps du dessin seulement.
        beforeDatasetDraw(chart, args) {
            const z = chart.$chartZoom;
            const k = z ? Math.pow(z.zoomDessin(), EXPOSANT_POINTS) : 1;
            if (k === 1) return;
            for (const el of args.meta.data) {
                const o = el.options;
                if (!o || !o.radius) continue;
                el.$optionsHorsLoupe = o;
                el.options = Object.assign({}, o, { radius: o.radius * k });
            }
        },
        afterDatasetDraw(chart, args) {
            for (const el of args.meta.data) {
                if (!el.$optionsHorsLoupe) continue;
                el.options = el.$optionsHorsLoupe;
                delete el.$optionsHorsLoupe;
            }
        }
    };
    if (window.Chart) {
        Chart.register(pluginLoupe);
        // Positionneur de bulle orientee vers le centre de la partie visible.
        if (Chart.Tooltip && Chart.Tooltip.positioners) Chart.Tooltip.positioners.loupe = function (items, positionEvenement) {
            const z = this.chart.$chartZoom;
            const origine = (z && Chart.Tooltip.positioners[z.positionOrigine]) || Chart.Tooltip.positioners.average;
            const pos = origine.call(this, items, positionEvenement);
            if (!pos || !z || z.zoom() === 1) return pos;
            const v = z.zoneVisible();
            const quart = (v.bas - v.haut) / 4;
            let yAlign = 'center';
            if (pos.y < v.haut + quart) yAlign = 'top'; // bulle sous le point
            else if (pos.y > v.bas - quart) yAlign = 'bottom'; // bulle au-dessus
            const xAlign = pos.x <= (v.gauche + v.droite) / 2 ? 'left' : 'right';
            return Object.assign({}, pos, { xAlign, yAlign });
        };
    }

    function brancher(chart, { glisserPermis = null, touchActionAuRepos = 'pan-x pan-y', surChangement = null } = {}) {
        if (!chart) return;
        injecterStyles();
        const canvas = chart.canvas;
        const vue = canvas.parentNode;
        // Graphique recree dans la meme vue : on retire l'ancien branchement.
        if (vue.$chartZoomDetacher) vue.$chartZoomDetacher();
        const abandon = new AbortController();
        const ecoute = { signal: abandon.signal };
        vue.classList.add('chart-zoom-vue');
        canvas.style.transformOrigin = '0 0';

        const bouton = document.createElement('button');
        bouton.type = 'button';
        bouton.className = 'chart-zoom-reset';
        bouton.title = 'Revenir à la vue complète (ou double-clic)';
        bouton.textContent = '⟲';
        bouton.addEventListener('click', (ev) => { ev.stopPropagation(); reinitialiser(); }, ecoute);
        vue.appendChild(bouton);

        const bandeau = document.createElement('div');
        bandeau.className = 'chart-zoom-hint';
        bandeau.textContent = 'Ctrl + molette pour zoomer';
        vue.appendChild(bandeau);
        let minuterieBandeau = null;

        // z : zoom voulu ; zDessin : zoom du dernier dessin Chart.js ;
        // tx, ty : coin haut-gauche du canvas dans la vue.
        let z = 1, zDessin = 1, tx = 0, ty = 0;
        let base = null; // taille du graphique non zoome
        let minuterieRedessin = null;
        const echelle = () => z / zDessin;

        const tooltipOptions = chart.options.plugins && chart.options.plugins.tooltip;
        chart.$chartZoom = {
            echelle,
            zoom: () => z,
            zoomDessin: () => zDessin,
            versVue: (x, y) => ({ x: tx + x * echelle(), y: ty + y * echelle() }),
            // Partie visible, en coordonnees du graphique.
            zoneVisible: () => {
                const { w, h } = tailleBase(), s = echelle();
                return { gauche: -tx / s, haut: -ty / s, droite: (w - tx) / s, bas: (h - ty) / s };
            },
            positionOrigine: (tooltipOptions && tooltipOptions.position) || 'average'
        };
        if (tooltipOptions && window.Chart && Chart.Tooltip && Chart.Tooltip.positioners.loupe) {
            tooltipOptions.position = 'loupe';
        }

        // Ecrit dans la config du graphique, pris en compte au prochain update.
        function majZoneToucher() {
            const k = Math.pow(zDessin, EXPOSANT_POINTS);
            const marge = auDoigt() ? MARGE_TOUCHER_DOIGT_PX : MARGE_TOUCHER_SOURIS_PX;
            chart.options.elements.point.hitRadius = marge + RAYON_TYPE_PX * (k - 1);
        }

        function tailleBase() {
            return zDessin === 1 ? { w: chart.width, h: chart.height } : base;
        }

        function appliquer() {
            const { w, h } = tailleBase();
            tx = Math.min(0, Math.max(w - w * z, tx));
            ty = Math.min(0, Math.max(h - h * z, ty));
            const s = echelle();
            canvas.style.transform = (z === 1 && zDessin === 1) ? ''
                : `translate(${tx}px, ${ty}px)` + (s === 1 ? '' : ` scale(${s})`);
            vue.classList.toggle('est-zoome', z > 1);
            bouton.classList.toggle('is-visible', z > 1);
            // Zoome, le doigt deplace le graphique ; sinon il fait defiler la page.
            vue.style.touchAction = z > 1 ? 'none' : touchActionAuRepos;
            if (surChangement) surChangement();
        }

        // Redessine a la taille du zoom en gardant le centre de la vue au meme
        // endroit (repere en fraction des echelles).
        function redessiner() {
            clearTimeout(minuterieRedessin);
            if (z === zDessin) return;
            const { w, h } = tailleBase();
            if (zDessin === 1) base = { w, h };
            const s = echelle();
            const cx = w / 2, cy = h / 2;
            const sx = chart.scales && chart.scales.x, sy = chart.scales && chart.scales.y;
            const fx = sx ? sx.getDecimalForPixel((cx - tx) / s) : null;
            const fy = sy ? sy.getDecimalForPixel((cy - ty) / s) : null;
            const px = (cx - tx) / (z * w), py = (cy - ty) / (z * h); // repli

            // Arrete une animation en cours avant le resize.
            chart.stop();
            if (z === 1) {
                delete chart.options.devicePixelRatio;
                canvas.style.position = '';
                zDessin = 1;
                majZoneToucher();
                chart.resize();
            } else {
                const W = Math.round(w * z), H = Math.round(h * z);
                const ecran = window.devicePixelRatio || 1;
                chart.options.devicePixelRatio = Math.min(ecran, Math.sqrt(PIXELS_MAX / (W * H)));
                canvas.style.position = 'absolute';
                canvas.style.left = '0';
                canvas.style.top = '0';
                zDessin = z;
                majZoneToucher();
                chart.resize(W, H);
            }

            const nx = (sx && fx !== null) ? sx.getPixelForDecimal(fx) : px * chart.width;
            const ny = (sy && fy !== null) ? sy.getPixelForDecimal(fy) : py * chart.height;
            tx = cx - nx;
            ty = cy - ny;
            appliquer();
        }

        function programmerRedessin() {
            clearTimeout(minuterieRedessin);
            minuterieRedessin = setTimeout(redessiner, DELAI_REDESSIN_MS);
        }

        // Zoom vers `nouveau`, point (px, py) de la vue fixe.
        function zoomerVers(nouveau, px, py) {
            nouveau = Math.min(ZOOM_MAX, Math.max(1, nouveau));
            if (nouveau === z) return;
            const u = (px - tx) / z, v = (py - ty) / z;
            z = nouveau;
            tx = px - u * z;
            ty = py - v * z;
            appliquer();
            programmerRedessin();
        }

        function reinitialiser() {
            z = 1; tx = 0; ty = 0;
            redessiner();
            appliquer();
        }

        function posDansVue(clientX, clientY) {
            const r = vue.getBoundingClientRect();
            return { x: clientX - r.left, y: clientY - r.top };
        }

        vue.addEventListener('wheel', (ev) => {
            if (!ev.ctrlKey) {
                bandeau.classList.add('is-visible');
                clearTimeout(minuterieBandeau);
                minuterieBandeau = setTimeout(() => bandeau.classList.remove('is-visible'), 1200);
                return;
            }
            ev.preventDefault(); // empeche le zoom de toute la page
            const p = posDansVue(ev.clientX, ev.clientY);
            zoomerVers(z * Math.exp(-ev.deltaY * 0.002), p.x, p.y);
        }, { passive: false, signal: abandon.signal });

        const appuis = new Map();
        let glisse = false, depart = null, pince = null, finGlisser = 0;
        let dernierPointeur = 'mouse';

        vue.addEventListener('pointerdown', (ev) => {
            dernierPointeur = ev.pointerType;
            if (ev.target === bouton) return;
            if (ev.pointerType === 'mouse' && ev.button !== 0) return;
            appuis.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            if (appuis.size === 2) {
                const [a, b] = [...appuis.values()];
                pince = { dist: Math.hypot(a.x - b.x, a.y - b.y), z };
                glisse = false;
            } else if (appuis.size === 1) {
                // Element que la page fait glisser elle-meme (poignee).
                const permis = !glisserPermis || glisserPermis(ev.clientX, ev.clientY);
                depart = permis ? { x: ev.clientX, y: ev.clientY, tx, ty } : null;
                glisse = false;
            }
        }, ecoute);

        vue.addEventListener('pointermove', (ev) => {
            if (!appuis.has(ev.pointerId)) return;
            appuis.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            if (pince && appuis.size >= 2) {
                const [a, b] = [...appuis.values()];
                const dist = Math.hypot(a.x - b.x, a.y - b.y);
                if (pince.dist > 0) {
                    const m = posDansVue((a.x + b.x) / 2, (a.y + b.y) / 2);
                    zoomerVers(pince.z * dist / pince.dist, m.x, m.y);
                }
                return;
            }
            if (z === 1 || !depart) return;
            const dx = ev.clientX - depart.x, dy = ev.clientY - depart.y;
            if (!glisse && Math.hypot(dx, dy) < SEUIL_GLISSER_PX) return;
            if (!glisse) {
                glisse = true;
                vue.classList.add('glisse');
                try { vue.setPointerCapture(ev.pointerId); } catch (_) { /* pointeur deja relache */ }
            }
            tx = depart.tx + dx;
            ty = depart.ty + dy;
            appliquer();
        }, ecoute);

        function relacher(ev) {
            if (!appuis.has(ev.pointerId)) return;
            appuis.delete(ev.pointerId);
            if (appuis.size < 2) pince = null;
            if (appuis.size === 1) {
                // Un doigt restant reprend le glisser.
                const [a] = [...appuis.values()];
                depart = { x: a.x, y: a.y, tx, ty };
            }
            if (appuis.size === 0) {
                if (glisse) finGlisser = Date.now();
                glisse = false;
                depart = null;
                vue.classList.remove('glisse');
            }
        }
        vue.addEventListener('pointerup', relacher, ecoute);
        vue.addEventListener('pointercancel', relacher, ecoute);

        // Le relachement d'un glisser ne declenche pas le onClick du graphique
        // (capture sur la vue, avant le canvas).
        vue.addEventListener('click', (ev) => {
            if (Date.now() - finGlisser >= DELAI_CLIC_APRES_GLISSER_MS) return;
            ev.stopPropagation();
            ev.preventDefault();
        }, { capture: true, signal: abandon.signal });

        vue.addEventListener('dblclick', (ev) => {
            if (ev.target === bouton) return;
            // Au doigt, le double-tap est ignore.
            if (dernierPointeur === 'touch') return;
            reinitialiser();
        }, ecoute);

        // Changement de largeur : retour a la vue complete.
        let largeur = vue.clientWidth;
        const observateur = window.ResizeObserver ? new ResizeObserver(() => {
            if (vue.clientWidth === largeur) return;
            largeur = vue.clientWidth;
            if (z !== 1 || zDessin !== 1) reinitialiser();
        }) : null;
        if (observateur) observateur.observe(vue);

        vue.style.touchAction = touchActionAuRepos;
        majZoneToucher();
        chart.update('none');

        vue.$chartZoomDetacher = () => {
            abandon.abort();
            if (observateur) observateur.disconnect();
            clearTimeout(minuterieRedessin);
            clearTimeout(minuterieBandeau);
            bouton.remove();
            bandeau.remove();
            canvas.style.transform = '';
            canvas.style.position = '';
            vue.classList.remove('est-zoome', 'glisse');
            delete vue.$chartZoomDetacher;
        };
    }

    window.ChartZoom = { brancher, versVue, depuisEcran };
})();
