// Fenetre de choix de couleur partagee (tiers, fiches joueurs) : palette,
// curseurs teinte/saturation/clarte et code hexadecimal, appliques a
// « Confirmer ». Avec `couleurTexte`, une bascule Badge / Texte regle aussi la
// couleur du texte. La fenetre est construite a la premiere ouverture.
//
// Sans `libelle`, l'apercu est une simple pastille de couleur.
//
//   ChoixCouleur.ouvrir({
//       titre, libelle /* facultatif */, couleur, couleurTexte /* facultatif */,
//       surConfirmer: ({couleur, couleurTexte}) => { ... },
//   });

const ChoixCouleur = (function () {
    const HEX6 = /^#[0-9a-fA-F]{6}$/;

    function couleurSure(c) {
        return /^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : '#FFFFFF';
    }

    // Le backend accepte #RGB a #RRGGBBAA ; la fenetre travaille en #RRGGBB.
    function versHex6(c) {
        c = couleurSure(c);
        if (c.length === 4 || c.length === 5) {
            return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toUpperCase();
        }
        return c.slice(0, 7).toUpperCase();
    }

    function hslVersHex(h, s, l) {
        s /= 100; l /= 100;
        const a = s * Math.min(l, 1 - l);
        const f = n => {
            const k = (n + h / 30) % 12;
            const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
            return Math.round(v * 255).toString(16).padStart(2, '0');
        };
        return ('#' + f(0) + f(8) + f(4)).toUpperCase();
    }

    function hexVersHsl(hex) {
        const n = parseInt(versHex6(hex).slice(1), 16);
        const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
    }

    // Noir sur fond clair, blanc sur fond fonce.
    function texteSur(hex) {
        const n = parseInt(versHex6(hex).slice(1), 16);
        const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
        return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0f172a' : '#ffffff';
    }

    // Fond et texte d'un element (texte lisible si non fourni).
    function peindre(el, couleur, texte) {
        el.style.backgroundColor = couleurSure(couleur);
        el.style.color = texte ? couleurSure(texte) : texteSur(couleur);
    }

    // Palette : 8 teintes en nuances, puis neutres et metaux (avec les couleurs
    // par defaut des tiers S/A/B/C).
    const PALETTE = (() => {
        const teintes = [0, 28, 48, 125, 172, 205, 265, 320];
        const nuances = [[90, 82], [85, 70], [80, 58], [75, 46], [70, 34]];
        const couleurs = [];
        nuances.forEach(([s, l]) => teintes.forEach(h => couleurs.push(hslVersHex(h, s, l))));
        couleurs.push('#F77B7B', '#9CDA74', '#7FE6EE', '#AE6CE4', // S/A/B/C par defaut
                      '#FFD700', '#C0C0C0', '#CD7F32', '#FFFFFF', // or, argent, bronze, blanc
                      '#F1F5F9', '#CBD5E1', '#94A3B8', '#64748B', // gris, du clair...
                      '#475569', '#334155', '#1E293B', '#000000'); // ...au noir
        return couleurs;
    })();

    const GABARIT = `
        <div class="modal-background" data-fermer></div>
        <div class="modal-card choix-couleur-carte">
            <header class="modal-card-head">
                <p class="modal-card-title" id="choixCouleurTitre"></p>
                <button type="button" class="delete" aria-label="Fermer" data-fermer></button>
            </header>
            <section class="modal-card-body">
                <div class="choix-couleur-apercu">
                    <span class="choix-couleur-badge" id="choixCouleurApercu"></span>
                    <span class="choix-couleur-avant" id="choixCouleurAvant" title="Couleurs actuelles"></span>
                </div>

                <div class="buttons has-addons choix-couleur-cible" id="choixCouleurCible"
                     role="group" aria-label="Couleur à modifier">
                    <button type="button" class="button is-small" data-cible="fond" aria-pressed="true">
                        <i class="fas fa-fill-drip mr-1"></i> Badge
                    </button>
                    <button type="button" class="button is-small" data-cible="texte" aria-pressed="false">
                        <i class="fas fa-font mr-1"></i> Texte
                    </button>
                </div>

                <div class="choix-couleur-palette" id="choixCouleurPalette" role="listbox" aria-label="Palette"></div>

                <p class="choix-couleur-sous-titre">Affiner</p>
                <label class="choix-couleur-curseur">
                    <span>Teinte</span>
                    <input type="range" min="0" max="359" step="1" id="choixCouleurTeinte">
                </label>
                <label class="choix-couleur-curseur">
                    <span>Saturation</span>
                    <input type="range" min="0" max="100" step="1" id="choixCouleurSaturation">
                </label>
                <label class="choix-couleur-curseur">
                    <span>Clarté</span>
                    <input type="range" min="0" max="100" step="1" id="choixCouleurClarte">
                </label>

                <div class="field has-addons mt-3 mb-0">
                    <p class="control"><span class="button is-static is-small">Code</span></p>
                    <p class="control is-expanded">
                        <input class="input is-small" type="text" id="choixCouleurHex"
                               maxlength="7" autocomplete="off" autocapitalize="characters"
                               spellcheck="false" placeholder="#RRGGBB">
                    </p>
                </div>
            </section>
            <footer class="modal-card-foot">
                <button type="button" class="button" data-fermer>Annuler</button>
                <button type="button" class="button is-info" id="choixCouleurConfirmer">
                    <i class="fas fa-check mr-2"></i> Confirmer
                </button>
            </footer>
        </div>`;

    let modal = null;
    let fond = '#FFFFFF';
    let texte = null; // null : pas de reglage du texte
    let cible = 'fond'; // couleur editee : 'fond' ou 'texte'
    let surConfirmer = null;
    let declencheur = null; // element a qui rendre le focus

    function el(id) { return document.getElementById(id); }

    function couleurEditee() {
        return cible === 'texte' ? texte : fond;
    }

    function poserCouleur(c) {
        if (cible === 'texte') texte = c; else fond = c;
    }

    // Met a jour la fenetre depuis la couleur editee (`source` : champ a ne pas reecrire).
    function afficher(source) {
        const c = couleurEditee();
        peindre(el('choixCouleurApercu'), fond, texte);

        el('choixCouleurCible').querySelectorAll('button[data-cible]').forEach(b => {
            const oui = b.dataset.cible === cible;
            b.classList.toggle('is-info', oui);
            b.classList.toggle('is-selected', oui);
            b.setAttribute('aria-pressed', oui ? 'true' : 'false');
        });

        el('choixCouleurPalette').querySelectorAll('button').forEach(b => {
            const oui = b.dataset.couleur === c;
            b.classList.toggle('choisie', oui);
            b.setAttribute('aria-selected', oui ? 'true' : 'false');
        });

        const hex = el('choixCouleurHex');
        if (source !== 'hex') { hex.value = c; hex.classList.remove('is-danger'); }

        if (source !== 'curseurs') {
            const { h, s, l } = hexVersHsl(c);
            el('choixCouleurTeinte').value = h;
            el('choixCouleurSaturation').value = s;
            el('choixCouleurClarte').value = l;
        }
        const h = +el('choixCouleurTeinte').value;
        const s = +el('choixCouleurSaturation').value;
        const l = +el('choixCouleurClarte').value;
        el('choixCouleurSaturation').style.background =
            `linear-gradient(to right, ${hslVersHex(h, 0, l)}, ${hslVersHex(h, 100, l)})`;
        el('choixCouleurClarte').style.background =
            `linear-gradient(to right, #000, ${hslVersHex(h, s, 50)}, #fff)`;
    }

    function fermer() {
        if (!modal || !modal.classList.contains('is-active')) return;
        modal.classList.remove('is-active');
        // Une autre modale (fiche joueur) peut rester ouverte dessous.
        if (!document.querySelector('.modal.is-active')) {
            document.documentElement.classList.remove('is-clipped');
        }
        surConfirmer = null;
        if (declencheur && document.contains(declencheur)) declencheur.focus();
        declencheur = null;
    }

    function confirmer() {
        const rappel = surConfirmer;
        const choix = { couleur: fond, couleurTexte: texte };
        fermer();
        if (rappel) rappel(choix);
    }

    function construire() {
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'choixCouleurModal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'choixCouleurTitre');
        modal.innerHTML = GABARIT;
        // En fin de body : passe au-dessus d'une modale deja ouverte.
        document.body.appendChild(modal);

        const palette = el('choixCouleurPalette');
        PALETTE.forEach(c => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.couleur = c;
            b.style.backgroundColor = c;
            b.title = c;
            b.setAttribute('role', 'option');
            b.setAttribute('aria-label', c);
            palette.appendChild(b);
        });
        // Un clic dans la palette choisit seulement.
        palette.addEventListener('click', e => {
            const b = e.target.closest('button[data-couleur]');
            if (!b) return;
            poserCouleur(b.dataset.couleur);
            afficher();
        });

        // Bascule fond / texte : les reglages suivants s'appliquent a la cible.
        el('choixCouleurCible').addEventListener('click', e => {
            const b = e.target.closest('button[data-cible]');
            if (!b) return;
            cible = b.dataset.cible;
            afficher();
        });

        ['choixCouleurTeinte', 'choixCouleurSaturation', 'choixCouleurClarte'].forEach(id => {
            el(id).addEventListener('input', () => {
                poserCouleur(hslVersHex(+el('choixCouleurTeinte').value,
                                        +el('choixCouleurSaturation').value,
                                        +el('choixCouleurClarte').value));
                afficher('curseurs');
            });
        });

        const hex = el('choixCouleurHex');
        hex.addEventListener('input', () => {
            let v = hex.value.trim();
            if (v && v[0] !== '#') v = '#' + v;
            const ok = HEX6.test(v);
            hex.classList.toggle('is-danger', !ok && v.length >= 7);
            if (ok) { poserCouleur(v.toUpperCase()); afficher('hex'); }
        });
        // Entree dans le champ code = Confirmer.
        hex.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); confirmer(); }
        });

        el('choixCouleurConfirmer').addEventListener('click', confirmer);
        modal.querySelectorAll('[data-fermer]').forEach(b => b.addEventListener('click', fermer));
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && modal.classList.contains('is-active')) {
                e.stopPropagation();
                fermer();
            }
        }, true);
    }

    function ouvrir(options) {
        if (!modal) construire();
        fond = versHex6(options.couleur);
        const avecTexte = options.couleurTexte !== undefined;
        texte = avecTexte
            ? (options.couleurTexte ? versHex6(options.couleurTexte) : texteSur(fond).toUpperCase())
            : null;
        cible = 'fond';
        surConfirmer = options.surConfirmer || null;
        declencheur = document.activeElement;

        el('choixCouleurTitre').textContent = options.titre || 'Couleur';
        el('choixCouleurCible').hidden = !avecTexte;
        const libelle = (options.libelle || '').trim();
        el('choixCouleurApercu').textContent = libelle;
        const avant = el('choixCouleurAvant');
        avant.textContent = libelle;
        peindre(avant, options.couleur, avecTexte ? options.couleurTexte : null);
        afficher();

        modal.classList.add('is-active');
        document.documentElement.classList.add('is-clipped');
        el('choixCouleurConfirmer').focus();
    }

    return { ouvrir, couleurSure, versHex6, texteSur, peindre };
})();
