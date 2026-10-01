# Use an official Node.js runtime as the base image
FROM node:21.1-slim

# Set the working directory in the container
WORKDIR /usr/src/client

# Install pnpm globally
RUN npm install -g pnpm@9

# Copy package.json and ./pnpm-lock.yaml to the container
COPY ./package.json .
COPY ./pnpm-lock.yaml .

# Install Node.js dependencies
RUN pnpm install 

# Copy the rest of the application source code to the container
RUN mkdir src
COPY ./src ./src
COPY ./public ./public

# Copy tsconfig.json to the container
COPY ./tsconfig.json .
COPY ./tsconfig.app.json .
COPY ./tsconfig.node.json .
COPY ./vite.config.ts .
COPY ./index.html .

ARG VITE_ENVIRONMENT
ARG VITE_BASE_PATH="/"
ARG VITE_SPACE_BASE_URL
ARG SPHERE_PUBLIC_URL

ENV BASE_PATH=${VITE_BASE_PATH}

# Build your application
RUN pnpm run build
RUN pnpm add -D serve

# Specify the command to start the server
CMD ["pnpm", "exec", "serve", "-s", "./dist", "-l", "5050"]
