/* frontEnd/static/js/gestion.js */

// Fonction pour mapper le Tier à une classe de couleur Bulma
// (Déplacée ici pour être accessible partout)
getTierColor: function(rank) {
	switch(rank) {
		case 'S': return 'is-warning'; // Jaune
		case 'A': return 'is-success'; // Vert
		case 'B': return 'is-info';    // Bleu
		case 'C': return 'is-danger';  // Rouge (ou is-primary pour turquoise)
		case 'U': return 'is-white';   // <--- BLANC pour U
		default: return 'is-light';    
	}
}

document.addEventListener('DOMContentLoaded', () => {
    loadPlayers();

    // Gestionnaire soumission formulaire Ajout
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
                document.getElementById('newNom').value = ""; // Reset champ nom
                loadPlayers(); // Recharger la liste
            }
        });
    }
});

// Fonction générique pour les appels API
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
        return await response.json();
    } catch (err) {
        return { error: err.message };
    }
}

// Charger et afficher les joueurs
async function loadPlayers() {
    const players = await apiCall('/admin/joueurs', 'GET');
    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return; // Sécurité
    
    tbody.innerHTML = '';

    if (players.error) {
        console.error(players.error);
        return;
    }

    players.forEach(p => {
        // Appeler la fonction (maintenant accessible)
        const tierClass = getTierColorClass(p.tier); 
        
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
    
    // Réappliquer les animations fade-in
    document.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
}

// Suppression
async function deletePlayer(id) {
    if(!confirm("Êtes-vous sûr de vouloir supprimer ce joueur définitivement ?")) return;
    const res = await apiCall(`/admin/joueurs/${id}`, 'DELETE');
    if(res.status === 'success') loadPlayers();
    else alert("Erreur lors de la suppression");
}

// Modal Édition
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
