FROM node:26.13.0-alpine3.24@sha256:b2646ba6d774dc22c24d89fc37103fcf4c4467e870c78b9519aa403300b2835a

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY ./src ./src
COPY ./views ./views
COPY ./public ./public

EXPOSE 80
CMD ["npm", "run", "start"]
