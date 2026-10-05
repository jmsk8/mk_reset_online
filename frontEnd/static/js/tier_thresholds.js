// Reglage des tiers (page Reglages TrueSkill) : graphique de la distribution
// avec lignes de seuil glissables, et panneau ou chaque tier se renomme, se
// recolore, se regle et se supprime (/admin/tiers/*). Le graphique est en
// score brut ; les seuils sont stockes en ecart-type et convertis via
// mean/stdev de la distribution.

(function () {
    let chart = null;
    let mean = 0, stdev = 1;
    // [{id, nom, couleur, couleur_texte, seuil_k, rang}], trie rang DESC ;
    // seuil_k null pour le plancher.
    let tiersState = [];
    // U (non classe) : seules ses couleurs se reglent, envoyees si elles ont change.
    let couleurU = '#FFFFFF';
    let couleurUServeur = '#FFFFFF';
    let couleurTexteU = '#0A0A0A';
    let couleurTexteUServeur = '#0A0A0A';
    let playersRaw = []; // points {nom,x,y,color} venus du backend
    // Index (pas id) du tier en cours de glisse, -1 si aucun : un tier non
    // enregistre n'a pas d'id.
    let draggingIdx = -1;

    // Vrai si le tier existe en base (id numerique > 0).
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

    // Premier tier dont le score-frontiere est depasse, sinon le plancher.
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

    // Une zone par tier, entre son seuil et celui du tier precedent (au-dessus).
    function zonesFromState() {
        return tiersState.map((t, i) => ({
            nom: t.nom,
            couleur: t.couleur,
            from: scoreSeuil(t), // borne basse (null = -infini)
            to: i > 0 ? scoreSeuil(tiersState[i - 1]) : null, // borne haute (null = +infini)
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

    // Graphique et legende seulement (pendant la saisie, pour ne pas detruire
    // le champ en cours d'edition).
    function redrawGraphique() {
        if (!chart) return;
        chart.data.datasets[1].backgroundColor = colorsForPoints();
        chart.update('none');
        renderLegend();
    }

    // Graphique et panneau, pour les changements de structure.
    function redraw() {
        redrawGraphique();
        renderTiersPanel();
    }

    // Pendant un glisse : graphique redessine a chaque frame, seul le champ de
    // seuil concerne est mis a jour dans le panneau.
    let frameDemandee = false;

    function redrawPendantDrag() {
        if (!chart || frameDemandee) return;
        // Une seule mise a jour par frame.
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

    // Index du tier dont la ligne est la plus proche, ou -1.
    function nearestHandle(pixelX, x) {
        // Tolerance large (valeur ajustable au clavier dans le panneau).
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

    // Ecart minimal entre deux lignes voisines, en unites de score.
    function ecartMinimalEnScore() {
        const MIN_PX = 6;
        if (!chart || !chart.scales || !chart.scales.x) return 0.01;
        const x = chart.scales.x;
        const largeur = Math.abs(x.right - x.left);
        const etendue = Math.abs(x.max - x.min);
        if (!largeur || !etendue) return 0.01;
        return (etendue / largeur) * MIN_PX;
    }

    // Garde le seuil deplace entre ceux des tiers voisins (l'ordre ne change pas).
    function clampToNeighbors(idx, scoreValue) {
        // Ecart minimal exprime en pixels puis converti en score.
        const EPS = ecartMinimalEnScore();
        if (idx < 0 || idx >= tiersState.length) return scoreValue;
        const above = idx > 0 ? scoreSeuil(tiersState[idx - 1]) : null; // rang superieur
        // Voisin du dessous : prochain tier ayant un seuil.
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

        // X dans le repere interne du graphique (taille de rendu du canvas,
        // differente de sa taille CSS).
        function pixelXFromEvent(evt) {
            const source = evt.touches && evt.touches.length ? evt.touches[0] : evt;
            // Loupe : le canvas peut etre transforme, depuisEcran le rapporte
            // a sa taille reelle.
            if (window.ChartZoom) {
                return ChartZoom.depuisEcran(chart, source.clientX, source.clientY).x;
            }
            if (window.Chart && Chart.helpers && Chart.helpers.getRelativePosition) {
                // Gere le ratio rendu/CSS et le devicePixelRatio.
                return Chart.helpers.getRelativePosition(source, chart).x;
            }
            // Repli, ratio applique a la main.
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
                // '' : hors poignee, le curseur de la loupe reprend la main.
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

    // Une ligne par tier (deux rangees au telephone).
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

            // Pastille : ouvre la fenetre de choix des couleurs.
            const zCouleur = zone('couleur');
            const pastille = bouton('tier-pastille', 'fa-palette',
                `Changer les couleurs de ${t.nom || 'ce tier'}`, () => ouvrirChoixCouleur(idx));
            peindrePastille(pastille, t.couleur, t.couleur_texte);
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
                // Champ vide ou illisible : on remet la valeur retenue.
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

        // U, toujours en dernier : seule la pastille est active.
        const ligneU = document.createElement('div');
        ligneU.className = 'tier-ligne tier-ligne-u';
        ligneU.style.setProperty('--tier-couleur', couleurSure(couleurU));

        const zCouleurU = zone('couleur');
        const pastilleU = bouton('tier-pastille', 'fa-palette',
            'Changer les couleurs de U (non classé)', () => ouvrirChoixCouleur(CHOIX_U));
        peindrePastille(pastilleU, couleurU, couleurTexteU);
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

    // --- Choix des couleurs -------------------------------------------------
    // Fenetre partagee (choix_couleur.js) : fond du badge et couleur du texte.

    const { couleurSure, versHex6, texteSur } = ChoixCouleur;
    const peindrePastille = ChoixCouleur.peindre;

    const CHOIX_U = 'U'; // idx de la pastille U

    // N'ecrase une couleur que si elle a change (evite un envoi pour une casse).
    function appliquerChoix(cible, choix) {
        if (versHex6(cible.couleur) !== choix.couleur) cible.couleur = choix.couleur;
        if (!cible.couleur_texte || versHex6(cible.couleur_texte) !== choix.couleurTexte) {
            cible.couleur_texte = choix.couleurTexte;
        }
    }

    function ouvrirChoixCouleur(idx) {
        const t = idx === CHOIX_U
            ? { nom: 'U', couleur: couleurU, couleur_texte: couleurTexteU }
            : tiersState[idx];
        if (!t) return;
        ChoixCouleur.ouvrir({
            titre: `Couleurs du tier ${t.nom.trim() || ''}`.trim(),
            libelle: t.nom.trim() || '?',
            couleur: t.couleur,
            couleurTexte: t.couleur_texte || null,
            surConfirmer: choix => {
                appliquerChoix(t, choix);
                if (idx === CHOIX_U) {
                    couleurU = t.couleur;
                    couleurTexteU = t.couleur_texte;
                    renderTiersPanel(); // U n'est pas sur le graphique
                } else {
                    redraw();
                }
                // Panneau reconstruit : le focus revient a la nouvelle pastille.
                const ligne = idx === CHOIX_U ? '.tier-ligne-u' : `.tier-ligne[data-idx="${idx}"]`;
                const p = document.querySelector(`#tiersListBody ${ligne} .tier-pastille`);
                if (p) p.focus();
            },
        });
    }

    function moveTier(from, to) {
        if (to < 0 || to >= tiersState.length) return;
        const [moved] = tiersState.splice(from, 1);
        tiersState.splice(to, 0, moved);
        // Le plancher (dernier de la liste) n'a pas de seuil.
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
        // Equivalent client de _appliquer_plancher() (routes_admin.py).
        tiersState.forEach((t, i) => {
            const isPlancher = i === tiersState.length - 1;
            if (isPlancher) {
                t.seuil_k = null;
            } else if (t.seuil_k === null || t.seuil_k === undefined) {
                // Ancien plancher promu : seuil de depart juste sous son voisin.
                const above = i > 0 ? tiersState[i - 1].seuil_k : null;
                t.seuil_k = above !== null ? above - 1 : 0;
            }
        });
    }

    function addTierRow() {
        const top = tiersState[0];
        const nouveauK = top && top.seuil_k !== null && top.seuil_k !== undefined ? top.seuil_k + 1 : 1;
        // id null : tier a creer par saveTiers.
        tiersState.unshift({
            id: null, nom: 'Nouveau', couleur: '#cccccc', couleur_texte: texteSur('#cccccc'),
            seuil_k: nouveauK, rang: 0,
        });
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
        for (let i = 0; i < tiersState.length - 1; i++) {
            const k = tiersState[i].seuil_k;
            if (k === null || k === undefined || isNaN(k)) {
                return `Le tier « ${tiersState[i].nom} » n'a pas de seuil valide.`;
            }
        }
        // Seuils strictement decroissants (hors plancher).
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
            // Ordre : suppressions, creations, reordonnancement, puis seuils
            // (le serveur doit connaitre l'ordre final avant les PUT).
            const original = await apiCall('/admin/tiers', 'GET');
            if (!Array.isArray(original)) throw new Error("Lecture des tiers existants impossible");
            // Tier serveur sans id : on s'arrete plutot que de tout supprimer.
            if (original.some(t => !estIdServeur(t.id))) {
                throw new Error("Le serveur n'a pas renvoyé l'identifiant des tiers existants");
            }
            const idsConserves = new Set(tiersState.filter(t => estIdServeur(t.id)).map(t => t.id));

            for (const t of original) {
                if (!idsConserves.has(t.id)) {
                    const res = await apiCall(`/admin/tiers/${t.id}`, 'DELETE');
                    if (res.error) throw new Error(res.error);
                }
            }

            // 2. Creations (seuil pose a l'etape 4).
            for (const t of tiersState) {
                if (!estIdServeur(t.id)) {
                    const res = await apiCall('/admin/tiers', 'POST', {
                        nom: t.nom.trim(), couleur: t.couleur, couleur_texte: t.couleur_texte,
                        seuil_k: t.seuil_k,
                    });
                    if (res.error) throw new Error(res.error);
                    if (typeof res.id !== 'number') throw new Error("Le serveur n'a pas renvoyé l'id du tier créé");
                    t.id = res.id;
                }
            }

            // 3. Ordre definitif.
            const ordre = tiersState.map(t => t.id);
            const resOrdre = await apiCall('/admin/tiers/reorder', 'PUT', { ordre });
            if (resOrdre.error) throw new Error(resOrdre.error);

            // 4. Nom, couleurs et seuil des tiers crees ou modifies (seuil_k null
            //    pour le plancher).
            const lus = new Map(original.map(t => [t.id, t]));
            for (const t of tiersState) {
                const o = lus.get(t.id);
                const seuil = t.seuil_k === undefined ? null : t.seuil_k;
                if (o && o.nom === t.nom.trim() && o.couleur === t.couleur
                        && o.couleur_texte === t.couleur_texte
                        && (o.seuil_k === undefined ? null : o.seuil_k) === seuil) continue;
                const res = await apiCall(`/admin/tiers/${t.id}`, 'PUT', {
                    nom: t.nom.trim(), couleur: t.couleur, couleur_texte: t.couleur_texte,
                    seuil_k: (t.seuil_k === undefined ? null : t.seuil_k),
                });
                if (res.error) throw new Error(res.error);
            }

            // 5. Couleurs de U, envoyees ensemble : ce qui s'affiche est ce qui est garde.
            if (couleurU !== couleurUServeur || couleurTexteU !== couleurTexteUServeur) {
                const res = await apiCall('/admin/tiers/unranked', 'PUT', {
                    couleur: couleurU, couleur_texte: couleurTexteU,
                });
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
        if (!canvasEl) return; // bloc absent (page ou permission)

        const loading = document.getElementById('tierChartLoading');
        const wrapper = document.getElementById('tierChartWrapper');
        const empty = document.getElementById('tierChartEmpty');
        loading.style.display = '';
        wrapper.style.display = 'none';
        empty.style.display = 'none';

        // loadTiers() (gestion.js) mutualise la requete ; repli sur un appel
        // direct si gestion.js n'est pas charge.
        const [dist, tiersData, couleursUData] = await Promise.all([
            apiCall('/admin/config/tier-distribution', 'GET'),
            (typeof loadTiers === 'function')
                ? loadTiers()
                : apiCall('/admin/tiers', 'GET'),
            (typeof loadCouleurU === 'function')
                ? loadCouleurU()
                : apiCall('/admin/tiers/unranked', 'GET'),
        ]);
        const u = couleursUData || {};
        couleurU = couleurUServeur = couleurSure(u.couleur);
        couleurTexteU = couleurTexteUServeur =
            u.couleur_texte ? couleurSure(u.couleur_texte) : texteSur(couleurU);

        loading.style.display = 'none';

        if (!dist || dist.error || !Array.isArray(dist.players) || dist.players.length < 2
            || !Array.isArray(dist.curve) || dist.curve.length === 0
            || typeof dist.mean !== 'number' || typeof dist.stdev !== 'number') {
            empty.style.display = '';
            return;
        }

        playersRaw = dist.players;
        // mean/stdev fournis par le backend (build_distribution).
        mean = dist.mean;
        stdev = dist.stdev || 1;
        // Bornes de l'axe calculees depuis mean/stdev (comme _CURVE_SPREAD de
        // services.py), pas depuis les points de la courbe.
        const CURVE_SPREAD = 3.5; // doit suivre _CURVE_SPREAD dans services.py
        const xMin = mean - CURVE_SPREAD * stdev, xMax = mean + CURVE_SPREAD * stdev;

        tiersState = (Array.isArray(tiersData) ? tiersData : [])
            .map(t => ({
                id: t.id, nom: t.nom, couleur: t.couleur,
                couleur_texte: t.couleur_texte || '#FFFFFF', seuil_k: t.seuil_k, rang: t.rang,
            }))
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
                            // Axe en ecart-type : afterBuildTicks impose un tick
                            // par multiple entier de sigma (ticks.values ne
                            // garantit pas les positions).
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
                // Le doigt reste reserve au graphique (poignees).
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
        initTierChart();
    });
})();
