function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

async function apiCall(endpoint, method = 'GET', body = null) {
    // Pas d'en-tête d'auth : ces URL sont les routes proxy du frontend, qui
    // injectent X-Admin-Token depuis la session serveur.
    //
    // `Accept` est explicite et non décoratif : le frontend s'en sert pour
    // distinguer l'ouverture d'une PAGE d'un appel de données fait par une page
    // déjà ouverte, et ne revalider la session que dans le premier cas. Sans cet
    // en-tête, `fetch()` envoie « */* », que le serveur doit alors traiter comme
    // une navigation -- ce qui revalidait la session sur chacun de ces appels,
    // soit 9 allers-retours backend pour ouvrir une page qui n'en vaut que 4
    // (docs/audit-503-zone-admin.md).
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    if (csrfMeta) {
        headers['X-CSRFToken'] = csrfMeta.content;
    }

    const options = { method: method, headers: headers };
    if (body) options.body = JSON.stringify(body);

    try {
        console.log(`📡 Appel API : ${method} ${endpoint}`);
        const response = await fetch(endpoint, options);
        
        if (response.status === 401 || response.status === 403) {
            // Tous les refus ne sont pas une session morte. Depuis la hiérarchie
            // à 4 rôles, un 403 dit le plus souvent « ce droit ne vous a pas été
            // accordé » : rediriger vers la connexion serait absurde, l'intéressé
            // se reconnecterait pour retomber sur le même refus. On distingue
            // donc sur le code renvoyé (hierarchie-admin-plan.md, B.5).
            let code = null;
            try { code = JSON.parse(await response.clone().text()).code; } catch (e) {}

            const REFUS_DE_DROIT = ['permission_manquante', 'droits_insuffisants',
                                    'cible_protegee', 'auto_modification',
                                    'plafond_delegation'];
            if (response.status === 403 && REFUS_DE_DROIT.includes(code)) {
                console.warn("⛔ Droit manquant :", code);
                alert("Vous n'avez pas ce droit. S'il vient de vous être retiré, "
                      + "rechargez la page.");
                return { error: "Droits insuffisants", code: code };
            }

            console.warn("⛔ Session expirée ou non autorisée");
            alert("Votre session a expiré. Redirection vers la connexion...");
            window.location.href = '/admin';
            return { error: "Non autorisé" };
        }

        // 503 = le limiteur de débit de nginx a rejeté l'appel, et sa réponse
        // est une page HTML. Sans ce cas, on tombait dans le catch du parse et
        // l'utilisateur lisait « Erreur serveur (Réponse invalide) » -- un
        // message qui accuse le serveur d'être cassé alors qu'il se protège, et
        // qui n'indique pas la seule chose utile : attendre quelques secondes.
        if (response.status === 503) {
            const attente = parseInt(response.headers.get('Retry-After'), 10) || 5;
            console.warn(`⏳ Débit limité par le serveur, réessayer dans ${attente}s`);
            return { error: `Trop de requêtes d'un coup. Patientez ${attente} secondes, `
                            + `puis rechargez la page.`, limite: true };
        }

        const text = await response.text();
        try {
            const data = JSON.parse(text);
            return data;
        } catch (e) {
            console.error("❌ Erreur parsing JSON:", text);
            return { error: "Erreur serveur (Réponse invalide)" };
        }
    } catch (error) {
        console.error("❌ Erreur réseau :", error);
        return { error: error.message };
    }
}

// Couleurs des tiers dynamiques (Partie B) : chargees une fois depuis
// /admin/tiers et mises en cache ici plutot que refaire un appel reseau par
// ligne de tableau. `tiersColorCache` mappe nom -> couleur hex ; 'U' reste
// hors de la table `tiers`, gere a part.
let tiersColorCache = null;
// La PROMESSE, pas seulement le résultat : loadPlayers() et loadTierLegend()
// partent en parallèle au chargement de la page, et ne mémoriser que le
// résultat laissait les deux appeler /admin/tiers avant qu'il n'existe. Deux
// requêtes pour la même donnée, sur une zone nginx limitée à 30 r/min.
let tiersPromesse = null;

// La réponse brute, que loadTierLegend réutilise : elle a besoin du `rang`,
// que la table nom -> couleur ne garde pas.
async function loadTiers() {
    if (tiersPromesse) return tiersPromesse;
    tiersPromesse = apiCall('/admin/tiers', 'GET').then(res => {
        const liste = Array.isArray(res) ? res : [];
        tiersColorCache = Object.fromEntries(liste.map(t => [t.nom, t.couleur]));
        return liste;
    }).catch(e => {
        // Un échec ne doit pas figer le cache sur une promesse rejetée :
        // le prochain appel doit pouvoir réessayer.
        tiersPromesse = null;
        throw e;
    });
    return tiersPromesse;
}

async function loadTiersColorCache() {
    await loadTiers();
    return tiersColorCache;
}

// Renvoie {class, style} pour un badge de tier : `style` porte la couleur
// dynamique (fond degrade non reproduit ici -- juste la couleur du tier),
// `class` gere seulement les cas hors table (U, tier inconnu/vide).
function getTierColor(rank) {
    if (!rank) return { class: 'is-light', style: '' };
    const cleanedRank = rank.trim();
    if (cleanedRank === 'U') return { class: 'is-white', style: '' };
    const couleur = tiersColorCache && tiersColorCache[cleanedRank];
    if (couleur) return { class: '', style: `background:${couleur}; color:#fff;` };
    return { class: 'is-light', style: '' };
}


document.addEventListener('DOMContentLoaded', () => {
    const fadeElems = document.querySelectorAll('.fade-in');
    fadeElems.forEach(elem => {
        requestAnimationFrame(() => {
            elem.classList.add('visible');
        });
    });

    loadPlayers();
    loadConfig();
    loadTierLegend();

    const dateInput = document.getElementById('globalResetDate');
    if (dateInput) {
        dateInput.valueAsDate = new Date();
    }

    const addForm = document.getElementById('addPlayerForm');
    if (addForm) {
        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const newMu = parseFloat(document.getElementById('newMu').value);
            const newSigma = parseFloat(document.getElementById('newSigma').value);
            const nom = document.getElementById('newNom').value;
            const newColor = document.getElementById('newColor').value;

            if (isNaN(newMu) || isNaN(newSigma)) {
                alert("Erreur: Mu et Sigma doivent être des nombres.");
                return;
            }

            // Même règle qu'à l'édition : sans le droit, on n'envoie pas le
            // champ, et le backend applique la valeur par défaut. Les champs
            // sont déjà grisés côté gabarit, ceci ferme l'appel direct.
            const data = { nom: nom };
            if (peutChamp('mu')) { data.mu = newMu; data.sigma = newSigma; }
            if (peutChamp('color')) data.color = newColor;

            const res = await apiCall('/admin/joueurs', 'POST', data);
            
            if (res.error) {
                alert("Erreur: " + res.error);
            } else if (res.status === 'success') {
                document.getElementById('newNom').value = "";
                document.getElementById('newMu').value = "50"; 
                document.getElementById('newSigma').value = "8.333";
                document.getElementById('newColor').value = "#ffffff";
                loadPlayers();
            }
        });
    }

    const configForm = document.getElementById('configForm');
    if (configForm) {
        configForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const tau = parseFloat(document.getElementById('configTau').value);
            const ghost = document.getElementById('configGhost').checked;
            const ghostPenalty = parseFloat(document.getElementById('configGhostPenalty').value);
            const ghostThresholdSessions = parseInt(document.getElementById('configGhostThresholdSessions').value);
            const ghostIntervalSessions = parseInt(document.getElementById('configGhostIntervalSessions').value);
            const unrankedLimit = parseInt(document.getElementById('configUnrankedLimit').value);
            const sigmaThreshold = parseFloat(document.getElementById('configSigmaLimit').value);
            const ipVersionLive = document.querySelector('input[name="ipVersionLive"]:checked')?.value || 'v1';

            if (isNaN(tau)) { alert("Erreur: Tau invalide."); return; }
            if (isNaN(ghostPenalty)) { alert("Erreur: Pénalité invalide."); return; }
            if (isNaN(ghostThresholdSessions) || ghostThresholdSessions < 1) { alert("Erreur: Seuil d'absence (sessions) invalide."); return; }
            if (isNaN(ghostIntervalSessions) || ghostIntervalSessions < 1) { alert("Erreur: Fréquence de pénalité (sessions) invalide."); return; }
            if (isNaN(unrankedLimit)) { alert("Erreur: Limite Unranked invalide."); return; }
            if (isNaN(sigmaThreshold)) { alert("Erreur: Limite Sigma invalide."); return; }

            const res = await apiCall('/admin/config', 'POST', {
                tau: tau,
                ghost_enabled: ghost,
                ghost_penalty: ghostPenalty,
                ghost_threshold_sessions: ghostThresholdSessions,
                ghost_interval_sessions: ghostIntervalSessions,
                unranked_threshold: unrankedLimit,
                sigma_threshold: sigmaThreshold,
                ip_version_live: ipVersionLive
            });
            
            if (res.error) alert("Erreur: " + res.error);
            else alert("Configuration sauvegardée avec succès !");
        });
    }
});


// Dernier chargement de /admin/joueurs, indexe par id : deletePlayer() ne
// recoit qu'un id par son onclick.
const joueursCharges = {};

async function loadPlayers() {
    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="5" class="has-text-centered has-text-grey">Chargement en cours...</td></tr>';

    const [res] = await Promise.all([apiCall('/admin/joueurs', 'GET'), loadTiersColorCache()]);
    tbody.innerHTML = '';

    if (res.error) {
        tbody.innerHTML = `<tr><td colspan="5" class="has-text-danger has-text-centered">Erreur Backend: ${escapeHtml(res.error)}</td></tr>`;
        return;
    }
    
    if (!Array.isArray(res) || res.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="has-text-grey has-text-centered">Aucun joueur trouvé.</td></tr>`;
        return;
    }

    res.forEach(player => {
        joueursCharges[player.id] = player;
        const tr = document.createElement('tr');
        const tierBadge = getTierColor(player.tier);

        const badgeCompte = player.compte_lie
            ? `<span class="icon has-text-link ml-1" title="Compte Discord rattaché : `
              + `${escapeHtml(player.compte_lie.pseudo)}"><i class="fab fa-discord"></i></span>`
            : '';
        
        const rowOpacity = (player.is_ranked === false) ? 'style="opacity: 0.6;"' : '';

        tr.innerHTML = `
            <td class="has-text-centered">${player.is_ranked
                ? '<span class="icon has-text-success"><i class="fas fa-square-check"></i></span>'
                : '<span class="icon has-text-danger"><i class="fas fa-square-xmark"></i></span>'}
            </td>
            <td class="has-text-white font-weight-bold" ${rowOpacity}>
                <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background-color:${escapeHtml(player.color || '#fff')}; margin-right:8px; border:1px solid #555;"></span>
                ${escapeHtml(player.nom || 'Inconnu')}${badgeCompte}
            </td>
            <td class="has-text-grey-light" ${rowOpacity}>
                ${player.mu ? parseFloat(player.mu).toFixed(3) : '0.000'}
            </td>
            <td class="has-text-grey-light" ${rowOpacity}>
                ${player.sigma ? parseFloat(player.sigma).toFixed(3) : '0.000'}
            </td>
            <td ${rowOpacity}>
                <span class="tag ${tierBadge.class}" style="${tierBadge.style}">${escapeHtml(player.tier || '?')}</span>
            </td>
            <td class="has-text-right">
                <button class="button is-small is-info is-outlined mr-1"
                    onclick="openEditModal(${player.id}, '${escapeHtml(player.nom).replace(/'/g, "\\'")}', ${player.mu}, ${player.sigma}, ${player.is_ranked}, ${player.consecutive_missed}, '${escapeHtml(player.color || '#ffffff')}')">
                    <i class="fas fa-edit"></i>
                </button>
                ${peutChamp('irreversible') ? `
                <button class="button is-small is-danger is-outlined" onclick="deletePlayer(${player.id})">
                    <i class="fas fa-trash"></i>
                </button>` : `
                <button class="button is-small is-danger is-outlined est-interdit" disabled
                    title="Vous n'avez pas la permission « Supprimer ou anonymiser ».">
                    <i class="fas fa-trash"></i>
                </button>`}
            </td>
        `;
        tbody.appendChild(tr);
        requestAnimationFrame(() => tr.classList.add('visible'));
    });
}

async function loadConfig() {
    // Le formulaire de configuration ne vit plus que sur la page Réglages : ce
    // script sert aussi les Fiches joueurs, qui ne le contient pas. Sortir tôt
    // évite l'appel réseau inutile ET la TypeError sur un getElementById nul,
    // qui interromprait tout le reste du script.
    if (!document.getElementById('configForm')) return;

    const res = await apiCall('/admin/config', 'GET');
    if (!res || res.error) return;

    // Chaque champ est posé indépendamment : un id absent ne doit pas empêcher
    // les suivants d'être remplis.
    const poser = (id, valeur, propriete) => {
        if (valeur === undefined) return;
        const el = document.getElementById(id);
        if (el) el[propriete || 'value'] = valeur;
    };

    poser('configTau', res.tau);
    poser('configGhost', res.ghost_enabled, 'checked');
    poser('configGhostPenalty', res.ghost_penalty);
    poser('configGhostThresholdSessions', res.ghost_threshold_sessions);
    poser('configGhostIntervalSessions', res.ghost_interval_sessions);
    poser('configUnrankedLimit', res.unranked_threshold);
    poser('configSigmaLimit', res.sigma_threshold);

    if (res.ip_version_live !== undefined) {
        const isV2 = res.ip_version_live === 'v2';
        poser('configIpVersionV2', isV2, 'checked');
        poser('configIpVersionV1', !isV2, 'checked');
    }
}

// Legende des tiers (page Fiches joueurs) : tiers dynamiques (Partie B),
// plus de S/A/B/C figes dans le gabarit -- voir
// docs/tableau-seuils-tiers-plan.md. Le 'U' (non classe) reste dans le HTML,
// hors de la table `tiers`, et sert de point d'ancrage pour l'insertion.
async function loadTierLegend() {
    const list = document.getElementById('tierLegendList');
    if (!list) return; // page sans ce bloc

    // Passe par le cache partagé : loadPlayers() demande la même liste au même
    // moment, et deux appels pour une donnée identique épuisent pour rien le
    // budget de la zone nginx `admin`.
    const res = await loadTiers();
    if (!Array.isArray(res)) return;

    const uLi = list.querySelector('li');
    res.slice().sort((a, b) => b.rang - a.rang).forEach((t, idx, arr) => {
        const li = document.createElement('li');
        const tag = document.createElement('span');
        tag.className = 'tag is-light';
        tag.style.background = t.couleur;
        tag.style.color = '#fff';
        tag.textContent = t.nom;
        const isPlancher = idx === arr.length - 1;
        li.appendChild(tag);
        li.appendChild(document.createTextNode(
            ' ' + (isPlancher ? 'Débutant' : (idx === 0 ? 'Top Tier' : 'Intermédiaire'))
        ));
        list.insertBefore(li, uLi);
    });
}

async function deletePlayer(id) {
    const joueur = joueursCharges[id];

    // Fiche rattachee : ca merite mieux qu'un « Êtes-vous sûr ? » generique.
    if (joueur && joueur.compte_lie) {
        if (!confirm(
            "⚠️ ATTENTION — cette fiche est rattachée à un compte Discord.\n\n"
            + "  fiche  : " + (joueur.nom || '') + "\n"
            + "  compte : " + joueur.compte_lie.pseudo + "\n\n"
            + "La supprimer détachera ce compte : la personne se retrouvera "
            + "sans fiche joueur et devra en revendiquer une nouvelle.\n"
            + "Son compte Discord, lui, n'est pas supprimé.\n\n"
            + "Continuer ?"
        )) return;
    }

    if(!confirm("Êtes-vous sûr de vouloir supprimer ce joueur définitivement ? (Irréversible)")) return;

    const res = await apiCall(`/admin/joueurs/${id}`, 'DELETE');
    if(res.status === 'success') {
        if (res.compte_delie) {
            alert("Fiche supprimée. Le compte Discord « " + res.compte_delie.pseudo
                  + " » a été détaché et repasse en « " + res.compte_delie.statut + " ».");
        }
        loadPlayers();
        return;
    }

    // Le backend refuse de supprimer un joueur qui a un historique et propose
    // l'anonymisation : encore faut-il pouvoir la déclencher d'ici.
    if (res.code === 'historique_non_vide') {
        if (!confirm(
            (res.error || "") + "\n\n"
            + "Anonymiser ce joueur à la place ?\n\n"
            + "Son nom sera remplacé par un identifiant neutre. Ses statistiques, "
            + "son classement et ses trophées restent strictement identiques.\n"
            + "L'ancien nom ne pourra plus être ressaisi."
        )) return;

        const anon = await apiCall(`/admin/joueurs/${id}/anonymiser`, 'POST');
        if (anon.status === 'success') {
            alert(`✅ « ${anon.ancien_nom} » est désormais « ${anon.nouveau_nom} ».`);
            loadPlayers();
        } else {
            alert("Erreur lors de l'anonymisation : " + (anon.error || ""));
        }
        return;
    }

    alert("Erreur lors de la suppression: " + (res.error || ""));
}

// Droits de la session sur la fiche joueur, déclarés par le gabarit avant ce
// script. Le `typeof` protège les autres pages qui chargent gestion.js sans
// les définir : elles n'ouvrent pas cette modale, mais elles lisent le fichier.
function peutChamp(nom) {
    const drapeaux = (typeof PEUT_CHAMPS_JOUEUR !== 'undefined') ? PEUT_CHAMPS_JOUEUR : null;
    return drapeaux ? drapeaux[nom] === true : true;
}

// Grise un champ et explique pourquoi au survol, plutôt que de le masquer :
// l'admin voit la valeur, comprend qu'un droit lui manque, et peut la demander.
function interdireChamp(idChamp, permission) {
    const champ = document.getElementById(idChamp);
    if (!champ) return;
    champ.disabled = true;
    champ.readOnly = true;
    champ.classList.add('est-interdit');
    champ.title = "Vous n'avez pas la permission « " + permission + " ».";
}

function openEditModal(id, nom, mu, sigma, isRanked, missed, color) {
    document.getElementById('editId').value = id;
    document.getElementById('editNom').value = nom;
    document.getElementById('editMu').value = parseFloat(mu).toFixed(3);
    document.getElementById('editSigma').value = parseFloat(sigma).toFixed(3);
    document.getElementById('editMissed').value = missed !== undefined ? missed : 0;
    document.getElementById('editColor').value = color || '#ffffff';

    // Chaque champ est réactivé avant d'être éventuellement réinterdit : la
    // modale est réutilisée d'un joueur à l'autre, un état laissé collé
    // interdirait un champ pour le reste de la session.
    const btnRanked = document.getElementById('rankedToggleBtn');
    [['editNom', 'nom', 'Renommer'],
     ['editMu', 'mu', 'Corriger le score'],
     ['editSigma', 'sigma', 'Corriger le score'],
     ['editColor', 'color', 'Changer la couleur']].forEach(([idChamp, cle, libelle]) => {
        const champ = document.getElementById(idChamp);
        if (!champ) return;
        champ.disabled = false;
        champ.readOnly = false;
        champ.classList.remove('est-interdit');
        champ.removeAttribute('title');
        if (!peutChamp(cle)) interdireChamp(idChamp, libelle);
    });

    if (btnRanked) {
        btnRanked.classList.toggle('est-interdit', !peutChamp('is_ranked'));
        btnRanked.title = peutChamp('is_ranked')
            ? '' : "Vous n'avez pas la permission « Changer le statut classé ».";
    }

    updateRankedVisuals(isRanked);

    document.getElementById('editModal').classList.add('is-active');
}

function toggleRankedStatus() {
    // Sans le droit, le bouton reste inerte plutôt que de laisser croire au
    // changement puis d'échouer à l'enregistrement.
    const btn = document.getElementById('rankedToggleBtn');
    if (btn && btn.classList.contains('est-interdit')) return;
    const currentVal = document.getElementById('editIsRankedValue').value === 'true';
    updateRankedVisuals(!currentVal);
}

function updateRankedVisuals(isRanked) {
    document.getElementById('editIsRankedValue').value = isRanked;
    const btn = document.getElementById('rankedToggleBtn');
    const icon = document.getElementById('rankedIcon');
    const text = document.getElementById('rankedText');

    // `est-interdit` est posée une fois à l'ouverture de la modale, alors que
    // className est réécrit à chaque bascule : la relire ici évite qu'un simple
    // rafraîchissement visuel ne rende le bouton cliquable.
    const interdit = btn.classList.contains('est-interdit') ? ' est-interdit' : '';

    if (isRanked) {
        btn.className = 'button is-success is-fullwidth' + interdit;
        icon.innerHTML = '<i class="fas fa-check"></i>';
        text.innerText = 'Joueur Classé (Actif)';
    } else {
        btn.className = 'button is-danger is-outlined is-fullwidth' + interdit;
        icon.innerHTML = '<i class="fas fa-times"></i>';
        text.innerText = 'Non Classé (Inactif)';
    }
}


function closeModal() {
    document.getElementById('editModal').classList.remove('is-active');
}

async function saveEdit() {
    const id = document.getElementById('editId').value;

    // Un champ désactivé n'est PAS envoyé. Le backend n'exige la
    // sous-permission que sur les champs présents et réellement modifiés : lui
    // renvoyer une valeur qu'on n'a pas le droit de changer produirait un 403,
    // même sans y avoir touché.
    //
    // Ce n'est pas qu'une précaution : mu et sigma sont affichés arrondis à 3
    // décimales alors que TrueSkill en produit bien plus, donc les renvoyer
    // tels quels serait lu comme un vrai changement de valeur.
    const data = {};
    const siActif = (idChamp, cle, lire) => {
        const champ = document.getElementById(idChamp);
        if (champ && !champ.disabled) data[cle] = lire(champ);
    };

    siActif('editNom', 'nom', c => c.value);
    siActif('editMu', 'mu', c => parseFloat(c.value));
    siActif('editSigma', 'sigma', c => parseFloat(c.value));
    siActif('editColor', 'color', c => c.value);
    // Le statut classé n'est pas un <input> : son état vit dans un champ caché,
    // et c'est le bouton qui porte l'interdiction.
    const btnRanked = document.getElementById('rankedToggleBtn');
    if (btnRanked && !btnRanked.classList.contains('est-interdit')) {
        data.is_ranked = document.getElementById('editIsRankedValue').value === 'true';
    }
    // consecutive_missed déclenche la pénalité de sigma : capacité de rôle du
    // superadmin, jamais une permission déléguable.
    siActif('editMissed', 'consecutive_missed', c => parseInt(c.value));

    if (('mu' in data && isNaN(data.mu)) || ('sigma' in data && isNaN(data.sigma))) {
        alert("Erreur: Mu et Sigma doivent être des nombres.");
        return;
    }

    const res = await apiCall(`/admin/joueurs/${id}`, 'PUT', data);
    
    if(res.status === 'success') {
        closeModal();
        loadPlayers();
    } else {
        alert("Erreur: " + (res.error || "Erreur inconnue"));
    }
}

async function applyGlobalReset() {
    const val = parseFloat(document.getElementById('globalResetValue').value);
    const maxSigma = parseFloat(document.getElementById('globalResetMaxSigma').value);
    const dateStr = document.getElementById('globalResetDate').value;

    if (!dateStr) {
        alert("Veuillez sélectionner une date.");
        return;
    }
    if (isNaN(val) || val <= 0) {
        alert("Erreur: la valeur à ajouter doit être un nombre positif.");
        return;
    }
    if (isNaN(maxSigma) || maxSigma <= 0) {
        alert("Erreur: le plafond de Sigma doit être un nombre positif.");
        return;
    }

    const dateParts = dateStr.split('-');
    const dateDisplay = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
    if (!confirm(`Es-tu sûr de vouloir ajouter ${val} de Sigma (plafonné à ${maxSigma}) en date du ${dateDisplay} ?\n\nSeuls les joueurs sous ${maxSigma} sont concernés, sans dépasser ce plafond.\n\nAttention : Cela sera refusé si un tournoi existe déjà à cette date ou après.`)) return;

    try {
        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const csrfHeaders = csrfMeta ? {'X-CSRFToken': csrfMeta.content} : {};
        const res = await fetch('/admin/global-reset', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', ...csrfHeaders},
            body: JSON.stringify({
                value: val,
                max_sigma: maxSigma,
                date: dateStr
            })
        });
        const data = await res.json();

        if (res.ok) {
            alert("✅ " + data.message);
        } else {
            alert("⛔ Erreur : " + data.error);
        }
    } catch (e) {
        alert("Erreur de connexion au serveur");
    }
}

async function revertGlobalReset() {
    if (!confirm("Annuler le dernier reset global ?\n\nCela ne fonctionnera que si aucun tournoi n'a été joué depuis ce reset.")) return;

    try {
        const csrfMeta2 = document.querySelector('meta[name="csrf-token"]');
        const csrfHeaders2 = csrfMeta2 ? {'X-CSRFToken': csrfMeta2.content} : {};
        const res = await fetch('/admin/revert-global-reset', { method: 'POST', headers: {...csrfHeaders2} });
        const data = await res.json();
        
        if (res.ok) {
            alert("✅ " + data.message);
        } else {
            alert("⛔ " + data.error);
        }
    } catch (e) {
        alert("Erreur de connexion au serveur");
    }
}
