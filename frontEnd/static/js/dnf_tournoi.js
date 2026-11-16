// DNF d'un tournoi déjà enregistré (fenêtre #dnfModal de add_tournament.html).
// Hors IP : enregistré directement, l'IP se recalcule à l'affichage. Hors TS :
// le TrueSkill est rejoué depuis la date du tournoi ; « Appliquer » exige un
// aperçu et renvoie l'empreinte des données lue à ce moment-là.
(function () {
    const modal = document.getElementById('dnfModal');
    if (!modal) return;

    const zoneDate = document.getElementById('dnfDate');
    const zoneRecaps = document.getElementById('dnfRecaps');
    const chargement = document.getElementById('dnfChargement');
    const tableau = document.getElementById('dnfTableau');
    const corps = document.getElementById('dnfJoueurs');
    const zoneResultat = document.getElementById('dnfResultat');
    const btnApercu = document.getElementById('dnfApercu');
    const btnAppliquer = document.getElementById('dnfAppliquer');

    // Sous 0,0005 l'écart s'arrondit à 0.000 (même seuil que le recalcul TS).
    const SEUIL_ECART = 0.0005;

    let tournoiId = null;
    let tournoiDate = '';
    let joueurs = [];          // état enregistré, tel que lu à l'ouverture
    let apercu = null;         // {empreinte} du dernier aperçu valide

    const echapper = (s) => String(s).replace(/[&<>"']/g, (c) => (
        {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    const signe = (x, n) => (x > 0 ? '+' : '') + Number(x).toFixed(n);

    function enTetes() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return Object.assign({'Content-Type': 'application/json', 'Accept': 'application/json'},
                             meta ? {'X-CSRFToken': meta.content} : {});
    }

    // Helper : Accept explicite (enTetes), pas de revalidation de session.
    async function appeler(methode, url, corpsJson) {
        const options = {
            method: methode,
            headers: enTetes(),
            body: corpsJson === undefined ? undefined : JSON.stringify(corpsJson),
        };
        const res = await fetch(url, options);
        let data = {};
        try { data = await res.json(); } catch (e) { /* corps vide */ }
        return {ok: res.ok, status: res.status, data};
    }

    function erreur(message) {
        zoneResultat.innerHTML = `<p class="has-text-danger is-size-7 mt-3">⛔ ${echapper(message)}</p>`;
    }

    // Joueurs dont une case diffère de l'état enregistré.
    function changements() {
        const liste = [];
        corps.querySelectorAll('tr[data-joueur]').forEach((tr) => {
            const j = joueurs.find((x) => x.joueur_id === Number(tr.dataset.joueur));
            const ts = tr.querySelector('.dnf-ts').checked;
            const ip = tr.querySelector('.dnf-ip').checked;
            if (ts !== j.exclu_ts || ip !== j.exclu_ip) {
                liste.push({joueur_id: j.joueur_id, exclu_ts: ts, exclu_ip: ip});
            }
        });
        return liste;
    }

    const toucheTs = (liste) => liste.some((c) =>
        c.exclu_ts !== joueurs.find((j) => j.joueur_id === c.joueur_id).exclu_ts);

    // Boutons selon la saisie : un changement de TS passe par l'aperçu.
    function majBoutons() {
        const liste = changements();
        const ts = toucheTs(liste);
        btnApercu.disabled = !ts;
        btnApercu.title = ts ? '' : "Seul un changement de No TS demande un aperçu.";
        btnAppliquer.disabled = !liste.length || (ts && apercu === null);
        btnAppliquer.lastChild.textContent = ts ? ' Appliquer' : ' Enregistrer';
    }

    function invalider() {
        if (apercu !== null) {
            apercu = null;
            zoneResultat.innerHTML = '<p class="has-text-warning is-size-7 mt-3">'
                + "Saisie modifiée : relancez l'aperçu avant d'appliquer.</p>";
        }
        majBoutons();
    }

    function afficherJoueurs(peutModifier) {
        corps.innerHTML = joueurs.map((j) => `
            <tr data-joueur="${j.joueur_id}">
                <td>${j.position != null ? j.position : '—'}</td>
                <td class="has-text-white">${echapper(j.nom)}</td>
                <td class="has-text-right">${echapper(j.score)}</td>
                <td class="has-text-centered"><input type="checkbox" class="dnf-ts case-centree"
                    aria-label="No TS pour ${echapper(j.nom)}" ${j.exclu_ts ? 'checked' : ''}
                    ${peutModifier ? '' : 'disabled'}></td>
                <td class="has-text-centered"><input type="checkbox" class="dnf-ip case-centree"
                    aria-label="No IP pour ${echapper(j.nom)}" ${j.exclu_ip ? 'checked' : ''}
                    ${peutModifier ? '' : 'disabled'}></td>
            </tr>`).join('');
        corps.querySelectorAll('input').forEach((i) => i.addEventListener('change', invalider));
    }

    function afficherRecaps(recaps) {
        if (!recaps.length) { zoneRecaps.style.display = 'none'; return; }
        const noms = recaps.map((r) => '« ' + echapper(r.nom) + ' »').join(', ');
        const awards = recaps.some((r) => r.awards)
            ? ' ; les awards déjà distribués restent tels quels' : '';
        zoneRecaps.innerHTML = `Ce tournoi fait partie du récap ${noms} : son classement
            suivra ce changement${awards}.`;
        zoneRecaps.style.display = '';
    }

    function afficherApercu(r) {
        const bouges = r.joueurs.filter((j) => Math.abs(j.delta_ts) >= SEUIL_ECART);
        let html = `<p class="has-text-white is-size-7 mt-3 mb-2">
            TrueSkill rejoué depuis le ${echapper(r.date_debut)} (tau ${echapper(r.tau)}) :
            <strong>${r.nb_tournois}</strong> tournois.
            <strong>${bouges.length}</strong> joueur(s) voient leur TS bouger d'au moins 0,001.</p>`;
        if (r.ecarts.length) {
            html += `<p class="has-text-warning is-size-7 mb-2">${r.ecarts.length} correction(s)
                manuelle(s) dans l'historique, reportée(s) telles quelles.</p>`;
        }
        if (bouges.length) {
            html += `<div class="table-container"><table class="table is-fullwidth is-narrow is-size-7"
                    style="background: transparent;">
                <thead><tr><th>Joueur</th><th>TS actuel</th><th>TS recalculé</th><th>Écart</th></tr></thead>
                <tbody>${bouges.map((j) => `<tr>
                    <td>${echapper(j.nom)}</td>
                    <td>${Number(j.ts_avant).toFixed(3)}</td>
                    <td>${Number(j.ts_apres).toFixed(3)}</td>
                    <td class="${j.delta_ts > 0 ? 'has-text-success' : 'has-text-danger'}">${signe(j.delta_ts, 3)}</td>
                </tr>`).join('')}</tbody></table></div>`;
        }
        zoneResultat.innerHTML = html;
    }

    window.ouvrirDnf = async function (id) {
        tournoiId = id;
        apercu = null;
        joueurs = [];
        zoneDate.textContent = '…';
        zoneRecaps.style.display = 'none';
        zoneResultat.innerHTML = '';
        tableau.style.display = 'none';
        chargement.style.display = '';
        btnApercu.disabled = true;
        btnAppliquer.disabled = true;
        modal.classList.add('is-active');
        try {
            const {ok, data} = await appeler('GET', `/admin/tournois/${id}/dnf`);
            chargement.style.display = 'none';
            if (!ok) { erreur(data.error || 'Lecture impossible.'); return; }
            tournoiDate = data.tournoi.date;
            zoneDate.textContent = tournoiDate;
            joueurs = data.joueurs;
            afficherJoueurs(data.peut_modifier);
            afficherRecaps(data.recaps || []);
            tableau.style.display = '';
            if (!data.peut_modifier) {
                erreur("Déclarer un DNF demande un droit sur le TrueSkill "
                       + "(« Réglage TS » ou « Corriger le score »).");
            }
            majBoutons();
        } catch (e) {
            chargement.style.display = 'none';
            erreur('Erreur de connexion au serveur.');
        }
    };

    function fermer() {
        modal.classList.remove('is-active');
        tournoiId = null;
    }
    modal.querySelectorAll('[data-fermer-dnf]').forEach((el) => el.addEventListener('click', fermer));

    btnApercu.addEventListener('click', async () => {
        const liste = changements();
        if (!liste.length) return;
        btnApercu.classList.add('is-loading');
        btnAppliquer.disabled = true;
        apercu = null;
        try {
            const {ok, data} = await appeler('POST', `/admin/tournois/${tournoiId}/dnf/apercu`,
                                             {joueurs: liste});
            if (!ok) { erreur(data.error || 'Erreur inconnue'); return; }
            if (data.recalcul_ts) afficherApercu(data.recalcul_ts);
            apercu = {empreinte: data.empreinte};
        } catch (e) {
            erreur('Erreur de connexion au serveur.');
        } finally {
            btnApercu.classList.remove('is-loading');
            majBoutons();
        }
    });

    btnAppliquer.addEventListener('click', async () => {
        const liste = changements();
        if (!liste.length) return;
        const ts = toucheTs(liste);
        const question = ts
            ? `Recalculer le TrueSkill de tout le monde depuis le ${tournoiDate} ?\n\n`
              + 'Toutes les valeurs depuis cette date seront réécrites. Seul un dump '
              + 'permet de revenir en arrière.'
            : "Enregistrer ce DNF ? L'IP est recalculée aussitôt ; décocher annule.";
        if (!confirm(question)) return;
        btnAppliquer.classList.add('is-loading');
        try {
            const corpsJson = {joueurs: liste};
            if (ts) corpsJson.empreinte = apercu ? apercu.empreinte : null;
            const {ok, data} = await appeler('POST', `/admin/tournois/${tournoiId}/dnf`, corpsJson);
            if (ok) {
                alert('✅ ' + (data.message || 'DNF enregistré.'));
                window.location.reload();
                return;
            }
            if (data.code === 'apercu_perime') apercu = null;
            erreur(data.error || 'Erreur inconnue');
        } catch (e) {
            erreur('Erreur de connexion au serveur.');
        } finally {
            btnAppliquer.classList.remove('is-loading');
            majBoutons();
        }
    });
})();
