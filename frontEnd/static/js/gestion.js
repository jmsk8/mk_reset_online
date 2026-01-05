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
            console.warn("⛔ Session expirée");
            alert("Session expirée. Redirection...");
            window.location.href = '/admin_login.html'; 
            return { error: "Non autorisé" };
        }

        const text = await response.text();
        try {
            const data = JSON.parse(text);
            return data;
        } catch (e) {
            console.error("❌ Erreur parsing JSON:", text);
            return { error: "Erreur serveur" };
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
    loadPlayers();
    loadConfig();

    const addForm = document.getElementById('addPlayerForm');
    if (addForm) {
        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newMu = parseFloat(document.getElementById('newMu').value);
            const newSigma = parseFloat(document.getElementById('newSigma').value);
            
            if (isNaN(newMu) || isNaN(newSigma)) {
                alert("Erreur: Mu et Sigma doivent être des nombres.");
                return;
            }
            
            const data = {
                nom: document.getElementById('newNom').value,
                mu: newMu,
                sigma: newSigma
            };

            const res = await apiCall('/admin/joueurs', 'POST', data);
            if (res.error) alert("Erreur: " + res.error);
            else if (res.status === 'success') {
                document.getElementById('newNom').value = "";
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
            
            if (isNaN(tau)) {
                alert("Erreur: Tau doit être un nombre.");
                return;
            }
            if (isNaN(ghostPenalty)) {
                alert("Erreur: La pénalité doit être un nombre.");
                return;
            }
            
            const res = await apiCall('/admin/config', 'POST', { 
                tau: tau, 
                ghost_enabled: ghost,
                ghost_penalty: ghostPenalty 
            });
            
            if (res.error) alert("Erreur: " + res.error);
            else alert("Configuration sauvegardée !");
        });
    }
});

async function loadPlayers() {
    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="5" class="has-text-centered has-text-grey">Chargement...</td></tr>';

    const res = await apiCall('/admin/joueurs', 'GET');
    tbody.innerHTML = '';

    if (res.error) {
        tbody.innerHTML = `<tr><td colspan="5" class="has-text-danger has-text-centered">Erreur: ${res.error}</td></tr>`;
        return;
    }
    
    if (!Array.isArray(res) || res.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="has-text-grey has-text-centered">Aucun joueur.</td></tr>`;
        return;
    }

    res.forEach(player => {
        const tr = document.createElement('tr');
        const tierClass = getTierColor(player.tier);
        tr.innerHTML = `
            <td class="has-text-white font-weight-bold">${player.nom || 'Inconnu'}</td>
            <td class="has-text-grey-light">${player.mu ? parseFloat(player.mu).toFixed(3) : '0.000'}</td>
            <td class="has-text-grey-light">${player.sigma ? parseFloat(player.sigma).toFixed(3) : '0.000'}</td>
            <td><span class="tag ${tierClass}">${player.tier || '?'}</span></td>
            <td class="has-text-right">
                <button class="button is-small is-info is-outlined mr-2" onclick='openEditModal(${JSON.stringify(player)})'>
                    <i class="fas fa-edit"></i>
                </button>
                <button class="button is-small is-danger is-outlined" onclick="deletePlayer(${player.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    document.querySelectorAll('.fade-in').forEach(elem => elem.classList.add('visible'));
}

async function loadConfig() {
    const res = await apiCall('/admin/config', 'GET');
    if (res && !res.error) {
        if (res.tau !== undefined) document.getElementById('configTau').value = res.tau;
        if (res.ghost_enabled !== undefined) document.getElementById('configGhost').checked = res.ghost_enabled;
        if (res.ghost_penalty !== undefined) document.getElementById('configGhostPenalty').value = res.ghost_penalty;
    }
}

async function deletePlayer(id) {
    if(!confirm("Supprimer ce joueur ?")) return;
    const res = await apiCall(`/admin/joueurs/${id}`, 'DELETE');
    if(res.status === 'success') loadPlayers();
    else alert("Erreur: " + (res.error || ""));
}

function openEditModal(player) {
    document.getElementById('editId').value = player.id;
    document.getElementById('editNom').value = player.nom;
    document.getElementById('editMu').value = parseFloat(player.mu).toFixed(3);
    document.getElementById('editSigma').value = parseFloat(player.sigma).toFixed(3);
    document.getElementById('editModal').classList.add('is-active');
}

function closeModal() {
    document.getElementById('editModal').classList.remove('is-active');
}

async function saveEdit() {
    const id = document.getElementById('editId').value;
    const data = {
        nom: document.getElementById('editNom').value,
        mu: parseFloat(document.getElementById('editMu').value),
        sigma: parseFloat(document.getElementById('editSigma').value)
    };
    const res = await apiCall(`/admin/joueurs/${id}`, 'PUT', data);
    if(res.status === 'success') {
        closeModal();
        loadPlayers();
    } else {
        alert("Erreur: " + (res.error || ""));
    }
}
