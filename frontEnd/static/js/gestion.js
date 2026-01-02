function getTierColor(rank) {
    const cleanedRank = rank ? rank.trim() : '?';
    
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
                document.getElementById('newMu').value = "50"; 
                document.getElementById('newSigma').value = "8.333";
                loadPlayers();
            } else {
                 alert("Erreur: " + (res.message || res.status));
            }
        });
    }

    const configForm = document.getElementById('configForm');
    if (configForm) {
        configForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const tau = parseFloat(document.getElementById('configTau').value);
            if (isNaN(tau)) {
                alert("Erreur: Tau doit être un nombre.");
                return;
            }
            const res = await apiCall('/admin/config', 'POST', { tau: tau });
            if (res.error) alert("Erreur: " + res.error);
            else if (res.status === 'success') {
                alert("Configuration mise à jour avec succès.");
            } else {
                alert("Erreur update config.");
            }
        });
    }
});

async function apiCall(endpoint, method, body = null) {
    const url = endpoint; 
    
    const options = {
        method: method,
        headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': (typeof ADMIN_TOKEN !== 'undefined') ? ADMIN_TOKEN : ''
        }
    };
    if (body) options.body = JSON.stringify(body);
    
    try {
        const response = await fetch(url, options);
        
        if (response.status === 401 || response.status === 403) {
            alert("Votre session a expiré. Redirection vers la connexion...");
            window.location.href = '/admin/logout'; 
            return { error: "Session expirée" };
        }
        
        if (!response.ok) {
            const errorText = await response.text();
            try {
                const errorJson = JSON.parse(errorText);
                return { error: errorJson.error || response.statusText, status: response.status };
            } catch {
                return { error: response.statusText, status: response.status };
            }
        }
        
        return await response.json();
        
    } catch (err) {
        console.error("Erreur Fetch:", err);
        return { error: "Erreur de connexion au serveur API." };
    }
}

async function loadConfig() {
    const res = await apiCall('/admin/config', 'GET');
    if (res.tau !== undefined) {
        document.getElementById('configTau').value = res.tau;
    }
}

async function loadPlayers() {
    const players = await apiCall('/admin/joueurs', 'GET');
    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return; 
    
    tbody.innerHTML = '';

    if (players.error || !Array.isArray(players)) {
        console.error("Erreur de l'API:", players.error || players);
        tbody.innerHTML = `<tr><td colspan="5" class="has-text-centered has-text-danger">Impossible de charger les données (${players.error || "Erreur inconnue"}).</td></tr>`;
        return;
    }

    players.forEach(p => {
        const tierClass = getTierColor(p.tier); 
        
        const tr = document.createElement('tr');
        tr.className = "fade-in";
        
        const playerDataString = JSON.stringify(p).replace(/'/g, "\\'"); 
        
        tr.innerHTML = `
            <td class="has-text-light has-text-weight-bold">${p.nom}</td>
            <td class="has-text-grey-light">${parseFloat(p.mu).toFixed(3)}</td> 
            <td class="has-text-grey-light">${parseFloat(p.sigma).toFixed(3)}</td>
            
            <td><span class="tag ${tierClass}">${p.tier ? p.tier.trim() : '?'}</span></td>
            
            <td class="has-text-right">
                <button class="button is-small is-warning is-outlined mr-2" onclick='openEditModal(${playerDataString})'>
                    <i class="fas fa-edit"></i>
                </button>
                <button class="button is-small is-danger is-outlined" onclick="deletePlayer(${p.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    setTimeout(() => {
        document.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
    }, 50);
}

async function deletePlayer(id) {
    if(!confirm("Êtes-vous sûr de vouloir supprimer ce joueur définitivement ?")) return;
    const res = await apiCall(`/admin/joueurs/${id}`, 'DELETE');
    if(res.status === 'success') loadPlayers();
    else alert("Erreur lors de la suppression: " + (res.error || ""));
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
    const newNom = document.getElementById('editNom').value;
    const newMu = parseFloat(document.getElementById('editMu').value);
    const newSigma = parseFloat(document.getElementById('editSigma').value);
    
    if (isNaN(newMu) || isNaN(newSigma)) {
        alert("Erreur: Mu et Sigma doivent être des nombres.");
        return;
    }
    
    const data = {
        nom: newNom,
        mu: newMu,
        sigma: newSigma
    };
    
    const res = await apiCall(`/admin/joueurs/${id}`, 'PUT', data);
    
    if(res.status === 'success') {
        closeModal();
        loadPlayers();
    } else {
        alert("Erreur lors de l'enregistrement: " + (res.error || ""));
    }
}
