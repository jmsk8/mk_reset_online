async function apiCall(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    
    if (typeof ADMIN_TOKEN !== 'undefined' && ADMIN_TOKEN) {
        headers['X-Admin-Token'] = ADMIN_TOKEN;
    }

    const options = { method: method, headers: headers };
    if (body) options.body = JSON.stringify(body);

    try {
        console.log(`📡 Appel API : ${method} ${endpoint}`);
        const response = await fetch(endpoint, options);
        
        if (response.status === 401 || response.status === 403) {
            console.warn("⛔ Session expirée ou non autorisée");
            alert("Votre session a expiré. Redirection vers la connexion...");
            window.location.href = '/admin_login.html'; 
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

function getTierColor(rank) {
    if (!rank) return 'is-light';
    const cleanedRank = rank.trim();
    switch(cleanedRank) {
        case 'S': return 'tier-s';
        case 'A': return 'tier-a';
        case 'B': return 'tier-b';
        case 'C': return 'tier-c';
        case 'U': return 'is-white';
        default: return 'is-light';
    }
}


document.addEventListener('DOMContentLoaded', () => {
    // --- CORRECTION : Afficher l'interface immédiatement ---
    const fadeElems = document.querySelectorAll('.fade-in');
    fadeElems.forEach(elem => {
        requestAnimationFrame(() => {
            elem.classList.add('visible');
        });
    });

    // Ensuite, on charge les données
    loadPlayers();
    loadConfig();

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
            
            if (isNaN(newMu) || isNaN(newSigma)) {
                alert("Erreur: Mu et Sigma doivent être des nombres.");
                return;
            }
            
            const data = {
                nom: nom,
                mu: newMu,
                sigma: newSigma
            };

            const res = await apiCall('/admin/joueurs', 'POST', data);
            
            if (res.error) {
                alert("Erreur: " + res.error);
            } else if (res.status === 'success') {
                document.getElementById('newNom').value = "";
                document.getElementById('newMu').value = "50"; 
                document.getElementById('newSigma').value = "8.333";
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
            const unrankedLimit = parseInt(document.getElementById('configUnrankedLimit').value);
            const sigmaThreshold = parseFloat(document.getElementById('configSigmaLimit').value);
            
            if (isNaN(tau)) { alert("Erreur: Tau invalide."); return; }
            if (isNaN(ghostPenalty)) { alert("Erreur: Pénalité invalide."); return; }
            if (isNaN(unrankedLimit)) { alert("Erreur: Limite Unranked invalide."); return; }
            if (isNaN(sigmaThreshold)) { alert("Erreur: Limite Sigma invalide."); return; }
            
            const res = await apiCall('/admin/config', 'POST', { 
                tau: tau, 
                ghost_enabled: ghost,
                ghost_penalty: ghostPenalty,
                unranked_threshold: unrankedLimit,
                sigma_threshold: sigmaThreshold
            });
            
            if (res.error) alert("Erreur: " + res.error);
            else alert("Configuration sauvegardée avec succès !");
        });
    }
});


async function loadPlayers() {
    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="5" class="has-text-centered has-text-grey">Chargement en cours...</td></tr>';

    const res = await apiCall('/admin/joueurs', 'GET');
    tbody.innerHTML = '';

    if (res.error) {
        tbody.innerHTML = `<tr><td colspan="5" class="has-text-danger has-text-centered">Erreur Backend: ${res.error}</td></tr>`;
        return;
    }
    
    if (!Array.isArray(res) || res.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="has-text-grey has-text-centered">Aucun joueur trouvé.</td></tr>`;
        return;
    }

    res.forEach(player => {
        const tr = document.createElement('tr');
        const tierClass = getTierColor(player.tier);
        
        const rankedStatusIcon = (player.is_ranked === false) 
            ? '<span class="icon has-text-danger ml-2" title="Joueur Non Classé (Inactif)"><i class="fas fa-user-slash"></i></span>' 
            : '';

        const rowOpacity = (player.is_ranked === false) ? 'style="opacity: 0.6;"' : '';

        tr.innerHTML = `
            <td class="has-text-centered">${player.is_ranked 
                ? '<span class="icon has-text-success"><i class="fas fa-square-check"></i></span>' 
                : '<span class="icon has-text-danger"><i class="fas fa-square-xmark"></i></span>'}
            </td>
            <td class="has-text-white font-weight-bold" ${rowOpacity}>
                ${player.nom || 'Inconnu'}
            </td>
            <td class="has-text-grey-light" ${rowOpacity}>
                ${player.mu ? parseFloat(player.mu).toFixed(3) : '0.000'}
            </td>
            <td class="has-text-grey-light" ${rowOpacity}>
                ${player.sigma ? parseFloat(player.sigma).toFixed(3) : '0.000'}
            </td>
            <td ${rowOpacity}>
                <span class="tag ${tierClass}">${player.tier || '?'}</span>
            </td>
            <td class="has-text-right">
                <button class="button is-small is-info is-outlined mr-1" 
                    onclick="openEditModal(${player.id}, '${player.nom.replace(/'/g, "\\'")}', ${player.mu}, ${player.sigma}, ${player.is_ranked}, ${player.consecutive_missed})">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="button is-small is-danger is-outlined" onclick="deletePlayer(${player.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
        // Animation pour les lignes du tableau
        requestAnimationFrame(() => tr.classList.add('visible'));
    });
}

async function loadConfig() {
    const res = await apiCall('/admin/config', 'GET');
    if (res && !res.error) {
        if (res.tau !== undefined) document.getElementById('configTau').value = res.tau;
        if (res.ghost_enabled !== undefined) document.getElementById('configGhost').checked = res.ghost_enabled;
        if (res.ghost_penalty !== undefined) document.getElementById('configGhostPenalty').value = res.ghost_penalty;
        if (res.unranked_threshold !== undefined) document.getElementById('configUnrankedLimit').value = res.unranked_threshold;
        
        // Sécurité si le backend n'est pas encore à jour avec la nouvelle colonne
        const sigmaInput = document.getElementById('configSigmaLimit');
        if (sigmaInput && res.sigma_threshold !== undefined) {
            sigmaInput.value = res.sigma_threshold;
        }
    }
}

async function deletePlayer(id) {
    if(!confirm("Êtes-vous sûr de vouloir supprimer ce joueur définitivement ? (Irréversible)")) return;
    
    const res = await apiCall(`/admin/joueurs/${id}`, 'DELETE');
    if(res.status === 'success') {
        loadPlayers();
    } else {
        alert("Erreur lors de la suppression: " + (res.error || ""));
    }
}

function openEditModal(id, nom, mu, sigma, isRanked, missed) {
    document.getElementById('editId').value = id;
    document.getElementById('editNom').value = nom;
    document.getElementById('editMu').value = parseFloat(mu).toFixed(3);
    document.getElementById('editSigma').value = parseFloat(sigma).toFixed(3);
    document.getElementById('editMissed').value = missed !== undefined ? missed : 0;
    
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
        consecutive_missed: parseInt(document.getElementById('editMissed').value)
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

    if (!confirm(`Es-tu sûr de vouloir ajouter ${val} de Sigma à TOUS les joueurs en date du ${dateStr} ?\n\nAttention : Cela sera refusé si un tournoi existe déjà à cette date ou après.`)) return;

    try {
        const res = await fetch('/admin/global-reset', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN},
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
        const res = await fetch('/admin/revert-global-reset', { method: 'POST', headers: {'X-Admin-Token': ADMIN_TOKEN} });
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
