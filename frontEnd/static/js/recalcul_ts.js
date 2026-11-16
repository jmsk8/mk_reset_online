// Recalcul du TrueSkill depuis une date (bloc partiels/recalcul_ts.html).
// L'aperçu ne modifie rien ; « Appliquer » renvoie exactement la saisie de
// l'aperçu, avec l'empreinte des données lue à ce moment-là.
(function () {
    const bloc = document.getElementById('bloc-recalcul-ts');
    if (!bloc) return;

    const champDebut = document.getElementById('recalculDebut');
    const zonePeriodes = document.getElementById('recalculPeriodes');
    const btnAjout = document.getElementById('recalculAjoutPeriode');
    const btnApercu = document.getElementById('recalculApercu');
    const btnAppliquer = document.getElementById('recalculAppliquer');
    const zoneResultat = document.getElementById('recalculResultat');

    // Saisie validée par le dernier aperçu (null : rien à appliquer).
    let apercuValide = null;

    const echapper = (s) => String(s).replace(/[&<>"']/g, (c) => (
        {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    const nombre = (x, n) => Number(x).toFixed(n);
    const signe = (x, n) => (x > 0 ? '+' : '') + Number(x).toFixed(n);
    const dateFr = (iso) => iso.split('-').reverse().join('/');
    // Sous 0,0005 l'écart s'arrondit à 0.000 : on affiche « = » plutôt qu'un
    // « +0.000 » ou « -0.000 » qui laisserait croire à un mouvement.
    const SEUIL_ECART = 0.0005;
    function celluleEcart(x) {
        if (Math.abs(x) < SEUIL_ECART) return '<td class="has-text-grey">=</td>';
        return `<td class="${x > 0 ? 'has-text-success' : 'has-text-danger'}">${signe(x, 3)}</td>`;
    }

    function enTetesCsrf() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? {'X-CSRFToken': meta.content} : {};
    }

    function invalider() {
        if (apercuValide === null) return;
        apercuValide = null;
        btnAppliquer.disabled = true;
        const note = document.createElement('p');
        note.className = 'has-text-warning is-size-7 mb-2';
        note.textContent = "Saisie modifiée : relancez l'aperçu avant d'appliquer.";
        zoneResultat.prepend(note);
    }

    function ajouterPeriode(debut, tau, premiere) {
        const ligne = document.createElement('div');
        ligne.className = 'recalcul-periode';
        ligne.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;margin-bottom:0.5rem;';
        ligne.innerHTML = `
            <input class="input periode-debut" type="date" aria-label="Début de la période"
                   style="max-width:11rem;" ${premiere ? 'disabled' : ''}>
            <input class="input periode-tau" type="number" step="0.001" min="0" max="5"
                   aria-label="Tau de la période" placeholder="ex. 0.2" style="max-width:7rem;">
            ${premiere
                ? '<span class="is-size-7 has-text-grey-light">part de la date de départ</span>'
                : '<button type="button" class="button is-small is-danger is-outlined periode-suppr" aria-label="Retirer la période"><i class="fas fa-trash"></i></button>'}
        `;
        ligne.querySelector('.periode-debut').value = debut || '';
        ligne.querySelector('.periode-tau').value = tau;
        ligne.querySelectorAll('input').forEach((i) => i.addEventListener('input', invalider));
        const suppr = ligne.querySelector('.periode-suppr');
        if (suppr) suppr.addEventListener('click', () => { ligne.remove(); invalider(); });
        zonePeriodes.appendChild(ligne);
    }

    function lireSaisie() {
        const debut = champDebut.value;
        if (!debut) return {erreur: 'Choisissez une date de départ.'};
        const periodes = [];
        for (const ligne of zonePeriodes.querySelectorAll('.recalcul-periode')) {
            const champ = ligne.querySelector('.periode-debut');
            const d = champ.disabled ? debut : champ.value;
            const tau = parseFloat(ligne.querySelector('.periode-tau').value);
            if (!d) return {erreur: "Chaque période doit avoir une date de début."};
            if (isNaN(tau) || tau < 0 || tau > 5) return {erreur: 'Chaque tau doit être un nombre entre 0 et 5.'};
            if (d < debut) return {erreur: `La période du ${dateFr(d)} commence avant la date de départ.`};
            periodes.push({debut: d, tau});
        }
        return {date_debut: debut, periodes};
    }

    async function envoyer(etape, corps) {
        const res = await fetch(`/admin/recalcul-ts/${etape}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', ...enTetesCsrf()},
            body: JSON.stringify(corps),
        });
        let data = {};
        try { data = await res.json(); } catch (e) { /* corps vide */ }
        return {ok: res.ok, data};
    }

    function afficherApercu(r) {
        const bouges = r.joueurs.filter((j) => Math.abs(j.delta_ts) >= SEUIL_ECART);
        let html = `<p class="has-text-white mb-2">
            <strong>${r.nb_tournois}</strong> tournois rejoués,
            ${r.nb_participations} participations, ${r.nb_penalites} pénalités fantôme.
            <strong>${bouges.length}</strong> joueur(s) voient leur TS bouger d'au moins 0,001.</p>`;

        if (r.ecarts.length) {
            html += `<div class="notification is-warning is-light is-size-7">
                <p><strong>${r.ecarts.length} discontinuité(s) dans l'historique</strong> :
                une valeur modifiée hors tournoi (correction manuelle, ancien bug). Elles sont
                reportées telles quelles sur le recalcul.</p><ul>${
                r.ecarts.map((e) => `<li>${dateFr(e.date)} · ${echapper(e.nom)} (${echapper(e.origine)}) :
                    mu ${signe(e.delta_mu, 4)}, sigma ${signe(e.delta_sigma, 4)}</li>`).join('')
            }</ul></div>`;
        }

        html += `<div class="table-container"><table class="table is-fullwidth is-narrow is-size-7"
                style="background:transparent;">
            <thead><tr><th>Joueur</th><th>TS actuel</th><th>TS recalculé</th><th>Écart</th>
            <th>mu</th><th>sigma</th></tr></thead><tbody>${
            r.joueurs.map((j) => `<tr>
                <td>${echapper(j.nom)}</td>
                <td>${nombre(j.ts_avant, 3)}</td>
                <td>${nombre(j.ts_apres, 3)}</td>
                ${celluleEcart(j.delta_ts)}
                <td>${nombre(j.mu_avant, 3)} → ${nombre(j.mu_apres, 3)}</td>
                <td>${nombre(j.sigma_avant, 3)} → ${nombre(j.sigma_apres, 3)}</td>
            </tr>`).join('')
        }</tbody></table></div>`;
        zoneResultat.innerHTML = html;
    }

    btnApercu.addEventListener('click', async () => {
        const saisie = lireSaisie();
        if (saisie.erreur) { alert(saisie.erreur); return; }
        btnApercu.classList.add('is-loading');
        btnAppliquer.disabled = true;
        apercuValide = null;
        try {
            const {ok, data} = await envoyer('apercu', saisie);
            if (!ok) {
                zoneResultat.innerHTML = `<p class="has-text-danger">⛔ ${echapper(data.error || 'Erreur inconnue')}</p>`;
                return;
            }
            afficherApercu(data);
            apercuValide = {...saisie, empreinte: data.empreinte};
            btnAppliquer.disabled = false;
        } catch (e) {
            zoneResultat.innerHTML = '<p class="has-text-danger">Erreur de connexion au serveur.</p>';
        } finally {
            btnApercu.classList.remove('is-loading');
        }
    });

    btnAppliquer.addEventListener('click', async () => {
        if (!apercuValide) return;
        const taus = apercuValide.periodes.map((p) => `tau ${p.tau} dès le ${dateFr(p.debut)}`).join(', ');
        if (!confirm(`Recalculer le TrueSkill de tout le monde depuis le ${dateFr(apercuValide.date_debut)} (${taus}) ?\n\nToutes les valeurs depuis cette date seront réécrites. Seul un dump permet de revenir en arrière.`)) return;
        btnAppliquer.classList.add('is-loading');
        try {
            const {ok, data} = await envoyer('appliquer', apercuValide);
            if (ok) {
                zoneResultat.innerHTML = `<p class="has-text-success">✅ ${echapper(data.message)}</p>`;
            } else {
                alert('⛔ ' + (data.error || 'Erreur inconnue'));
            }
            apercuValide = null;
            btnAppliquer.disabled = true;
        } catch (e) {
            alert('Erreur de connexion au serveur');
        } finally {
            btnAppliquer.classList.remove('is-loading');
        }
    });

    btnAjout.addEventListener('click', () => { ajouterPeriode('', '', false); invalider(); });
    // La première période part de la date de départ : son champ (grisé) la recopie.
    champDebut.addEventListener('input', () => {
        const premiere = zonePeriodes.querySelector('.periode-debut[disabled]');
        if (premiere) premiere.value = champDebut.value;
        invalider();
    });

    // Première période : celle qui part de la date de départ.
    ajouterPeriode('', '', true);
})();
