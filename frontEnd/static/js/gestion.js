function getTierColor(rank) {
    const cleanedRank = rank ? rank.trim() : '?';
    
    switch(cleanedRank) {
        case 'S': return 'is-warning';
        case 'A': return 'is-success';
        case 'B': return 'is-info';
        case 'C': return 'is-danger';
        case 'U': return 'is-white';
        default: return 'is-light';    
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadPlayers();

    const addForm = document.getElementById('addPlayerForm');
    if (addForm) {
        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                nom: document.getElementById('newNom').value,
                mu: document.getElementById('newMu').value,
                sigma: document.getElementById('newSigma').value
            };

            const res = await apiCall('/admin/joueurs', 'POST', data);
            if (res.error) alert("Erreur: " + res.error);
            else {
                document.getElementById('newNom').value = "";
                loadPlayers();
            }
        });
    }
});

async function apiCall(url, method, body = null) {
    const options = {
        method: method,
        headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': ADMIN_TOKEN 
        }
    };
    if (body) options.body = JSON.stringify(body);
    
    try {
        const response = await fetch(url, options);
        const text = await response.text();
        try {
             return JSON.parse(text);
        } catch(e) {
             return { status: response.statusText };
        }
    } catch (err) {
        return { error: err.message };
    }
}

async function loadPlayers() {
    const players = await apiCall('/admin/joueurs', 'GET');
    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return; 
    
    tbody.innerHTML = '';

    if (players.error || !Array.isArray(players)) {
        console.error("Erreur de l'API:", players.error || players);
        tbody.innerHTML = `<tr><td colspan="5" class="has-text-centered has-text-danger">Impossible de charger les données.</td></tr>`;
        return;
    }

    players.forEach(p => {
        const tierClass = getTierColor(p.tier); 
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="has-text-light font-weight-bold">${p.nom}</td>
            <td class="has-text-grey-light">${parseFloat(p.mu).toFixed(3)}</td> 
            <td class="has-text-grey-light">${parseFloat(p.sigma).toFixed(3)}</td>
            
            <td><span class="tag ${tierClass}">${p.tier}</span></td>
            
            <td class="has-text-right">
                <button class="button is-small is-warning is-outlined mr-2" onclick='openEditModal(${JSON.stringify(p)})'>
                    <i class="fas fa-edit"></i>
                </button>
                <button class="button is-small is-danger is-outlined" onclick="deletePlayer(${p.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    document.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
}

async function deletePlayer(id) {
    if(!confirm("Êtes-vous sûr de vouloir supprimer ce joueur définitivement ?")) return;
    const res = await apiCall(`/admin/joueurs/${id}`, 'DELETE');
    if(res.status === 'success') loadPlayers();
    else alert("Erreur lors de la suppression");
}

function openEditModal(player) {
    document.getElementById('editId').value = player.id;
    document.getElementById('editNom').value = player.nom;
    document.getElementById('editMu').value = player.mu;
    document.getElementById('editSigma').value = player.sigma;
    document.getElementById('editModal').classList.add('is-active');
}

function closeModal() {
    document.getElementById('editModal').classList.remove('is-active');
}

async function saveEdit() {
    const id = document.getElementById('editId').value;
    const data = {
        nom: document.getElementById('editNom').value,
        mu: document.getElementById('editMu').value,
        sigma: document.getElementById('editSigma').value
    };
    
    const res = await apiCall(`/admin/joueurs/${id}`, 'PUT', data);
    if(res.status === 'success') {
        closeModal();
        loadPlayers();
    } else {
        alert("Erreur: " + res.error);
    }
}
