// Tableau de reglage des tiers (page Reglages TrueSkill).
//
// Tiers dynamiques (Partie B, docs/tableau-seuils-tiers-plan.md) : la liste
// des tiers (nom, couleur, seuil en ecart-type, rang) est geree par l'admin
// via /admin/tiers/* (GET/POST/PUT/DELETE + /reorder + /reset), plus figee a
// S/A/B/C. Ce fichier affiche :
//   - un graphique (courbe normale + joueurs + lignes de seuil glissables),
//     genere pour un nombre quelconque de tiers ;
//   - un panneau liste ou chaque tier se renomme, se recolore (fenetre de
//     choix avec « Confirmer »), se regle (en sigma) et se supprime, avec
//     ajout d'un nouveau tier et bouton Reinitialiser (restaure S/A/B/C par
//     defaut, /admin/tiers/reset).
//
// Le graphique reste en score TrueSkill brut sur son axe (c'est la
// distribution reelle du jour) ; le panneau liste et les seuils du plugin de
// lignes travaillent en ecart-type (l'unite stockee en base), convertis a la
// volee via mean/stdev de la distribution chargee.

(function () {
    let chart = null;
    let mean = 0, stdev = 1;
    // tiersState : [{id, nom, couleur, seuil_k, rang}], trie rang DESC (le
    // meilleur en premier). seuil_k est null pour le plancher (rang le plus
    // bas de la liste) -- toujours vrai par construction cote backend.
    let tiersState = [];
    // U (non classe) : hors de tiersState, ce n'est pas un tier -- ni seuil,
    // ni rang, ni nom modifiable. Seule sa couleur se regle, et ne part au
    // serveur que si elle a change : chaque envoi laisse une ligne au journal.
    let couleurU = '#FFFFFF';
    let couleurUServeur = '#FFFFFF';
    let playersRaw = [];       // points {nom,x,y,color} venus du backend
    // INDEX (et non id) du tier en cours de glisse, -1 si aucun : un tier
    // ajoute mais pas encore enregistre n'a pas d'id serveur, et deux ids
    // absents se confondraient.
    let draggingIdx = -1;

    // Un tier existe en base s'il porte un id numerique strictement positif.
    // Tout le reste (null pour une ligne ajoutee dans le panneau, undefined si
    // le serveur omet le champ) signifie « pas encore cree ».
    function estIdServeur(id) {
        return typeof id === 'number' && Number.isFinite(id) && id > 0;
    }

    function kFromScore(score) {
        return stdev ? (score - mean) / stdev : 0;
    }
    function scoreFromK(k) {
        return mean + k * stdev;
    }

    function scoreSeuil(tier) {
        return tier.seuil_k === null || tier.seuil_k === undefined ? null : scoreFromK(tier.seuil_k);
    }

    // tiersState est trie rang DESC : le premier tier dont le score-frontiere
    // est depasse gagne ; le dernier (plancher, seuil_k null) sert de secours.
    function tierForScore(score) {
        for (const t of tiersState) {
            const seuil = scoreSeuil(t);
            if (seuil !== null && score > seuil) return t.nom;
        }
        return tiersState.length ? tiersState[tiersState.length - 1].nom : '?';
    }

    function colorForTierName(nom) {
        const t = tiersState.find(t => t.nom === nom);
        return t ? t.couleur : '#FFFFFF';
    }

    function renderLegend() {
        const legend = document.getElementById('tierLegend');
        if (!legend) return;
        legend.innerHTML = '';
        playersRaw.slice().sort((a, b) => b.x - a.x).forEach(p => {
            const tierNom = tierForScore(p.x);
            const item = document.createElement('div');
            item.className = 'legend-item';
            const dot = document.createElement('div');
            dot.className = 'legend-color-dot';
            dot.style.backgroundColor = /^#[0-9a-fA-F]{3,8}$/.test(p.color) ? p.color : '#FFFFFF';
            const name = document.createElement('span');
            name.className = 'legend-name';
            name.textContent = p.nom || '';
            const val = document.createElement('span');
            val.className = 'legend-val';
            val.textContent = tierNom;
            val.style.color = colorForTierName(tierNom);
            item.appendChild(dot);
            item.appendChild(name);
            item.appendChild(val);
            legend.appendChild(item);
        });
    }

    // Zones : une bande par tier, entre son seuil et celui du tier juste
    // au-dessus (rang+1). tiersState est deja trie rang DESC donc l'element
    // precedent dans le tableau EST le tier du dessus.
    function zonesFromState() {
        return tiersState.map((t, i) => ({
            nom: t.nom,
            couleur: t.couleur,
            from: scoreSeuil(t),                    // borne basse (null = -infini)
            to: i > 0 ? scoreSeuil(tiersState[i - 1]) : null, // borne haute (null = +infini, sommet)
        }));
    }

    const tierLinesPlugin = {
        id: 'tierLinesInteractive',
        beforeDatasetsDraw(c) {
            const { ctx, chartArea, scales: { x } } = c;
            if (!chartArea) return;
            const clamp = v => Math.max(chartArea.left, Math.min(chartArea.right, v));
            zonesFromState().forEach(zone => {
                const left = zone.from !== null ? clamp(x.getPixelForValue(zone.from)) : chartArea.left;
                const right = zone.to !== null ? clamp(x.getPixelForValue(zone.to)) : chartArea.right;
                if (right <= left) return;
                ctx.save();
                ctx.fillStyle = zone.couleur;
                ctx.globalAlpha = 0.06;
                ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
                ctx.globalAlpha = 1;
                ctx.restore();
            });
        },
        afterDraw(c) {
            const { ctx, chartArea, scales: { x } } = c;
            if (!chartArea) return;
            const clamp = v => Math.max(chartArea.left, Math.min(chartArea.right, v));
            tiersState.forEach((t, i) => {
                const seuil = scoreSeuil(t);
                if (seuil === null) return; // plancher : pas de ligne
                const px = x.getPixelForValue(seuil);
                if (px < chartArea.left || px > chartArea.right) return;
                const active = draggingIdx === i;
                ctx.save();
                ctx.beginPath();
                ctx.setLineDash(active ? [] : [6, 4]);
                ctx.strokeStyle = t.couleur;
                ctx.lineWidth = active ? 3 : 2;
                ctx.globalAlpha = active ? 0.9 : 0.55;
                ctx.moveTo(px, chartArea.top);
                ctx.lineTo(px, chartArea.bottom);
                ctx.stroke();
                ctx.restore();

                // Poignee : petite languette en haut, plus facile a attraper
                // qu'un trait de 1px.
                ctx.save();
                ctx.fillStyle = t.couleur;
                ctx.beginPath();
                ctx.moveTo(px - 7, chartArea.top);
                ctx.lineTo(px + 7, chartArea.top);
                ctx.lineTo(px, chartArea.top + 10);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            });
            zonesFromState().forEach(zone => {
                const left = zone.from !== null ? clamp(x.getPixelForValue(zone.from)) : chartArea.left;
                const right = zone.to !== null ? clamp(x.getPixelForValue(zone.to)) : chartArea.right;
                if (right <= left) return;
                const center = (left + right) / 2;
                ctx.save();
                ctx.fillStyle = zone.couleur;
                ctx.font = 'bold 13px sans-serif';
                ctx.textAlign = 'center';
                ctx.globalAlpha = 0.7;
                ctx.fillText(zone.nom, center, chartArea.top + 24);
                ctx.restore();
            });
        }
    };

    function playerPointsForChart() {
        return playersRaw.map(p => ({ x: p.x, y: p.y, name: p.nom, color: p.color }));
    }

    function colorsForPoints() {
        return playersRaw.map(p => colorForTierName(tierForScore(p.x)));
    }

    // Graphique et legende seulement. C'est ce qu'appellent les champs du
    // panneau pendant la saisie : reconstruire le panneau a chaque frappe
    // detruisait le champ en cours d'edition (focus perdu, clavier du
    // telephone referme, selecteur de couleur detache de son champ).
    function redrawGraphique() {
        if (!chart) return;
        chart.data.datasets[1].backgroundColor = colorsForPoints();
        chart.update('none');
        renderLegend();
    }

    // Graphique ET panneau : reserve aux changements de structure (ajout,
    // suppression, deplacement, couleur confirmee), jamais pendant une saisie.
    function redraw() {
        redrawGraphique();
        renderTiersPanel();
    }

    // Pendant un glisse : on redessine le graphique a chaque pixel, mais PAS
    // le panneau -- le reconstruire en continu detruirait les champs a chaque
    // mousemove (perte du focus, saisie en cours annulee). Seule la valeur du
    // champ de seuil concerne est rafraichie, sans toucher au DOM alentour.
    let frameDemandee = false;

    function redrawPendantDrag() {
        if (!chart || frameDemandee) return;
        // Un mousemove peut arriver plusieurs fois par frame : on ne redessine
        // qu'une fois par rafraichissement ecran, sinon le glisse saccade.
        frameDemandee = true;
        requestAnimationFrame(() => {
            frameDemandee = false;
            redrawGraphique();
            const t = tiersState[draggingIdx];
            if (!t || t.seuil_k === null || t.seuil_k === undefined) return;
            const champ = document.querySelector(
                `#tiersListBody .tier-ligne[data-idx="${draggingIdx}"] .tier-seuil`);
            if (champ) champ.value = t.seuil_k.toFixed(3);
        });
    }

    // Renvoie l'INDEX du tier dont la ligne est la plus proche, ou -1. On
    // travaille par index et non par id : l'id peut etre absent (tier pas
    // encore cree en base) et deux `undefined` se confondraient -- c'est
    // exactement le bug de recette du 13/09, ou seul le premier tier bougeait.
    function nearestHandle(pixelX, x) {
        // Tolerance large : viser un trait de 2px a la souris est penible, et
        // la valeur est de toute facon ajustable au clavier dans le tableau.
        const THRESH_PX = 18;
        let best = -1, bestDist = Infinity;
        tiersState.forEach((t, i) => {
            const seuil = scoreSeuil(t);
            if (seuil === null) return;
            const px = x.getPixelForValue(seuil);
            const d = Math.abs(px - pixelX);
            if (d < bestDist) { bestDist = d; best = i; }
        });
        return bestDist <= THRESH_PX ? best : -1;
    }

    // Ecart minimal entre deux lignes voisines, en unites de score : assez
    // pour qu'elles restent visuellement (et donc cliquablement) distinctes.
    function ecartMinimalEnScore() {
        const MIN_PX = 6;
        if (!chart || !chart.scales || !chart.scales.x) return 0.01;
        const x = chart.scales.x;
        const largeur = Math.abs(x.right - x.left);
        const etendue = Math.abs(x.max - x.min);
        if (!largeur || !etendue) return 0.01;
        return (etendue / largeur) * MIN_PX;
    }

    // Contraint le seuil deplace a rester strictement entre les seuils des
    // tiers voisins (rang+1 au-dessus, rang-1 en dessous) -- l'ordre des
    // rangs ne change jamais par un simple drag, seule la valeur bouge.
    function clampToNeighbors(idx, scoreValue) {
        // Ecart minimal exprime en PIXELS puis converti en score : un epsilon
        // numerique (1e-6) laissait deux lignes se superposer a l'ecran, et
        // elles devenaient alors impossibles a separer a la souris (le clic
        // attrapait toujours la meme).
        const EPS = ecartMinimalEnScore();
        if (idx < 0 || idx >= tiersState.length) return scoreValue;
        const above = idx > 0 ? scoreSeuil(tiersState[idx - 1]) : null;   // rang superieur
        // Le voisin du dessous : le prochain tier dans la liste QUI A un
        // seuil (le plancher n'en a pas, donc pas de borne basse dans ce cas).
        let below = null;
        for (let j = idx + 1; j < tiersState.length; j++) {
            const s = scoreSeuil(tiersState[j]);
            if (s !== null) { below = s; break; }
        }
        let v = scoreValue;
        if (above !== null) v = Math.min(v, above - EPS);
        if (below !== null) v = Math.max(v, below + EPS);
        return v;
    }

    let dragHandlersAttached = false;

    function attachDragHandlers(canvas) {
        if (dragHandlersAttached) return; // le canvas ne change pas d'un rechargement a l'autre
        dragHandlersAttached = true;
        const area = document.getElementById('tierChartArea');

        // Coordonnee X dans le repere INTERNE du graphique (celui des
        // `scales`), qui n'est pas celui de l'ecran : Chart.js dessine dans un
        // canvas dont la taille de rendu (attribut width) differe de la taille
        // CSS affichee des que le layout le redimensionne. Un simple
        // `clientX - rect.left` melangeait les deux reperes -- les lignes
        // etaient alors decalees de plusieurs dizaines de pixels, d'ou
        // l'impossibilite de les attraper.
        function pixelXFromEvent(evt) {
            const source = evt.touches && evt.touches.length ? evt.touches[0] : evt;
            // Loupe (chart_zoom.js) : le canvas peut etre deplace ou agrandi par
            // un transform CSS. Au doigt, getRelativePosition passe alors par
            // clientX en coordonnees ecran agrandies et rate la poignee ;
            // depuisEcran rapporte la position a la taille reelle du canvas.
            if (window.ChartZoom) {
                return ChartZoom.depuisEcran(chart, source.clientX, source.clientY).x;
            }
            if (window.Chart && Chart.helpers && Chart.helpers.getRelativePosition) {
                // API officielle : gere le ratio rendu/CSS et le devicePixelRatio.
                return Chart.helpers.getRelativePosition(source, chart).x;
            }
            // Repli si l'API bouge : meme calcul, ratio applique a la main.
            const rect = canvas.getBoundingClientRect();
            const ratio = rect.width ? (canvas.width / rect.width) : 1;
            return (source.clientX - rect.left) * ratio;
        }

        function onDown(evt) {
            if (!chart) return;
            const px = pixelXFromEvent(evt);
            const idx = nearestHandle(px, chart.scales.x);
            if (idx < 0) return;
            draggingIdx = idx;
            area.classList.add('dragging-handle');
            evt.preventDefault();
        }

        function onMove(evt) {
            if (!chart) return;
            const px = pixelXFromEvent(evt);
            if (draggingIdx < 0) {
                // '' plutot que 'default' : hors poignee, le curseur de la loupe
                // (main ouverte une fois zoome) reprend la main.
                area.style.cursor = nearestHandle(px, chart.scales.x) >= 0 ? 'ew-resize' : '';
                return;
            }
            const value = chart.scales.x.getValueForPixel(px);
            const t = tiersState[draggingIdx];
            if (t) t.seuil_k = kFromScore(clampToNeighbors(draggingIdx, value));
            redrawPendantDrag();
            evt.preventDefault();
        }

        function onUp() {
            if (draggingIdx >= 0) {
                draggingIdx = -1;
                area.classList.remove('dragging-handle');
                redraw();
            }
        }

        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        canvas.addEventListener('touchstart', onDown, { passive: false });
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
    }

    // --- Panneau liste des tiers -------------------------------------------

    function bouton(classe, icone, titre, action) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = classe;
        b.title = titre;
        b.setAttribute('aria-label', titre);
        b.innerHTML = `<i class="fas ${icone}"></i>`;
        b.onclick = action;
        return b;
    }

    function zone(nom) {
        const d = document.createElement('div');
        d.className = `zone-${nom}`;
        return d;
    }

    // Une ligne par tier (div en grille, plus un tableau) : au telephone elle
    // passe sur deux rangees au lieu de deborder de l'ecran (CSS de la page).
    function renderTiersPanel() {
        const body = document.getElementById('tiersListBody');
        if (!body) return;
        body.innerHTML = '';

        tiersState.forEach((t, idx) => {
            const isPlancher = idx === tiersState.length - 1;
            const ligne = document.createElement('div');
            ligne.className = 'tier-ligne';
            ligne.dataset.idx = String(idx);
            ligne.style.setProperty('--tier-couleur', couleurSure(t.couleur));

            // Pastille : ouvre la fenetre de choix, la couleur n'est appliquee
            // qu'a « Confirmer ».
            const zCouleur = zone('couleur');
            const pastille = bouton('tier-pastille', 'fa-palette',
                `Changer la couleur de ${t.nom || 'ce tier'}`, () => ouvrirChoixCouleur(idx));
            peindrePastille(pastille, t.couleur);
            zCouleur.appendChild(pastille);

            const zNom = zone('nom');
            const nomInput = document.createElement('input');
            nomInput.className = 'input is-small';
            nomInput.type = 'text';
            nomInput.maxLength = 10;
            nomInput.placeholder = 'Nom';
            nomInput.setAttribute('aria-label', 'Nom du tier');
            nomInput.value = t.nom;
            nomInput.oninput = () => { t.nom = nomInput.value; redrawGraphique(); };
            zNom.appendChild(nomInput);

            const zSeuil = zone('seuil');
            if (isPlancher) {
                const span = document.createElement('span');
                span.className = 'tier-plancher';
                span.textContent = 'Plancher : tous les joueurs en dessous';
                zSeuil.appendChild(span);
            } else {
                const etiquette = document.createElement('span');
                etiquette.className = 'tier-etiquette';
                etiquette.textContent = 'Seuil';
                const seuilInput = document.createElement('input');
                seuilInput.className = 'input is-small tier-seuil';
                seuilInput.type = 'number';
                seuilInput.step = '0.01';
                seuilInput.setAttribute('aria-label', `Seuil de ${t.nom || 'ce tier'} en écarts-types`);
                seuilInput.value = (t.seuil_k !== null && t.seuil_k !== undefined) ? t.seuil_k.toFixed(3) : '';
                seuilInput.oninput = () => {
                    const v = parseFloat(seuilInput.value);
                    if (!isNaN(v)) { t.seuil_k = v; redrawGraphique(); }
                };
                // Champ laisse vide ou illisible : on y remet la valeur retenue.
                seuilInput.onchange = () => {
                    if (isNaN(parseFloat(seuilInput.value)) && typeof t.seuil_k === 'number') {
                        seuilInput.value = t.seuil_k.toFixed(3);
                    }
                };
                const unite = document.createElement('span');
                unite.className = 'tier-etiquette';
                unite.textContent = 'σ';
                zSeuil.append(etiquette, seuilInput, unite);
            }

            const zOrdre = zone('ordre');
            const upBtn = bouton('button is-small', 'fa-arrow-up', 'Monter', () => moveTier(idx, idx - 1));
            upBtn.disabled = idx === 0;
            const downBtn = bouton('button is-small', 'fa-arrow-down', 'Descendre', () => moveTier(idx, idx + 1));
            downBtn.disabled = isPlancher;
            zOrdre.append(upBtn, downBtn);

            const zSuppr = zone('suppr');
            const seul = tiersState.length <= 1;
            const delBtn = bouton('button is-small is-danger is-outlined', 'fa-trash',
                seul ? 'Impossible de supprimer le dernier tier' : 'Supprimer', () => removeTierRow(idx));
            delBtn.disabled = seul;
            zSuppr.appendChild(delBtn);

            ligne.append(zCouleur, zNom, zSeuil, zOrdre, zSuppr);
            body.appendChild(ligne);
        });

        // U, toujours en dernier : ni deplacable, ni supprimable, ni
        // renommable. Seule la pastille est active.
        const ligneU = document.createElement('div');
        ligneU.className = 'tier-ligne tier-ligne-u';
        ligneU.style.setProperty('--tier-couleur', couleurSure(couleurU));

        const zCouleurU = zone('couleur');
        const pastilleU = bouton('tier-pastille', 'fa-palette',
            'Changer la couleur de U (non classé)', () => ouvrirChoixCouleur(CHOIX_U));
        peindrePastille(pastilleU, couleurU);
        zCouleurU.appendChild(pastilleU);

        const zNomU = zone('nom');
        const nomU = document.createElement('span');
        nomU.className = 'tier-nom-fixe';
        nomU.textContent = 'U';
        zNomU.appendChild(nomU);

        const zSeuilU = zone('seuil');
        const explication = document.createElement('span');
        explication.className = 'tier-plancher';
        explication.textContent = 'Non classés : niveau encore incertain, ou inactifs';
        zSeuilU.appendChild(explication);

        ligneU.append(zCouleurU, zNomU, zSeuilU);
        body.appendChild(ligneU);
    }

    // --- Choix de la couleur ------------------------------------------------
    //
    // Remplace le <input type="color"> natif. Au telephone, il ne proposait
    // qu'une poignee de teintes ; et partout, le premier changement
    // reconstruisait le panneau, ce qui detruisait le champ et refermait le
    // selecteur des le premier clic. Ici : une palette, trois curseurs pour
    // affiner, un code hexadecimal, et rien n'est applique avant « Confirmer ».

    const HEX6 = /^#[0-9a-fA-F]{6}$/;

    function couleurSure(c) {
        return /^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : '#FFFFFF';
    }

    // Le backend accepte #RGB a #RRGGBBAA ; la fenetre travaille en #RRGGBB.
    function versHex6(c) {
        c = couleurSure(c);
        if (c.length === 4 || c.length === 5) {
            return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toUpperCase();
        }
        return c.slice(0, 7).toUpperCase();
    }

    function hslVersHex(h, s, l) {
        s /= 100; l /= 100;
        const a = s * Math.min(l, 1 - l);
        const f = n => {
            const k = (n + h / 30) % 12;
            const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
            return Math.round(v * 255).toString(16).padStart(2, '0');
        };
        return ('#' + f(0) + f(8) + f(4)).toUpperCase();
    }

    function hexVersHsl(hex) {
        const n = parseInt(versHex6(hex).slice(1), 16);
        const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
    }

    // Texte lisible sur la couleur : noir sur fond clair, blanc sur fond fonce.
    function texteSur(hex) {
        const n = parseInt(versHex6(hex).slice(1), 16);
        const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
        return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0f172a' : '#ffffff';
    }

    function peindrePastille(el, couleur) {
        el.style.backgroundColor = couleurSure(couleur);
        el.style.color = texteSur(couleur);
    }

    // Palette : 8 teintes en colonnes, de la plus claire a la plus foncee,
    // puis une rangee de neutres et de metaux. Les couleurs par defaut
    // (S/A/B/C) en font partie, pour pouvoir y revenir d'un geste.
    const PALETTE = (() => {
        const teintes = [0, 28, 48, 125, 172, 205, 265, 320];
        const nuances = [[90, 82], [85, 70], [80, 58], [75, 46], [70, 34]];
        const couleurs = [];
        nuances.forEach(([s, l]) => teintes.forEach(h => couleurs.push(hslVersHex(h, s, l))));
        couleurs.push('#F77B7B', '#9CDA74', '#7FE6EE', '#AE6CE4',   // S/A/B/C par defaut
                      '#FFD700', '#C0C0C0', '#CD7F32', '#FFFFFF',   // or, argent, bronze, blanc
                      '#F1F5F9', '#CBD5E1', '#94A3B8', '#64748B',   // gris, du clair...
                      '#475569', '#334155', '#1E293B', '#000000');  // ...au noir
        return couleurs;
    })();

    const CHOIX_U = 'U';        // choixIdx de la pastille U, hors de tiersState
    let choixIdx = -1;          // tier dont on choisit la couleur
    let choixCouleur = '#FFFFFF';
    let choixDeclencheur = null; // pastille a qui rendre le focus en sortant

    function elChoix(id) { return document.getElementById(id); }

    function cibleChoix(idx) {
        return idx === CHOIX_U ? { nom: 'U', couleur: couleurU } : tiersState[idx];
    }

    // Met a jour toute la fenetre depuis `choixCouleur`. `source` evite de
    // reecrire le champ qu'on est en train de manipuler.
    function afficherChoix(source) {
        const c = choixCouleur;
        const apercu = elChoix('tierCouleurApercu');
        apercu.style.backgroundColor = c;
        apercu.style.color = texteSur(c);

        elChoix('tierPalette').querySelectorAll('button').forEach(b => {
            const oui = b.dataset.couleur === c;
            b.classList.toggle('choisie', oui);
            b.setAttribute('aria-selected', oui ? 'true' : 'false');
        });

        const hex = elChoix('tierCouleurHex');
        if (source !== 'hex') { hex.value = c; hex.classList.remove('is-danger'); }

        if (source !== 'curseurs') {
            const { h, s, l } = hexVersHsl(c);
            elChoix('tierCurseurTeinte').value = h;
            elChoix('tierCurseurSaturation').value = s;
            elChoix('tierCurseurClarte').value = l;
        }
        // Pistes degradees calees sur les deux autres reglages.
        const h = +elChoix('tierCurseurTeinte').value;
        const s = +elChoix('tierCurseurSaturation').value;
        const l = +elChoix('tierCurseurClarte').value;
        elChoix('tierCurseurSaturation').style.background =
            `linear-gradient(to right, ${hslVersHex(h, 0, l)}, ${hslVersHex(h, 100, l)})`;
        elChoix('tierCurseurClarte').style.background =
            `linear-gradient(to right, #000, ${hslVersHex(h, s, 50)}, #fff)`;
    }

    function ouvrirChoixCouleur(idx) {
        const t = cibleChoix(idx);
        const modal = elChoix('tierCouleurModal');
        if (!t || !modal) return;
        choixIdx = idx;
        choixCouleur = versHex6(t.couleur);
        choixDeclencheur = document.activeElement;
        elChoix('tierCouleurTitre').textContent = `Couleur du tier ${t.nom.trim() || ''}`.trim();
        elChoix('tierCouleurApercu').textContent = t.nom.trim() || '?';
        elChoix('tierCouleurAvant').style.backgroundColor = couleurSure(t.couleur);
        afficherChoix();
        modal.classList.add('is-active');
        document.documentElement.classList.add('is-clipped');
        elChoix('tierCouleurConfirmer').focus();
    }

    function fermerChoixCouleur() {
        const modal = elChoix('tierCouleurModal');
        if (!modal || !modal.classList.contains('is-active')) return;
        modal.classList.remove('is-active');
        document.documentElement.classList.remove('is-clipped');
        choixIdx = -1;
        if (choixDeclencheur && document.contains(choixDeclencheur)) choixDeclencheur.focus();
        choixDeclencheur = null;
    }

    function confirmerChoixCouleur() {
        if (choixIdx === CHOIX_U) {
            couleurU = choixCouleur;
            fermerChoixCouleur();
            renderTiersPanel();   // U n'est pas sur le graphique
            const p = document.querySelector('#tiersListBody .tier-ligne-u .tier-pastille');
            if (p) p.focus();
            return;
        }
        const t = tiersState[choixIdx];
        if (t) {
            t.couleur = choixCouleur;
            // Le panneau peut etre reconstruit : la fenetre est au premier plan,
            // aucun champ n'y est en cours d'edition. On rend ensuite le focus
            // a la NOUVELLE pastille, l'ancienne n'existant plus.
            const idx = choixIdx;
            fermerChoixCouleur();
            redraw();
            const p = document.querySelector(`#tiersListBody .tier-ligne[data-idx="${idx}"] .tier-pastille`);
            if (p) p.focus();
            return;
        }
        fermerChoixCouleur();
    }

    function attachChoixCouleur() {
        const modal = elChoix('tierCouleurModal');
        if (!modal) return;

        const palette = elChoix('tierPalette');
        PALETTE.forEach(c => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.couleur = c;
            b.style.backgroundColor = c;
            b.title = c;
            b.setAttribute('role', 'option');
            b.setAttribute('aria-label', c);
            palette.appendChild(b);
        });
        // Un clic dans la palette ne fait que CHOISIR : rien ne se ferme, rien
        // n'est applique au tier avant « Confirmer ».
        palette.addEventListener('click', e => {
            const b = e.target.closest('button[data-couleur]');
            if (!b) return;
            choixCouleur = b.dataset.couleur;
            afficherChoix();
        });

        ['tierCurseurTeinte', 'tierCurseurSaturation', 'tierCurseurClarte'].forEach(id => {
            elChoix(id).addEventListener('input', () => {
                choixCouleur = hslVersHex(+elChoix('tierCurseurTeinte').value,
                                          +elChoix('tierCurseurSaturation').value,
                                          +elChoix('tierCurseurClarte').value);
                afficherChoix('curseurs');
            });
        });

        const hex = elChoix('tierCouleurHex');
        hex.addEventListener('input', () => {
            let v = hex.value.trim();
            if (v && v[0] !== '#') v = '#' + v;
            const ok = HEX6.test(v);
            hex.classList.toggle('is-danger', !ok && v.length >= 7);
            if (ok) { choixCouleur = v.toUpperCase(); afficherChoix('hex'); }
        });
        // Entree dans le champ code = Confirmer, comme on s'y attend au clavier.
        hex.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); confirmerChoixCouleur(); }
        });

        elChoix('tierCouleurConfirmer').addEventListener('click', confirmerChoixCouleur);
        modal.querySelectorAll('[data-fermer]').forEach(el => el.addEventListener('click', fermerChoixCouleur));
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') fermerChoixCouleur();
        });
    }

    function moveTier(from, to) {
        if (to < 0 || to >= tiersState.length) return;
        const [moved] = tiersState.splice(from, 1);
        tiersState.splice(to, 0, moved);
        // Le plancher (dernier de la liste) n'a jamais de seuil bas ; un
        // echange peut faire glisser un tier avec seuil vers cette position.
        appliquerPlancherLocal();
        redraw();
    }

    function removeTierRow(idx) {
        if (tiersState.length <= 1) return;
        if (!confirm(`Supprimer le tier « ${tiersState[idx].nom} » ? Les joueurs actuellement dans ce tier seront reclasses au prochain enregistrement.`)) return;
        tiersState.splice(idx, 1);
        appliquerPlancherLocal();
        redraw();
    }

    function appliquerPlancherLocal() {
        // Miroir cote client de _appliquer_plancher() (routes_admin.py) :
        // seul le dernier tier de la liste (rang le plus bas) doit avoir
        // seuil_k == null, tous les autres doivent en avoir un.
        tiersState.forEach((t, i) => {
            const isPlancher = i === tiersState.length - 1;
            if (isPlancher) {
                t.seuil_k = null;
            } else if (t.seuil_k === null || t.seuil_k === undefined) {
                // Un ancien plancher promu tier normal : lui donner une valeur
                // de depart raisonnable (juste sous son voisin du dessus).
                const above = i > 0 ? tiersState[i - 1].seuil_k : null;
                t.seuil_k = above !== null ? above - 1 : 0;
            }
        });
    }

    function addTierRow() {
        const top = tiersState[0];
        const nouveauK = top && top.seuil_k !== null && top.seuil_k !== undefined ? top.seuil_k + 1 : 1;
        // id null : la ligne n'existe pas encore en base, saveTiers la creera.
        tiersState.unshift({ id: null, nom: 'Nouveau', couleur: '#cccccc', seuil_k: nouveauK, rang: 0 });
        appliquerPlancherLocal();
        redraw();
    }

    function attachPanelHandlers() {
        const addBtn = document.getElementById('tierAddBtn');
        if (addBtn) addBtn.addEventListener('click', addTierRow);

        const resetBtn = document.getElementById('tierResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', async () => {
                if (!confirm("Réinitialiser restaure les tiers S/A/B/C par défaut et supprime toute personnalisation. Continuer ?")) return;
                resetBtn.classList.add('is-loading');
                const res = await apiCall('/admin/tiers/reset', 'POST');
                resetBtn.classList.remove('is-loading');
                if (res.error) { alert("Erreur: " + res.error); return; }
                if (typeof oublierTiers === 'function') oublierTiers();
                await initTierChart();
            });
        }

        const saveBtn = document.getElementById('tierSaveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveTiers);
        }
    }

    function validerAvantEnvoi() {
        const noms = tiersState.map(t => t.nom.trim());
        if (noms.some(n => !n || n.length > 10)) {
            return "Chaque nom de tier doit faire entre 1 et 10 caractères.";
        }
        if (noms.some(n => n.toUpperCase() === 'U')) {
            return "Le nom « U » est réservé (joueurs non classés).";
        }
        if (new Set(noms.map(n => n.toUpperCase())).size !== noms.length) {
            return "Deux tiers ne peuvent pas porter le même nom.";
        }
        // Seul le dernier tier (le plancher) peut ne pas avoir de seuil.
        for (let i = 0; i < tiersState.length - 1; i++) {
            const k = tiersState[i].seuil_k;
            if (k === null || k === undefined || isNaN(k)) {
                return `Le tier « ${tiersState[i].nom} » n'a pas de seuil valide.`;
            }
        }
        // Ordre strict des seuils : chaque tier (sauf le plancher) doit avoir
        // un seuil strictement superieur a celui du tier juste en dessous.
        for (let i = 0; i < tiersState.length - 2; i++) {
            const cur = tiersState[i].seuil_k, next = tiersState[i + 1].seuil_k;
            if (!(cur > next)) {
                return `Seuils incohérents : « ${tiersState[i].nom} » (${cur}σ) doit être `
                     + `strictement au-dessus de « ${tiersState[i + 1].nom} » (${next}σ).`;
            }
        }
        return null;
    }

    async function saveTiers() {
        const erreur = validerAvantEnvoi();
        if (erreur) { alert(erreur); return; }

        const saveBtn = document.getElementById('tierSaveBtn');
        saveBtn.classList.add('is-loading');
        try {
            // Ordre des operations, important : suppressions, puis creations,
            // puis REORDONNANCEMENT, et seulement ensuite les seuils.
            //
            // Le reorder doit passer AVANT les PUT : tant que l'ordre final
            // n'est pas etabli, le serveur considere comme plancher un tier
            // qui ne le sera plus, et efface le seuil qu'on vient de lui
            // ecrire (bug du 14/09 : le tier se retrouvait sans seuil, puis
            // avec une valeur incoherente, et le classement partait de
            // travers). Une fois les rangs poses, chaque PUT porte sur un
            // tier dont la position est definitive.
            const original = await apiCall('/admin/tiers', 'GET');
            if (!Array.isArray(original)) throw new Error("Lecture des tiers existants impossible");
            // Un tier venu du serveur SANS id est anormal : plutot que de
            // supprimer toute la table par erreur (ce que faisait le filtre
            // `t.id > 0` quand l'id manquait), on s'arrete net.
            if (original.some(t => !estIdServeur(t.id))) {
                throw new Error("Le serveur n'a pas renvoyé l'identifiant des tiers existants");
            }
            const idsConserves = new Set(tiersState.filter(t => estIdServeur(t.id)).map(t => t.id));

            // 1. Suppressions des tiers retires du tableau.
            for (const t of original) {
                if (!idsConserves.has(t.id)) {
                    const res = await apiCall(`/admin/tiers/${t.id}`, 'DELETE');
                    if (res.error) throw new Error(res.error);
                }
            }

            // 2. Creations. Le nom et la couleur suffisent ici : le seuil sera
            //    pose par le PUT de l'etape 4, une fois les rangs definitifs.
            for (const t of tiersState) {
                if (!estIdServeur(t.id)) {
                    const res = await apiCall('/admin/tiers', 'POST', {
                        nom: t.nom.trim(), couleur: t.couleur, seuil_k: t.seuil_k,
                    });
                    if (res.error) throw new Error(res.error);
                    if (typeof res.id !== 'number') throw new Error("Le serveur n'a pas renvoyé l'id du tier créé");
                    t.id = res.id;
                }
            }

            // 3. Ordre definitif, AVANT d'ecrire les seuils.
            const ordre = tiersState.map(t => t.id);
            const resOrdre = await apiCall('/admin/tiers/reorder', 'PUT', { ordre });
            if (resOrdre.error) throw new Error(resOrdre.error);

            // 4. Nom, couleur et seuil de chaque tier, a sa place definitive.
            //    seuil_k est toujours transmis, `null` pour le plancher :
            //    l'omettre laissait un ancien plancher promu sans seuil.
            //    Seulement les tiers crees ou modifies : chaque PUT recalcule
            //    le tier de tous les joueurs.
            const lus = new Map(original.map(t => [t.id, t]));
            for (const t of tiersState) {
                const o = lus.get(t.id);
                const seuil = t.seuil_k === undefined ? null : t.seuil_k;
                if (o && o.nom === t.nom.trim() && o.couleur === t.couleur
                        && (o.seuil_k === undefined ? null : o.seuil_k) === seuil) continue;
                const res = await apiCall(`/admin/tiers/${t.id}`, 'PUT', {
                    nom: t.nom.trim(), couleur: t.couleur,
                    seuil_k: (t.seuil_k === undefined ? null : t.seuil_k),
                });
                if (res.error) throw new Error(res.error);
            }

            // 5. Couleur de U, a part : ce n'est pas un tier.
            if (couleurU !== couleurUServeur) {
                const res = await apiCall('/admin/tiers/unranked', 'PUT', { couleur: couleurU });
                if (res.error) throw new Error(res.error);
            }

            alert("Tiers enregistrés — les tiers de tous les joueurs viennent d'être recalculés.");
            if (typeof oublierTiers === 'function') oublierTiers();
            await initTierChart();
        } catch (e) {
            alert("Erreur: " + (e.message || e));
        } finally {
            saveBtn.classList.remove('is-loading');
        }
    }

    async function initTierChart() {
        const canvasEl = document.getElementById('tierChart');
        if (!canvasEl) return; // page/permission sans ce bloc

        const loading = document.getElementById('tierChartLoading');
        const wrapper = document.getElementById('tierChartWrapper');
        const empty = document.getElementById('tierChartEmpty');
        loading.style.display = '';
        wrapper.style.display = 'none';
        empty.style.display = 'none';

        // `loadTiers()` (gestion.js) plutot qu'un apiCall direct : les deux
        // scripts vivent sur la meme page et voulaient tous deux la liste des
        // tiers au chargement, soit DEUX requetes pour la meme donnee. Le cache
        // de gestion.js mutualise la promesse, donc une seule part sur le
        // reseau. Sur une page qui en emet deja 7, c'en est une de moins dans
        // le budget du limiteur nginx (docs/audit-503-zone-admin.md, §11).
        //
        // Le repli garde la page fonctionnelle si gestion.js n'est pas charge :
        // ce script sert aussi ailleurs.
        const [dist, tiersData, couleurUData] = await Promise.all([
            apiCall('/admin/config/tier-distribution', 'GET'),
            (typeof loadTiers === 'function')
                ? loadTiers()
                : apiCall('/admin/tiers', 'GET'),
            (typeof loadCouleurU === 'function')
                ? loadCouleurU()
                : apiCall('/admin/tiers/unranked', 'GET').then(r => r && r.couleur),
        ]);
        couleurU = couleurUServeur = couleurSure(couleurUData);

        loading.style.display = 'none';

        if (!dist || dist.error || !Array.isArray(dist.players) || dist.players.length < 2
            || !Array.isArray(dist.curve) || dist.curve.length === 0
            || typeof dist.mean !== 'number' || typeof dist.stdev !== 'number') {
            empty.style.display = '';
            return;
        }

        playersRaw = dist.players;
        // mean/stdev renvoyes tels quels par le backend (build_distribution) :
        // les reconstruire depuis min/max de la courbe etait fragile, la
        // boucle qui genere la courbe n'atteint pas toujours exactement sa
        // borne haute (accumulation flottante), ce qui decalait legerement
        // les lignes de seuil affichees par rapport a la vraie distribution
        // (bug du 14/09).
        mean = dist.mean;
        stdev = dist.stdev || 1;
        // Bornes de l'axe calees sur mean/stdev (meme demi-largeur que le
        // backend pour generer la courbe, cf _CURVE_SPREAD dans services.py),
        // PAS relues depuis les points de dist.curve : cette derniere est
        // tronquee de facon asymetrique par l'accumulation flottante de la
        // boucle qui la genere (son dernier point n'atteint jamais tout a
        // fait x_max). Un axe cale sur cette plage tronquee restait legerement
        // decentre par rapport a mean, donc les graduations en sigma (0, ±1...)
        // ne tombaient pas exactement ou la ligne de seuil glissee semblait
        // pointer (bug persistant du 14/09, constate lors du drag).
        const CURVE_SPREAD = 3.5; // doit suivre _CURVE_SPREAD dans services.py
        const xMin = mean - CURVE_SPREAD * stdev, xMax = mean + CURVE_SPREAD * stdev;

        tiersState = (Array.isArray(tiersData) ? tiersData : [])
            .map(t => ({ id: t.id, nom: t.nom, couleur: t.couleur, seuil_k: t.seuil_k, rang: t.rang }))
            .sort((a, b) => b.rang - a.rang);
        if (tiersState.length === 0) {
            empty.style.display = '';
            return;
        }

        wrapper.style.display = '';

        if (chart) { chart.destroy(); chart = null; }
        const ctx = canvasEl.getContext('2d');
        chart = new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: [
                    {
                        type: 'line', label: 'Distribution', data: dist.curve,
                        borderColor: 'rgba(255,255,255,0.2)', borderWidth: 2,
                        pointRadius: 0, pointHoverRadius: 0, pointHitRadius: 0,
                        fill: true, backgroundColor: 'rgba(255,255,255,0.02)',
                        tension: 0.4, animation: false,
                    },
                    {
                        type: 'scatter', label: 'Joueurs', data: playerPointsForChart(),
                        backgroundColor: colorsForPoints(),
                        borderColor: '#fff', borderWidth: 1,
                        pointRadius: 6, pointHoverRadius: 8,
                    },
                ],
            },
            plugins: [tierLinesPlugin],
            options: {
                responsive: true, maintainAspectRatio: false,
                animation: false,
                layout: { padding: { top: 24 } },
                events: ['mousemove', 'mouseout', 'click', 'touchstart'],
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        filter: () => draggingIdx < 0,
                        callbacks: {
                            title: c => c[0].raw.name || 'Joueur',
                            label: c => `${kFromScore(c.raw.x).toFixed(2)}σ — tier ${tierForScore(c.raw.x)}`,
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        min: xMin, max: xMax,
                        afterBuildTicks: axis => {
                            // Axe affiche en ecart-type (0, ±1, ±2...) plutot
                            // qu'en score TrueSkill brut, pour rester lisible
                            // independamment de l'echelle du jour. `ticks.values`
                            // n'impose PAS de positions exactes sur un axe
                            // lineaire (Chart.js le fusionne avec son propre
                            // generateur et peut en sauter -- le -1σ manquant
                            // constate malgre autoSkip:false). afterBuildTicks
                            // est l'API qui remplace vraiment la liste des ticks :
                            // un par multiple entier de sigma dans la plage
                            // visible, mean (0σ) toujours inclus.
                            const kMin = Math.ceil(kFromScore(xMin));
                            const kMax = Math.floor(kFromScore(xMax));
                            const vals = [];
                            for (let k = kMin; k <= kMax; k++) vals.push(scoreFromK(k));
                            axis.ticks = vals.map(v => ({ value: v }));
                        },
                        ticks: {
                            autoSkip: false,
                            maxRotation: 0,
                            callback: value => `${(kFromScore(value).toFixed(0).replace('-0', '0'))}σ`,
                        },
                    },
                    y: { display: false },
                },
            },
        });

        attachDragHandlers(canvasEl);
        if (window.ChartZoom) {
            ChartZoom.brancher(chart, {
                // Le doigt reste reserve au graphique, comme avant la loupe :
                // attraper une poignee ne doit jamais faire defiler la page.
                touchActionAuRepos: 'none',
                // Un appui sur une poignee deplace le seuil, pas la vue.
                glisserPermis: (clientX, clientY) =>
                    nearestHandle(ChartZoom.depuisEcran(chart, clientX, clientY).x, chart.scales.x) < 0,
            });
        }
        renderLegend();
        renderTiersPanel();
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!document.getElementById('tierChart')) return;
        attachPanelHandlers();
        attachChoixCouleur();
        initTierChart();
    });
})();
