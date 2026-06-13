# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Archivos de configuración
COPY package*.json ./
COPY tsconfig*.json ./

# Instalar TODAS las dependencias (incluyendo devDependencies)
RUN npm ci

# Copiar el código fuente
COPY src/ ./src/

# Compilar TypeScript a JavaScript
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS runner

ENV NODE_ENV=production

# Instalar dumb-init para un correcto manejo de señales
RUN apk add --no-cache dumb-init

# Usar usuario no-root por seguridad
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nodejs -G nodejs

WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar SOLO dependencias de producción
RUN npm ci --omit=dev

# Copiar artefactos compilados desde el builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Cambiar al usuario no-root
USER nodejs

# Exponer el puerto interno
EXPOSE 4000

# Iniciar la aplicación con dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
