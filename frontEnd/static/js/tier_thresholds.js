// Tableau de reglage des tiers (page Reglages TrueSkill).
//
// Tiers dynamiques (Partie B, docs/tableau-seuils-tiers-plan.md) : la liste
// des tiers (nom, couleur, seuil en ecart-type, rang) est geree par l'admin
// via /admin/tiers/* (GET/POST/PUT/DELETE + /reorder + /reset), plus figee a
// S/A/B/C. Ce fichier affiche :
//   - un graphique (courbe normale + joueurs + lignes de seuil glissables),
//     genere pour un nombre quelconque de tiers ;
//   - un panneau liste ou chaque tier se renomme, se recolore, se regle (en
//     sigma) et se supprime, avec ajout d'un nouveau tier et bouton
//     Reinitialiser (restaure S/A/B/C par defaut, /admin/tiers/reset).
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

    function redraw() {
        if (!chart) return;
        chart.data.datasets[1].backgroundColor = colorsForPoints();
        chart.update('none');
        renderLegend();
        renderTiersPanel();
    }

    // Pendant un glisse : on redessine le graphique a chaque pixel, mais PAS
    // le tableau -- le reconstruire en continu detruirait les champs a chaque
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
            if (!chart) return;
            chart.data.datasets[1].backgroundColor = colorsForPoints();
            chart.update('none');
            renderLegend();
            const t = tiersState[draggingIdx];
            if (!t || t.seuil_k === null || t.seuil_k === undefined) return;
            const champ = document.querySelector(
                `#tiersListBody tr:nth-child(${draggingIdx + 1}) input[type="number"]`);
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
                area.style.cursor = nearestHandle(px, chart.scales.x) >= 0 ? 'ew-resize' : 'default';
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

    function renderTiersPanel() {
        const body = document.getElementById('tiersListBody');
        if (!body) return;
        body.innerHTML = '';

        tiersState.forEach((t, idx) => {
            const isPlancher = idx === tiersState.length - 1;
            const tr = document.createElement('tr');

            const tdOrdre = document.createElement('td');
            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.className = 'button is-small mr-1';
            upBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
            upBtn.disabled = idx === 0;
            upBtn.onclick = () => { moveTier(idx, idx - 1); };
            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.className = 'button is-small';
            downBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
            downBtn.disabled = idx === tiersState.length - 1;
            downBtn.onclick = () => { moveTier(idx, idx + 1); };
            tdOrdre.appendChild(upBtn);
            tdOrdre.appendChild(downBtn);

            const tdCouleur = document.createElement('td');
            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.value = /^#[0-9a-fA-F]{6}$/.test(t.couleur) ? t.couleur : '#ffffff';
            colorInput.oninput = () => { t.couleur = colorInput.value; redraw(); };
            tdCouleur.appendChild(colorInput);

            const tdNom = document.createElement('td');
            const nomInput = document.createElement('input');
            nomInput.className = 'input is-small';
            nomInput.type = 'text';
            nomInput.maxLength = 10;
            nomInput.style.width = '90px';
            nomInput.value = t.nom;
            nomInput.oninput = () => { t.nom = nomInput.value; };
            nomInput.onblur = () => { redraw(); };
            tdNom.appendChild(nomInput);

            const tdSeuil = document.createElement('td');
            if (isPlancher) {
                const span = document.createElement('span');
                span.className = 'has-text-grey-light is-size-7';
                span.textContent = 'plancher';
                tdSeuil.appendChild(span);
            } else {
                const seuilInput = document.createElement('input');
                seuilInput.className = 'input is-small';
                seuilInput.type = 'number';
                seuilInput.step = '0.01';
                seuilInput.style.width = '90px';
                seuilInput.value = (t.seuil_k !== null && t.seuil_k !== undefined) ? t.seuil_k.toFixed(3) : '';
                seuilInput.oninput = () => {
                    const v = parseFloat(seuilInput.value);
                    if (!isNaN(v)) { t.seuil_k = v; redraw(); }
                };
                tdSeuil.appendChild(seuilInput);
                const unite = document.createElement('span');
                unite.className = 'has-text-grey-light is-size-7 ml-1';
                unite.textContent = 'σ';
                tdSeuil.appendChild(unite);
            }

            const tdSuppr = document.createElement('td');
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'button is-small is-danger is-outlined';
            delBtn.innerHTML = '<i class="fas fa-trash"></i>';
            delBtn.disabled = tiersState.length <= 1;
            delBtn.title = tiersState.length <= 1 ? 'Impossible de supprimer le dernier tier' : 'Supprimer';
            delBtn.onclick = () => { removeTierRow(idx); };
            tdSuppr.appendChild(delBtn);

            tr.appendChild(tdOrdre);
            tr.appendChild(tdCouleur);
            tr.appendChild(tdNom);
            tr.appendChild(tdSeuil);
            tr.appendChild(tdSuppr);
            body.appendChild(tr);
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
            for (const t of tiersState) {
                const res = await apiCall(`/admin/tiers/${t.id}`, 'PUT', {
                    nom: t.nom.trim(), couleur: t.couleur,
                    seuil_k: (t.seuil_k === undefined ? null : t.seuil_k),
                });
                if (res.error) throw new Error(res.error);
            }

            alert("Tiers enregistrés — les tiers de tous les joueurs viennent d'être recalculés.");
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
        const [dist, tiersData] = await Promise.all([
            apiCall('/admin/config/tier-distribution', 'GET'),
            (typeof loadTiers === 'function')
                ? loadTiers()
                : apiCall('/admin/tiers', 'GET'),
        ]);

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
        renderLegend();
        renderTiersPanel();
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!document.getElementById('tierChart')) return;
        attachPanelHandlers();
        initTierChart();
    });
})();
