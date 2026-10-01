FROM node:22-alpine

WORKDIR /app

# Dépendances d'abord, pour le cache (`ws` seulement).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src/ src/
COPY tools/ tools/

# tracks/ est monté par docker-compose (pas besoin de reconstruire l'image).

# Utilisateur non root fourni par l'image node.
USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
