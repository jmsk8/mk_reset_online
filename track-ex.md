# Anneau du Moai

Le circuit historique du banner, celui qui vivait en dur dans `physics-config.js`
avant que les tracés ne se dessinent. Un anneau nu : ligne d'arrivée, un rideau
de quatre boîtes au tiers du tour, et rien d'autre entre les deux.

Il sert de référence — tant qu'il est en tête de la rotation, une course
ressemble exactement à ce qu'elle a toujours été.

- **96 colonnes** → un tour de 7680 px, ~30 s au rythme de croisière
- **ligne d'arrivée colonne 18** → 1440 px
- **boîtes colonne 50** → 4000 px, soit un tiers de tour après la ligne
- **4 rangées** → les boîtes couvrent toute la profondeur de la piste

```track
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
                  x                       B                     PP                   PP           
                  x                                             PP                   PP         
                  x            P          B                                                    
                  x                                                                         PP   
                  x                       B                                                 PP     
                  x                                             PP                PP        
                  x                       B                     PP                PP        
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Repères de colonnes, pour se placer sans compter :

```
0        10        20        30        40        50        60        70        80        90
|---------|---------|---------|---------|---------|---------|---------|---------|---------|-----
                  ^ ligne                        ^ boîtes
```
