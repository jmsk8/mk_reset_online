FROM node:22-alpine

WORKDIR /app

# Les dépendances d'abord : cette couche reste en cache tant que package.json
# ne bouge pas. `ws` est la seule, et elle n'a aucune dépendance transitive.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Le service et son moteur. Tout est copié : depuis que le navigateur ne charge
# plus la physique, le moteur est du code serveur ordinaire et n'a plus de
# raison d'être monté depuis le dépôt.
COPY src/ src/
COPY tools/ tools/

# tracks/ n'est PAS copié, et c'est délibéré : ce sont des dessins, pas du code.
# Monté par docker-compose, un circuit retouché part en course au prochain
# `make restart-race` ; copié, il faudrait reconstruire l'image pour déplacer
# une boîte à objets.

# Convention du dépôt : aucun service ne tourne en root. L'image node fournit
# déjà un utilisateur `node` en uid 1000.
USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
