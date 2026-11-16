// Annonces du superadmin (admin_annonces.html). L'aperçu passe par le même
// rendu que la cloche (MKNotifs, navbar.js) : ce qu'on voit ici est ce que les
// joueurs verront.
document.addEventListener('DOMContentLoaded', () => {
    const bloc = document.getElementById('bloc-annonce');
    if (!bloc || !window.MKNotifs) return;

    const champTitre = document.getElementById('annonceTitre');
    const champCorps = document.getElementById('annonceCorps');
    const compteurTitre = document.getElementById('annonceTitreCompteur');
    const compteurCorps = document.getElementById('annonceCorpsCompteur');
    const apercu = document.getElementById('annonceApercu');
    const btnPublier = document.getElementById('annoncePublier');
    const zoneMessage = document.getElementById('annonceMessage');
    const zoneListe = document.getElementById('annoncesListe');

    const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const HEADERS_JSON = {'Accept': 'application/json', 'Content-Type': 'application/json',
                          'X-CSRFToken': CSRF};

    function message(texte, classe) {
        zoneMessage.innerHTML = '';
        if (!texte) return;
        const n = document.createElement('div');
        n.className = 'notification is-light mt-3 ' + classe;
        n.textContent = texte;
        zoneMessage.appendChild(n);
    }

    async function appel(methode, url, corps) {
        const r = await fetch(url, {
            method: methode, headers: HEADERS_JSON,
            body: corps === undefined ? undefined : JSON.stringify(corps),
        });
        let data = {};
        try { data = await r.json(); } catch (e) { /* réponse vide */ }
        if (!r.ok) throw new Error(data.error || ('Erreur ' + r.status));
        return data;
    }

    // --- Rédaction et aperçu ----------------------------------------------

    function compter(champ, zone) {
        const max = champ.maxLength;
        zone.textContent = champ.value.length + ' / ' + max;
        zone.classList.toggle('has-text-warning', champ.value.length > max * 0.9);
    }

    function rafraichirApercu() {
        compter(champTitre, compteurTitre);
        compter(champCorps, compteurCorps);
        const titre = champTitre.value.trim();
        btnPublier.disabled = !titre;
        apercu.innerHTML = '';
        apercu.appendChild(window.MKNotifs.ligne({
            type: 'annonce',
            titre: titre || 'Titre de l’annonce',
            corps: champCorps.value,
            created_at: new Date().toISOString(),
            lue: false,
            lien: null,
        }));
    }

    champTitre.addEventListener('input', rafraichirApercu);
    champCorps.addEventListener('input', rafraichirApercu);
    rafraichirApercu();

    btnPublier.addEventListener('click', async () => {
        const titre = champTitre.value.trim();
        if (!titre) return;
        if (!confirm('Publier « ' + titre + ' » dans la cloche de tous les comptes ?')) return;
        btnPublier.disabled = true;
        btnPublier.classList.add('is-loading');
        try {
            const res = await appel('POST', '/admin/api/annonces',
                                    {titre: titre, corps: champCorps.value});
            message(res.message, 'is-success');
            champTitre.value = '';
            champCorps.value = '';
            rafraichirApercu();
            charger();
        } catch (e) {
            message(e.message, 'is-danger');
            btnPublier.disabled = false;
        } finally {
            btnPublier.classList.remove('is-loading');
        }
    });

    // --- Annonces en ligne -------------------------------------------------

    function ligneAnnonce(a) {
        const ligne = document.createElement('div');
        ligne.className = 'annonce-ligne';

        const gauche = document.createElement('div');
        gauche.style.minWidth = '0';
        const titre = document.createElement('strong');
        titre.className = 'has-text-white';
        titre.textContent = a.titre;
        gauche.appendChild(titre);
        const meta = document.createElement('p');
        meta.className = 'is-size-7 has-text-grey-light';
        meta.textContent = new Date(a.created_at).toLocaleString('fr-FR')
            + ' · lue par ' + a.lues + ' / ' + a.destinataires;
        gauche.appendChild(meta);
        if (a.corps) {
            const detail = document.createElement('details');
            detail.className = 'is-size-7 mt-1';
            const resume = document.createElement('summary');
            resume.textContent = 'Texte';
            resume.style.cursor = 'pointer';
            detail.appendChild(resume);
            detail.appendChild(window.MKNotifs.miniMarkdown(a.corps));
            gauche.appendChild(detail);
        }
        ligne.appendChild(gauche);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'button is-small is-danger is-outlined';
        btn.innerHTML = '<i class="fas fa-trash mr-1"></i> Supprimer';
        btn.addEventListener('click', async () => {
            if (!confirm('Supprimer « ' + a.titre + ' » ? Elle disparaîtra de la cloche de '
                         + a.destinataires + ' compte(s).')) return;
            btn.classList.add('is-loading');
            try {
                const res = await appel('DELETE', '/admin/api/annonces/' + a.id);
                message(res.message, 'is-success');
                charger();
            } catch (e) {
                message(e.message, 'is-danger');
                btn.classList.remove('is-loading');
            }
        });
        ligne.appendChild(btn);
        return ligne;
    }

    async function charger() {
        let res;
        try {
            res = await appel('GET', '/admin/api/annonces');
        } catch (e) {
            zoneListe.innerHTML = '';
            const err = document.createElement('div');
            err.className = 'has-text-danger';
            err.textContent = e.message;
            zoneListe.appendChild(err);
            return;
        }
        // Bornes du backend (le gabarit n'en porte qu'une copie de repli).
        if (res.titre_max) champTitre.maxLength = res.titre_max;
        if (res.corps_max) champCorps.maxLength = res.corps_max;
        rafraichirApercu();
        zoneListe.innerHTML = '';
        if (!res.annonces || !res.annonces.length) {
            const vide = document.createElement('div');
            vide.className = 'has-text-grey';
            vide.textContent = 'Aucune annonce en ligne.';
            zoneListe.appendChild(vide);
            return;
        }
        res.annonces.forEach(a => zoneListe.appendChild(ligneAnnonce(a)));
    }

    charger();
});
