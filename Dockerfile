FROM node:24.22.2-alpine3.24@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY ./src ./src
COPY ./views ./views
COPY ./public ./public

EXPOSE 80
CMD ["npm", "run", "start"]
