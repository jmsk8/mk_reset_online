document.addEventListener('DOMContentLoaded', () => {
  // Accept explicite pour les appels de données de la navbar (pas de
  // revalidation de session).
  const HEADERS_JSON = { headers: { 'Accept': 'application/json' } };

  // Jeton CSRF porte par le <nav>, avec repli sur la <meta>.
  const JETON_CSRF = document.querySelector('.navbar[data-csrf]')?.dataset.csrf
                     || document.querySelector('meta[name="csrf-token"]')?.content
                     || '';

  const $navbarBurgers = Array.prototype.slice.call(document.querySelectorAll('.navbar-burger'), 0);
  if ($navbarBurgers.length > 0) {
    $navbarBurgers.forEach( el => {
      el.addEventListener('click', () => {
        const target = el.dataset.target;
        const $target = document.getElementById(target);
        el.classList.toggle('is-active');
        $target.classList.toggle('is-active');
      });
    });
  }

  // Cloche et avatar mobiles : ouverture au clic, un seul panneau a la fois.
  const panneauxMobiles = document.querySelectorAll('.cloche-mobile, .compte-mobile');
  panneauxMobiles.forEach(panneau => {
    const lien = panneau.querySelector('.navbar-link');
    lien.addEventListener('click', ev => {
      ev.preventDefault();
      const ouvrir = !panneau.classList.contains('est-ouverte');
      fermerPanneaux();
      if (ouvrir) {
        panneau.classList.add('est-ouverte');
        lien.setAttribute('aria-expanded', 'true');
      }
    });
  });

  function fermerPanneaux() {
    panneauxMobiles.forEach(p => {
      p.classList.remove('est-ouverte');
      p.querySelector('.navbar-link').setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('click', ev => {
    if (ev.target.closest('.cloche-mobile, .compte-mobile')) return;
    fermerPanneaux();
  });

  // Sous-menus : ouverture au clic sur tous les ecrans (cloche et compte du
  // desktop compris). Dans le burger, plusieurs peuvent rester ouverts.
  const sectionsMenu = document.querySelectorAll(
    '#navbarMenu .navbar-item.has-dropdown:not(.cloche-mobile):not(.compte-mobile)'
  );

  function fermerSections(sauf) {
    sectionsMenu.forEach(section => {
      if (section === sauf) return;
      section.classList.remove('est-ouverte');
      const l = section.querySelector('.navbar-link');
      if (l) l.setAttribute('aria-expanded', 'false');
    });
  }

  sectionsMenu.forEach(section => {
    const lien = section.querySelector('.navbar-link');
    if (!lien) return;

    lien.setAttribute('aria-expanded', 'false');
    lien.addEventListener('click', ev => {
      ev.preventDefault();
      const ouvert = section.classList.toggle('est-ouverte');
      lien.setAttribute('aria-expanded', ouvert ? 'true' : 'false');

      // Au-dessus de 1024px, un seul menu ouvert a la fois.
      if (ouvert && window.matchMedia('(min-width: 1024px)').matches) {
        fermerSections(section);
      }
    });
  });

  // Ecran large : un clic hors du menu le referme.
  document.addEventListener('click', ev => {
    if (!window.matchMedia('(min-width: 1024px)').matches) return;
    if (ev.target.closest('#navbarMenu .navbar-item.has-dropdown')) return;
    fermerSections(null);
  });

  // Echap referme aussi.
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') fermerSections(null);
  });

  // Refermer le burger replie ses sous-menus.
  document.querySelectorAll('.navbar-burger').forEach(burger => {
    burger.addEventListener('click', () => fermerSections(null));
  });

  // Repli si l'avatar Discord ne charge pas.
  document.querySelectorAll('img[data-repli-avatar]').forEach(img => {
    img.addEventListener('error', () => {
      const silhouette = document.createElement('span');
      silhouette.className = 'icon';
      silhouette.innerHTML = '<i class="fas fa-user-circle"></i>';
      img.closest('figure').replaceWith(silhouette);
    });
  });

  // Disparition automatique, suspendue au survol.
  document.querySelectorAll('#messages-flash .notification').forEach(bulle => {
    const delai = parseInt(bulle.dataset.delai, 10) || 5000;
    let minuteur;

    const fermer = () => {
      clearTimeout(minuteur);
      bulle.classList.add('sortant');
      // Repli si l'animation ne joue pas.
      const retrait = setTimeout(() => bulle.remove(), 400);
      bulle.addEventListener('animationend', () => {
        clearTimeout(retrait);
        bulle.remove();
      });
    };

    const armer = () => { minuteur = setTimeout(fermer, delai); };

    bulle.querySelector('.delete').addEventListener('click', fermer);
    bulle.addEventListener('mouseenter', () => clearTimeout(minuteur));
    bulle.addEventListener('mouseleave', armer);
    armer();
  });

  // Notifications (textContent : textes saisis par des humains).
  (async function () {
    // Deux cloches (desktop et mobile), toutes deux remplies.
    const badges = document.querySelectorAll('.badge-notifs');
    const listes = document.querySelectorAll('.liste-notifs');
    if (!badges.length || !listes.length) return;

    const ICONES = {
      liaison_approuvee:  'fa-circle-check has-text-success',
      liaison_refusee:    'fa-circle-xmark has-text-danger',
      liaison_annulee:    'fa-link-slash has-text-warning',
      fiche_supprimee:    'fa-trash has-text-danger',
      tournoi_ajoute:     'fa-flag-checkered has-text-info',
      recap_publie:       'fa-scroll has-text-warning',
      promotion_proposee: 'fa-user-shield has-text-link',
      promotion_acceptee: 'fa-user-check has-text-success',
      promotion_refusee:  'fa-user-xmark has-text-grey',
      reset_global:        'fa-rotate-left has-text-danger',
      reset_global_annule: 'fa-rotate-right has-text-grey'
    };

    // Marque tout comme lu a l'ouverture de la cloche (une seule fois).
    let deja = false;
    async function toutMarquerLu() {
      if (deja) return;
      deja = true;
      // La pastille s'eteint immediatement.
      badges.forEach(badge => badge.classList.add('is-hidden'));
      listes.forEach(l => {
        l.querySelectorAll('.navbar-item').forEach(i => i.classList.add('has-text-grey'));
      });
      try {
        const r = await fetch('/me/notifications/lues', {
          method: 'POST',
          headers: {'X-CSRFToken': JETON_CSRF}
        });
        // fetch ne leve pas sur une reponse d'erreur.
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (e) {
        // Echec : on rallume la pastille.
        deja = false;
        badges.forEach(badge => {
          if (badge.textContent && badge.textContent !== '0') {
            badge.classList.remove('is-hidden');
          }
        });
      }
    }

    function ligne(n) {
      // Lien seulement si la notification en a un, et seulement interne.
      const cliquable = typeof n.lien === 'string'
                        && n.lien.startsWith('/') && !n.lien.startsWith('//');
      const item = document.createElement(cliquable ? 'a' : 'div');
      item.className = 'navbar-item is-flex' + (n.lue ? ' has-text-grey' : '');
      item.style.whiteSpace = 'normal';
      item.style.alignItems = 'flex-start';
      if (cliquable) {
        item.href = n.lien;
      }

      const ico = document.createElement('span');
      ico.className = 'icon mr-2 mt-1';
      ico.innerHTML = '<i class="fas ' + (ICONES[n.type] || 'fa-circle-info') + '"></i>';
      item.appendChild(ico);

      const bloc = document.createElement('div');
      const t = document.createElement('strong');
      t.textContent = n.titre;
      bloc.appendChild(t);
      if (n.corps) {
        const c = document.createElement('p');
        c.className = 'is-size-7';
        c.textContent = n.corps;
        bloc.appendChild(c);
      }
      const d = document.createElement('p');
      d.className = 'is-size-7 has-text-grey';
      d.textContent = new Date(n.created_at).toLocaleString('fr-FR');
      bloc.appendChild(d);
      item.appendChild(bloc);
      return item;
    }

    let res;
    try {
      // Accept explicite : appel de données.
      res = await (await fetch('/me/notifications', HEADERS_JSON)).json();
    } catch (e) { return; } // navbar muette plutôt que cassée

    if (res.non_lues > 0) {
      badges.forEach(badge => {
        badge.textContent = res.non_lues;
        badge.classList.remove('is-hidden');
      });
    }

    listes.forEach(liste => {
      liste.innerHTML = '';
      if (!res.notifications || res.notifications.length === 0) {
        const vide = document.createElement('div');
        vide.className = 'navbar-item has-text-grey';
        vide.textContent = 'Aucune notification.';
        liste.appendChild(vide);
        return;
      }
      res.notifications.forEach(n => liste.appendChild(ligne(n)));

    });

    // Ouvrir la cloche (desktop ou mobile) vaut lecture. Declencheur sur
    // l'en-tete, pas sur la liste.
    document.querySelectorAll('.zone-cloche > .navbar-link').forEach(lien => {
      lien.addEventListener('click', () => {
        // Seulement a l'ouverture (le meme clic referme sur desktop).
        const section = lien.closest('.zone-cloche');
        if (section && section.classList.contains('est-ouverte')) toutMarquerLu();
      });
    });
  })();

  (async function () {
    if (!document.getElementById('badge-admin')) return;
    let res;
    try {
      res = await (await fetch('/admin/notifications', HEADERS_JSON)).json();
    } catch (e) { return; }
    const poser = (id, n) => {
      const el = document.getElementById(id);
      if (!el || !n) return;
      el.textContent = n;
      el.classList.remove('is-hidden');
    };
    poser('badge-admin', res.total);
    poser('badge-admin-comptes', res.liaisons_en_attente);
  })();

});
