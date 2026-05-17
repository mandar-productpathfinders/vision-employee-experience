FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.js .
COPY lib ./lib
EXPOSE 8200
CMD ["node", "index.js"]
