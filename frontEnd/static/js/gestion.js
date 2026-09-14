function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

async function apiCall(endpoint, method = 'GET', body = null) {
    // Pas d'en-tête d'auth : ces URL sont les routes proxy du frontend, qui
    // injectent X-Admin-Token depuis la session serveur.
    const headers = { 'Content-Type': 'application/json' };

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

async function loadTiersColorCache() {
    if (tiersColorCache) return tiersColorCache;
    const res = await apiCall('/admin/tiers', 'GET');
    tiersColorCache = Array.isArray(res)
        ? Object.fromEntries(res.map(t => [t.nom, t.couleur]))
        : {};
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
            
            const data = {
                nom: nom,
                mu: newMu,
                sigma: newSigma,
                color: newColor
            };

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
            const ghostThresholdDays = parseInt(document.getElementById('configGhostThresholdDays').value);
            const ghostIntervalDays = parseInt(document.getElementById('configGhostIntervalDays').value);
            const unrankedLimit = parseInt(document.getElementById('configUnrankedLimit').value);
            const sigmaThreshold = parseFloat(document.getElementById('configSigmaLimit').value);
            const ipVersionLive = document.querySelector('input[name="ipVersionLive"]:checked')?.value || 'v1';

            if (isNaN(tau)) { alert("Erreur: Tau invalide."); return; }
            if (isNaN(ghostPenalty)) { alert("Erreur: Pénalité invalide."); return; }
            if (isNaN(ghostThresholdDays) || ghostThresholdDays < 1) { alert("Erreur: Seuil d'absence (jours) invalide."); return; }
            if (isNaN(ghostIntervalDays) || ghostIntervalDays < 1) { alert("Erreur: Fréquence de pénalité (jours) invalide."); return; }
            if (isNaN(unrankedLimit)) { alert("Erreur: Limite Unranked invalide."); return; }
            if (isNaN(sigmaThreshold)) { alert("Erreur: Limite Sigma invalide."); return; }

            const res = await apiCall('/admin/config', 'POST', {
                tau: tau,
                ghost_enabled: ghost,
                ghost_penalty: ghostPenalty,
                ghost_threshold_days: ghostThresholdDays,
                ghost_interval_days: ghostIntervalDays,
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
                ${typeof PEUT_RGPD_JOUEURS !== 'undefined' && !PEUT_RGPD_JOUEURS ? '' : `
                <button class="button is-small is-danger is-outlined" onclick="deletePlayer(${player.id})">
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
    poser('configGhostThresholdDays', res.ghost_threshold_days);
    poser('configGhostIntervalDays', res.ghost_interval_days);
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

    const res = await apiCall('/admin/tiers', 'GET');
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

function openEditModal(id, nom, mu, sigma, isRanked, missed, color) {
    document.getElementById('editId').value = id;
    document.getElementById('editNom').value = nom;
    document.getElementById('editMu').value = parseFloat(mu).toFixed(3);
    document.getElementById('editSigma').value = parseFloat(sigma).toFixed(3);
    document.getElementById('editMissed').value = missed !== undefined ? missed : 0;
    document.getElementById('editColor').value = color || '#ffffff';
    
    updateRankedVisuals(isRanked);

    document.getElementById('editModal').classList.add('is-active');
}

function toggleRankedStatus() {
    const currentVal = document.getElementById('editIsRankedValue').value === 'true';
    updateRankedVisuals(!currentVal);
}

function updateRankedVisuals(isRanked) {
    document.getElementById('editIsRankedValue').value = isRanked;
    const btn = document.getElementById('rankedToggleBtn');
    const icon = document.getElementById('rankedIcon');
    const text = document.getElementById('rankedText');

    if (isRanked) {
        btn.className = 'button is-success is-fullwidth';
        icon.innerHTML = '<i class="fas fa-check"></i>';
        text.innerText = 'Joueur Classé (Actif)';
    } else {
        btn.className = 'button is-danger is-outlined is-fullwidth';
        icon.innerHTML = '<i class="fas fa-times"></i>';
        text.innerText = 'Non Classé (Inactif)';
    }
}


function closeModal() {
    document.getElementById('editModal').classList.remove('is-active');
}

async function saveEdit() {
    const id = document.getElementById('editId').value;
    
    const data = {
        nom: document.getElementById('editNom').value,
        mu: parseFloat(document.getElementById('editMu').value),
        sigma: parseFloat(document.getElementById('editSigma').value),
        is_ranked: document.getElementById('editIsRankedValue').value === 'true',
        consecutive_missed: parseInt(document.getElementById('editMissed').value),
        color: document.getElementById('editColor').value
    };
    
    if (isNaN(data.mu) || isNaN(data.sigma)) {
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
    const val = document.getElementById('globalResetValue').value;
    const dateStr = document.getElementById('globalResetDate').value;

    if (!dateStr) {
        alert("Veuillez sélectionner une date.");
        return;
    }

    const dateParts = dateStr.split('-');
    const dateDisplay = `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`;
    if (!confirm(`Es-tu sûr de vouloir ajouter ${val} de Sigma à TOUS les joueurs en date du ${dateDisplay} ?\n\nAttention : Cela sera refusé si un tournoi existe déjà à cette date ou après.`)) return;

    try {
        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const csrfHeaders = csrfMeta ? {'X-CSRFToken': csrfMeta.content} : {};
        const res = await fetch('/admin/global-reset', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', ...csrfHeaders},
            body: JSON.stringify({
                value: val,
                date: dateStr
            })
        });
        const data = await res.json();
        
        if (res.ok) {
            alert("✅ " + data.message);
            loadPlayers();
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
            loadPlayers();
        } else {
            alert("⛔ " + data.error);
        }
    } catch (e) {
        alert("Erreur de connexion au serveur");
    }
}
