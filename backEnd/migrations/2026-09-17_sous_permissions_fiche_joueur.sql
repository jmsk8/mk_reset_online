-- Fiche joueur : gestion_joueurs ne donne plus que la lecture, chaque action a
-- sa sous-permission. rgpd_joueurs est renomme joueurs_irreversible.

-- Supprime d'abord les doublons eventuels (contrainte UNIQUE).
DELETE FROM public.permissions_admin a
 WHERE a.permission = 'rgpd_joueurs'
   AND EXISTS (SELECT 1 FROM public.permissions_admin b
                WHERE b.compte_id = a.compte_id
                  AND b.permission = 'joueurs_irreversible');

UPDATE public.permissions_admin
   SET permission = 'joueurs_irreversible'
 WHERE permission = 'rgpd_joueurs';

-- Les autres sous-permissions ne sont pas accordees retroactivement : elles
-- s'accordent une par une depuis le panneau des permissions.
