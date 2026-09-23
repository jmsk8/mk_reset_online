// Loupe sur les graphiques Chart.js (chantier 13.9,
// docs/etat-avancement-global.md). Le graphique entier s'etire (x1 a x4) et on
// s'y deplace dans les deux sens, comme sur une carte. Les axes ne sont jamais
// recadres : tout le graphique reste la, simplement plus grand.
//
// Gestes, a la maniere d'une carte integree :
//   - Ctrl + molette (ou pincement du trackpad, que le navigateur envoie comme
//     une molette avec ctrlKey) : zoom autour du curseur. La molette seule fait
//     defiler la page, un bandeau rappelle alors le geste ;
//   - pincement a deux doigts : zoom ;
//   - une fois zoome, glisser (souris ou doigt) : deplacement ;
//   - double-clic ou bouton ⟲ (visible une fois zoome) : retour.
//
// Usage, apres la creation du graphique :
//   ChartZoom.brancher(chart);
//   ChartZoom.brancher(chart, {
//       glisserPermis: (clientX, clientY) => bool, // false : l'appui appartient
//                                                  // a la page (ex. poignee)
//       touchActionAuRepos: 'none',   // defaut 'pan-x pan-y' (la page defile)
//       surChangement: () => {},      // apres chaque zoom, deplacement, redessin
//   });
// Rappeler brancher sur un graphique recree dans le meme parent remplace le
// branchement precedent.
//
// Outils pour le code des pages :
//   ChartZoom.versVue(chart, x, y)            point du graphique -> position
//                                             dans le parent (element HTML
//                                             pose par-dessus, ex. une bulle) ;
//   ChartZoom.depuisEcran(chart, clientX, clientY) -> point du graphique
//                                             (glisser fait a la main).
//
// Principe, en deux temps :
//   1. pendant le geste, le canvas est agrandi par un transform CSS (scale) :
//      c'est instantane, mais traits, points et textes grossissent avec ;
//   2. 200 ms apres, Chart.js redessine le graphique a la taille zoomee
//      (canvas plus grand que son parent, qui coupe ce qui depasse). Traits,
//      points, textes et bulles d'info retrouvent leur taille normale, seules
//      les distances s'etirent. Le transform ne garde que le deplacement.
// Le parent doit etre en position relative et avoir une hauteur propre (le
// canvas zoome passe en absolu et ne la porte plus) ; ses autres enfants,
// poses en absolu, ne sont pas agrandis.

(function () {
    const ZOOM_MAX = 4;
    // Pixels reels maximum du canvas zoome : au-dela, iOS refuse de le dessiner
    // (limite ~16,7 M) et chaque survol redessine une surface enorme. Passe ce
    // plafond, la densite de pixels baisse (un peu moins net sur ecran retina
    // a fort zoom) plutot que la taille.
    const PIXELS_MAX = 12e6;
    // Mouvement en dessous duquel un appui reste un clic et pas un glisser.
    const SEUIL_GLISSER_PX = 6;
    const DELAI_REDESSIN_MS = 200;
    // Un clic qui suit de moins de ce delai la fin d'un glisser en est le
    // relachement, pas un vrai clic.
    const DELAI_CLIC_APRES_GLISSER_MS = 300;

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

    // Position ecran -> point du graphique, que le canvas soit deplace,
    // agrandi par transform ou non.
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
        // Pendant un geste (canvas agrandi par transform), Chart.js calcule mal
        // la position du doigt (il passe par clientX, en coordonnees ecran
        // agrandies). On la recalcule depuis le rectangle reel du canvas :
        // infobulles et clics tombent sur le bon point.
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
        // Meme periode : la bulle d'info, dessinee dans le canvas, grossirait
        // avec lui. On la reduit d'autant autour de sa pointe.
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
        }
    };
    if (window.Chart) Chart.register(pluginLoupe);

    function brancher(chart, { glisserPermis = null, touchActionAuRepos = 'pan-x pan-y', surChangement = null } = {}) {
        if (!chart) return;
        injecterStyles();
        const canvas = chart.canvas;
        const vue = canvas.parentNode;
        // Graphique recree dans la meme vue (page admin des tiers) : on defait
        // le branchement precedent, sinon ecouteurs et boutons s'empileraient.
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

        // z      : zoom voulu (1 a ZOOM_MAX) ;
        // zDessin: zoom auquel Chart.js a dessine le canvas ;
        // tx, ty : position du coin haut-gauche du canvas dans la vue.
        // L'ecart z / zDessin est comble par un scale CSS le temps du geste.
        let z = 1, zDessin = 1, tx = 0, ty = 0;
        let base = null; // taille du graphique non zoome, relevee au depart
        let minuterieRedessin = null;
        const echelle = () => z / zDessin;

        chart.$chartZoom = {
            echelle,
            versVue: (x, y) => ({ x: tx + x * echelle(), y: ty + y * echelle() })
        };

        function tailleBase() {
            return zDessin === 1 ? { w: chart.width, h: chart.height } : base;
        }

        function appliquer() {
            const { w, h } = tailleBase();
            // Le graphique agrandi doit toujours couvrir toute la vue.
            tx = Math.min(0, Math.max(w - w * z, tx));
            ty = Math.min(0, Math.max(h - h * z, ty));
            const s = echelle();
            canvas.style.transform = (z === 1 && zDessin === 1) ? ''
                : `translate(${tx}px, ${ty}px)` + (s === 1 ? '' : ` scale(${s})`);
            vue.classList.toggle('est-zoome', z > 1);
            bouton.classList.toggle('is-visible', z > 1);
            // Zoome, le doigt deplace le graphique ; sinon il garde son role
            // au repos (defiler la page par defaut). Le pincement nous revient.
            vue.style.touchAction = z > 1 ? 'none' : touchActionAuRepos;
            if (surChangement) surChangement();
        }

        // Redessine le graphique a la taille du zoom. Le centre de la vue
        // reste sur le meme endroit du graphique : la mise en page n'est pas
        // strictement proportionnelle (les axes gardent leur largeur en
        // pixels), on repere donc ce centre en fraction des echelles.
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

            // Une animation en cours (survol) ferait reporter le resize a la
            // frame suivante : le recalage ci-dessous lirait les anciennes
            // echelles.
            chart.stop();
            if (z === 1) {
                delete chart.options.devicePixelRatio;
                canvas.style.position = '';
                zDessin = 1;
                chart.resize();
            } else {
                const W = Math.round(w * z), H = Math.round(h * z);
                const ecran = window.devicePixelRatio || 1;
                chart.options.devicePixelRatio = Math.min(ecran, Math.sqrt(PIXELS_MAX / (W * H)));
                // En absolu, le canvas plus grand que la vue ne l'elargit pas.
                canvas.style.position = 'absolute';
                canvas.style.left = '0';
                canvas.style.top = '0';
                zDessin = z;
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

        // Zoom vers `nouveau`, en gardant fixe le point (px, py) de la vue.
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
            ev.preventDefault(); // sinon le navigateur zoome la page entiere
            const p = posDansVue(ev.clientX, ev.clientY);
            zoomerVers(z * Math.exp(-ev.deltaY * 0.002), p.x, p.y);
        }, { passive: false, signal: abandon.signal });

        // Glisser et pincement, en pointer events (souris, doigt et stylet).
        const appuis = new Map();
        let glisse = false, depart = null, pince = null, finGlisser = 0;

        vue.addEventListener('pointerdown', (ev) => {
            if (ev.target === bouton) return;
            if (ev.pointerType === 'mouse' && ev.button !== 0) return;
            appuis.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            if (appuis.size === 2) {
                const [a, b] = [...appuis.values()];
                pince = { dist: Math.hypot(a.x - b.x, a.y - b.y), z };
                glisse = false;
            } else if (appuis.size === 1) {
                // Appui sur un element que la page fait glisser elle-meme (une
                // poignee de seuil) : la loupe ne deplace pas la vue.
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
                // Un doigt reste apres un pincement : il reprend le glisser.
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

        // Le relachement d'un glisser n'est pas un clic : il ne doit pas
        // declencher le onClick du graphique (infobulle, modale, alert).
        // En phase de capture sur la vue, on passe avant le canvas.
        vue.addEventListener('click', (ev) => {
            if (Date.now() - finGlisser >= DELAI_CLIC_APRES_GLISSER_MS) return;
            ev.stopPropagation();
            ev.preventDefault();
        }, { capture: true, signal: abandon.signal });

        vue.addEventListener('dblclick', (ev) => {
            if (ev.target === bouton) return;
            reinitialiser();
        }, ecoute);

        // La vue change de largeur (rotation, fenetre) : on repart de la vue
        // complete plutot que de recaler un zoom devenu faux.
        let largeur = vue.clientWidth;
        const observateur = window.ResizeObserver ? new ResizeObserver(() => {
            if (vue.clientWidth === largeur) return;
            largeur = vue.clientWidth;
            if (z !== 1 || zDessin !== 1) reinitialiser();
        }) : null;
        if (observateur) observateur.observe(vue);

        vue.style.touchAction = touchActionAuRepos;

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
