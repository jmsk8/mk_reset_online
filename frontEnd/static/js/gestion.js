function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

async function apiCall(endpoint, method = 'GET', body = null) {
    // Routes proxy du frontend (l'en-tête d'auth est ajouté côté serveur).
    // Accept explicite : appel de données, pas de revalidation de session.
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
            // Un 403 « droit manquant » ne déconnecte pas.
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

        // 429 (limiteur nginx) : la réponse est du HTML.
        if (response.status === 429) {
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

// Couleurs des tiers (nom -> fond, nom -> texte), chargées une fois depuis /admin/tiers.
let tiersColorCache = null;
let tiersTexteCache = null;
// Promesse partagée : loadPlayers() et loadTierLegend() démarrent en parallèle.
let tiersPromesse = null;

// Réponse brute (loadTierLegend a besoin du rang).
async function loadTiers() {
    if (tiersPromesse) return tiersPromesse;
    tiersPromesse = apiCall('/admin/tiers', 'GET').then(res => {
        const liste = Array.isArray(res) ? res : [];
        tiersColorCache = Object.fromEntries(liste.map(t => [t.nom, t.couleur]));
        tiersTexteCache = Object.fromEntries(liste.map(t => [t.nom, t.couleur_texte || '#FFFFFF']));
        return liste;
    }).catch(e => {
        // Un échec permet de réessayer.
        tiersPromesse = null;
        throw e;
    });
    return tiersPromesse;
}

// Couleurs de la pastille U (non classé) : {couleur, couleur_texte}, promesse partagée.
let couleurUPromesse = null;

async function loadCouleurU() {
    if (couleurUPromesse) return couleurUPromesse;
    const hex = v => /^#[0-9a-fA-F]{3,8}$/.test(v || '');
    couleurUPromesse = apiCall('/admin/tiers/unranked', 'GET').then(res => {
        const couleur = (res && hex(res.couleur)) ? res.couleur : '#FFFFFF';
        const couleur_texte = (res && hex(res.couleur_texte)) ? res.couleur_texte : texteLisible(couleur);
        return { couleur, couleur_texte };
    });
    return couleurUPromesse;
}

// Vide le cache après un enregistrement des tiers.
function oublierTiers() {
    tiersPromesse = null;
    couleurUPromesse = null;
}

async function loadTiersColorCache() {
    const [, u] = await Promise.all([loadTiers(), loadCouleurU()]);
    tiersColorCache.U = u.couleur;
    tiersTexteCache.U = u.couleur_texte;
    return tiersColorCache;
}

// Noir ou blanc selon le contraste avec `hex`.
function texteLisible(hex) {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(c => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    if (isNaN(n)) return '#0a0a0a';
    const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0a0a0a' : '#ffffff';
}

// {class, style} d'un badge de tier.
function getTierColor(rank) {
    if (!rank) return { class: 'is-light', style: '' };
    const cleanedRank = rank.trim();
    if (cleanedRank === 'U') {
        const c = (tiersColorCache && tiersColorCache.U) || '#FFFFFF';
        const t = (tiersTexteCache && tiersTexteCache.U) || texteLisible(c);
        return { class: '', style: `background:${c}; color:${t};` };
    }
    const couleur = tiersColorCache && tiersColorCache[cleanedRank];
    const texte = (tiersTexteCache && tiersTexteCache[cleanedRank]) || '#fff';
    if (couleur) return { class: '', style: `background:${couleur}; color:${texte};` };
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
        peindreBoutonCouleur(document.getElementById('newColor'), '#FFFFFF');
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

            // Sans le droit, mu/sigma ne sont pas envoyés (valeurs par défaut).
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
                peindreBoutonCouleur(document.getElementById('newColor'), '#FFFFFF');
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


// Dernier chargement de /admin/joueurs, indexé par id.
const joueursCharges = {};

// Fiches liées à un compte de rang égal ou supérieur : grisées.
const TITRE_FICHE_PROTEGEE = "Fiche d'un compte de rang égal ou supérieur au vôtre : "
    + "seul un rang au-dessus peut la modifier.";

/* Tri du tableau des joueurs (colonne null : ordre du backend). */
let triJoueurs = { colonne: null, ascendant: true };

/* Derniere liste recue, pour re-trier sans appel reseau. */
let joueursListe = [];

/* Valeur de comparaison d'un joueur pour une colonne (type homogene). */
function valeurTri(player, colonne) {
    switch (colonne) {
        case 'status': return player.is_ranked ? 1 : 0;
        case 'nom':    return (player.nom || '').toLowerCase();
        case 'mu':     return parseFloat(player.mu) || 0;
        case 'sigma':  return parseFloat(player.sigma) || 0;
        // '?' : un tier absent se range avec les valeurs textuelles.
        case 'tier':   return (player.tier || '?').toUpperCase();
        default:       return '';
    }
}

function comparerJoueurs(a, b) {
    const va = valeurTri(a, triJoueurs.colonne);
    const vb = valeurTri(b, triJoueurs.colonne);
    let ordre;
    if (typeof va === 'string') {
        // Tri alphabetique francais (accents).
        ordre = va.localeCompare(vb, 'fr', { sensitivity: 'base' });
    } else {
        ordre = va - vb;
    }
    return triJoueurs.ascendant ? ordre : -ordre;
}

/* Premier clic : croissant ; clic suivant sur la meme colonne : inverse. */
function trierJoueurs(colonne) {
    if (triJoueurs.colonne === colonne) {
        triJoueurs.ascendant = !triJoueurs.ascendant;
    } else {
        triJoueurs = { colonne: colonne, ascendant: true };
    }
    majIndicateursTri();
    afficherJoueurs();
}

/* Fleche sur l'en-tete actif seulement. */
function majIndicateursTri() {
    document.querySelectorAll('th[data-tri]').forEach(th => {
        const icone = th.querySelector('.icone-tri');
        if (!icone) return;
        const actif = th.dataset.tri === triJoueurs.colonne;
        th.classList.toggle('tri-actif', actif);
        icone.className = 'icone-tri fas '
            + (!actif ? 'fa-sort'
                      : (triJoueurs.ascendant ? 'fa-sort-up' : 'fa-sort-down'));
    });
}

async function loadPlayers() {
    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="6" class="has-text-centered has-text-grey">Chargement en cours...</td></tr>';

    const [res] = await Promise.all([apiCall('/admin/joueurs', 'GET'), loadTiersColorCache()]);
    tbody.innerHTML = '';

    if (res.error) {
        tbody.innerHTML = `<tr><td colspan="6" class="has-text-danger has-text-centered">Erreur Backend: ${escapeHtml(res.error)}</td></tr>`;
        return;
    }
    
    if (!Array.isArray(res) || res.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="has-text-grey has-text-centered">Aucun joueur trouvé.</td></tr>`;
        return;
    }

    joueursListe = res;
    afficherJoueurs();
}

/* Rend le tableau a partir de `joueursListe`. */
function afficherJoueurs() {
    const tbody = document.getElementById('playersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // slice() : la liste d'origine garde l'ordre du backend.
    const liste = triJoueurs.colonne
        ? joueursListe.slice().sort(comparerJoueurs)
        : joueursListe;

    liste.forEach(player => {
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
                ${player.protegee ? `
                <button class="button is-small is-info is-outlined mr-1 est-interdit" disabled
                    title="${TITRE_FICHE_PROTEGEE}">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="button is-small is-danger is-outlined est-interdit" disabled
                    title="${TITRE_FICHE_PROTEGEE}">
                    <i class="fas fa-trash"></i>
                </button>` : `
                <button class="button is-small is-info is-outlined mr-1"
                    onclick="openEditModal(${Number(player.id)})">
                    <i class="fas fa-edit"></i>
                </button>
                ${peutChamp('irreversible') ? `
                <button class="button is-small is-danger is-outlined" onclick="deletePlayer(${player.id})">
                    <i class="fas fa-trash"></i>
                </button>` : `
                <button class="button is-small is-danger is-outlined est-interdit" disabled
                    title="Vous n'avez pas la permission « Supprimer ou anonymiser ».">
                    <i class="fas fa-trash"></i>
                </button>`}`}
            </td>
        `;
        tbody.appendChild(tr);
        requestAnimationFrame(() => tr.classList.add('visible'));
    });
}

async function loadConfig() {
    // Le formulaire de configuration n'existe que sur la page Réglages.
    if (!document.getElementById('configForm')) return;

    const res = await apiCall('/admin/config', 'GET');
    if (!res || res.error) return;

    // Chaque champ est posé indépendamment.
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
    poserTextesIp(res.ip_textes);
}

// Noms et resumes des versions de l'IP, depuis /admin/config (textContent).
function poserTextesIp(textes) {
    if (!textes) return;
    document.querySelectorAll('[data-ip-nom]').forEach(el => {
        const t = textes[el.dataset.ipNom];
        if (t) el.textContent = t.nom;
    });
    document.querySelectorAll('[data-ip-resume]').forEach(el => {
        const t = textes[el.dataset.ipResume];
        if (t) el.textContent = t.resume_admin;
    });
}

// Legende des tiers (page Fiches joueurs) ; 'U' reste dans le HTML et sert
// d'ancre pour l'insertion.
async function loadTierLegend() {
    const list = document.getElementById('tierLegendList');
    if (!list) return; // page sans ce bloc

    // Cache partagé avec loadPlayers().
    const [res, u] = await Promise.all([loadTiers(), loadCouleurU()]);
    if (!Array.isArray(res)) return;

    const uLi = list.querySelector('li');
    const uTag = uLi && uLi.querySelector('.tag');
    if (uTag) {
        uTag.classList.remove('is-white');
        uTag.style.background = u.couleur;
        uTag.style.color = u.couleur_texte;
    }
    res.slice().sort((a, b) => b.rang - a.rang).forEach((t, idx, arr) => {
        const li = document.createElement('li');
        const tag = document.createElement('span');
        tag.className = 'tag is-light';
        tag.style.background = t.couleur;
        tag.style.color = t.couleur_texte || '#fff';
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

    // Fiche rattachée à un compte : confirmation explicite.
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

    // Joueur avec historique : on propose l'anonymisation.
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

// Droits de la session sur la fiche joueur, déclarés par le gabarit (absents
// sur les autres pages).
function peutChamp(nom) {
    const drapeaux = (typeof PEUT_CHAMPS_JOUEUR !== 'undefined') ? PEUT_CHAMPS_JOUEUR : null;
    return drapeaux ? drapeaux[nom] === true : true;
}

// Grise un champ et explique pourquoi au survol.
function interdireChamp(idChamp, permission) {
    const champ = document.getElementById(idChamp);
    if (!champ) return;
    champ.disabled = true;
    champ.readOnly = true;
    champ.classList.add('est-interdit');
    champ.title = "Vous n'avez pas la permission « " + permission + " ».";
}

// Bouton de couleur d'une fiche : sa valeur est la couleur, son fond la montre.
function peindreBoutonCouleur(btn, couleur) {
    if (!btn || typeof ChoixCouleur === 'undefined') return;
    btn.value = ChoixCouleur.versHex6(couleur);
    ChoixCouleur.peindre(btn, btn.value);
    btn.setAttribute('aria-label', 'Couleur ' + btn.value);
}

// Ouvre la fenetre de choix (apercu : la couleur seule).
function choisirCouleurJoueur(idBouton) {
    const btn = document.getElementById(idBouton);
    if (!btn || btn.disabled) return;
    ChoixCouleur.ouvrir({
        titre: 'Couleur du joueur',
        couleur: btn.value,
        surConfirmer: ({ couleur }) => peindreBoutonCouleur(btn, couleur),
    });
}

// Seul l'identifiant passe dans l'onclick ; le reste est relu dans joueursCharges.
function openEditModal(id) {
    const joueur = joueursCharges[id];
    if (!joueur) return;
    const nom = joueur.nom;
    const mu = joueur.mu;
    const sigma = joueur.sigma;
    const isRanked = joueur.is_ranked;
    const missed = joueur.consecutive_missed;
    const color = joueur.color;
    document.getElementById('editId').value = id;
    document.getElementById('editNom').value = nom;
    document.getElementById('editMu').value = parseFloat(mu).toFixed(3);
    document.getElementById('editSigma').value = parseFloat(sigma).toFixed(3);
    document.getElementById('editMissed').value = missed !== undefined ? missed : 0;
    peindreBoutonCouleur(document.getElementById('editColor'), color || '#FFFFFF');

    // Chaque champ est réactivé avant d'être éventuellement interdit (modale réutilisée).
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
    // Sans le droit, le bouton reste inerte.
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

    // `est-interdit` est conservée quand className est réécrit.
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

    // Un champ désactivé n'est pas envoyé (mu/sigma affichés arrondis seraient
    // lus comme modifiés).
    const data = {};
    const siActif = (idChamp, cle, lire) => {
        const champ = document.getElementById(idChamp);
        if (champ && !champ.disabled) data[cle] = lire(champ);
    };

    siActif('editNom', 'nom', c => c.value);
    siActif('editMu', 'mu', c => parseFloat(c.value));
    siActif('editSigma', 'sigma', c => parseFloat(c.value));
    siActif('editColor', 'color', c => c.value);
    // Statut classé : champ caché, interdiction portée par le bouton.
    const btnRanked = document.getElementById('rankedToggleBtn');
    if (btnRanked && !btnRanked.classList.contains('est-interdit')) {
        data.is_ranked = document.getElementById('editIsRankedValue').value === 'true';
    }
    // consecutive_missed : superadmin seulement.
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
