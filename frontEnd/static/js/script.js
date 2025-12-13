let joueurCount = 1;

function ajouterJoueur() {
    if (joueurCount >= 12) {
        alert("Vous ne pouvez pas ajouter plus de 12 joueurs.");
        return;
    }
    joueurCount++;
    const joueursContainer = document.getElementById('joueursContainer');
    const newJoueurDiv = document.createElement('div');
    newJoueurDiv.className = 'box joueur glass-card';
    newJoueurDiv.innerHTML = `
        <div class="field">
            <label class="label" for="nom${joueurCount}">Nom du joueur ${joueurCount}:</label>
            <div class="control has-icons-left">
                <input type="text" id="nom${joueurCount}" name="nom${joueurCount}" class="input player-name-input" list="existingPlayers" required>
                <span class="icon is-small is-left">
                    <i class="fas fa-user"></i>
                </span>
            </div>
        </div>
        <div class="field">
            <label class="label" for="score${joueurCount}">Score du joueur ${joueurCount}:</label>
            <div class="control has-icons-left">
                <input type="number" id="score${joueurCount}" name="score${joueurCount}" class="input" required>
                <span class="icon is-small is-left">
                    <i class="fas fa-star"></i>
                </span>
            </div>
        </div>
        <button type="button" class="button is-danger is-small remove-joueur" onclick="supprimerJoueur(this)">
            <span class="icon">
                <i class="fas fa-trash"></i>
            </span>
            <span>Supprimer</span>
        </button>    `;
    joueursContainer.appendChild(newJoueurDiv);
}

function supprimerJoueur(button) {
    const joueurDiv = button.parentElement;
    joueurDiv.remove();
    joueurCount--;
    renumeroterJoueurs();
}

function renumeroterJoueurs() {
    const joueursContainer = document.getElementById('joueursContainer');
    const joueurs = joueursContainer.getElementsByClassName('joueur');
    for (let i = 0; i < joueurs.length; i++) {
        const joueur = joueurs[i];
        const index = i + 1;
        
        const labelNom = joueur.querySelector('label[for^="nom"]');
        if(labelNom) {
            labelNom.setAttribute('for', `nom${index}`);
            labelNom.textContent = `Nom du joueur ${index}:`;
        }
        
        const inputNom = joueur.querySelector('input[id^="nom"]');
        if(inputNom) {
            inputNom.setAttribute('id', `nom${index}`);
            inputNom.setAttribute('name', `nom${index}`);
        }

        const labelScore = joueur.querySelector('label[for^="score"]');
        if(labelScore) {
            labelScore.setAttribute('for', `score${index}`);
            labelScore.textContent = `Score du joueur ${index}:`;
        }
        
        const inputScore = joueur.querySelector('input[id^="score"]');
        if(inputScore) {
            inputScore.setAttribute('id', `score${index}`);
            inputScore.setAttribute('name', `score${index}`);
        }
    }
}
