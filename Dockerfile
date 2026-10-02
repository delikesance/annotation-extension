FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache zip git

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npm", "run", "build"]
